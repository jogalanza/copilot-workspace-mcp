import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AccessError, resolveUserPath } from './security.js';

const MAX_OUTPUT_CHARS = 100_000;

/** Branch / ref names: no leading "-" (option injection), no ":" (refspecs), no "+" (forced refspecs), no whitespace. */
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^-]*$/;
/** Remote *names* only: URLs and paths are refused so a push/pull cannot be pointed at an arbitrary host. */
const REMOTE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function assertRef(value: string, what = 'ref'): string {
  const v = value.trim();
  if (!REF_RE.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) {
    throw new AccessError(`Invalid ${what} "${value}".`);
  }
  return v;
}

export function assertRemote(value: string): string {
  const v = value.trim();
  if (!REMOTE_RE.test(v)) throw new AccessError(`Invalid remote name "${value}" (use a configured remote such as "origin").`);
  return v;
}

/**
 * Validate user-supplied paths and return them relative to the repo working directory
 * (forward slashes). Anything inside .git is refused.
 */
export async function gitPaths(root: string, paths: string[]): Promise<string[]> {
  const realRoot = await fsp.realpath(root);
  const out: string[] = [];
  for (const p of paths) {
    const { target } = await resolveUserPath(root, p);
    const rel = path.relative(realRoot, target).split(path.sep).join('/') || '.';
    if (rel.split('/').some((s) => s.toLowerCase() === '.git')) throw new AccessError('Paths inside ".git" are not allowed.');
    out.push(rel);
  }
  return out;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run git without a shell. Never prompts for credentials and never opens a pager or editor. */
export function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
          GCM_INTERACTIVE: 'never',
        },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        if (e && e.code === 'ENOENT') return reject(new AccessError('git is not installed or not on the PATH of the server.'));
        const code = !e ? 0 : typeof e.code === 'number' ? e.code : 1;
        resolve({ code, stdout, stderr, timedOut: !!e?.killed });
      },
    );
  });
}

const clip = (s: string) =>
  s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: ${s.length} chars]` : s;

/** Run git and return combined output; a non-zero exit becomes an error carrying git's message. */
export async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const r = await runGit(cwd, args, timeoutMs);
  const body = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n');
  if (r.timedOut) throw new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s.\n${clip(body)}`);
  if (r.code !== 0) throw new Error(`git ${args[0]} exited with code ${r.code}.\n${clip(body)}`);
  return clip(body) || '(no output)';
}
