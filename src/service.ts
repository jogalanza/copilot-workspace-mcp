// Installs copilot-workspace-mcp as a background service that starts with the machine, on Windows, macOS and Linux.
//
//   copilot-workspace-mcp service install [--exe <path>] [--boot]   set up, register and start the service
//   copilot-workspace-mcp service uninstall                         stop and remove it (config and logs are kept)
//   copilot-workspace-mcp service status | start | stop | restart
//   copilot-workspace-mcp service url                               print the public tunnel address
//   copilot-workspace-mcp service logs [-f]                         print (or follow) the log
//
// The service runs the executable with --service: no prompts, no window, log in <config dir>/logs/service.log and
// the public address in <config dir>/tunnel-url.txt. The web UI stays at http://localhost:8791 in any browser.
//
// The dev tunnel sign-in belongs to your user account, so the service runs as YOU, not as SYSTEM/root:
//   Windows : Scheduled Task, starts when you log on (restarts if it crashes).
//   Linux   : systemd user service, started at boot via "loginctl enable-linger" (needs sudo once).
//   macOS   : LaunchAgent, starts when you log in. With --boot a LaunchDaemon that starts at boot (needs sudo).
// "install" first runs "<exe> --setup" interactively (workspace folder, API key, dev tunnel sign-in).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'copilot-workspace-mcp';
const TASK = 'CopilotWorkspaceMCP';
const LABEL = 'com.copilot-workspace-mcp';
const plat = process.platform;
let rest: string[] = [];
let flags = new Set<string>();
let defaultExe: string | undefined;
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

