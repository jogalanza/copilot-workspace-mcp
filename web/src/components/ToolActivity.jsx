import { useState } from 'react';
import { fmtBytes, fmtMs, percentile, useNow } from '../util.js';
import { CallBars, Spark } from './charts.jsx';
import { IssuesTab, Section, Tile, ToolsTab, UsageTab } from './analytics.jsx';

const WIN = 30;
const MIN = 60000;
const TABS = ['Overview', 'Tools', 'Issues', 'Usage'];

/** The last WIN minutes, with empty buckets filled in. */
function windowBuckets(buckets, now) {
  const cur = Math.floor(now / MIN) * MIN;
  const map = new Map(buckets.map((b) => [b.t, b]));
  return Array.from({ length: WIN }, (_, i) => {
    const t = cur - (WIN - 1 - i) * MIN;
    return map.get(t) || { t, calls: 0, errors: 0, ms: 0, timed: 0, inB: 0, outB: 0, kinds: {}, lat: [] };
  });
}

function Overview({ w }) {
  let calls = 0, errs = 0, ms = 0, timed = 0, peak = 1, inB = 0, outB = 0, maxMs = 0;
  const lat = [];
  for (const b of w) {
    calls += b.calls; errs += b.errors; ms += b.ms; timed += b.timed; inB += b.inB || 0; outB += b.outB || 0;
    if (b.timed) peak = Math.max(peak, b.ms / b.timed);
    for (const v of b.lat || []) { lat.push(v); maxMs = Math.max(maxMs, v); }
  }
  const rate = calls ? ((calls - errs) / calls) * 100 : null;
  const p50 = percentile(lat, 50);
  const p95 = percentile(lat, 95);
  const p95s = w.map((b) => percentile(b.lat || [], 95));
  const p95Peak = Math.max(1, ...p95s.filter((v) => v !== null));
  const outPeak = Math.max(1, ...w.map((b) => b.outB || 0));
  return (
    <>
      <Section title="Calls per minute" note={calls + (calls === 1 ? ' call' : ' calls')}>
        <CallBars window={w} />
        <div className="mt-1 flex justify-between text-[11px] text-mute"><span>30 min ago</span><span>now</span></div>
      </Section>
      <div className="grid shrink-0 grid-cols-2 gap-3">
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
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Slow calls (p95)</div>
          <div className="text-xl font-light tabular-nums">{p95 === null ? '-' : fmtMs(p95)}</div>
          <div className="truncate text-xs text-mute">{p50 === null ? 'no timed calls' : 'median ' + fmtMs(p50) + ' · max ' + fmtMs(maxMs)}</div>
          <Spark values={p95s} lo={0} hi={p95Peak} color="#a78bfa" />
        </section>
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Data returned</div>
          <div className="text-xl font-light tabular-nums">{fmtBytes(outB)}</div>
          <div className="truncate text-xs text-mute">{fmtBytes(inB) + ' received in requests'}</div>
          <Spark values={w.map((b) => (b.calls ? b.outB || 0 : null))} lo={0} hi={outPeak} color="#22d3ee" />
        </section>
      </div>
    </>
  );
}

export default function ToolActivity({ stats, state }) {
  const now = useNow(20000);
  const [tab, setTab] = useState(0);
  const w = windowBuckets(stats.buckets, now);
  return (
    <aside aria-label="Tool activity" className="glass flex min-h-0 flex-col gap-3.5 overflow-auto rounded-[28px] p-5 lg:w-[25rem] lg:shrink-0">
      <div className="flex shrink-0 items-baseline justify-between">
        <h2 className="text-base font-medium">Tool activity</h2>
        <span className="text-xs text-mute">{tab === 3 ? 'Sessions and history' : 'Last 30 minutes'}</span>
      </div>
      <div role="tablist" aria-label="Analytics" className="flex shrink-0 gap-1 rounded-full bg-white/5 p-1">
        {TABS.map((name, i) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === i}
            onClick={() => setTab(i)}
            className={`flex-1 rounded-full px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-route ${tab === i ? 'bg-hair text-white' : 'text-mute hover:text-white'}`}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === 0 && <Overview w={w} />}
      {tab === 1 && <ToolsTab tools={stats.tools} />}
      {tab === 2 && <IssuesTab window={w} blocked={stats.blocked || []} now={now} />}
      {tab === 3 && <UsageTab stats={stats} state={state} now={now} />}
    </aside>
  );
}
