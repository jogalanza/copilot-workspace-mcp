import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? path.normalize(p).toLowerCase() : path.normalize(p));

export class AccessError extends Error {}

/** True if `child` equals `parent` or is inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True for "/x", "C:\x", "C:x" and UNC "\\server\share" (on any platform). */
export function isAbsoluteLike(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\');
}

/** Realpath of the deepest existing ancestor of `p` (resolves symlinks/junctions). */
export async function realpathOfExistingAncestor(p: string): Promise<string> {
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

// ---- path input hygiene (spaces, quotes, URLs) ------------------------------

/**
 * Trim whitespace and strip matching surrounding quotes. Shells, .env files and LLM
 * clients often wrap paths that contain spaces in quotes ("D:/My Projects/x").
 * Spaces *inside* the path are preserved.
 */
export function unquote(value: string): string {
  let s = value.trim();
  for (;;) {
    const q = s[0];
    if (s.length < 2 || (q !== '"' && q !== "'") || s[s.length - 1] !== q) return s;
    const inner = s.slice(1, -1);
    // Only a genuine wrapping pair: 'a'='b' is two quoted parts, not one quoted string.
    if (inner.includes(q)) return s;
    s = inner.trim();
  }
}

/** Clean an absolute folder path from config or a tool: unquote and accept file:// URLs (%20 becomes a space). */
export function cleanAbsolutePath(value: string): string {
  const s = unquote(value);
  if (/^file:\/\//i.test(s)) {
    try {
      return fileURLToPath(s);
    } catch {
      throw new AccessError(`Invalid file URL: ${s}`);
    }
  }
  return s;
}

/** Windows mangles names ending in a space or "." and forbids reserved characters (":" also opens alternate data streams). */
const WIN_BAD_SEGMENT = /[<>:"|?*]|[ .]$/;

function assertPortableSegments(relPath: string) {
  if (process.platform !== 'win32') return;
  for (const seg of relPath.split(/[\\/]+/)) {
    if (seg && seg !== '.' && seg !== '..' && (WIN_BAD_SEGMENT.test(seg) || [...seg].some((c) => c.charCodeAt(0) < 32))) {
      throw new AccessError(
        `Invalid file or folder name "${seg}": on Windows names cannot end with a space or "." or contain < > : " | ? *.`,
      );
    }
  }
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** Segment key that ignores whitespace (and case where the file system does). */
const squash = (s: string) => {
  const k = s.replace(/\s+/g, '');
  return caseInsensitive ? k.toLowerCase() : k;
};

/** True if two path segments are equal ignoring whitespace (and case where the FS does). */
export function sameIgnoringSpaces(a: string, b: string): boolean {
  return squash(a) === squash(b);
}

/**
 * Clients and LLMs sometimes drop or add spaces in folder names ("D:\MyProjects" for
 * "D:\My Projects"). Walk `segments` below `base`; any segment that does not exist is
 * matched against the real directory entries ignoring whitespace, and only when exactly
 * one entry matches. Returns the corrected absolute path, or undefined if a segment
 * cannot be matched unambiguously. With `allowMissingLeaf`, the last segment may be a
 * new file (kept as given). Callers must still run containment checks on the result.
 */
export async function matchIgnoringSpaces(
  base: string,
  segments: string[],
  allowMissingLeaf = false,
): Promise<string | undefined> {
  let current = base;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      current = path.dirname(current);
      continue;
    }
    const literal = path.join(current, seg);
    if (await exists(literal)) {
      current = literal;
      continue;
    }
    const entries = await fs.readdir(current).catch(() => [] as string[]);
    const hits = entries.filter((e) => sameIgnoringSpaces(e, seg));
    if (hits.length === 1) {
      current = path.join(current, hits[0]);
      continue;
    }
    if (allowMissingLeaf && i === segments.length - 1 && hits.length === 0) return literal;
    return undefined;
  }
  return current;
}

/** Split an absolute path into its root ("D:\\", "/", "\\\\server\\share\\") and segments. */
export function splitAbsolute(p: string): { base: string; segments: string[] } {
  const abs = path.resolve(p);
  const { root } = path.parse(abs);
  return { base: root, segments: abs.slice(root.length).split(/[\\/]+/).filter(Boolean) };
}

/**
 * Like resolveInside, but tolerant of how clients mangle paths with spaces:
 * surrounding quotes are stripped, and a URL-encoded path ("My%20File.md") is decoded
 * when the literal path does not exist but the decoded one (or its folder) does.
 * The decoded form is re-validated by resolveInside, so encoded "../" cannot escape.
 */
export async function resolveUserPath(root: string, relPath: string): Promise<{ target: string; relPath: string }> {
  const rel = typeof relPath === 'string' ? unquote(relPath) : relPath;
  const literal = await resolveInside(root, rel);
  if (await exists(literal)) return { target: literal, relPath: rel };

  let candidate = rel;
  if (/%[0-9A-Fa-f]{2}/.test(rel)) {
    try {
      const decodedRel = decodeURIComponent(rel);
      const decoded = await resolveInside(root, decodedRel);
      if ((await exists(decoded)) || (!(await exists(path.dirname(literal))) && (await exists(path.dirname(decoded))))) {
        return { target: decoded, relPath: decodedRel };
      }
      candidate = decodedRel;
    } catch (err) {
      if (err instanceof AccessError) throw err;
      /* malformed escape: keep the literal */
    }
  }

  // Last resort: the client dropped/added spaces in a folder or file name.
  const realRoot = await fs.realpath(root);
  const matched = await matchIgnoringSpaces(realRoot, candidate.split(/[\\/]+/), true);
  if (matched && matched !== path.resolve(realRoot, candidate)) {
    const fixedRel = path.relative(realRoot, matched).split(path.sep).join('/');
    if (fixedRel && !fixedRel.startsWith('..')) {
      return { target: await resolveInside(root, fixedRel), relPath: fixedRel }; // re-validated
    }
  }
  return { target: literal, relPath: rel };
}

/**
 * Resolve a workspace-relative path and guarantee it stays inside the workspace,
 * including after following symlinks / junctions.
 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.trim() === '') throw new AccessError('Path is required.');
  relPath = unquote(relPath);
  if (relPath === '') throw new AccessError('Path is required.');
  if (relPath.includes('\0')) throw new AccessError('Invalid path.');
  if (isAbsoluteLike(relPath)) {
    throw new AccessError('Use a path relative to the workspace root.');
  }
  assertPortableSegments(relPath);
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

export const MAX_GLOB_LENGTH = 512;
export const MAX_GLOB_NESTING = 8;

/**
 * Glob patterns must be relative, must not climb out of the workspace, and must be
 * small and shallow. The nesting cap mitigates CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm
 * (braces <= 3.0.3 stack exhaustion via deeply nested brace patterns; no patched release yet).
 */
export function assertSafeGlob(pattern: string) {
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new AccessError(`Glob pattern is too long (max ${MAX_GLOB_LENGTH} characters).`);
  }
  let depth = 0;
  let max = 0;
  for (const ch of pattern) {
    if (ch === '{' || ch === '(' || ch === '[') max = Math.max(max, ++depth);
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
  }
  if (max > MAX_GLOB_NESTING) {
    throw new AccessError(`Glob pattern is nested too deeply (max ${MAX_GLOB_NESTING} levels).`);
  }
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