export const serviceConfigDir =
  plat === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP)
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP);
const logFile = path.join(serviceConfigDir, 'logs', 'service.log');
const urlFile = path.join(serviceConfigDir, 'tunnel-url.txt');

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const run = (c, a, opts = {}) => spawnSync(c, a, { encoding: 'utf8', ...opts });
const mustRun = (c, a, opts = {}) => {
  const r = run(c, a, opts);
  if (r.error || r.status !== 0) die(`${c} ${a.join(' ')} failed${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
  return r;
};
const sudo = (c: string, a: string[], opts: Record<string, unknown> = {}) => (process.getuid?.() === 0 ? mustRun(c, a, opts) : mustRun('sudo', [c, ...a], { stdio: 'inherit', ...opts }));

function findExe() {
  const given = flagValue('--exe');
  if (given) return fs.existsSync(given) ? path.resolve(given) : die(`--exe not found: ${given}`);
  if (defaultExe) return defaultExe;
  const ext = plat === 'win32' ? '.exe' : '';
  const names = [`${APP}${ext}`, `${APP}-${plat}-${process.arch}${ext}`];
  for (const dir of [process.cwd(), path.join(process.cwd(), 'release')]) {
    for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.resolve(dir, n);
  }
  return die(`Could not find the ${APP} executable. Pass --exe <path> (build it with: npm run build:standalone).`);
}

// ---- Windows: Scheduled Task ----------------------------------------------------------------

const ps = (script, opts = {}) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], opts);

/** Stop-ScheduledTask ends the wrapper but not its child, so end the server it started (only a "--service" instance; a manually started one is left alone). */
const killService = () =>
  ps(`Get-CimInstance Win32_Process -Filter "Name like '${APP}%'" | Where-Object { $_.CommandLine -match '--service' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);

const win = {
  install(exe) {
    const q = (s) => s.replace(/'/g, "''");
    // Start-Process -Wait keeps the task "running" while the server runs, so Task Scheduler can restart it on failure.
    const inner = `$p = Start-Process -FilePath '${q(exe)}' -ArgumentList '--service' -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`;
    const script = `
$ErrorActionPreference = 'Stop'
$user = "$env:USERDOMAIN\\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('${q(inner)}')))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK}'`;
    const r = ps(script);
    if (r.status !== 0) die(`Could not register the scheduled task: ${(r.stderr || r.stdout).trim()}`);
    console.log(`Scheduled task "${TASK}" created: it starts when you log on and restarts if it stops. Started now.`);
  },
  uninstall() {
    ps(`Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`);
    killService();
  },
  status() {
    const r = ps(`$t = Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; if ($t) { "$($t.State)" } else { 'not installed' }`);
    return r.stdout.trim();
  },
  start: () => ps(`Start-ScheduledTask -TaskName '${TASK}'`),
  stop() {
    ps(`Stop-ScheduledTask -TaskName '${TASK}'`);
    killService();
  },
};

// ---- Linux: systemd user service ------------------------------------------------------------

const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
const unitFile = path.join(unitDir, `${APP}.service`);
const sc = (...a) => run('systemctl', ['--user', ...a], { encoding: 'utf8' });

const linux = {
  install(exe) {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      unitFile,
      `[Unit]
Description=Copilot Workspace MCP server (with dev tunnel)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${exe}" --service
Environment=PATH=${process.env.PATH}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`,
    );
    mustRun('systemctl', ['--user', 'daemon-reload']);
    mustRun('systemctl', ['--user', 'enable', '--now', `${APP}.service`]);
    // Without lingering, a user service only runs while the user is logged in.
    const user = os.userInfo().username;
    const linger = run('loginctl', ['show-user', user, '-p', 'Linger']).stdout.trim();
    if (linger !== 'Linger=yes') {
      console.log('Enabling lingering so the service starts at boot, before you log in (sudo may ask for your password)...');
      const r = run('sudo', ['loginctl', 'enable-linger', user], { stdio: 'inherit' });
      if (r.status !== 0) console.log(`Could not enable lingering. Run "sudo loginctl enable-linger ${user}" to start at boot; until then it starts at login.`);
    }
    console.log(`systemd user service "${APP}" installed and started.`);
  },
  uninstall() {
    sc('disable', '--now', `${APP}.service`);
    fs.rmSync(unitFile, { force: true });
    sc('daemon-reload');
  },
  status: () => {
    const r = sc('is-active', `${APP}.service`);
    return r.stdout.trim() || 'not installed';
  },
  start: () => sc('start', `${APP}.service`),
  stop: () => sc('stop', `${APP}.service`),
};

// ---- macOS: launchd -------------------------------------------------------------------------

const boot = () => flags.has('--boot');
const plistFile = () => (boot() ? `/Library/LaunchDaemons/${LABEL}.plist` : path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`));
const domain = () => (boot() ? 'system' : `gui/${process.getuid?.()}`);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const mac = {
  install(exe) {
    const out = path.join(serviceConfigDir, 'logs', 'launchd.log');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const user = os.userInfo().username;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(exe)}</string><string>--service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(out)}</string>
  <key>StandardErrorPath</key><string>${esc(out)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${esc(os.homedir())}</string>
    <key>PATH</key><string>${esc(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string>
  </dict>${boot() ? `\n  <key>UserName</key><string>${user}</string>` : ''}
</dict></plist>
`;
    if (boot()) {
      const tmp = path.join(os.tmpdir(), `${LABEL}.plist`);
      fs.writeFileSync(tmp, plist);
      sudo('install', ['-m', '644', '-o', 'root', '-g', 'wheel', tmp, plistFile()]);
      run('sudo', ['launchctl', 'bootout', `${domain()}/${LABEL}`]);
      sudo('launchctl', ['bootstrap', domain(), plistFile()]);
    } else {
      fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
      fs.writeFileSync(plistFile(), plist);
      run('launchctl', ['bootout', `${domain()}/${LABEL}`]);
      mustRun('launchctl', ['bootstrap', domain(), plistFile()]);
    }
    console.log(`launchd ${boot() ? 'daemon (starts at boot)' : 'agent (starts at login)'} "${LABEL}" installed and started.`);
  },
  uninstall() {
    if (boot()) {
      run('sudo', ['launchctl', 'bootout', `${domain()}/${LABEL}`], { stdio: 'inherit' });
      run('sudo', ['rm', '-f', plistFile()], { stdio: 'inherit' });
    } else {
      run('launchctl', ['bootout', `${domain()}/${LABEL}`]);
      fs.rmSync(plistFile(), { force: true });
    }
  },
  status: () => {
    const r = run('launchctl', ['print', `${domain()}/${LABEL}`]);
    if (r.status !== 0) return 'not installed';
    return /state = running/.test(r.stdout) ? 'running' : 'loaded, not running';
  },
  start: () => run('launchctl', ['kickstart', `${domain()}/${LABEL}`]),
  stop: () => run('launchctl', ['kill', 'SIGTERM', `${domain()}/${LABEL}`]),
};


// ---- commands -------------------------------------------------------------------------------

function readUrl() {
  return fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf8').trim() : undefined;
}

async function waitForUrl(seconds) {
  const stale = readUrl();
  if (stale) fs.rmSync(urlFile, { force: true }); // wait for the URL of THIS run
  for (let i = 0; i < seconds; i++) {
    const u = readUrl();
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return stale;
}

/** `<exe> service <cmd> [flags]`. `exe` is the executable to register (the running one inside the standalone build). */
export async function runServiceCommand(argv: string[], exe?: string): Promise<void> {
  const [cmd = 'help', ...more] = argv;
  rest = more;
  flags = new Set(more.filter((a) => a.startsWith('-')));
  defaultExe = exe;
  const impl = { win32: win, linux, darwin: mac }[plat];
  if (!impl) return die(`Unsupported platform: ${plat}`);
  switch (cmd) {
    case 'install': {
      const exe = findExe();
      console.log(`Using ${exe}\nFirst-time setup (workspace folder, API key, dev tunnel sign-in)...\n`);
      if (!flags.has('--skip-setup')) {
        const setup = run(exe, ['--setup'], { stdio: 'inherit' });
        if (setup.status !== 0) die('Setup failed; the service was not installed.');
      }
      impl.uninstall?.call(impl); // stop a previous instance so the new one can bind the ports
      impl.install(exe);
      console.log('\nWaiting for the tunnel address (up to 60 s)...');
      const url = await waitForUrl(60);
      console.log(url ? `\nPublic MCP endpoint: ${url}` : `\nNot ready yet. Check later with:  copilot-workspace-mcp service url   (or logs)`);
      console.log(`Web UI : http://localhost:8791\nLog    : ${logFile}\nAddress: ${urlFile}`);
      break;
    }
    case 'uninstall':
      impl.uninstall();
      console.log(`Service removed. Config and logs are kept in ${serviceConfigDir}`);
      break;
    case 'status':
      console.log(`Service: ${impl.status()}\nPublic MCP endpoint: ${readUrl() ?? '(none yet)'}\nWeb UI: http://localhost:8791\nLog: ${logFile}`);
      break;
    case 'start':
    case 'stop':
      impl[cmd]();
      console.log(`${cmd} requested.`);
      break;
    case 'restart':
      impl.stop();
      await new Promise((r) => setTimeout(r, 2000));
      impl.start();
      console.log('restart requested.');
      break;
    case 'url': {
      const u = readUrl();
      if (!u) die(`No address yet. Is the service running? See ${logFile}`);
      console.log(u);
      break;
    }
    case 'logs': {
      if (!fs.existsSync(logFile)) die(`No log yet: ${logFile}`);
      const lines = fs.readFileSync(logFile, 'utf8').split('\n');
      console.log(lines.slice(-80).join('\n'));
      if (flags.has('-f')) {
        let pos = fs.statSync(logFile).size;
        setInterval(() => {
          const size = fs.statSync(logFile).size;
          if (size < pos) pos = 0; // rotated
          if (size > pos) {
            const fd = fs.openSync(logFile, 'r');
            const buf = Buffer.alloc(size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            fs.closeSync(fd);
            process.stdout.write(buf.toString());
            pos = size;
          }
        }, 1000);
      }
      break;
    }
    default:
      console.log(`Usage: copilot-workspace-mcp service <install|uninstall|status|start|stop|restart|url|logs [-f]> [--exe <path>] [--boot] [--skip-setup]
    install   run first-time setup, register the service so it starts with the machine, start it, print the tunnel address
    url       print the public tunnel address      logs  show the log (${logFile})`);
  }
}
