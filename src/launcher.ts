// Entry point of the standalone executable: one command that provisions everything
// (config + API key, devtunnel CLI, tunnel), starts the MCP server and hosts the tunnel.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { activity } from './activity.js';
import { loadConfig } from './config.js';
import { KNOWN_VARS, LAUNCHER_DEFAULTS } from './envVars.js';
import { LogBus, type LogLevel } from './logBus.js';
import { SERVER_VERSION } from './mcpServer.js';
import { runServiceCommand } from './service.js';
import { startServer } from './server.js';
import { startUi, type ConfigChange, type UiState } from './ui.js';

const APP = 'copilot-workspace-mcp';
const TUNNEL_NAME = APP;
const isWin = process.platform === 'win32';

const HELP = `${APP} - starts the MCP server and exposes it through a Microsoft dev tunnel.

Usage: ${APP} [options]
       ${APP} service <install|uninstall|status|start|stop|restart|url|logs>   run at system start (see README)
  --reconfigure   re-ask for the workspace folder (the API key is kept)
  --new-key       generate a new API key
  --show-key      print the API key in the startup banner
  --no-tunnel     run the server only
  --no-ui         do not start the web UI
  --no-open       start the web UI but do not open the window
  --setup         first-time setup (workspace, API key, dev tunnel install + sign-in), then exit
  --service       unattended mode for a system service: no prompts, no window, log to
                  <config dir>/logs/service.log and write the public URL to <config dir>/tunnel-url.txt
  --verbose       show all dev tunnel output, not just errors and important lines
  -h, --help      this text

Config lives in ${configDir()}
Any variable from .env.example can be set in config.env there, in a .env next to where you run
this, or in the environment.`;

function configDir(): string {
  return isWin
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP)
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP);
}
const CONFIG_FILE = path.join(configDir(), 'config.env');
const TUNNEL_FILE = path.join(configDir(), 'tunnel.json');
const BIN_DIR = path.join(configDir(), 'bin');

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');

const stamp = () => new Date().toTimeString().slice(0, 8);
const bus = new LogBus();
const consoleErr = console.error.bind(console);
const serviceMode = args.has('--service');
const LOG_DIR = path.join(configDir(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'service.log');
const URL_FILE = path.join(configDir(), 'tunnel-url.txt');
if (serviceMode) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size! > 5_000_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* logging to a file is best effort */
  }
}
/** Writes to stderr and, in service mode, appends the same text to the log file. */
const rawErr = (...a: unknown[]) => {
  consoleErr(...a);
  if (serviceMode) {
    try {
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString().slice(0, 19).replace("T", " ")} ${a.map(String).join(' ')}
`);
    } catch {
      /* ignore */
    }
  }
};
// Everything the server prints via console.error ("[copilot-mcp] ...") is mirrored into the web UI.
console.error = (...a: unknown[]) => {
  const text = (a[0] === '[copilot-mcp]' ? a.slice(1) : a).map(String).join(' ');
  bus.add('server', LogBus.guessLevel(text), text);
  rawErr(...a);
};
const log = (msg: string, level: LogLevel = 'info') => {
  bus.add('launcher', level, msg);
  rawErr(`${stamp()} [launcher] ${level === 'error' ? 'ERROR: ' : ''}${msg}`);
};
const fail = (msg: string): never => {
  throw new Error(msg);
};

// ---- config --------------------------------------------------------------------------------

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const readEnvFile = (file: string) => (fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {});

function writeEnvFile(file: string, values: Record<string, string>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(values).map(([k, v]) => `${k}=${/[\s;#]/.test(v) ? `"${v}"` : v}`);
  fs.writeFileSync(file, `# Written by ${APP}. Edit freely; see .env.example in the repo for all options.\n${body.join('\n')}\n`, { mode: 0o600 });
}

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(`${question} [${fallback}]: `)).trim() || fallback;
  } finally {
    rl.close();
  }
}

