import { fmtMs, useNow, windowBuckets } from '../util.js';
import { CallBars, Spark } from './charts.jsx';

/** One compact figure with a sparkline. */
function Kpi({ label, value, sub, valueClass = '', children }) {
  return (
    <section className="glass flex min-h-0 flex-1 flex-col justify-center rounded-[22px] px-4 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-mute">{label}</span>
        <span className="truncate text-[11px] text-mute">{sub}</span>
      </div>
      <div className={`text-2xl font-light leading-tight tabular-nums ${valueClass}`}>{value}</div>
      {children}
    </section>
  );
}

/** Calls per minute, success rate and average time over the last 30 minutes, stacked beside the call counter. */
export default function KpiStack({ buckets }) {
  const now = useNow(20000);
  const w = windowBuckets(buckets, now);
  let calls = 0, errs = 0, ms = 0, timed = 0, peakMs = 1;
  for (const b of w) {
    calls += b.calls; errs += b.errors; ms += b.ms; timed += b.timed;
    if (b.timed) peakMs = Math.max(peakMs, b.ms / b.timed);
  }
  const recent = w.slice(-5).reduce((n, b) => n + b.calls, 0) / 5; // smooth: a one-minute rate jumps around
  const rate = calls ? ((calls - errs) / calls) * 100 : null;
  const rateColor = rate !== null && rate < 95 ? 'var(--color-warn)' : 'var(--color-go)';
  return (
    <div className="flex min-h-72 flex-col gap-3 lg:col-span-3">
      <Kpi label="Calls per minute" value={recent ? (recent < 10 ? recent.toFixed(1) : Math.round(recent)) : '0'} sub={calls + (calls === 1 ? ' call' : ' calls') + ' · 30 min'}>
        <CallBars window={w} className="h-9" />
      </Kpi>
      <Kpi
        label="Success rate"
        value={rate === null ? '-' : (rate === 100 ? '100' : rate.toFixed(1)) + '%'}
        valueClass={rate === null || rate >= 95 ? '' : rate >= 80 ? 'text-warn' : 'text-stop'}
        sub={errs ? errs + ' failed' : 'no failures'}
      >
        <Spark values={w.map((b) => (b.calls ? ((b.calls - b.errors) / b.calls) * 100 : null))} lo={0} hi={100} color={rateColor} />
      </Kpi>
      <Kpi label="Average time" value={timed ? fmtMs(ms / timed) : '-'} sub="per call">
        <Spark values={w.map((b) => (b.timed ? b.ms / b.timed : null))} lo={0} hi={peakMs} color="var(--color-route)" />
      </Kpi>
    </div>
  );
}
