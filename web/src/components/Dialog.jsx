import { useEffect, useRef } from 'react';

/** Thin wrapper over the native <dialog>: modal, Esc-to-close and focus handling come from the browser. */
export default function Dialog({ open, onClose, className, backdropClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className}
      onClose={onClose}
      onClick={backdropClose ? (e) => e.target === ref.current && onClose() : undefined}
    >
      {children}
    </dialog>
  );
}
