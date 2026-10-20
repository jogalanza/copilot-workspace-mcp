const ICON = 'size-6';

function RailButton({ label, onClick, disabled, danger, wrapClass = '', children }) {
  return (
    <span className={`group relative ${wrapClass}`}>
      <button
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={`grid size-12 place-items-center rounded-full bg-raised hover:bg-hair focus-visible:outline-2 focus-visible:outline-route disabled:opacity-30 disabled:hover:bg-raised ${danger ? 'text-stop' : ''}`}
      >
        <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
      </button>
      <span role="tooltip" className="pointer-events-none absolute left-1/2 top-full z-30 mt-2.5 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#1a1a1d] px-3 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl ring-1 ring-white/10 transition-opacity delay-100 group-hover:opacity-100 group-focus-within:opacity-100 lg:left-full lg:top-1/2 lg:ml-3 lg:mt-0 lg:-translate-x-0 lg:-translate-y-1/2">{label}</span>
    </span>
  );
}

export default function IconRail({ onSettings, onRestart, restartDisabled, onSave, onStop }) {
  return (
    <nav aria-label="Controls" className="glass relative z-20 flex shrink-0 flex-row items-center gap-2.5 rounded-[28px] p-2.5 lg:w-[4.75rem] lg:flex-col lg:px-2.5 lg:py-5">
      <RailButton label="Settings" onClick={onSettings}>
        <path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0" /><circle cx="15" cy="6" r="2.2" /><circle cx="9" cy="12" r="2.2" /><circle cx="17" cy="18" r="2.2" />
      </RailButton>
      <RailButton label="Restart tunnel" onClick={onRestart} disabled={restartDisabled}>
        <path d="M20 12a8 8 0 1 0-2.4 5.7" /><path d="M20 5v7h-7" />
      </RailButton>
      <RailButton label="Save log" onClick={onSave}>
        <path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" />
      </RailButton>
      <RailButton label="Stop server and tunnel" onClick={onStop} danger wrapClass="ml-auto lg:ml-0 lg:mt-auto">
        <path d="M12 3v9" /><path d="M6.4 6.8a8 8 0 1 0 11.2 0" />
      </RailButton>
    </nav>
  );
}
