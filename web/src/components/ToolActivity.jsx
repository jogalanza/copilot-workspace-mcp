import { useState } from 'react';
import { fmtBytes, fmtMs, percentile, useNow, windowBuckets } from '../util.js';
import { Spark } from './charts.jsx';
import { IssuesTab, ToolsTab, TunnelHealth, UsageTab } from './analytics.jsx';

const TABS = ['Overview', 'Tools', 'Issues', 'Usage'];

function Overview({ w, state, now }) {
  let inB = 0, outB = 0, maxMs = 0;
  const lat = [];
  for (const b of w) {
    inB += b.inB || 0; outB += b.outB || 0;
    for (const v of b.lat || []) { lat.push(v); maxMs = Math.max(maxMs, v); }
  }
  const p50 = percentile(lat, 50);
  const p95 = percentile(lat, 95);
  const p95s = w.map((b) => percentile(b.lat || [], 95));
  const p95Peak = Math.max(1, ...p95s.filter((v) => v !== null));
  const outPeak = Math.max(1, ...w.map((b) => b.outB || 0));
  return (
    <>
      <div className="grid shrink-0 grid-cols-2 gap-3">
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Slow calls (p95)</div>
          <div className="text-xl font-light tabular-nums">{p95 === null ? '-' : fmtMs(p95)}</div>
          <div className="truncate text-xs text-mute">{p50 === null ? 'no timed calls' : 'median ' + fmtMs(p50) + ' · max ' + fmtMs(maxMs)}</div>
          <Spark values={p95s} lo={0} hi={p95Peak} color="var(--chart-violet)" />
        </section>
        <section className="rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="text-xs text-mute">Data returned</div>
          <div className="text-xl font-light tabular-nums">{fmtBytes(outB)}</div>
          <div className="truncate text-xs text-mute">{fmtBytes(inB) + ' received in requests'}</div>
          <Spark values={w.map((b) => (b.calls ? b.outB || 0 : null))} lo={0} hi={outPeak} color="var(--chart-cyan)" />
        </section>
      </div>
      <TunnelHealth state={state} now={now} />
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
      {tab === 0 && <Overview w={w} state={state} now={now} />}
      {tab === 1 && <ToolsTab tools={stats.tools} />}
      {tab === 2 && <IssuesTab window={w} blocked={stats.blocked || []} now={now} />}
      {tab === 3 && <UsageTab stats={stats} state={state} now={now} />}
    </aside>
  );
}
