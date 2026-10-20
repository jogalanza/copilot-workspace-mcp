import { ago, fmtBytes, fmtMs, upTime } from '../util.js';
import { Spark } from './charts.jsx';

const callsLabel = (t) => t.calls + (t.calls === 1 ? ' call' : ' calls');

/** Rows of: a name, a right-hand value, a bar scaled to `frac` (0..1) and a sub line. */
export function ToolList({ items, empty, row }) {
  if (!items.length) return <div className="mt-2 flex flex-col gap-2"><div className="text-sm text-mute">{empty}</div></div>;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {items.map((t) => {
        const d = row(t);
        return (
          <div key={t.name} className="relative overflow-hidden rounded-xl bg-white/5 px-3 py-1.5">
            <i className={`absolute inset-y-0 left-0 ${d.barClass || 'bg-white/10'}`} style={{ width: Math.max(4, d.frac * 100) + '%' }} />
            <div className="relative flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{d.label || t.name}</span>
              <span className={`shrink-0 tabular-nums ${d.valueClass || ''}`}>{d.value}</span>
            </div>
            <div className="relative mt-0.5 truncate text-xs text-mute">{d.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, children, note }) {
  return (
    <section className="shrink-0">
      <div className="flex items-baseline justify-between">
        <div className="text-sm text-mute">{title}</div>
        {note && <div className="text-[11px] text-mute">{note}</div>}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, sub, valueClass = '' }) {
  return (
    <section className="rounded-2xl bg-white/5 px-3 py-2.5">
      <div className="text-xs text-mute">{label}</div>
      <div className={`text-xl font-light tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-0.5 truncate text-xs text-mute">{sub}</div>
    </section>
  );
}

// ---- tool categories -------------------------------------------------------------------------

export const CATEGORIES = [
  { id: 'files', label: 'Files', color: '#2aa7ff', match: (n) => n === 'list_files' || n.startsWith('ws_') || n === 'notebook_edit' },
  { id: 'git', label: 'Git', color: '#f5a623', match: (n) => n.startsWith('git_') },
  { id: 'browser', label: 'Browser', color: '#a78bfa', match: (n) => n.startsWith('browser_') },
  { id: 'commands', label: 'Commands', color: '#1fd96b', match: (n) => n === 'run_command' || n.startsWith('process_') || n === 'list_processes' },
  { id: 'web', label: 'Web & API', color: '#22d3ee', match: (n) => n === 'curl' || n.startsWith('web_') },
  { id: 'workspace', label: 'Workspace', color: '#8e8e93', match: () => true },
];
export const categoryOf = (name) => CATEGORIES.find((c) => c.match(name));

// ---- Tools tab -------------------------------------------------------------------------------

export function ToolsTab({ tools }) {
  const active = tools.filter((t) => t.calls > 0);
  const used = active.slice().sort((a, b) => b.calls - a.calls).slice(0, 5);
  const usedTop = used.length ? used[0].calls : 1;
  const slowest = active.slice().sort((a, b) => b.avgMs - a.avgMs).slice(0, 4);
  const slowTop = slowest.length ? Math.max(1, slowest[0].avgMs) : 1;
  const failing = active
    .filter((t) => t.errors > 0)
    .sort((a, b) => b.errors / b.calls - a.errors / a.calls || b.errors - a.errors)
    .slice(0, 4);

  const total = active.reduce((n, t) => n + t.calls, 0);
  const byCat = CATEGORIES.map((c) => ({ ...c, calls: active.filter((t) => categoryOf(t.name) === c).reduce((n, t) => n + t.calls, 0) })).filter((c) => c.calls);

  return (
    <>
      <Section title="Most used" note="this session">
        <ToolList
          items={used}
          empty="No tool calls yet. Charts fill in as Copilot uses tools."
          row={(t) => ({
            frac: t.calls / usedTop,
            value: callsLabel(t),
            sub: 'avg ' + fmtBytes(t.outB / t.calls) + ' returned' + (t.errors ? ' · ' + t.errors + ' failed' : ''),
          })}
        />
      </Section>
      <Section title="By category" note="share of calls">
        {total ? (
          <>
            <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-white/5" role="img" aria-label={byCat.map((c) => c.label + ' ' + Math.round((c.calls / total) * 100) + '%').join(', ')}>
              {byCat.map((c) => <i key={c.id} style={{ width: (c.calls / total) * 100 + '%', background: c.color }} title={c.label + ': ' + callsLabel(c)} />)}
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {byCat.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5"><i className="size-2 shrink-0 rounded-full" style={{ background: c.color }} /><span className="truncate">{c.label}</span></span>
                  <span className="tabular-nums text-mute">{Math.round((c.calls / total) * 100)}%</span>
                </li>
              ))}
            </ul>
          </>
        ) : <div className="mt-2 text-sm text-mute">No tool calls yet.</div>}
      </Section>
      <Section title="Slowest tools" note="this session">
        <ToolList
          items={slowest}
          empty="No tool calls yet."
          row={(t) => ({ frac: t.avgMs / slowTop, value: fmtMs(t.avgMs), sub: 'max ' + fmtMs(t.maxMs) + ' · ' + callsLabel(t) + (t.errors ? ' · ' + t.errors + ' failed' : '') })}
        />
      </Section>
      <Section title="Failing most" note="this session">
        <ToolList
          items={failing}
          empty={active.length ? 'No failures. Nice.' : 'No tool calls yet.'}
          row={(t) => {
            const r = t.errors / t.calls;
            return { frac: r, barClass: 'bg-stop/25', valueClass: r >= 0.2 ? 'text-stop' : 'text-warn', value: Math.round(r * 100) + '%', sub: t.errors + ' of ' + callsLabel(t) + ' failed' };
          }}
        />
      </Section>
    </>
  );
}

// ---- Issues tab ------------------------------------------------------------------------------

const KINDS = {
  blocked: { label: 'Blocked by policy', hint: 'path, host or command not allowed', bar: 'bg-warn/25', text: 'text-warn' },
  timeout: { label: 'Timed out', hint: 'hit a time limit', bar: 'bg-warn/25', text: 'text-warn' },
  invalid: { label: 'Invalid request', hint: 'unknown tool or bad arguments', bar: 'bg-stop/25', text: 'text-stop' },
  rejected: { label: 'Rejected input', hint: 'tool refused the request', bar: 'bg-stop/25', text: 'text-stop' },
  failed: { label: 'Tool failed', hint: 'error inside the tool', bar: 'bg-stop/25', text: 'text-stop' },
};

export function IssuesTab({ window: w, blocked, now }) {
  const counts = {};
  for (const b of w) for (const [k, n] of Object.entries(b.kinds || {})) counts[k] = (counts[k] || 0) + n;
  const causes = Object.keys(KINDS).filter((k) => counts[k]).map((k) => ({ name: k, n: counts[k] })).sort((a, b) => b.n - a.n);
  const totalErrs = causes.reduce((n, c) => n + c.n, 0);
  return (
    <>
      <Section title="Error causes" note="last 30 minutes">
        <ToolList
          items={causes}
          empty="No errors in the last 30 minutes."
          row={(c) => {
            const k = KINDS[c.name];
            return { label: k.label, frac: c.n / totalErrs, barClass: k.bar, valueClass: k.text, value: c.n + (c.n === 1 ? ' error' : ' errors'), sub: Math.round((c.n / totalErrs) * 100) + '% · ' + k.hint };
          }}
        />
      </Section>
      <Section title="Blocked by policy" note="this session">
        <ToolList
          items={blocked.map((b) => ({ ...b, name: b.tool }))}
          empty="Nothing was blocked."
          row={(b) => ({ frac: 1, barClass: 'bg-warn/15', valueClass: 'text-warn', value: b.count + '×', sub: ago(b.ts, now) + ' · ' + b.error })}
        />
      </Section>
    </>
  );
}

// ---- Usage tab -------------------------------------------------------------------------------

/** "Copilot Studio", "node", ... from a user agent or client label. */
function clientName(c) {
  if (!c) return 'unknown client';
  if (c === 'copilot-studio' || c === 'http' || c === 'stdio') return c;
  return c.split(/[\s/]/)[0] || c;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Heatmap({ hours, now }) {
  const byT = new Map(hours.map((h) => [h.t, h]));
  const today = new Date(now);
  let max = 0, best = null;
  const rows = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i));
    const cells = Array.from({ length: 24 }, (_, h) => {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
      const b = byT.get(t);
      const calls = b ? b.calls : 0;
      if (calls > max) { max = calls; best = { day, h, calls }; }
      return { h, t, calls, errors: b ? b.errors : 0, future: t > now };
    });
    return { day, cells };
  });
  return (
    <>
      <div className="mt-2 flex flex-col gap-[3px]" role="img" aria-label={best ? `Busiest hour: ${DAY[best.day.getDay()]} ${best.h}:00 with ${best.calls} calls` : 'No history yet'}>
        {rows.map(({ day, cells }) => (
          <div key={day.getTime()} className="flex items-center gap-1.5">
            <span className="w-7 shrink-0 text-[11px] text-mute">{DAY[day.getDay()]}</span>
            <div className="grid min-w-0 flex-1 grid-cols-24 gap-[2px]">
              {cells.map((c) => (
                <i
                  key={c.t}
                  className="aspect-square rounded-[3px]"
                  title={`${DAY[day.getDay()]} ${String(c.h).padStart(2, '0')}:00 · ${c.calls} ${c.calls === 1 ? 'call' : 'calls'}${c.errors ? ', ' + c.errors + ' failed' : ''}`}
                  style={{ background: c.calls ? `rgb(42 167 255 / ${0.18 + 0.82 * (c.calls / max)})` : 'rgb(255 255 255 / ' + (c.future ? 0.02 : 0.06) + ')' }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-1.5">
          <span className="w-7 shrink-0" />
          <div className="flex flex-1 justify-between text-[11px] text-mute"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
        </div>
      </div>
      <div className="mt-1.5 text-xs text-mute">{best ? `Busiest: ${DAY[best.day.getDay()]} ${String(best.h).padStart(2, '0')}:00 · ${best.calls} ${best.calls === 1 ? 'call' : 'calls'}` : 'Fills in as calls are made.'}</div>
    </>
  );
}

/** One row per workspace: calls since start, share of all workspace calls, and a trend line with the change over the period. */
function WorkspaceTrends({ items }) {
  if (!items.length) return <div className="mt-2 text-sm text-mute">No workspace calls yet.</div>;
  const total = items.reduce((n, w) => n + w.calls, 0);
  return (
    <div className="mt-2 flex flex-col gap-2">
      {items.map((w) => {
        const half = Math.floor(w.trend.length / 2);
        const before = w.trend.slice(0, half).reduce((n, v) => n + v, 0);
        const after = w.trend.slice(half).reduce((n, v) => n + v, 0);
        // Compare the recent half of the period with the earlier half.
        const delta = before === 0 ? (after > 0 ? null : 0) : Math.round(((after - before) / before) * 100);
        const label = delta === null ? 'new' : delta === 0 ? 'steady' : (delta > 0 ? '↑ ' : '↓ ') + Math.abs(delta) + '%';
        return (
          <div key={w.alias} className="rounded-xl bg-white/5 px-3 py-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{w.alias}</span>
              <span className="shrink-0 tabular-nums">{callsLabel(w)}</span>
            </div>
            <Spark values={w.trend} lo={0} hi={Math.max(1, ...w.trend)} color="#2aa7ff" />
            <div className="flex justify-between text-xs text-mute">
              <span>{Math.round((w.calls / total) * 100)}% of workspace calls{w.errors ? ' · ' + w.errors + ' failed' : ''}</span>
              <span className={delta === null || delta > 0 ? 'text-go' : ''}>{label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function pctClass(p) {
  return p === undefined || p >= 99 ? '' : p >= 90 ? 'text-warn' : 'text-stop';
}

export function UsageTab({ stats, state, now }) {
  const chats = stats.chats || [];
  const top = chats.length ? Math.max(1, ...chats.map((c) => c.calls)) : 1;
  const stateLabel = state ? state.tunnel : null;
  const since = state?.tunnelSince ? upTime((now - state.tunnelSince) / 1000) : null;
  return (
    <>
      <Section title="Chats and clients" note="this session">
        <ToolList
          items={chats.map((c) => ({ ...c, name: c.id || '(no chat id)' }))}
          empty="No calls yet."
          row={(c) => ({
            label: c.id ? '…' + c.id.slice(-10) : 'No chat id',
            frac: c.calls / top,
            value: callsLabel(c),
            sub: clientName(c.client) + ' · ' + ago(c.lastTs, now) + (c.errors ? ' · ' + c.errors + ' failed' : ''),
          })}
        />
      </Section>
      <Section title="Workspace trend" note={'since start · ' + upTime((now - (stats.since || now)) / 1000)}>
        <WorkspaceTrends items={stats.workspaces || []} />
      </Section>
      <Section title="Busiest hours" note="last 7 days">
        <Heatmap hours={stats.hours || []} now={now} />
      </Section>
      <Section title="Tunnel health" note={stateLabel ? stateLabel + (since ? ' for ' + since : '') : ''}>
        {state && state.tunnel !== 'disabled' ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Tile label="Uptime" value={state.tunnelUptimePct === undefined ? '-' : (state.tunnelUptimePct >= 99.95 ? '100' : state.tunnelUptimePct.toFixed(1)) + '%'} valueClass={pctClass(state.tunnelUptimePct)} sub="since start" />
            <Tile label="Restarts" value={state.tunnelRestarts ?? 0} valueClass={state.tunnelRestarts ? 'text-warn' : ''} sub="this session" />
            <Tile label="Last restart" value={state.tunnelLastRestart ? ago(state.tunnelLastRestart, now).replace(' ago', '') : 'none'} sub={state.tunnelLastRestart ? 'ago' : 'so far'} />
          </div>
        ) : <div className="mt-2 text-sm text-mute">{state ? 'The tunnel is off.' : 'Connecting...'}</div>}
      </Section>
    </>
  );
}

export { Tile, Section };
