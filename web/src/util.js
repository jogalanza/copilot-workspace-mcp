import { useEffect, useState } from 'react';

// Shared class strings (full strings, so Tailwind's scanner sees them).
export const BTN = 'rounded-full bg-raised px-4 py-1.5 text-sm font-medium hover:bg-hair focus-visible:outline-2 focus-visible:outline-route';
export const INPUT = 'min-w-0 flex-1 rounded-lg bg-well px-3 py-2 font-mono text-[14px] placeholder:text-mute focus-visible:outline-2 focus-visible:outline-route';

export const post = (p) => fetch(p, { method: 'POST', headers: { 'x-cwm': '1' } });

const pad = (n) => (n < 10 ? '0' + n : '' + n);
export function fmt(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 5 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago';
}
export function fmtMs(ms) {
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
}
export function upTime(s) {
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/** Re-renders the caller every `ms` and returns the current time. */
export function useNow(ms) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