/** Creates/updates config.env. Returns the saved values and whether the key is new. */
async function ensureConfig(): Promise<{ saved: Record<string, string>; keyIsNew: boolean }> {
  const saved = readEnvFile(CONFIG_FILE);
  let keyIsNew = false;
  if (!saved.MCP_API_KEY || args.has('--new-key')) {
    saved.MCP_API_KEY = crypto.randomBytes(32).toString('base64url');
    keyIsNew = true;
  }
  if (!saved.WORKSPACES || args.has('--reconfigure')) {
    const dir = path.resolve(await ask('Workspace folder to expose to Copilot', process.cwd()));
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`Not a folder: ${dir}`);
    const alias = (await ask('Workspace alias', path.basename(dir))).replace(/[^A-Za-z0-9._-]/g, '-') || 'workspace';
    saved.WORKSPACES = `${alias}=${dir.replace(/\\/g, '/')}`;
    saved.DEFAULT_WORKSPACE = alias;
    saved.ALLOWED_ROOTS ||= path.dirname(dir).replace(/\\/g, '/');
  }
  writeEnvFile(CONFIG_FILE, saved);
  return { saved, keyIsNew };
}

// ---- dev tunnel CLI ------------------------------------------------------------------------

function run(cmd: string, argv: string[]) {
  return spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true });
}

function devtunnelPath(): string | undefined {
  const exe = isWin ? 'devtunnel.exe' : 'devtunnel';
  const local = path.join(BIN_DIR, exe);
  for (const candidate of ['devtunnel', local]) {
    if (!run(candidate, ['--version']).error) return candidate;
  }
  return undefined;
}

