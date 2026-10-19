import os from 'node:os';
import path from 'node:path';

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
}

/** Split a list on ';' (and newlines). ';' is used instead of path.delimiter so
 *  the same .env works on Windows and POSIX (Windows paths contain ':'). */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** WORKSPACES="api=D:/Repos/Api;web=D:/Repos/Web" */
export function parseWorkspaceList(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of splitList(value)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid WORKSPACES entry "${entry}" (expected alias=path)`);
    map.set(entry.slice(0, eq).trim(), path.resolve(entry.slice(eq + 1).trim()));
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
    const root = path.resolve(env.WORKSPACE_ROOT);
    seedWorkspaces.set(path.basename(root).replace(/[^A-Za-z0-9._-]/g, '-') || 'default', root);
  }
  return {
    port: int(env.PORT, 8790, 'PORT'),
    apiKey: env.MCP_API_KEY || undefined,
    allowAnonymous: env.MCP_ALLOW_ANONYMOUS === 'true',
    stateDbPath: path.resolve(env.STATE_DB || path.join(defaultStateDir(), 'state.db')),
    allowedRoots: splitList(env.ALLOWED_ROOTS).map((p) => path.resolve(p)),
    seedWorkspaces,
    defaultWorkspace: env.DEFAULT_WORKSPACE || undefined,
    bindingTtlDays: int(env.BINDING_TTL_DAYS, 30, 'BINDING_TTL_DAYS'),
    maxWriteBytes: int(env.MAX_WRITE_BYTES, 1024 * 1024, 'MAX_WRITE_BYTES'),
    maxReadBytes: int(env.MAX_READ_BYTES, 1024 * 1024, 'MAX_READ_BYTES'),
    maxListResults: int(env.MAX_LIST_RESULTS, 500, 'MAX_LIST_RESULTS'),
    enableStdio: env.ENABLE_STDIO === 'true',
  };
}
