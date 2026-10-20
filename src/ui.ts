// Local web UI for the standalone launcher: live colour-coded logs, status and controls.
// Bound to loopback only and NOT part of the tunnelled port, so it is never reachable from the internet.
import http from 'node:http';
import { activity } from './activity.js';
import type { LogBus } from './logBus.js';
import { UI_HTML } from './uiPage.js';

export interface UiState {
  version: string;
  mcpPort: number;
  startedAt: number;
  publicUrl?: string;
  tunnel: 'disabled' | 'starting' | 'running' | 'restarting' | 'stopped';
}

export interface ConfigVar {
  key: string;
  /** Value stored in config.env ('' for secrets unless revealed). */
  value: string;
  /** A value is stored (lets the UI show "set" for hidden secrets). */
  set: boolean;
  secret: boolean;
  description: string;
  /** Value used when the variable is not set. */
  default?: string;
  /** Set when a .env file or the real environment overrides config.env for this key. */
  overriddenBy?: string;
}

export interface ConfigChange {
  set?: Record<string, string>;
  remove?: string[];
}

export interface UiHooks {
  getConfig: (reveal: boolean) => { file: string; vars: ConfigVar[] };
  saveConfig: (change: ConfigChange) => Promise<{ ok: boolean; error?: string }>;
  bus: LogBus;
  getState: () => UiState;
  restartTunnel: () => void;
  stop: () => void;
}

export function startUi(hooks: UiHooks, preferredPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    // Anti DNS-rebinding: only answer requests addressed to loopback.
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(req.headers.host ?? '')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (body: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(UI_HTML);
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
      json({ ...hooks.getState(), errors: hooks.bus.errorCount() });
    } else if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('snapshot', hooks.bus.snapshot());
      const unsub = hooks.bus.subscribe((e) => (e.type === 'log' ? send('log', e.entry) : send('clear', {})));
      send('activity', activity.snapshot());
      const unsubActivity = activity.subscribe((s) => send('activity', s));
      send('stats', activity.statsSnapshot());
      const unsubStats = activity.subscribeStats((s) => send('stats', s));
      const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        unsub();
        unsubActivity();
        unsubStats();
        clearInterval(beat);
      });
    } else if (req.method === 'GET' && url.pathname === '/api/config') {
      json(hooks.getConfig(url.searchParams.get('reveal') === '1'));
    } else if (req.method === 'POST' && req.headers['x-cwm'] === '1' && url.pathname === '/api/config') {
      readBody(req)
        .then((body) => hooks.saveConfig(JSON.parse(body) as ConfigChange))
        .then((r) => res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(r)))
        .catch((e) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })));
    } else if (req.method === 'POST' && req.headers['x-cwm'] === '1') {
      // The custom header forces a CORS preflight for cross-site pages, which this server never grants.
      if (url.pathname === '/api/clear') hooks.bus.clear();
      else if (url.pathname === '/api/tunnel/restart') hooks.restartTunnel();
      else if (url.pathname === '/api/stop') setImmediate(hooks.stop);
      else {
        res.writeHead(404).end();
        return;
      }
      json({ ok: true });
    } else {
      res.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    let port = preferredPort;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < preferredPort + 10) server.listen(++port, '127.0.0.1');
      else reject(err);
    });
    server.on('listening', () =>
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      }),
    );
    server.listen(port, '127.0.0.1');
  });
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error('Request too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
