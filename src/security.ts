import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? path.normalize(p).toLowerCase() : path.normalize(p));

export class AccessError extends Error {}

/** True if `child` equals `parent` or is inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Realpath of the deepest existing ancestor of `p` (resolves symlinks/junctions). */
async function realpathOfExistingAncestor(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, path.relative(current, p));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

/**
 * Resolve a workspace-relative path and guarantee it stays inside the workspace,
 * including after following symlinks / junctions.
 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.trim() === '') throw new AccessError('Path is required.');
  if (relPath.includes('\0')) throw new AccessError('Invalid path.');
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new AccessError('Use a path relative to the workspace root.');
  }
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relPath);
  if (!isInside(realRoot, target)) throw new AccessError(`Path escapes the workspace: ${relPath}`);
  const realTarget = await realpathOfExistingAncestor(target);
  if (!isInside(realRoot, realTarget)) throw new AccessError(`Path escapes the workspace via a link: ${relPath}`);
  return target;
}

const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules']);

/** Writes into VCS metadata or dependency folders are refused. */
export function assertWritable(root: string, target: string, extraBlocked: string[] = []) {
  const rel = path.relative(root, target);
  if (rel === '') throw new AccessError('Cannot write to the workspace root itself.');
  const segments = rel.split(/[\\/]+/).map((s) => s.toLowerCase());
  const hit = segments.find((s) => PROTECTED_SEGMENTS.has(s));
  if (hit) throw new AccessError(`Writing inside "${hit}" is not allowed.`);
  for (const blocked of extraBlocked) {
    if (norm(target) === norm(blocked) || norm(target).startsWith(norm(blocked) + '-')) {
      throw new AccessError('Writing to the server state database is not allowed.');
    }
  }
}

/** Glob patterns must be relative and must not climb out of the workspace. */
export function assertSafeGlob(pattern: string) {
  if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.startsWith('\\\\')) {
    throw new AccessError('Glob pattern must be relative to the workspace.');
  }
  if (pattern.split(/[\\/]+/).includes('..')) throw new AccessError('Glob pattern must not contain "..".');
}

export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertAlias(alias: string) {
  if (!ALIAS_RE.test(alias)) {
    throw new AccessError('Workspace alias must be 1-64 chars: letters, digits, ".", "_" or "-".');
  }
}

/** Constant-time API-key comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Extract an API key from `api-key` header, `Authorization: Bearer`, or `?api_key=`. */
export function extractApiKey(headers: Record<string, string | string[] | undefined>, query: unknown): string | undefined {
  const h = headers['api-key'];
  if (typeof h === 'string' && h) return h;
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const q = (query as Record<string, unknown> | undefined)?.api_key;
  return typeof q === 'string' && q ? q : undefined;
}
