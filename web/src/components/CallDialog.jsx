import Dialog from './Dialog.jsx';
import { BTN, ago, useNow } from '../util.js';

const STATUS = {
  ok: 'bg-go/20 text-go',
  error: 'bg-stop/20 text-red-300 [:root[data-theme=light]_&]:text-stop',
  pending: 'bg-route/20 text-route',
};
const STATUS_LABEL = { pending: 'Running', ok: 'Succeeded', error: 'Failed' };

function Field({ label, value, pre }) {
  return (
    <>
      <div className="mt-4 text-xs text-mute">{label}</div>
      {pre
        ? <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono text-[14px]">{value}</pre>
        : <div className="mt-0.5 break-words text-base">{value}</div>}
    </>
  );
}

/** Details of the latest MCP call; it updates live while open because `activity` is pushed by the server. */
export default function CallDialog({ open, onClose, call }) {
  const now = useNow(1000);
  const tool = call?.method === 'tools/call';
  return (
    <Dialog open={open} onClose={onClose} className="m-auto w-[min(640px,94vw)] rounded-[28px] border border-white/10 bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70">
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-center gap-3 px-5 py-4">
          <h2 className="text-lg font-medium">Latest MCP call</h2>
          {call && <span className={`rounded-full px-3 py-0.5 text-xs font-medium ${STATUS[call.status]}`}>{STATUS_LABEL[call.status]}</span>}
          <button onClick={onClose} className={`ml-auto ${BTN}`}>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 text-sm">
          {!call ? 'No MCP calls yet.' : (
            <>
              <Field label={tool ? 'Tool' : 'Method'} value={call.name} />
              <Field label="Received" value={new Date(call.ts).toLocaleString() + ' (' + ago(call.ts, now) + ')'} />
              {call.ms !== undefined && <Field label="Duration" value={call.ms + ' ms'} />}
              {call.workspace && <Field label="Workspace" value={call.workspace} />}
              {call.conversation && <Field label="Conversation" value={call.conversation} />}
              {call.client && <Field label="Client" value={call.client} />}
              {call.error && <Field label="Error" value={call.error} pre />}
              {call.args && <Field label={tool ? 'Arguments' : 'Params'} value={call.args} pre />}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
