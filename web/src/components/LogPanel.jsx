import { memo, useLayoutEffect, useRef, useState } from 'react';
import { fmt } from '../util.js';

const LEVEL = {
  error: 'border-stop bg-stop/10 text-red-300 [:root[data-theme=light]_&]:text-stop',
  warn: 'border-warn bg-warn/10 text-amber-200 [:root[data-theme=light]_&]:text-warn',
  info: 'border-transparent text-white/85',
  debug: 'border-transparent text-mute',
};
const SRC = { launcher: 'text-[var(--chart-violet)]', server: 'text-route', tunnel: 'text-go' };

const CHIPS = [
  { value: 'error', label: 'Errors', on: 'peer-checked:bg-stop/20 peer-checked:text-stop' },
  { value: 'warn', label: 'Warnings', on: 'peer-checked:bg-warn/20 peer-checked:text-warn' },
  { value: 'info', label: 'Info', on: 'peer-checked:bg-route/20 peer-checked:text-route' },
  { value: 'debug', label: 'Debug', on: 'peer-checked:bg-white/15 peer-checked:text-white' },
];

const Row = memo(function Row({ e }) {
  return (
    <div className={`flex gap-2 whitespace-pre-wrap break-words rounded-sm border-l-[3px] px-2 py-px ${LEVEL[e.level]}`}>
      <span className="shrink-0 select-none text-mute">{fmt(e.ts)}</span>
      <span className={`hidden w-16 shrink-0 select-none font-semibold sm:inline ${SRC[e.source]}`}>{e.source}</span>
      <span className="min-w-0 flex-1">{e.text}</span>
    </div>
  );
});

const pill = 'rounded-full bg-raised px-3.5 py-1 text-xs font-medium hover:bg-hair focus-visible:outline-2 focus-visible:outline-route';

export default function LogPanel({ entries, onClear }) {
  const [levels, setLevels] = useState({ error: true, warn: true, info: true, debug: false });
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  // While paused the view shows a frozen copy; new lines keep arriving in `entries`.
  const [frozen, setFrozen] = useState(null);
  const logRef = useRef(null);

  const all = frozen ?? entries;
  const q = query.toLowerCase();
  const shown = all.filter((e) => levels[e.level] && (!source || source === e.source) && (!q || e.text.toLowerCase().includes(q)));

  useLayoutEffect(() => {
    if (follow) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [shown.length, follow, frozen]);

  return (
    <section className="glass flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] lg:min-h-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <label key={c.value} className="cursor-pointer">
              <input type="checkbox" className="peer sr-only" checked={levels[c.value]} onChange={(e) => setLevels({ ...levels, [c.value]: e.target.checked })} />
              <span className={`inline-block rounded-full bg-raised px-3 py-1 text-xs font-medium text-mute ${c.on} peer-focus-visible:outline-2 peer-focus-visible:outline-route`}>{c.label}</span>
            </label>
          ))}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded-full bg-raised px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-route">
          <option value="">All sources</option><option>launcher</option><option>server</option><option>tunnel</option>
        </select>
        <input type="search" placeholder="Filter log" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 basis-40 rounded-full bg-raised px-4 py-1 text-sm placeholder:text-mute focus-visible:outline-2 focus-visible:outline-route" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-mute">{shown.length} of {all.length} lines</span>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-mute">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="peer sr-only" />
            <span aria-hidden="true" className="relative h-5 w-9 rounded-full bg-hair transition-colors duration-200 peer-checked:bg-go peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-route after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:duration-200 after:content-[''] peer-checked:after:translate-x-4" />
            Follow
          </label>
          <button className={pill} onClick={() => setFrozen(frozen ? null : entries)}>{frozen ? 'Resume' : 'Pause'}</button>
          <button className={pill} onClick={onClear}>Clear</button>
        </div>
      </div>
      <main ref={logRef} className="min-h-0 flex-1 overflow-auto bg-well px-2 py-2 font-mono text-[14px] leading-relaxed sm:px-4">
        {shown.map((e) => <Row key={e._k} e={e} />)}
        {!shown.length && <div className="py-16 text-center text-sm text-mute">{all.length ? 'No lines match the filters.' : 'No log lines yet.'}</div>}
      </main>
    </section>
  );
}