async function installDevtunnel(): Promise<string> {
  const os_ = isWin ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = `https://aka.ms/TunnelsCliDownload/${os_}-${arch}`;
  log(`devtunnel not found - downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`Download failed: HTTP ${res.status}`);
  const target = path.join(BIN_DIR, isWin ? 'devtunnel.exe' : 'devtunnel');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  if (run(target, ['--version']).error) fail(`Downloaded devtunnel does not run (${target}).`);
  log(`devtunnel installed to ${target}`);
  return target;
}

function ensureLogin(dt: string) {
  if (run(dt, ['user', 'show']).status === 0) return;
  if (serviceMode) fail(`Not signed in to dev tunnels. Run "${APP} --setup" once as this user, then start the service again.`);
  const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  log(`Not signed in to dev tunnels - starting ${headless ? 'device-code' : 'browser'} login...`);
  const login = spawnSync(dt, ['user', 'login', ...(headless ? ['-d'] : [])], { stdio: 'inherit' });
  if (login.status !== 0) fail('Dev tunnel login failed.');
}

/** Reuses the saved tunnel (a tunnel id keeps the same public URL across runs) or creates one. */
function ensureTunnel(dt: string, port: number): string {
  let id: string | undefined;
  try {
    id = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8')).id;
  } catch {
    /* first run */
  }
  if (id && run(dt, ['show', id]).status !== 0) {
    log(`Saved tunnel ${id} no longer exists - creating a new one.`);
    id = undefined;
  }
  if (!id) {
    const created = run(dt, ['create', TUNNEL_NAME, '--json']);
    if (created.status !== 0) {
      // The name is already taken by this account (e.g. config dir was wiped): adopt it.
      if (run(dt, ['show', TUNNEL_NAME]).status !== 0) fail(`devtunnel create failed: ${(created.stdout + created.stderr).trim()}`);
      id = TUNNEL_NAME;
    } else {
      id = (JSON.parse(created.stdout).tunnel?.tunnelId as string | undefined) ?? fail('Could not read tunnel id from devtunnel output.');
    }
    fs.writeFileSync(TUNNEL_FILE, JSON.stringify({ id }));
    log(`Created tunnel ${id}`);
  }
  // Idempotent: keep exactly one port (PORT) on the tunnel. Stale ports would each get their own public URL.
  const listed = run(dt, ['port', 'list', id, '--json']);
  const existing = listed.status === 0 ? [...listed.stdout.matchAll(/"portNumber"\s*:\s*(\d+)/g)].map((m) => Number(m[1])) : [];
  for (const stale of existing.filter((p) => p !== port)) {
    run(dt, ['port', 'delete', id, '-p', String(stale)]);
    log(`Removed stale port ${stale} from the tunnel.`);
  }
  if (!existing.includes(port)) {
    const added = run(dt, ['port', 'create', id, '-p', String(port), '--protocol', 'http']);
    if (added.status !== 0) fail(`devtunnel port create failed: ${(added.stdout + added.stderr).trim()}`);
  }
  syncTunnelAccess(dt, id);
  return id;
}

/** TUNNEL_ALLOW_ANONYMOUS (default true) controls whether the tunnel accepts unauthenticated clients.
 *  Copilot Studio / M365 Copilot cannot sign in to a dev tunnel, so false only suits your own clients. */
function syncTunnelAccess(dt: string, id: string) {
  const allow = process.env.TUNNEL_ALLOW_ANONYMOUS !== 'false';
  const has = /anonymous/i.test(run(dt, ['access', 'list', id]).stdout);
  if (allow && !has) {
    const r = run(dt, ['access', 'create', id, '--anonymous']);
    if (r.status !== 0) fail(`Could not allow anonymous access: ${(r.stdout + r.stderr).trim()}`);
    log('Tunnel now allows anonymous access (the API key still protects /mcp).');
  } else if (!allow && has) {
    const r = run(dt, ['access', 'reset', id]);
    if (r.status !== 0) fail(`Could not restrict tunnel access: ${(r.stdout + r.stderr).trim()}`);
    log('Tunnel restricted to your Microsoft account: Copilot Studio / M365 Copilot cannot reach it.', 'warn');
  }
}


// ---- tunnel hosting ------------------------------------------------------------------------

const NOISE = /^(Inspect network|Hosting port|Ready to accept)/i;
const IMPORTANT = /https?:\/\/\S+|error|fail|denied|unauthori[sz]ed|expired|refused|unable|exception|warn|retry|disconnect|reconnect/i;
const startedAt = Date.now();
const baseEnv = { ...process.env } as Record<string, string>; // real environment, before config files are applied
let tunnelState: UiState['tunnel'] = 'disabled';
// Tunnel health: how long it has been up, how often it dropped, and when it last restarted.
let tunnelSince = startedAt;
let tunnelTracking: number | undefined;
let tunnelUpMs = 0;
let tunnelRestarts = 0;
let tunnelLastRestart: number | undefined;

function setTunnel(next: UiState['tunnel']) {
  const now = Date.now();
  tunnelTracking ??= now;
  if (tunnelState === 'running') tunnelUpMs += now - tunnelSince;
  if (next === 'restarting' && tunnelState === 'running') {
    tunnelRestarts++;
    tunnelLastRestart = now;
  }
  if (next !== tunnelState) tunnelSince = now;
  tunnelState = next;
}

function tunnelHealth(): Pick<UiState, 'tunnelUptimePct' | 'tunnelRestarts' | 'tunnelLastRestart' | 'tunnelSince'> {
  const now = Date.now();
  const up = tunnelUpMs + (tunnelState === 'running' ? now - tunnelSince : 0);
  const span = tunnelTracking === undefined ? 0 : now - tunnelTracking;
  return {
    tunnelUptimePct: span > 0 ? Math.min(100, (up / span) * 100) : undefined,
    tunnelRestarts,
    tunnelLastRestart,
    tunnelSince,
  };
}
let publicUrl: string | undefined;
let child: ChildProcess | undefined;
let stopping = false;
let restartRequested = false;
let retryTimer: NodeJS.Timeout | undefined;

function hostTunnel(dt: string, id: string, getPort: () => number, onUrl: (url: string) => void, attempt = 0) {
  setTunnel(attempt || restartRequested ? 'restarting' : 'starting');
  const proc = spawn(dt, ['host', id], { windowsHide: true });
  child = proc;
  let started = Date.now();
  const onData = (chunk: Buffer) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!line) continue;
      const url = /Connect via browser:\s*(https:\/\/\S+)/i.exec(line)?.[1]?.split(',')[0];
      if (url && !url.includes(`-${getPort()}.`)) continue; // URL of a different port: not ours
      if (url) {
        started = Date.now();
        setTunnel('running');
        publicUrl = url;
        onUrl(url);
        continue;
      }
      const important = IMPORTANT.test(line) && !NOISE.test(line);
      // The web UI gets every line (noise at "debug"); the console only the important ones.
      bus.add('tunnel', important ? LogBus.guessLevel(line) : 'debug', line);
      if (verbose || important) rawErr(`${stamp()} [tunnel] ${line}`);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => log(`cannot run devtunnel: ${e.message}`, 'error'));
  proc.on('exit', (code) => {
    if (stopping) return;
    setTunnel('restarting');
    // A tunnel that ran for a while (or was restarted on purpose) resets the backoff.
    const next = restartRequested || Date.now() - started > 60_000 ? 0 : attempt + 1;
    const delay = restartRequested ? 1 : Math.min(30, 2 ** next);
    restartRequested = false;
    if (!restartRequested && next > 0) log(`tunnel stopped (exit ${code}); restarting in ${delay}s`, 'error');
    else log(`tunnel restarting in ${delay}s`);
    retryTimer = setTimeout(() => hostTunnel(dt, id, getPort, onUrl, next), delay * 1000);
  });
}

/** Asks devtunnel to exit (it unregisters its host connection on SIGINT/SIGTERM) and force-kills after a grace period. */
function stopTunnel(graceMs = 5000): Promise<void> {
  stopping = true;
  clearTimeout(retryTimer);
  const proc = child;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      log('tunnel did not exit in time - killing it', 'warn');
      proc.kill('SIGKILL');
    }, graceMs);
    proc.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

// ---- main ----------------------------------------------------------------------------------

async function main() {
  if (process.argv[2] === 'service') {
    const sea = (process as unknown as { getBuiltinModule?: (id: string) => any }).getBuiltinModule?.('node:sea');
    await runServiceCommand(process.argv.slice(3), sea?.isSea?.() ? process.execPath : undefined);
    return;
  }
  if (args.has('-h') || args.has('--help')) {
    console.log(HELP);
    return;
  }
  if (serviceMode) args.add('--no-open');
  const ensured = await ensureConfig();
  let saved = ensured.saved;
  const keyIsNew = ensured.keyIsNew;
  // Precedence: ./.env < real environment < config.env (settings saved from the UI).
  const computeEnv = (cfg: Record<string, string>) => ({ ...LAUNCHER_DEFAULTS, ...readEnvFile(path.resolve('.env')), ...baseEnv, ...cfg });
  let appliedKeys = new Set<string>();
  const applyEnv = (env: Record<string, string>) => {
    for (const k of appliedKeys) if (!(k in env)) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    appliedKeys = new Set(Object.keys(env));
  };
  applyEnv(computeEnv(saved));
  let port = Number(process.env.PORT || 8790);

  let dt: string | undefined;
  let tunnelId: string | undefined;
  if (!args.has('--no-tunnel')) {
    dt = devtunnelPath() ?? (await installDevtunnel());
    ensureLogin(dt);
    tunnelId = ensureTunnel(dt, port);
  }
  if (args.has('--setup')) {
    log(`Setup complete. Config: ${CONFIG_FILE}`);
    process.exit(0);
  }

  // The launcher owns signal handling so the tunnel is stopped before the process exits.
  activity.persistTo(path.join(configDir(), 'history.json')); // hourly totals for the busiest-hours heatmap
  let stopServer = await startServer({ handleSignals: false });
  let uiServer: Awaited<ReturnType<typeof startUi>> | undefined;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      log('Second stop request - exiting immediately.', 'warn');
      process.exit(1);
    }
    shuttingDown = true;
    stopShell();
    log(`Shutting down (${reason})...`);
    // Hard stop if something hangs.
    setTimeout(() => process.exit(1), 15_000).unref();
    await stopTunnel();
    await Promise.allSettled([stopServer(), uiServer?.close()]);
    activity.flush();
    log('Stopped cleanly.');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
  process.on('uncaughtException', (e) => log(`Uncaught exception: ${e.stack ?? e}`, 'error'));
  process.on('unhandledRejection', (e) => log(`Unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : e}`, 'error'));
  // Last resort if something calls process.exit(): don't leave devtunnel orphaned.
  process.on('exit', () => {
    child?.kill();
    shellProc?.kill();
  });

  const getConfig = (reveal: boolean) => {
    const known = new Map(KNOWN_VARS.map((v) => [v.key, v]));
    const keys = [...KNOWN_VARS.map((v) => v.key), ...Object.keys(saved).filter((k) => !known.has(k))];
    return {
      file: CONFIG_FILE,
      vars: keys.map((key) => {
        const k = known.get(key);
        const secret = !!k?.secret;
        return {
          key,
          value: secret && !reveal ? '' : (saved[key] ?? ''),
          set: key in saved,
          secret,
          description: k?.description ?? 'Custom variable.',
          default: k?.default,
        };
      }),
    };
  };
  const saveConfig = async (change: ConfigChange) => {
    const next = { ...saved };
    for (const [k, v] of Object.entries(change.set ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(String(v))) return { ok: false, error: `Invalid variable: ${k}` };
      next[k] = String(v);
    }
    for (const k of change.remove ?? []) delete next[k];
    const merged = computeEnv(next);
    try {
      const cfg = loadConfig(merged as NodeJS.ProcessEnv);
      if (!cfg.apiKey && !cfg.allowAnonymous) throw new Error('MCP_API_KEY is required (or set MCP_ALLOW_ANONYMOUS=true).');
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const previous = { saved, env: computeEnv(saved) };
    log('Applying new configuration - restarting the server...');
    try {
      await stopServer();
      applyEnv(merged);
      stopServer = await startServer({ handleSignals: false });
    } catch (e) {
      log(`New configuration failed (${e instanceof Error ? e.message : e}) - rolling back.`, 'error');
      applyEnv(previous.env);
      stopServer = await startServer({ handleSignals: false });
      return { ok: false, error: `Server failed to start with the new values: ${e instanceof Error ? e.message : e}` };
    }
    saved = next;
    writeEnvFile(CONFIG_FILE, saved);
    const newPort = Number(process.env.PORT || 8790);
    if (newPort === port && dt && tunnelId) {
      try {
        syncTunnelAccess(dt, tunnelId);
      } catch (e) {
        log(e instanceof Error ? e.message : String(e), 'error');
      }
    }
    if (newPort !== port) {
      port = newPort;
      if (dt && tunnelId) {
        try {
          ensureTunnel(dt, port);
          restartRequested = true;
          child?.kill('SIGTERM');
        } catch (e) {
          log(`Could not re-point the tunnel to port ${port}: ${e instanceof Error ? e.message : e}`, 'error');
        }
      }
    }
    log('Configuration saved; server restarted.');
    return { ok: true };
  };

  if (!args.has('--no-ui')) {
    try {
      uiServer = await startUi(
        {
          bus,
          getConfig,
          saveConfig,
          getState: () => ({ version: SERVER_VERSION, mcpPort: port, startedAt, publicUrl, tunnel: tunnelState, ...tunnelHealth() }),
          restartTunnel: () => {
            if (!child || stopping) return;
            log('Restarting tunnel (requested from the UI)...');
            restartRequested = true;
            child.kill('SIGTERM');
          },
          stop: () => void shutdown('UI'),
        },
        Number(process.env.UI_PORT || 8791),
      );
    } catch (e) {
      log(`Web UI could not start: ${e instanceof Error ? e.message : e}`, 'warn');
    }
  }
  const uiUrl = uiServer ? `http://localhost:${uiServer.port}` : undefined;

  const showKey = keyIsNew || args.has('--show-key');
  let printed = '';
  const banner = (url?: string) => {
    const lines = [
      '',
      '='.repeat(64),
      ` ${APP} is running`,
      ` Local   : http://localhost:${port}/mcp`,
      url ? ` Public  : ${url.replace(/\/$/, '')}/mcp   <- register this in Copilot` : undefined,
      uiUrl ? ` Web UI  : ${uiUrl}` : undefined,
      ` API key : ${showKey ? process.env.MCP_API_KEY : '(hidden - run with --show-key)'}`,
      ` Config  : ${CONFIG_FILE}`,
      ' Ctrl+C to stop.',
      '='.repeat(64),
      '',
    ];
    rawErr(lines.filter((l) => l !== undefined).join('\n'));
  };
  if (dt && tunnelId) {
    hostTunnel(dt, tunnelId, () => port, (url) => {
      // The CLI prints several lines per port; show the banner once per distinct URL.
      if (url === printed) return;
      printed = url;
      const endpoint = `${url.replace(/\/$/, '')}/mcp`;
      bus.add('launcher', 'info', `Public MCP endpoint: ${endpoint}`);
      if (serviceMode) {
        log(`TUNNEL URL: ${endpoint}`);
        try {
          fs.writeFileSync(URL_FILE, `${endpoint}\n`);
        } catch {
          /* the log line above is enough */
        }
      }
      banner(url);
    });
  } else {
    banner();
  }
  if (uiUrl && !args.has('--no-open')) openUi(uiUrl);
}

