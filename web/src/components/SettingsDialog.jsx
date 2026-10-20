import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import { BTN, INPUT } from '../util.js';

const DEFAULT_MSG = { text: 'Saving restarts the MCP server (a few seconds of downtime).', kind: '' };
const MSG_COLOR = { err: 'text-red-300', ok: 'text-go', '': 'text-mute' };
const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function VarRow({ row, onChange, onShow, onGenerate }) {
  const v = row.meta;
  const placeholder = v.secret && v.set ? '(set - hidden; type to replace)' : v.default ? '(default: ' + v.default + ')' : '(not set)';
  return (
    <div className="py-3">
      <div className="font-mono text-[14px] font-semibold">
        {row.custom
          ? <input placeholder="VARIABLE_NAME" value={row.newKey} onChange={(e) => onChange({ newKey: e.target.value })} className={INPUT} />
          : v.key}
      </div>
      <div className="mt-1.5 flex gap-2">
        <input
          className={INPUT}
          type={v.secret && row.hidden ? 'password' : 'text'}
          value={row.value}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => onChange({ value: e.target.value, touched: true })}
        />
        {v.secret && (
          <>
            <button className={BTN} onClick={onShow}>{row.hidden ? 'Show' : 'Hide'}</button>
            <button className={BTN} onClick={onGenerate}>Generate</button>
          </>
        )}
      </div>
      {v.description && <p className="mt-1.5 text-xs text-mute">{v.description}</p>}
    </div>
  );
}

export default function SettingsDialog({ open, onClose }) {
  const [file, setFile] = useState('');
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState(DEFAULT_MSG);
  const [busy, setBusy] = useState(false);
  const orig = useRef({}); // key -> value as loaded (or as revealed)
  const listRef = useRef(null);

  // Each time the dialog opens, reload the variables from the server.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    fetch('/api/config').then((r) => r.json()).then((c) => {
      if (stale) return;
      setFile(c.file);
      orig.current = Object.fromEntries(c.vars.map((v) => [v.key, v.value]));
      setRows(c.vars.map((v) => ({ id: v.key, meta: v, value: v.value, touched: false, hidden: !!v.secret, custom: false, newKey: '' })));
      setMsg(DEFAULT_MSG);
    });
    return () => { stale = true; };
  }, [open]);

  const patch = (id, p) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const show = (row) => {
    if (!row.hidden) return patch(row.id, { hidden: true });
    fetch('/api/config?reveal=1').then((x) => x.json()).then((c) => {
      const q = c.vars.find((x) => x.key === row.meta.key);
      if (q && !row.touched) {
        orig.current[row.meta.key] = q.value;
        patch(row.id, { value: q.value, hidden: false });
      } else patch(row.id, { hidden: false });
    });
  };

  const addVar = () => {
    const id = 'new-' + Date.now();
    setRows((rs) => [...rs, { id, meta: { key: '', set: false, secret: false, description: '' }, value: '', touched: false, hidden: false, custom: true, newKey: '' }]);
    setTimeout(() => {
      const last = listRef.current?.lastElementChild;
      last?.querySelector('input')?.focus();
      last?.scrollIntoView();
    });
  };

  const save = () => {
    const set = {}, remove = [];
    for (const r of rows) {
      const key = r.meta.key || r.newKey.trim();
      if (!key) continue;
      const o = orig.current;
      if (r.touched || (!(key in o) && r.value) || (key in o && r.value !== o[key] && !(r.meta.secret && r.hidden && !r.touched))) {
        if (r.value === '') remove.push(key); else set[key] = r.value;
      }
    }
    setMsg({ text: 'Applying...', kind: '' });
    setBusy(true);
    fetch('/api/config', { method: 'POST', headers: { 'x-cwm': '1', 'content-type': 'application/json' }, body: JSON.stringify({ set, remove }) })
      .then((r) => r.json())
      .then((r) => {
        setBusy(false);
        if (r.ok) { setMsg({ text: 'Saved and applied.', kind: 'ok' }); setTimeout(onClose, 900); }
        else setMsg({ text: r.error || 'Failed', kind: 'err' });
      })
      .catch(() => { setBusy(false); setMsg({ text: 'Request failed', kind: 'err' }); });
  };

  return (
    <Dialog open={open} onClose={onClose} className="m-auto h-full max-h-[100dvh] w-full max-w-none overflow-hidden rounded-none border border-white/10 bg-[#1a1a1d] p-0 text-white shadow-2xl backdrop:bg-black/70 sm:h-auto sm:max-h-[88vh] sm:w-[min(860px,94vw)] sm:rounded-[28px]">
      <div className="flex h-full max-h-[inherit] flex-col sm:max-h-[88vh]">
        <div className="flex items-center gap-3 px-5 py-4">
          <h2 className="text-lg font-medium">Settings</h2>
          <span className="ml-auto truncate text-xs text-mute">{file}</span>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 divide-y divide-hair overflow-auto px-5">
          {rows.map((r) => (
            <VarRow key={r.id} row={r} onChange={(p) => patch(r.id, p)} onShow={() => show(r)} onGenerate={() => patch(r.id, { value: newToken(), touched: true, hidden: false })} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-hair px-5 py-3">
          <button onClick={addVar} className={BTN}>Add variable</button>
          <span className={`order-last w-full text-xs sm:order-none sm:w-auto sm:flex-1 ${MSG_COLOR[msg.kind]}`}>{msg.text}</span>
          <button onClick={onClose} className={`ml-auto sm:ml-0 ${BTN}`}>Close</button>
          <button onClick={save} disabled={busy} className="rounded-full bg-route px-4 py-1.5 text-sm font-medium text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50">Save &amp; apply</button>
        </div>
      </div>
    </Dialog>
  );
}
