import { upTime, useNow } from '../util.js';

// Icon colour per tunnel state. Only a live tunnel glows (a slow breathing halo), so a steady glow reads as "not stale".
const TUNNEL = {
  running: 'text-go animate-glow',
  starting: 'text-warn animate-pulse',
  restarting: 'text-warn animate-pulse',
  stopped: 'text-stop',
  disabled: 'text-mute',
};

const winBtn = 'grid size-7 place-items-center rounded-full bg-raised text-white hover:bg-hair focus-visible:outline-2 focus-visible:outline-route';

/** `shell` is the native frameless-window bridge (or null in a normal browser): the bar then drags the window. */
export default function StatusBar({ state, offline, shell }) {
  const now = useNow(15000);
  const d = new Date(now);
  const onBar = (e) => !e.target.closest('button,a,input,select');
  const label = offline ? 'Disconnected' : state ? 'Tunnel ' + state.tunnel : 'Connecting';
  const tone = offline ? TUNNEL.stopped : state ? TUNNEL[state.tunnel] : 'text-mute';
  return (
    <header
      className={`flex select-none flex-wrap items-center gap-x-5 gap-y-1 px-2 text-sm ${shell ? 'py-2' : ''}`}
      onMouseDown={shell ? (e) => e.button === 0 && onBar(e) && shell('drag') : undefined}
      onDoubleClick={shell ? (e) => onBar(e) && shell('max') : undefined}
    >
      <span className="group relative inline-flex items-center" tabIndex={0} role="img" aria-label={label}>
        <svg viewBox="0 0 24 24" className={`size-5 motion-reduce:animate-none ${tone}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
        </svg>
        <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-30 mt-2 whitespace-nowrap rounded-lg bg-[#1a1a1d] px-3 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl ring-1 ring-white/10 transition-opacity delay-100 group-hover:opacity-100 group-focus:opacity-100">{label}</span>
      </span>
      <span className="text-mute">{state ? 'v' + state.version : ''}</span>
      <span className="ml-auto flex items-center gap-5 text-mute">
        <span className={state?.errors ? 'text-red-300' : ''}>{state ? (state.errors ? state.errors + (state.errors === 1 ? ' error' : ' errors') : 'No errors') : ''}</span>
        <span>{state ? 'Up ' + upTime((now - state.startedAt) / 1000) : ''}</span>
        <span className="hidden sm:inline">{d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span className="font-medium text-white">{d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <span className={`items-center gap-1.5 ${shell ? 'flex' : 'hidden'}`} aria-label="Window">
          <button type="button" title="Minimize" aria-label="Minimize" onClick={() => shell?.('min')} className={winBtn}>
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
          </button>
          <button type="button" title="Maximize or restore" aria-label="Maximize or restore" onClick={() => shell?.('max')} className={winBtn}>
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
          </button>
        </span>
      </span>
    </header>
  );
}