/** An installed Chromium browser that can show the UI as a chromeless app window (Edge/Chrome/Chromium). */
function findAppBrowser(): string | undefined {
  const env = process.env;
  const candidates = isWin
    ? ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'].flatMap((v) =>
        env[v]
          ? [path.join(env[v]!, 'Microsoft/Edge/Application/msedge.exe'), path.join(env[v]!, 'Google/Chrome/Application/chrome.exe')]
          : [],
      )
    : process.platform === 'darwin'
      ? ['Microsoft Edge', 'Google Chrome', 'Chromium'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`)
      : (env.PATH ?? '')
          .split(path.delimiter)
          .flatMap((d) => ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'].map((n) => path.join(d, n)));
  return candidates.find((c) => fs.existsSync(c));
}

// ---- native shell: a frameless window (Windows only) that has no close button; Stop is the only way out ----
let shellProc: ChildProcess | undefined;
let shellStopping = false;
let shellStarts: number[] = [];

/** Stops the shell window (called first on shutdown so the window disappears at once). */
function stopShell() {
  shellStopping = true;
  shellProc?.kill();
}

/**
 * Path of the frameless WebView2 host, unpacked from the executable on first run (one folder per build).
 * Undefined when there is none (not Windows, built without the .NET SDK, ...), in which case a browser app window is used.
 */
function shellExe(): string | undefined {
  if (!isWin) return undefined;
  try {
    const sea = (process as unknown as { getBuiltinModule?: (id: string) => any }).getBuiltinModule?.('node:sea');
    if (!sea?.isSea?.()) {
      const dev = path.resolve('build-shell', 'CopilotShell.exe'); // npm run dev, after npm run build:shell
      return fs.existsSync(dev) ? dev : undefined;
    }
    const manifest = JSON.parse(sea.getAsset('shell/manifest.json', 'utf8')) as { id: string; files: string[] };
    const root = path.join(configDir(), 'shell');
    const dir = path.join(root, manifest.id);
    if (!fs.existsSync(path.join(dir, '.complete'))) {
      fs.mkdirSync(dir, { recursive: true });
      for (const name of manifest.files) fs.writeFileSync(path.join(dir, name), Buffer.from(sea.getAsset(`shell/${name}`)));
      fs.writeFileSync(path.join(dir, '.complete'), '');
      for (const old of fs.readdirSync(root)) if (old !== manifest.id) fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
    return path.join(dir, 'CopilotShell.exe');
  } catch (e) {
    log(`Native window unavailable: ${e instanceof Error ? e.message : e}`, 'debug');
    return undefined;
  }
}

function launchShell(exe: string, url: string) {
  const proc = spawn(exe, ['--url', url, '--parent-pid', String(process.pid), '--data-dir', path.join(configDir(), 'webview2')], {
    stdio: 'ignore',
    windowsHide: false,
  });
  shellProc = proc;
  proc.on('error', () => openInBrowser(url));
  proc.on('exit', (code) => {
    if (shellStopping) return;
    if (code === 2) {
      log('The WebView2 runtime is not installed; opening the UI in a browser window instead.', 'warn');
      return openInBrowser(url);
    }
    // The window cannot be closed by the user, so an exit means a crash or a kill: bring it back, but not in a loop.
    const now = Date.now();
    shellStarts = shellStarts.filter((t) => now - t < 60_000);
    shellStarts.push(now);
    if (shellStarts.length > 3) {
      log('The native window keeps exiting; opening the UI in a browser window instead.', 'warn');
      return openInBrowser(url);
    }
    setTimeout(() => !shellStopping && launchShell(exe, url), 500);
  });
}

function openUi(url: string) {
  const exe = shellExe();
  if (exe) {
    launchShell(exe, url);
    return;
  }
  openInBrowser(url);
}

function openInBrowser(url: string) {
  const detached = (cmd: string, argv: string[]) => spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsHide: true });
  try {
    const browser = findAppBrowser();
    if (browser) {
      // --app gives a standalone window (no tabs/address bar); a separate profile keeps it from joining a normal browser session.
      const profile = path.join(configDir(), 'ui-profile');
      detached(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1100,750', '--no-first-run', '--no-default-browser-check'])
        .on('error', () => {})
        .unref();
      return;
    }
    const [cmd, argv] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    detached(cmd as string, argv as string[]).on('error', () => {}).unref();
  } catch {
    /* no browser available: the URL is in the banner */
  }
}

main().catch(async (err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`, 'error');
  // Keep a double-clicked console window open so the error can be read.
  if (process.stdin.isTTY && isWin) await ask('Press Enter to exit', '');
  process.exit(1);
});
