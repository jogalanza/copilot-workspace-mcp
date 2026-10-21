// Hand-written SVG charts (no chart library). Only numbers are interpolated into the geometry.

/** Calls per minute: one bar per minute, errors stacked in red on top. `window` is the 30 minute buckets. */
export function CallBars({ window: w, className = 'h-16' }) {
  const max = Math.max(1, ...w.map((b) => b.calls));
  return (
    <svg viewBox="0 0 300 72" preserveAspectRatio="none" className={`mt-1.5 w-full ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="gbar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".95" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".4" />
        </linearGradient>
      </defs>
      {w.map((b, i) => {
        const x = i * 10 + 1;
        if (!b.calls) return <rect key={b.t} x={x} y="68" width="8" height="2" rx="1" fill="currentColor" fillOpacity=".12" />;
        const ok = b.calls - b.errors;
        const okH = ok ? Math.max(2, (ok / max) * 64) : 0;
        const erH = b.errors ? Math.max(2, (b.errors / max) * 64) : 0;
        return (
          <g key={b.t}>
            {okH > 0 && <rect x={x} y={70 - okH} width="8" height={okH} rx="2" fill="url(#gbar)" />}
            {erH > 0 && <rect x={x} y={70 - okH - erH} width="8" height={erH} rx="2" fill="var(--color-stop)" />}
          </g>
        );
      })}
    </svg>
  );
}

/** A small line chart; `null` values leave gaps. The last point gets a dot. */
export function Spark({ values, lo, hi, color }) {
  const span = hi - lo || 1;
  let d = '', gap = true, last = null;
  values.forEach((v, i) => {
    if (v === null) { gap = true; return; }
    const x = ((i / (values.length - 1)) * 138 + 1).toFixed(1);
    const y = (33 - ((v - lo) / span) * 30).toFixed(1);
    d += (gap ? 'M' : 'L') + x + ' ' + y;
    gap = false;
    last = [x, y];
  });
  // The line is stretched to the tile width, so the end dot is a separate element: inside the SVG it would be squashed into an oval.
  return (
    <div className="relative mt-1 h-9 w-full">
      <svg viewBox="0 0 140 36" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
        {d && <path d={d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: color }} />}
      </svg>
      {last && (
        <i
          aria-hidden="true"
          className="absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: (last[0] / 140) * 100 + '%', top: (last[1] / 36) * 100 + '%', background: color }}
        />
      )}
    </div>
  );
}
