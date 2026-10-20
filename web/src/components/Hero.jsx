import { useEffect, useRef } from 'react';
import { ago, fmt, useNow } from '../util.js';

// Lookup maps of full class strings so Tailwind's scanner can see them.
const RING_COLOR = { idle: 'text-nebula/50', ok: 'text-go', error: 'text-stop', pending: 'text-route' };
const GLOW_COLOR = { idle: 'text-nebula', ok: 'text-go', error: 'text-stop', pending: 'text-route' };
const RIPPLE_HEX = { ok: '#1fd96b', error: '#e31937', pending: '#2aa7ff' };

/** One expanding ring per new call: motion that answers an event, skipped for reduced-motion users. */
function Ripple({ status, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return onDone();
    const a = ref.current.animate(
      [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 0.55 }, { transform: 'translate(-50%,-50%) scale(1.7)', opacity: 0 }],
      { duration: 1500, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
    a.onfinish = onDone;
    return () => a.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <i
      ref={ref}
      className="pointer-events-none absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
      style={{ borderColor: RIPPLE_HEX[status] || RIPPLE_HEX.ok }}
    />
  );
}

export default function Hero({ activity, ripples, onRippleDone, onOpen }) {
  const now = useNow(500);
  const l = activity.last;
  // The arcs glow in the call's status colour for a moment, then settle.
  const hot = l && (l.status === 'pending' || now - l.ts < 2500);
  return (
    <button
      type="button"
      aria-label="Show details of the latest MCP call"
      onClick={onOpen}
      className="glass group relative flex min-h-72 items-center justify-center overflow-hidden rounded-[28px] p-5 text-center focus-visible:outline-2 focus-visible:outline-route lg:col-span-7"
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 size-[30rem] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,currentColor,transparent)] transition-[opacity,color] duration-1000 motion-reduce:transition-none ${hot ? GLOW_COLOR[l.status] + ' opacity-30' : GLOW_COLOR.idle + ' opacity-10'}`}
      />
      <svg
        viewBox="0 0 220 220" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 drop-shadow-[0_0_6px_currentColor] transition-colors duration-700 motion-reduce:transition-none ${RING_COLOR[hot ? l.status : 'idle']}`}
      >
        <circle cx="110" cy="110" r="100" strokeWidth="1.5" style={{ opacity: 0.3 }} />
        <path d="M156.9 21.7A100 100 0 0 1 204.0 75.8" /><path d="M204.0 144.2A100 100 0 0 1 156.9 198.3" /><path d="M63.1 198.3A100 100 0 0 1 16.0 144.2" /><path d="M16.0 75.8A100 100 0 0 1 63.1 21.7" />
      </svg>
      {ripples.map((r) => <Ripple key={r.id} status={r.status} onDone={() => onRippleDone(r.id)} />)}
      <div className="relative">
        <div className="text-7xl font-extralight leading-none tracking-tighter tabular-nums">{activity.count}</div>
        <div className="mt-2 text-base text-mute">MCP calls</div>
        <div className="mt-3 max-w-40 truncate text-sm font-medium">{l ? l.name : 'Waiting for the first call'}</div>
        <div className="mt-0.5 text-xs text-mute">{l ? fmt(l.ts) + ' · ' + ago(l.ts, now) + (l.status === 'error' ? ' · failed' : '') : ''}</div>
      </div>
    </button>
  );
}
