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
  /** Let run_command accept a non-allowlisted command when the agent passes userApproved=true after asking the user. */
  runAllowApproval: boolean;
  runTimeoutSeconds: number;
  maxBackgroundProcesses: number;
  maxProcessOutputBytes: number;
  /** git_* tools (runs the server's git in a workspace). On by default; ENABLE_GIT=false disables them. */
  enableGit: boolean;
  /** curl tool (HTTP requests with any method). On by default; ENABLE_CURL=false disables it. */
  enableCurl: boolean;
  /** Hosts the curl tool may contact (exact, or "*.example.com"). Default: localhost only. */
  curlAllowedHosts: string[];
  curlTimeoutSeconds: number;
  /** web_fetch tool (public web pages as text). Off by default: it can reach the internet. */
  enableWebFetch: boolean;
  /** Hosts web_fetch may reach even if they resolve to private addresses (exact, or "*.example.com"). */
  webAllowedHosts: string[];
  webTimeoutSeconds: number;
  /** Brave Search API key; the web_search tool is enabled when it is set. */
  braveApiKey?: string;
  webSearchUrl: string;
}

/**
 * Programs run_command accepts when RUN_ALLOWED_COMMANDS is not set: common build, test and HTTP tools.
 * Shells (cmd, powershell, bash) are left out. Arguments still cannot contain quotes, pipes or other shell operators.
 */
export const DEFAULT_RUN_COMMANDS = [
  'dotnet', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pip', 'cargo', 'go', 'make', 'curl',
];

/** Split a list on ';' (and newlines). ';' is used instead of path.delimiter so
 *  the same .env works on Windows and POSIX (Windows paths contain ':'). */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[;\n]/)
    .map(unquote)
    .filter(Boolean);
}

/** Absolute path from config: tolerates quotes ("D:/My Projects/x") and file:// URLs (D:/My%20Projects). */
export function configPath(value: string): string {
  return path.resolve(cleanAbsolutePath(value));
}

/** WORKSPACES="api=D:/Repos/Api;web=D:/My Projects/Web"  (alias="D:/My Projects/Web" also accepted) */
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
    runAllowApproval: env.RUN_ALLOW_APPROVAL !== 'false',
    // Unset = the defaults below; set to an empty value to turn run_command off.
    runAllowedCommands: env.RUN_ALLOWED_COMMANDS === undefined ? DEFAULT_RUN_COMMANDS : splitList(env.RUN_ALLOWED_COMMANDS),
    runTimeoutSeconds: int(env.RUN_TIMEOUT_SECONDS, 120, 'RUN_TIMEOUT_SECONDS'),
    maxBackgroundProcesses: int(env.MAX_BACKGROUND_PROCESSES, 3, 'MAX_BACKGROUND_PROCESSES'),
    maxProcessOutputBytes: int(env.MAX_PROCESS_OUTPUT_BYTES, 64 * 1024, 'MAX_PROCESS_OUTPUT_BYTES'),
    enableGit: env.ENABLE_GIT !== 'false',
    enableCurl: env.ENABLE_CURL !== 'false',
    curlAllowedHosts: env.CURL_ALLOWED_HOSTS
      ? splitList(env.CURL_ALLOWED_HOSTS).map((h) => h.toLowerCase())
      : ['localhost', '127.0.0.1', '[::1]'],
    curlTimeoutSeconds: int(env.CURL_TIMEOUT_SECONDS, 30, 'CURL_TIMEOUT_SECONDS'),
    enableWebFetch: env.ENABLE_WEB_FETCH === 'true',
    webAllowedHosts: env.WEB_ALLOWED_HOSTS ? splitList(env.WEB_ALLOWED_HOSTS).map((h) => h.toLowerCase()) : [],
    webTimeoutSeconds: int(env.WEB_TIMEOUT_SECONDS, 30, 'WEB_TIMEOUT_SECONDS'),
    braveApiKey: env.BRAVE_API_KEY?.trim() || undefined,
    webSearchUrl: env.WEB_SEARCH_URL?.trim() || 'https://api.search.brave.com/res/v1/web/search',
  };
}
