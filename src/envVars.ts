// Every variable the server and launcher read; the web UI lists all of them for editing.
// Other variables can still be added by name.
export interface KnownVar {
  key: string;
  description: string;
  secret?: boolean;
  /** Value the app uses when the variable is not set (shown as a placeholder in the UI). */
  default?: string;
}

export const KNOWN_VARS: KnownVar[] = [
  // --- Security
  { key: 'MCP_API_KEY', secret: true, description: 'Shared secret clients must send (api-key header / Bearer / ?api_key=).' },
  { key: 'MCP_ALLOW_ANONYMOUS', default: 'false', description: 'true = run without an API key (only when MCP_API_KEY is empty). Local testing only.' },
  { key: 'TUNNEL_ALLOW_ANONYMOUS', default: 'true', description: 'true = anyone with the URL can reach the tunnel; the API key still protects /mcp. Required for Copilot Studio / M365 Copilot. false = only your Microsoft account can connect.' },

  // --- Workspaces
  { key: 'WORKSPACES', description: "Workspaces as alias=path, separated by ';'. Example: api=D:/Repos/Api;web=D:/Repos/Web" },
  { key: 'WORKSPACE_ROOT', description: 'Legacy: a single workspace folder. Ignored when WORKSPACES is set.' },
  { key: 'DEFAULT_WORKSPACE', description: 'Alias used by chats that have not chosen a workspace (default: the first workspace).' },
  { key: 'ALLOWED_ROOTS', description: "add_workspace may only register folders under these roots (';'-separated). Empty = add_workspace disabled." },
  { key: 'BINDING_TTL_DAYS', default: '30', description: 'Chat->workspace bindings unused for this many days are purged.' },

  // --- Server
  { key: 'PORT', default: '8790', description: 'Local MCP port. Changing it also re-points the tunnel.' },
  { key: 'STATE_DB', description: 'SQLite state file (default: %LOCALAPPDATA%/copilot-mcp/state.db, or ~/.local/state/copilot-mcp/state.db).' },
  { key: 'ENABLE_STDIO', default: 'false', description: 'true = also serve MCP over stdio.' },
  { key: 'MCP_TRACE', default: 'false', description: 'true = write every /mcp request and response to mcp-trace.log next to the state DB.' },
  { key: 'MAX_WRITE_BYTES', default: '1048576', description: 'Largest file write.' },
  { key: 'MAX_READ_BYTES', default: '1048576', description: 'Largest file read.' },
  { key: 'MAX_LIST_RESULTS', default: '500', description: 'Max results from list/search tools.' },

  // --- Browser tools
  { key: 'ENABLE_BROWSER', default: 'true', description: 'Headless browser_* tools. On by default in the standalone app; set false to disable.' },
  { key: 'BROWSER_CHANNEL', default: 'msedge', description: 'Installed browser to drive: msedge or chrome.' },
  { key: 'BROWSER_EXECUTABLE', description: 'Full path to a Chromium-based browser (overrides BROWSER_CHANNEL).' },
  { key: 'BROWSER_ALLOWED_HOSTS', default: 'localhost;127.0.0.1;[::1]', description: "Hosts the browser may load (';'-separated, *.example.com allowed). Default: localhost only." },
  { key: 'BROWSER_IDLE_MINUTES', default: '10', description: 'Close the browser after this many idle minutes.' },

  // --- run_command
  { key: 'RUN_ALLOWED_COMMANDS', description: "SECURITY: commands Copilot may run, as prefixes separated by ';' (e.g. npm run dev;npm test). Empty = run_command disabled. Never list interpreters (node, python, powershell, cmd)." },
  { key: 'RUN_TIMEOUT_SECONDS', default: '120', description: 'Timeout for run_command.' },
  { key: 'MAX_BACKGROUND_PROCESSES', default: '3', description: 'Concurrent background processes.' },
  { key: 'MAX_PROCESS_OUTPUT_BYTES', default: '65536', description: 'Output kept per background process.' },

  // --- Launcher
  { key: 'UI_PORT', default: '8791', description: 'Web UI port. Takes effect after restarting the app.' },
];

/** Defaults the standalone launcher applies below config.env, .env and the real environment. */
export const LAUNCHER_DEFAULTS: Record<string, string> = { ENABLE_BROWSER: 'true' };
