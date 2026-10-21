import { useEffect, useRef } from 'react';
import { ago, fmt, useNow } from '../util.js';

// Full class strings so Tailwind's scanner sees them. The orb takes its colour from the latest call's status.
const ORB_COLOR = { idle: 'text-route', ok: 'text-go', error: 'text-stop', pending: 'text-route' };
const RIPPLE_HEX = { ok: 'var(--color-go)', error: 'var(--color-stop)', pending: 'var(--color-route)' };

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
      className="glass group relative flex min-h-72 items-center justify-center overflow-hidden rounded-[28px] p-5 text-center focus-visible:outline-2 focus-visible:outline-route lg:col-span-4"
    >
      <div aria-hidden="true" className={`orb pointer-events-none ${ORB_COLOR[hot ? l.status : 'idle']} ${hot ? 'orb-hot' : ''}`}>
        <i className="orb-aura" />
        <i className="orb-ring" />
        <i className="orb-ring orb-ring-2" />
        <i className="orb-core" />
        <i className="orb-spark" />
        <i className="orb-spark orb-spark-2" />
        <i className="orb-spark orb-spark-3" />
        {l && <i key={l.id} className="orb-flash" />}
      </div>
      {ripples.map((r) => <Ripple key={r.id} status={r.status} onDone={() => onRippleDone(r.id)} />)}
      <div className="relative">
        <div key={activity.count} className="orb-count text-7xl font-extralight leading-none tracking-tighter tabular-nums">{activity.count}</div>
        <div className="mt-2 text-base text-mute">MCP calls</div>
        <div className="mt-3 max-w-40 truncate text-sm font-medium">{l ? l.name : 'Waiting for the first call'}</div>
        <div className="mt-0.5 text-xs text-mute">{l ? fmt(l.ts) + ' · ' + ago(l.ts, now) + (l.status === 'error' ? ' · failed' : '') : ''}</div>
      </div>
    </button>
  );
}
