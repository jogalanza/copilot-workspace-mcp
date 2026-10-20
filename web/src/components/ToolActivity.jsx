import { fmtMs, useNow } from '../util.js';
import { CallBars, Spark } from './charts.jsx';

const WIN = 30;
const MIN = 60000;

/** The last WIN minutes, with empty buckets filled in. */
function windowBuckets(buckets, now) {
  const cur = Math.floor(now / MIN) * MIN;
  const map = new Map(buckets.map((b) => [b.t, b]));
  return Array.from({ length: WIN }, (_, i) => {
    const t = cur - (WIN - 1 - i) * MIN;
    return map.get(t) || { t, calls: 0, errors: 0, ms: 0, timed: 0 };
  });
}

const callsLabel = (t) => t.calls + (t.calls === 1 ? ' call' : ' calls');

/** Rows of: a name, a right-hand value, a bar scaled to `frac` (0..1) and a sub line. */
function ToolList({ items, empty, row }) {
  if (!items.length) return <div className="mt-2 flex flex-col gap-2"><div className="text-sm text-mute">{empty}</div></div>;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {items.map((t) => {
        const d = row(t);
        return (
          <div key={t.name} className="relative overflow-hidden rounded-xl bg-white/5 px-3 py-1.5">
            <i className={`absolute inset-y-0 left-0 ${d.barClass || 'bg-white/10'}`} style={{ width: Math.max(4, d.frac * 100) + '%' }} />
            <div className="relative flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{t.name}</span>
              <span className={`shrink-0 tabular-nums ${d.valueClass || ''}`}>{d.value}</span>
            </div>
            <div className="relative mt-0.5 text-xs text-mute">{d.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function ToolActivity({ stats }) {
  const now = useNow(20000);
  const w = windowBuckets(stats.buckets, now);
  let calls = 0, errs = 0, ms = 0, timed = 0, peak = 1;
  for (const b of w) {
    calls += b.calls; errs += b.errors; ms += b.ms; timed += b.timed;
    if (b.timed) peak = Math.max(peak, b.ms / b.timed);
  }
  const rate = calls ? ((calls - errs) / calls) * 100 : null;

  const active = stats.tools.filter((t) => t.calls > 0);
  const slowest = active.slice().sort((a, b) => b.avgMs - a.avgMs).slice(0, 4);
  const top = slowest.length ? Math.max(1, slowest[0].avgMs) : 1;
  const failing = active
    .filter((t) => t.errors > 0)
    .sort((a, b) => b.errors / b.calls - a.errors / a.calls || b.errors - a.errors)
    .slice(0, 4);

  return (
    <aside aria-label="Tool activity" className="glass flex min-h-0 flex-col gap-3.5 overflow-auto rounded-[28px] p-5 lg:w-[25rem] lg:shrink-0">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Tool activity</h2>
        <span className="text-xs text-mute">Last 30 minutes</span>
      </div>
      <section>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-mute">Calls per minute</span>
          <span className="text-sm font-medium tabular-nums">{calls + (calls === 1 ? ' call' : ' calls')}</span>
        </div>
        <CallBars window={w} />
        <div className="mt-1 flex justify-between text-[11px] text-mute"><span>30 min ago</span><span>now</span></div>
      </section>
      <div className="grid grid-cols-2 gap-3">
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Success rate</div>
          <div className={`text-xl font-light tabular-nums ${rate === null || rate >= 95 ? '' : rate >= 80 ? 'text-warn' : 'text-stop'}`}>
            {rate === null ? '-' : (rate === 100 ? '100' : rate.toFixed(1)) + '%'}
          </div>
          <Spark values={w.map((b) => (b.calls ? ((b.calls - b.errors) / b.calls) * 100 : null))} lo={0} hi={100} color={rate !== null && rate < 95 ? '#f5a623' : '#1fd96b'} />
        </section>
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Average time</div>
          <div className="text-xl font-light tabular-nums">{timed ? fmtMs(ms / timed) : '-'}</div>
          <Spark values={w.map((b) => (b.timed ? b.ms / b.timed : null))} lo={0} hi={peak} color="#2aa7ff" />
        </section>
      </div>
      <section className="min-h-0">
        <div className="text-sm text-mute">Slowest tools</div>
        <ToolList
          items={slowest}
          empty="No tool calls yet. Charts fill in as Copilot uses tools."
          row={(t) => ({ frac: t.avgMs / top, value: fmtMs(t.avgMs), sub: 'max ' + fmtMs(t.maxMs) + ' · ' + callsLabel(t) + (t.errors ? ' · ' + t.errors + ' failed' : '') })}
        />
      </section>
      <section className="min-h-0">
        <div className="text-sm text-mute">Failing most</div>
        <ToolList
          items={failing}
          empty={active.length ? 'No failures. Nice.' : 'No tool calls yet.'}
          row={(t) => {
            const r = t.errors / t.calls;
            return { frac: r, barClass: 'bg-stop/25', valueClass: r >= 0.2 ? 'text-stop' : 'text-warn', value: Math.round(r * 100) + '%', sub: t.errors + ' of ' + callsLabel(t) + ' failed' };
          }}
        />
      </section>
    </aside>
  );
}
