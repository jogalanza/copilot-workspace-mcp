import os from 'node:os';
import path from 'node:path';
import { cleanAbsolutePath, unquote } from './security.js';

export interface AppConfig {
  port: number;
  /** Shared secret required on /mcp and admin HTTP endpoints. */
  apiKey: string | undefined;
  /** Explicit opt-out of auth (local testing only). */
  allowAnonymous: boolean;
  /** SQLite state file (kept outside every workspace). */
  stateDbPath: string;
  /** Parent folders under which add_workspace may register new workspaces. */
  allowedRoots: string[];
  /** Workspaces seeded/updated at startup: alias -> absolute path. */
  seedWorkspaces: Map<string, string>;
  /** Default workspace alias (used when a chat has no binding). */
  defaultWorkspace: string | undefined;
  /** Chat->workspace bindings unused for this many days are purged. */
  bindingTtlDays: number;
  maxWriteBytes: number;
  maxReadBytes: number;
  maxListResults: number;
  enableStdio: boolean;
  /** MCP_TRACE=true: append every /mcp request + response to this file (next to the state DB). */
  traceFile: string | undefined;
  /** ENABLE_BROWSER=true registers the browser_* tools (headless Chromium via playwright-core). */
  enableBrowser: boolean;
  /** Installed browser to drive: "msedge" (default), "chrome", ... Ignored when browserExecutable is set. */
  browserChannel: string;
  browserExecutable: string | undefined;
  /** Hosts the browser may load (exact, or "*.example.com"). Default: localhost only. */
  browserAllowedHosts: string[];
  browserIdleMinutes: number;
  /** Commands run_command may start: each entry is a command prefix like "npm run dev". Empty = run_command disabled. */
  runAllowedCommands: string[];
  runTimeoutSeconds: number;
  maxBackgroundProcesses: number;
  maxProcessOutputBytes: number;
}

/** Split a list on ';' (and newlines). ';' is used instead of path.delimiter so
 *  the same .env works on Windows and POSIX (Windows paths contain ':'). */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[;\n]/)
    .map(unquote)
    .filter(Boolean);
}

/** Absolute path from config: tolerates quotes ("D:/Red Files/x") and file:// URLs (D:/Red%20Files). */
export function configPath(value: string): string {
  return path.resolve(cleanAbsolutePath(value));
}

/** WORKSPACES="api=D:/Repos/Api;web=D:/Red Files/Web"  (alias="D:/Red Files/Web" also accepted) */
export function parseWorkspaceList(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of splitList(value)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid WORKSPACES entry "${entry}" (expected alias=path)`);
    const folder = unquote(entry.slice(eq + 1));
    if (!folder) throw new Error(`Invalid WORKSPACES entry "${entry}" (empty path)`);
    map.set(unquote(entry.slice(0, eq)), configPath(folder));
  }
  return map;
}

function defaultStateDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'copilot-mcp');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'copilot-mcp');
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const seedWorkspaces = parseWorkspaceList(env.WORKSPACES);
  // Backward compatibility: WORKSPACE_ROOT registers a single workspace.
  if (env.WORKSPACE_ROOT && seedWorkspaces.size === 0) {
    const root = configPath(env.WORKSPACE_ROOT);
    seedWorkspaces.set(path.basename(root).replace(/[^A-Za-z0-9._-]/g, '-') || 'default', root);
  }
  return {
    port: int(env.PORT, 8790, 'PORT'),
    apiKey: env.MCP_API_KEY || undefined,
    allowAnonymous: env.MCP_ALLOW_ANONYMOUS === 'true',
    stateDbPath: configPath(env.STATE_DB || path.join(defaultStateDir(), 'state.db')),
    allowedRoots: splitList(env.ALLOWED_ROOTS).map(configPath),
    seedWorkspaces,
    defaultWorkspace: env.DEFAULT_WORKSPACE || undefined,
    bindingTtlDays: int(env.BINDING_TTL_DAYS, 30, 'BINDING_TTL_DAYS'),
    maxWriteBytes: int(env.MAX_WRITE_BYTES, 1024 * 1024, 'MAX_WRITE_BYTES'),
    maxReadBytes: int(env.MAX_READ_BYTES, 1024 * 1024, 'MAX_READ_BYTES'),
    maxListResults: int(env.MAX_LIST_RESULTS, 500, 'MAX_LIST_RESULTS'),
    enableStdio: env.ENABLE_STDIO === 'true',
    traceFile:
      env.MCP_TRACE === 'true'
        ? path.join(path.dirname(configPath(env.STATE_DB || path.join(defaultStateDir(), 'state.db'))), 'mcp-trace.log')
        : undefined,
    enableBrowser: env.ENABLE_BROWSER === 'true',
    browserChannel: env.BROWSER_CHANNEL || 'msedge',
    browserExecutable: env.BROWSER_EXECUTABLE ? configPath(env.BROWSER_EXECUTABLE) : undefined,
    browserAllowedHosts: env.BROWSER_ALLOWED_HOSTS
      ? splitList(env.BROWSER_ALLOWED_HOSTS).map((h) => h.toLowerCase())
      : ['localhost', '127.0.0.1', '[::1]'],
    browserIdleMinutes: int(env.BROWSER_IDLE_MINUTES, 10, 'BROWSER_IDLE_MINUTES'),
    runAllowedCommands: splitList(env.RUN_ALLOWED_COMMANDS),
    runTimeoutSeconds: int(env.RUN_TIMEOUT_SECONDS, 120, 'RUN_TIMEOUT_SECONDS'),
    maxBackgroundProcesses: int(env.MAX_BACKGROUND_PROCESSES, 3, 'MAX_BACKGROUND_PROCESSES'),
    maxProcessOutputBytes: int(env.MAX_PROCESS_OUTPUT_BYTES, 64 * 1024, 'MAX_PROCESS_OUTPUT_BYTES'),
  };
}
