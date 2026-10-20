// Web UI development: Vite (hot reload) in front of a throw-away launcher backend.
//   npm run dev:ui
// The backend is the real launcher (logs, stats, settings API) but isolated from an installed/running copy:
// its own ports, its own config dir and state DB under .cache/dev/, no tunnel, no window.
// Ports (override with env): VITE_PORT 5180, DEV_UI_PORT 8795 (launcher UI/API), DEV_MCP_PORT 8796 (MCP).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const vitePort = Number(process.env.VITE_PORT || 5180);
const uiPort = process.env.DEV_UI_PORT || '8795';
const mcpPort = process.env.DEV_MCP_PORT || '8796';
const dir = path.resolve('.cache', 'dev');
fs.mkdirSync(path.join(dir, 'config'), { recursive: true });

// The launcher imports the built page; in dev Vite serves the page, so a stub is enough.
const stubUiHtml = {
  name: 'stub-ui-html',
  setup(b) {
    b.onResolve({ filter: /^virtual:ui-html$/ }, () => ({ path: 'ui-html', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `Dev backend. Open http://localhost:${vitePort}/ (Vite) for the UI.`,
      loader: 'text',
    }));
  },
};
const outfile = path.join(dir, 'launcher.mjs');
await build({
  entryPoints: ['src/launcher.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  packages: 'external',
  plugins: [stubUiHtml],
  logLevel: 'warning',
});

const env = {
  ...process.env,
  // config.env lives under APPDATA (Windows) or XDG_CONFIG_HOME: point both at the dev dir.
  APPDATA: path.join(dir, 'config'),
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  STATE_DB: path.join(dir, 'state.db'),
  PORT: mcpPort,
  UI_PORT: uiPort,
};
let closing = false;
const backend = spawn(process.execPath, [outfile, '--no-tunnel', '--no-open'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
backend.on('exit', (code) => {
  console.error(`[dev-ui] backend exited (${code}); stopping.`);
  void shutdown(code ?? 1);
});

// The proxy target in web/vite.config.js reads UI_PORT.
process.env.UI_PORT = uiPort;
const { createServer } = await import('vite');
const vite = await createServer({ configFile: path.resolve('web', 'vite.config.js'), server: { port: vitePort, strictPort: true } });
await vite.listen();
console.log(`\n[dev-ui] UI (hot reload): http://localhost:${vitePort}/`);
console.log(`[dev-ui] backend: UI/API on ${uiPort}, MCP on ${mcpPort}; config in ${path.join(dir, 'config')}\n`);

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  backend.kill('SIGTERM');
  await vite.close();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void shutdown(0));
