import { upTime, useNow } from '../util.js';

const DOT = {
  running: 'bg-go',
  starting: 'bg-warn animate-pulse',
  restarting: 'bg-warn animate-pulse',
  stopped: 'bg-stop',
  disabled: 'bg-mute',
};

const winBtn = 'grid size-7 place-items-center rounded-full bg-raised text-white hover:bg-hair focus-visible:outline-2 focus-visible:outline-route';

/** `shell` is the native frameless-window bridge (or null in a normal browser): the bar then drags the window. */
export default function StatusBar({ state, offline, shell }) {
  const now = useNow(15000);
  const d = new Date(now);
  const onBar = (e) => !e.target.closest('button,a,input,select');
  const label = offline ? 'Disconnected' : state ? 'Tunnel ' + state.tunnel : 'Connecting';
  const dot = offline ? DOT.stopped : state ? DOT[state.tunnel] : 'bg-mute';
  return (
    <header
      className={`flex select-none flex-wrap items-center gap-x-5 gap-y-1 px-2 text-sm ${shell ? 'py-2' : ''}`}
      onMouseDown={shell ? (e) => e.button === 0 && onBar(e) && shell('drag') : undefined}
      onDoubleClick={shell ? (e) => onBar(e) && shell('max') : undefined}
    >
      <span className="inline-flex items-center gap-2.5">
        <i className={`size-2.5 rounded-full ${dot}`} /><span className="font-medium">{label}</span>
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
