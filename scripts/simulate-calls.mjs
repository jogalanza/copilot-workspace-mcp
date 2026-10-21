// Simulate MCP traffic against a running server so the dashboard has something to show.
// Each minute a random number of tool calls is made at random moments, each with a random tool.
// Only read-only tools are used. Browser calls open https://www.google.com/ and take a screenshot, which needs
// ENABLE_BROWSER=true and BROWSER_ALLOWED_HOSTS to include www.google.com on the server (otherwise they log as errors).
//
// Usage: node scripts/simulate-calls.mjs [--url http://127.0.0.1:8790/mcp] [--key <key>] [--workspace <alias>]
//                                        [--min 20] [--max 40] [--minutes 0] [--browser-weight 3]
// Env fallbacks: MCP_URL, MCP_API_KEY (also read from .env). --minutes 0 runs until Ctrl+C.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const fromEnvFile = (k) => envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();

const url = opt('url', process.env.MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? fromEnvFile('PORT') ?? 8790}/mcp`);
const apiKey = opt('key', process.env.MCP_API_KEY ?? fromEnvFile('MCP_API_KEY'));
const minCalls = Number(opt('min', 20));
const maxCalls = Number(opt('max', 40));
const totalMinutes = Number(opt('minutes', 0));
const browserWeight = Number(opt('browser-weight', 3));
let workspace = opt('workspace', undefined);

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (list) => list[rand(0, list.length - 1)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsArg = () => (workspace ? { workspace } : {});

const clients = ['Copilot Studio', 'M365 Copilot', 'Claude Desktop', 'Cursor'];
const files = ['README.md', 'package.json', 'LICENSE', 'tsconfig.json', 'does-not-exist.txt'];
const patterns = ['TODO', 'function\\s+\\w+', 'import .* from', 'export const'];

// Each entry is one scenario; browser scenarios are repeated by --browser-weight to bias the mix.
const scenarios = [
  { name: 'list_workspaces', run: (c) => c.callTool({ name: 'list_workspaces', arguments: {} }) },
  { name: 'current_workspace', run: (c) => c.callTool({ name: 'current_workspace', arguments: {} }) },
  { name: 'list_files', run: (c) => c.callTool({ name: 'list_files', arguments: { ...wsArg() } }) },
  { name: 'ws_read_file', run: (c) => c.callTool({ name: 'ws_read_file', arguments: { filePath: pick(files), ...wsArg() } }) },
  { name: 'ws_grep', run: (c) => c.callTool({ name: 'ws_grep', arguments: { pattern: pick(patterns), glob: '**/*.{ts,js,md}', ...wsArg() } }) },
  { name: 'git_status', run: (c) => c.callTool({ name: 'git_status', arguments: { ...wsArg() } }) },
  { name: 'git_log', run: (c) => c.callTool({ name: 'git_log', arguments: { ...wsArg() } }) },
  { name: 'git_diff', run: (c) => c.callTool({ name: 'git_diff', arguments: { ...wsArg() } }) },
  { name: 'todo_read', run: (c) => c.callTool({ name: 'todo_read', arguments: {} }) },
  { name: 'list_processes', run: (c) => c.callTool({ name: 'list_processes', arguments: {} }) },
  ...Array.from({ length: browserWeight }, () => ({
    name: 'browser_open+screenshot',
    run: async (c) => {
      await c.callTool({ name: 'browser_open', arguments: { url: 'https://www.google.com/', ...wsArg() } });
      return c.callTool({ name: 'browser_screenshot', arguments: { fullPage: Math.random() < 0.3, ...wsArg() } });
    },
  })),
];

const stats = new Map();
const record = (name, ok, ms) => {
  const s = stats.get(name) ?? { ok: 0, fail: 0, ms: 0 };
  s[ok ? 'ok' : 'fail']++;
  s.ms += ms;
  stats.set(name, s);
};

async function connect(clientName) {
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { ...(apiKey ? { 'api-key': apiKey } : {}), 'conversation-id': `sim-${Math.random().toString(36).slice(2, 8)}` },
      },
    }),
  );
  return client;
}

async function oneCall() {
  const scenario = pick(scenarios);
  const client = await connect(pick(clients));
  const t0 = Date.now();
  try {
    const res = await scenario.run(client);
    const ok = !res.isError;
    record(scenario.name, ok, Date.now() - t0);
    console.log(`${new Date().toLocaleTimeString()}  ${ok ? 'ok  ' : 'ERR '} ${scenario.name} (${Date.now() - t0} ms)`);
  } catch (err) {
    record(scenario.name, false, Date.now() - t0);
    console.log(`${new Date().toLocaleTimeString()}  FAIL ${scenario.name}: ${err.message}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function summary() {
  console.log('\nSummary');
  for (const [name, s] of [...stats].sort()) {
    console.log(`  ${name.padEnd(26)} ok ${String(s.ok).padStart(3)}  failed ${String(s.fail).padStart(3)}  avg ${Math.round(s.ms / (s.ok + s.fail))} ms`);
  }
}

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});

if (!workspace) {
  try {
    const probe = await connect('simulator');
    const res = await probe.callTool({ name: 'list_workspaces', arguments: {} });
    const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    workspace = text.match(/"alias"\s*:\s*"([^"]+)"/)?.[1];
    await probe.close();
  } catch (err) {
    console.error(`Cannot reach ${url}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`Simulating ${minCalls}-${maxCalls} calls/min against ${url}${workspace ? ` (workspace ${workspace})` : ''}. Ctrl+C to stop.`);
for (let minute = 0; !stopping && (totalMinutes === 0 || minute < totalMinutes); minute++) {
  const n = rand(minCalls, maxCalls);
  const offsets = Array.from({ length: n }, () => Math.random() * 60_000).sort((a, b) => a - b);
  console.log(`\n-- minute ${minute + 1}: ${n} calls --`);
  const start = Date.now();
  const inFlight = [];
  for (const at of offsets) {
    if (stopping) break;
    await sleep(Math.max(0, start + at - Date.now()));
    inFlight.push(oneCall());
  }
  await Promise.all(inFlight);
  if (!stopping) await sleep(Math.max(0, start + 60_000 - Date.now()));
}
summary();
