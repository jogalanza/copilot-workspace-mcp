// Process-wide record of MCP requests, pushed to the launcher's web UI so it shows the server is alive.
// A module singleton on purpose: the MCP server is restarted in-process on config changes, the count should survive that.
// Only the counter and the single latest call (with details) are kept; there is no history.
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_ARGS_CHARS = 4000;
const BUCKET_MS = 60_000;
const BUCKET_COUNT = 60; // keep an hour of per-minute totals
const MAX_TOOLS = 100;

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
}
export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
}
export interface StatsSnapshot {
  buckets: Bucket[];
  tools: ToolStat[];
}
export interface CallSource {
  conversation?: string;
  client?: string;
}

/** Calls recorded for the HTTP request being handled, so a tool can report its outcome against the right entry. */
const pending = new AsyncLocalStorage<LastCall[]>();

function summarize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const s = JSON.stringify(value, null, 2) ?? '';
  return s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}\n[truncated: ${s.length} chars]` : s;
}

class ActivityTracker {
  private count = 0;
  private nextId = 1;
  private last: LastCall | undefined;
  private listeners = new Set<(s: ActivitySnapshot) => void>();
  private buckets: Bucket[] = [];
  private tools = new Map<string, { calls: number; errors: number; timed: number; totalMs: number; maxMs: number }>();
  private statsListeners = new Set<(s: StatsSnapshot) => void>();
  private statsTimer: NodeJS.Timeout | undefined;

  /** Fold one finished tool call into the minute buckets and the per-tool totals. */
  private addStat(tool: string, ok: boolean, ms: number | undefined) {
    const t = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.t !== t) {
      b = { t, calls: 0, errors: 0, ms: 0, timed: 0 };
      this.buckets.push(b);
      if (this.buckets.length > BUCKET_COUNT) this.buckets.splice(0, this.buckets.length - BUCKET_COUNT);
    }
    b.calls++;
    if (!ok) b.errors++;
    if (ms !== undefined) {
      b.ms += ms;
      b.timed++;
    }
    let st = this.tools.get(tool);
    if (!st && this.tools.size < MAX_TOOLS) {
      st = { calls: 0, errors: 0, timed: 0, totalMs: 0, maxMs: 0 };
      this.tools.set(tool, st);
    }
    if (st) {
      st.calls++;
      if (!ok) st.errors++;
      if (ms !== undefined) {
        st.timed++;
        st.totalMs += ms;
        st.maxMs = Math.max(st.maxMs, ms);
      }
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
    }));
    return { buckets: this.buckets.map((b) => ({ ...b })), tools };
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
      const call: LastCall = {
        id: this.nextId++,
        ts: Date.now(),
        name: (isTool ? (m.params!.name as string) : m.method).slice(0, 80),
        method: m.method,
        args: summarize(isTool ? m.params!.arguments : m.params),
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
  complete(tool: string, result: { ok: boolean; ms: number; workspace?: string; error?: string }) {
    const call = pending.getStore()?.find((c) => c.name === tool && c.status === 'pending');
    if (!call) return;
    call.status = result.ok ? 'ok' : 'error';
    call.ms = result.ms;
    call.workspace = result.workspace;
    call.error = result.error?.slice(0, 500);
    this.addStat(tool, result.ok, result.ms);
    if (this.last?.id === call.id) this.emit();
  }

  /** The HTTP request ended: any call still pending never reached its tool (rejected or invalid arguments). */
  abandon(calls: LastCall[]) {
    for (const call of calls) {
      if (call.status !== 'pending') continue;
      call.status = 'error';
      call.error = 'The request ended before the tool ran (unknown tool or invalid arguments).';
      if (call.method === 'tools/call') this.addStat(call.name, false, undefined);
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
