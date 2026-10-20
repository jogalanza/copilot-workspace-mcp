import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './app.js';
import { BrowserManager } from './browserManager.js';
import { loadConfig } from './config.js';
import { StateStore } from './db.js';
import { createMcpServer } from './mcpServer.js';
import { ProcessManager } from './processManager.js';
import { WorkspaceService } from './workspaceManager.js';

// All logging goes to stderr: stdout is reserved for the stdio MCP transport.
const log = (...args: unknown[]) => console.error('[copilot-mcp]', ...args);

const config = loadConfig();

if (!config.apiKey && !config.allowAnonymous) {
  log('MCP_API_KEY is not set. Set it (recommended) or MCP_ALLOW_ANONYMOUS=true for local-only testing.');
  process.exit(1);
}
if (!config.apiKey) log('WARNING: running WITHOUT authentication (MCP_ALLOW_ANONYMOUS=true).');

const store = new StateStore(config.stateDbPath);
const workspaces = new WorkspaceService(store, config);
const browser = config.enableBrowser ? new BrowserManager(config) : undefined;
const processes = config.runAllowedCommands.length ? new ProcessManager(config) : undefined;
const deps = { config, store, workspaces, browser, processes };

for (const w of await workspaces.seed()) log('WARNING:', w);

const AUDIT_RETENTION_DAYS = 90;
const housekeeping = () => {
  const bindings = store.purgeBindings(config.bindingTtlDays);
  const audit = store.purgeAudit(AUDIT_RETENTION_DAYS);
  if (bindings || audit) log(`Purged ${bindings} stale chat binding(s), ${audit} audit row(s).`);
};
housekeeping();
setInterval(housekeeping, 24 * 60 * 60 * 1000).unref();

log(`State DB: ${config.stateDbPath}`);
if (config.traceFile) log(`MCP_TRACE on: every /mcp request is written to ${config.traceFile}`);
if (browser) log(`Browser tools on (${config.browserExecutable ?? config.browserChannel}); allowed hosts: ${config.browserAllowedHosts.join(', ')}`);
if (processes) log(`run_command allowed: ${config.runAllowedCommands.join(' | ')}`);
log(`Workspaces: ${workspaces.availableText()} Default: ${workspaces.getDefault() ?? '(none)'}`);
if (config.allowedRoots.length) log(`add_workspace allowed under: ${config.allowedRoots.join('; ')}`);

const app = createApp(deps);
const httpServer = app.listen(config.port, (err?: Error) => {
  if (err) {
    // Express 5 passes listen errors (e.g. EADDRINUSE) here.
    log(`Failed to listen on ${config.port}: ${err.message}`);
    process.exit(1);
  }
  log(`Listening on ${config.port} (MCP endpoint: http://localhost:${config.port}/mcp)`);
});

if (config.enableStdio) {
  await createMcpServer(deps, { client: 'stdio' }).connect(new StdioServerTransport());
}

const shutdown = async () => {
  httpServer.close();
  await Promise.allSettled([browser?.shutdown(), processes?.shutdown()]);
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
