// Process-wide record of MCP requests, pushed to the launcher's web UI so it shows the server is alive.
// A module singleton on purpose: the MCP server is restarted in-process on config changes, the count should survive that.
// Only the counter and the single latest call (with details) are kept, plus aggregates for the analytics panel:
// per-minute buckets (an hour), per-tool and per-chat totals, and hourly totals (two weeks, optionally saved to a file).
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';

const MAX_ARGS_CHARS = 4000;
const BUCKET_MS = 60_000;
const BUCKET_COUNT = 60; // keep an hour of per-minute totals
const MAX_TOOLS = 100;
const MAX_CHATS = 50;
const MAX_BLOCKED = 20;
const HOUR_MS = 3_600_000;
const HOUR_COUNT = 14 * 24; // keep two weeks of per-hour totals
const MAX_LATENCY_SAMPLES = 40; // per minute bucket, for percentiles
const MAX_WORKSPACES = 20;
const WS_SLOT_MS = 600_000; // per-workspace counts are kept in 10 minute slots
const WS_SLOT_KEEP = 7 * 144; // ...for up to a week
const TREND_POINTS = 24; // points in a workspace trend line
const STARTED = Date.now(); // module load = process start; survives in-process server restarts

/** Why a tool call failed: policy refusal, time limit, malformed request, rejected input, or a crash in the tool. */
export type ErrorKind = 'blocked' | 'timeout' | 'invalid' | 'rejected' | 'failed';

/** Sort a failed call into an ErrorKind from its message and whether the tool raised an AccessError. */
export function classifyError(message: string | undefined, access: boolean): ErrorKind {
  const m = message ?? '';
  if (/timed out|timeout|time limit/i.test(m)) return 'timeout';
  if (/outside|not allowed|is disabled|denied|blocked|allowed (hosts|roots|commands)|embedded credentials|never allowed|only http/i.test(m)) return 'blocked';
  return access ? 'rejected' : 'failed';
}

export interface LastCall {
  id: number;
  ts: number;
  /** Tool name for tools/call, otherwise the JSON-RPC method (e.g. "tools/list"). */
  name: string;
  /** JSON-RPC method. */
  method: string;
  /** Arguments (tools/call) or params, pretty-printed and truncated. */
  args?: string;
  /** Chat/conversation id and user agent when the client sent them. */
  conversation?: string;
  client?: string;
  status: 'pending' | 'ok' | 'error';
  ms?: number;
  workspace?: string;
  error?: string;
  kind?: ErrorKind;
  /** Size of the request arguments and of the tool result, in bytes. */
  inBytes?: number;
  outBytes?: number;
}
export interface ActivitySnapshot {
  count: number;
  last?: LastCall;
}
/** Totals for one minute of finished tool calls. */
export interface Bucket {
  /** Start of the minute (epoch ms). */
  t: number;
  calls: number;
  errors: number;
  /** Sum of execution time of the calls that reported one. */
  ms: number;
  timed: number;
  /** Request / result bytes. */
  inB: number;
  outB: number;
  /** Failed calls by ErrorKind. */
  kinds: Partial<Record<ErrorKind, number>>;
  /** Up to MAX_LATENCY_SAMPLES execution times (ms), for percentiles. */
  lat: number[];
}
export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  inB: number;
  outB: number;
}
/** Totals for one hour (start, epoch ms). */
export interface HourBucket {
  t: number;
  calls: number;
  errors: number;
}
export interface ChatStat {
  /** Conversation id ('' when the client sent none). */
  id: string;
  client?: string;
  calls: number;
  errors: number;
  lastTs: number;
}
/** A call refused by policy (blocked path, host, command...). */
export interface BlockedStat {
  tool: string;
  count: number;
  ts: number;
  error: string;
}
/** Calls against one workspace since the process started, with a trend line spread evenly over that time. */
export interface WorkspaceStat {
  alias: string;
  calls: number;
  errors: number;
  /** TREND_POINTS call counts, oldest first, covering `since` to now. */
  trend: number[];
}
export interface StatsSnapshot {
  buckets: Bucket[];
  tools: ToolStat[];
  hours: HourBucket[];
  chats: ChatStat[];
  blocked: BlockedStat[];
  workspaces: WorkspaceStat[];
  /** When the process started (epoch ms): the left edge of the workspace trends. */
  since: number;
}
export interface CallSource {
  conversation?: string;
  client?: string;
}

