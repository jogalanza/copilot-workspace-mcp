import { useCallback, useEffect, useRef, useState } from 'react';
import IconRail from './components/IconRail.jsx';
import StatusBar from './components/StatusBar.jsx';
import Hero from './components/Hero.jsx';
import Endpoints from './components/Endpoints.jsx';
import LogPanel from './components/LogPanel.jsx';
import ToolActivity from './components/ToolActivity.jsx';
import CallDialog from './components/CallDialog.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import { post } from './util.js';

const MAX_LOG = 5000;

// Native shell (frameless window): it has no title bar or close button, so the page supplies drag and window buttons.
const shell = window.chrome?.webview ? (m) => window.chrome.webview.postMessage(m) : null;

export default function App() {
  const [entries, setEntries] = useState([]);
  const [activity, setActivity] = useState({ count: 0 });
  const [stats, setStats] = useState({ buckets: [], tools: [], hours: [], chats: [], blocked: [] });
  const [state, setState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [ripples, setRipples] = useState([]);
  const [dialog, setDialog] = useState(null); // 'settings' | 'call' | 'stop' | null
  const [stopped, setStopped] = useState(false);
  const es = useRef(null);
  const lastCallId = useRef(0);
  const keySeq = useRef(0);

  // Everything live arrives over one server-sent-events stream.
  useEffect(() => {
    const source = new EventSource('/api/stream');
    es.current = source;
    const tag = (e) => ({ ...e, _k: ++keySeq.current });
    source.addEventListener('snapshot', (m) => setEntries(JSON.parse(m.data).map(tag)));
    source.addEventListener('log', (m) => setEntries((prev) => [...(prev.length >= MAX_LOG ? prev.slice(1) : prev), tag(JSON.parse(m.data))]));
    source.addEventListener('clear', () => setEntries([]));
    source.addEventListener('activity', (m) => {
      const a = JSON.parse(m.data);
      setActivity(a);
      if (a.last && a.last.status !== 'pending' && a.last.id !== lastCallId.current) {
        lastCallId.current = a.last.id;
        setRipples((r) => [...r, { id: a.last.id, status: a.last.status }]);
      }
    });
    source.addEventListener('stats', (m) => setStats(JSON.parse(m.data)));
    return () => source.close();
  }, []);

  useEffect(() => {
    const poll = () =>
      fetch('/api/state').then((r) => r.json()).then((s) => { setState(s); setOffline(false); }).catch(() => setOffline(true));
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  const close = useCallback(() => setDialog(null), []);
  const stop = () => {
    setDialog(null);
    post('/api/stop').then(() => { es.current?.close(); setStopped(true); });
  };
  const saveLog = () => {
    const txt = entries.map((e) => new Date(e.ts).toISOString() + ' [' + e.source + '] ' + e.level.toUpperCase() + ' ' + e.text).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = 'copilot-workspace-mcp.log';
    a.click();
  };

  if (stopped) return <p className="p-8 text-center text-mute">{shell ? 'Stopped.' : 'Stopped. You can close this window.'}</p>;

  return (
    <>
      <div className="relative z-10 flex min-h-dvh flex-col gap-3 p-3 lg:h-dvh lg:flex-row">
        <IconRail
          onSettings={() => setDialog('settings')}
          onRestart={() => post('/api/tunnel/restart')}
          restartDisabled={state?.tunnel === 'disabled'}
          onSave={saveLog}
          onStop={() => setDialog('stop')}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <StatusBar state={state && { ...state }} offline={offline} shell={shell} />
          <div className="grid shrink-0 grid-cols-1 gap-3 lg:grid-cols-12">
            <Hero
              activity={activity}
              ripples={ripples}
              onRippleDone={(id) => setRipples((r) => r.filter((x) => x.id !== id))}
              onOpen={() => setDialog('call')}
            />
            <Endpoints state={state} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            <LogPanel entries={entries} onClear={() => post('/api/clear')} />
            <ToolActivity stats={stats} state={state} />
          </div>
        </div>
      </div>

      <CallDialog open={dialog === 'call'} onClose={close} call={activity.last} />
      <ConfirmDialog
        open={dialog === 'stop'}
        title="Stop the app?"
        text="This stops the MCP server and the tunnel, then exits."
        yesLabel="Stop"
        onYes={stop}
        onCancel={close}
      />
      <SettingsDialog open={dialog === 'settings'} onClose={close} />
    </>
  );
}
