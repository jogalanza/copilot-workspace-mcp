import { useEffect, useRef } from 'react';
import Dialog from './Dialog.jsx';
import { BTN } from '../util.js';

/** In-page replacement for window.confirm(). Cancel is focused so Enter never confirms by accident. */
export default function ConfirmDialog({ open, title, text, yesLabel = 'OK', onYes, onCancel }) {
  const noRef = useRef(null);
  useEffect(() => {
    if (open) noRef.current?.focus();
  }, [open]);
  return (
    <Dialog open={open} onClose={onCancel} backdropClose className="m-auto w-[min(420px,94vw)] rounded-[28px] border border-white/10 bg-[#1a1a1d] p-0 text-white shadow-2xl backdrop:bg-black/70">
      <div className="px-6 pb-5 pt-6">
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="mt-2 text-sm text-mute">{text}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button ref={noRef} onClick={onCancel} className={BTN}>Cancel</button>
          <button onClick={onYes} className="rounded-full bg-route px-4 py-1.5 text-sm font-medium text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-white">{yesLabel}</button>
        </div>
      </div>
    </Dialog>
  );
}