/** Calls recorded for the HTTP request being handled, so a tool can report its outcome against the right entry. */
const pending = new AsyncLocalStorage<LastCall[]>();

function summarize(value: unknown): { text?: string; bytes: number } {
  if (value === undefined) return { bytes: 0 };
  const s = JSON.stringify(value, null, 2) ?? '';
  const text = s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}\n[truncated: ${s.length} chars]` : s;
  return { text, bytes: Buffer.byteLength(s) };
}

class ActivityTracker {
  private count = 0;
  private nextId = 1;
  private last: LastCall | undefined;
  private listeners = new Set<(s: ActivitySnapshot) => void>();
  private buckets: Bucket[] = [];
  private tools = new Map<string, { calls: number; errors: number; timed: number; totalMs: number; maxMs: number; inB: number; outB: number }>();
  private hours = new Map<number, [calls: number, errors: number]>();
  private chats = new Map<string, ChatStat>();
  private blocked = new Map<string, BlockedStat>();
  private workspaces = new Map<string, { calls: number; errors: number; slots: Map<number, number> }>();
  private statsListeners = new Set<(s: StatsSnapshot) => void>();
  private statsTimer: NodeJS.Timeout | undefined;
  private file: string | undefined;
  private saveTimer: NodeJS.Timeout | undefined;

  /** Keep the hourly totals in `file`: load them now, save them shortly after they change and on flush(). */
  persistTo(file: string) {
    this.file = file;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { hours?: [number, number, number][] };
      for (const [t, c, e] of data.hours ?? []) if (Number.isFinite(t) && Number.isFinite(c) && Number.isFinite(e)) this.hours.set(t, [c, e]);
    } catch {
      /* no saved history yet */
    }
  }

  /** Write the hourly totals now (called on shutdown). */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ hours: [...this.hours].map(([t, [c, e]]) => [t, c, e]) }));
    } catch {
      /* history is a nicety; never fail a call over it */
    }
  }

  /** Fold one finished tool call into the minute buckets, hourly totals, per-tool and per-chat totals. */
  private addStat(call: LastCall, ok: boolean, ms: number | undefined) {
    const tool = call.name;
    const now = Date.now();
    const t = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.t !== t) {
      b = { t, calls: 0, errors: 0, ms: 0, timed: 0, inB: 0, outB: 0, kinds: {}, lat: [] };
      this.buckets.push(b);
      if (this.buckets.length > BUCKET_COUNT) this.buckets.splice(0, this.buckets.length - BUCKET_COUNT);
    }
    const inB = call.inBytes ?? 0;
    const outB = call.outBytes ?? 0;
    b.calls++;
    b.inB += inB;
    b.outB += outB;
    if (!ok) {
      b.errors++;
      if (call.kind) b.kinds[call.kind] = (b.kinds[call.kind] ?? 0) + 1;
    }
    if (ms !== undefined) {
      b.ms += ms;
      b.timed++;
      // Reservoir sampling keeps the sample unbiased once a busy minute overflows the cap.
      if (b.lat.length < MAX_LATENCY_SAMPLES) b.lat.push(ms);
      else {
        const j = Math.floor(Math.random() * b.timed);
        if (j < MAX_LATENCY_SAMPLES) b.lat[j] = ms;
      }
    }
    let st = this.tools.get(tool);
    if (!st && this.tools.size < MAX_TOOLS) {
      st = { calls: 0, errors: 0, timed: 0, totalMs: 0, maxMs: 0, inB: 0, outB: 0 };
      this.tools.set(tool, st);
    }
    if (st) {
      st.calls++;
      st.inB += inB;
      st.outB += outB;
      if (!ok) st.errors++;
      if (ms !== undefined) {
        st.timed++;
        st.totalMs += ms;
        st.maxMs = Math.max(st.maxMs, ms);
      }
    }

    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const h = this.hours.get(hour) ?? [0, 0];
    h[0]++;
    if (!ok) h[1]++;
    this.hours.set(hour, h);
    if (this.hours.size > HOUR_COUNT) {
      for (const k of [...this.hours.keys()].sort((x, y) => x - y).slice(0, this.hours.size - HOUR_COUNT)) this.hours.delete(k);
    }
    if (this.file) this.saveTimer ??= setTimeout(() => this.flush(), 30_000).unref();

    if (call.workspace) {
      let ws = this.workspaces.get(call.workspace);
      if (!ws && this.workspaces.size < MAX_WORKSPACES) {
        ws = { calls: 0, errors: 0, slots: new Map() };
        this.workspaces.set(call.workspace, ws);
      }
      if (ws) {
        ws.calls++;
        if (!ok) ws.errors++;
        const slot = Math.floor(now / WS_SLOT_MS) * WS_SLOT_MS;
        ws.slots.set(slot, (ws.slots.get(slot) ?? 0) + 1);
        if (ws.slots.size > WS_SLOT_KEEP) ws.slots.delete(Math.min(...ws.slots.keys()));
      }
    }

    const chatKey = call.conversation ?? '';
    let chat = this.chats.get(chatKey);
    if (!chat) {
      if (this.chats.size >= MAX_CHATS) {
        const oldest = [...this.chats.values()].sort((x, y) => x.lastTs - y.lastTs)[0];
        if (oldest) this.chats.delete(oldest.id);
      }
      chat = { id: chatKey, client: call.client?.slice(0, 60), calls: 0, errors: 0, lastTs: now };
      this.chats.set(chatKey, chat);
    }
    chat.calls++;
    if (!ok) chat.errors++;
    chat.lastTs = now;

    if (!ok && call.kind === 'blocked') {
      let bl = this.blocked.get(tool);
      if (!bl && this.blocked.size >= MAX_BLOCKED) this.blocked.delete([...this.blocked.values()].sort((x, y) => x.ts - y.ts)[0]!.tool);
      bl ??= { tool, count: 0, ts: now, error: '' };
      bl.count++;
      bl.ts = now;
      bl.error = (call.error ?? '').slice(0, 200);
      this.blocked.set(tool, bl);
    }
    // Several calls can finish in a burst; push at most one update per second.
    this.statsTimer ??= setTimeout(() => {
      this.statsTimer = undefined;
      const snap = this.statsSnapshot();
      for (const l of this.statsListeners) l(snap);
    }, 1000).unref();
  }

  statsSnapshot(): StatsSnapshot {
    const tools: ToolStat[] = [...this.tools].map(([name, v]) => ({
      name,
      calls: v.calls,
      errors: v.errors,
      avgMs: v.timed ? v.totalMs / v.timed : 0,
      maxMs: v.maxMs,
      inB: v.inB,
      outB: v.outB,
    }));
    const hours = [...this.hours]
      .sort(([x], [y]) => x - y)
      .map(([t, [calls, errors]]) => ({ t, calls, errors }));
    const chats = [...this.chats.values()].sort((x, y) => y.lastTs - x.lastTs).slice(0, 8).map((c) => ({ ...c }));
    const blocked = [...this.blocked.values()].sort((x, y) => y.ts - x.ts).slice(0, 8).map((x) => ({ ...x }));
    // Spread each workspace's 10 minute slots over TREND_POINTS evenly sized steps between process start and now.
    const now = Date.now();
    const step = Math.max(WS_SLOT_MS, (now - STARTED) / TREND_POINTS);
    const first = now - step * TREND_POINTS;
    const workspaces = [...this.workspaces]
      .map(([alias, v]) => {
        const trend = new Array<number>(TREND_POINTS).fill(0);
        for (const [slot, n] of v.slots) {
          const i = Math.floor((slot + WS_SLOT_MS / 2 - first) / step);
          if (i >= 0) trend[Math.min(TREND_POINTS - 1, i)]! += n;
        }
        // A young process has fewer than TREND_POINTS slots of history: drop the leading empty ones.
        const used = Math.min(TREND_POINTS, Math.max(2, Math.ceil((now - STARTED) / step)));
        return { alias, calls: v.calls, errors: v.errors, trend: trend.slice(TREND_POINTS - used) };
      })
      .sort((a, b) => b.calls - a.calls);
    return {
      buckets: this.buckets.map((b) => ({ ...b, kinds: { ...b.kinds }, lat: [...b.lat] })),
      tools,
      hours,
      chats,
      blocked,
      workspaces,
      since: STARTED,
    };
  }

  subscribeStats(l: (s: StatsSnapshot) => void): () => void {
    this.statsListeners.add(l);
    return () => this.statsListeners.delete(l);
  }

  private emit() {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  /** Record every request in a (possibly batched) JSON-RPC body; notifications are ignored. Returns the new entries. */
  recordBody(body: unknown, source: CallSource = {}): LastCall[] {
    const made: LastCall[] = [];
    for (const msg of Array.isArray(body) ? body : [body]) {
      const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
      if (!m || typeof m.method !== 'string' || m.method.startsWith('notifications/')) continue;
      const isTool = m.method === 'tools/call' && typeof m.params?.name === 'string';
      const args = summarize(isTool ? m.params!.arguments : m.params);
      const call: LastCall = {
        id: this.nextId++,
        ts: Date.now(),
        name: (isTool ? (m.params!.name as string) : m.method).slice(0, 80),
        method: m.method,
        args: args.text,
        inBytes: args.bytes,
        conversation: source.conversation?.slice(0, 120),
        client: source.client?.slice(0, 160),
        status: isTool ? 'pending' : 'ok',
      };
      this.count++;
      this.last = call;
      made.push(call);
    }
    if (made.length) this.emit();
    return made;
  }

  /** Run `fn` so that tool bodies can find the entries recorded for this request. */
  track<T>(calls: LastCall[], fn: () => T): T {
    return pending.run(calls, fn);
  }

  /** Called by the tool runner when a tool finishes. */
  complete(
    tool: string,
    result: { ok: boolean; ms: number; workspace?: string; error?: string; accessError?: boolean; outBytes?: number },
  ) {
    const call = pending.getStore()?.find((c) => c.name === tool && c.status === 'pending');
    if (!call) return;
    call.status = result.ok ? 'ok' : 'error';
    call.ms = result.ms;
    call.workspace = result.workspace;
    call.error = result.error?.slice(0, 500);
    call.outBytes = result.outBytes;
    if (!result.ok) call.kind = classifyError(result.error, result.accessError ?? false);
    this.addStat(call, result.ok, result.ms);
    if (this.last?.id === call.id) this.emit();
  }

  /** The HTTP request ended: any call still pending never reached its tool (rejected or invalid arguments). */
  abandon(calls: LastCall[]) {
    for (const call of calls) {
      if (call.status !== 'pending') continue;
      call.status = 'error';
      call.error = 'The request ended before the tool ran (unknown tool or invalid arguments).';
      call.kind = 'invalid';
      if (call.method === 'tools/call') this.addStat(call, false, undefined);
      if (this.last?.id === call.id) this.emit();
    }
  }

  snapshot(): ActivitySnapshot {
    return { count: this.count, last: this.last ? { ...this.last } : undefined };
  }

  subscribe(l: (s: ActivitySnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const activity = new ActivityTracker();
