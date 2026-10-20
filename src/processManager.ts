import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { AppConfig } from './config.js';
import { AccessError } from './security.js';

/** Tokens may contain only these characters: no quotes, pipes, redirects, expansions or command separators. */
const SAFE_TOKEN = /^[A-Za-z0-9_@+=:,./\\-]+$/;

/**
 * Validate `command` against the admin allowlist and return its argv.
 * Each allowlist entry is a command prefix ("npm run dev"); extra arguments after it are allowed
 * but every token must be free of shell metacharacters. Do not allowlist interpreters
 * ("node", "python", "powershell") because their arguments can run arbitrary code.
 */
export function parseCommand(command: string, allowed: string[]): string[] {
  if (!allowed.length) throw new AccessError('run_command is disabled: RUN_ALLOWED_COMMANDS is empty.');
  if (/[\r\n\0]/.test(command)) throw new AccessError('command must be a single line.');
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new AccessError('command is required.');
  const bad = tokens.find((t) => !SAFE_TOKEN.test(t));
  if (bad) {
    throw new AccessError(
      `Argument "${bad}" contains characters that are not allowed (quotes, | & ; < > $ ( ) % and similar). ` +
        'Pass a plain command such as "npm run dev".',
    );
  }
  const ok = allowed.some((entry) => {
    const prefix = entry.trim().split(/\s+/);
    return prefix.length <= tokens.length && prefix.every((p, i) => p.toLowerCase() === tokens[i].toLowerCase());
  });
  if (!ok) throw new AccessError(`Command not allowed. Allowed commands: ${allowed.join(' | ')}`);
  return tokens;
}

export interface ManagedProcess {
  id: string;
  owner: string;
  command: string;
  alias: string;
  startedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  output: string;
  truncated: boolean;
  child: ChildProcess;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProcessManager {
  private procs = new Map<string, ManagedProcess>();

  constructor(private config: AppConfig) {}

  /** Owner scoping keeps one chat from reading or killing another chat's processes. */
  list(owner: string) {
    return [...this.procs.values()].filter((p) => p.owner === owner);
  }

  get(owner: string, id: string): ManagedProcess {
    const p = this.procs.get(id);
    if (!p || p.owner !== owner) throw new AccessError(`No process "${id}" for this chat. Use list_processes.`);
    return p;
  }

  start(owner: string, alias: string, cwd: string, command: string): ManagedProcess {
    const argv = parseCommand(command, this.config.runAllowedCommands);
    const running = [...this.procs.values()].filter((p) => p.exitCode === undefined && p.signal === undefined);
    if (running.length >= this.config.maxBackgroundProcesses) {
      throw new AccessError(
        `Too many running processes (max ${this.config.maxBackgroundProcesses}). Stop one with process_stop.`,
      );
    }
    // Never hand the server's own secret to child processes.
    const { MCP_API_KEY: _omit, ...env } = process.env;
    const opts = {
      cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    // Windows needs a shell to resolve npm.cmd; every token was validated metacharacter-free above.
    const child =
      process.platform === 'win32' ? spawn(argv.join(' '), { ...opts, shell: true }) : spawn(argv[0], argv.slice(1), opts);
    const proc: ManagedProcess = {
      id: crypto.randomBytes(3).toString('hex'),
      owner,
      command: argv.join(' '),
      alias,
      startedAt: Date.now(),
      output: '',
      truncated: false,
      child,
      done: undefined as unknown as Promise<void>,
    };
    const append = (chunk: Buffer) => {
      proc.output += chunk.toString('utf8');
      if (proc.output.length > this.config.maxProcessOutputBytes) {
        proc.output = proc.output.slice(-this.config.maxProcessOutputBytes);
        proc.truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    proc.done = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        append(Buffer.from(`\n[spawn error] ${err.message}\n`));
        proc.exitCode = -1;
        resolve();
      });
      child.on('close', (code, signal) => {
        proc.exitCode = code;
        proc.signal = signal;
        resolve();
      });
    });
    this.procs.set(proc.id, proc);
    // Keep finished processes (for process_output) but cap how many.
    const finished = [...this.procs.values()].filter((p) => p.exitCode !== undefined || p.signal);
    for (const old of finished.slice(0, Math.max(0, finished.length - 20))) this.procs.delete(old.id);
    return proc;
  }

  /** Wait until the process ends, `readyText` appears in its output, or `ms` elapses. */
  async waitFor(proc: ManagedProcess, ms: number, readyText?: string): Promise<'exited' | 'ready' | 'timeout'> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (proc.exitCode !== undefined || proc.signal) return 'exited';
      if (readyText && proc.output.includes(readyText)) return 'ready';
      if (Date.now() >= deadline) return 'timeout';
      await Promise.race([proc.done, sleep(100)]);
    }
  }

  async stop(proc: ManagedProcess) {
    if (proc.exitCode !== undefined || proc.signal) return;
    const pid = proc.child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        // Kill the whole tree: "npm run dev" spawns node children that outlive the shell.
        await new Promise<void>((resolve) =>
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', () =>
            resolve(),
          ),
        );
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          proc.child.kill('SIGTERM');
        }
      }
    }
    await Promise.race([proc.done, sleep(3000)]);
    if (proc.exitCode === undefined && !proc.signal && pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await Promise.race([proc.done, sleep(1000)]);
    }
  }

  async shutdown() {
    await Promise.all([...this.procs.values()].map((p) => this.stop(p)));
  }
}
