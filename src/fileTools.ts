import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { AccessError } from './security.js';

// ---- exact-string edit ---------------------------------------------------------

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean | null;
}

/** A file saved with CRLF endings is matched by LF-only edits too, and the edit is written back as CRLF. */
const toCrlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

/**
 * Apply exact-string replacements in order, all or nothing. Each `oldString` must occur exactly once
 * (unless `replaceAll`), so an ambiguous edit fails instead of changing the wrong place.
 */
export function applyEdits(content: string, edits: TextEdit[]): { content: string; replacements: number } {
  if (!edits.length) throw new AccessError('No edits given.');
  const crlf = content.includes('\r\n');
  let out = content;
  let replacements = 0;
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `Edit ${i + 1}: ` : '';
    let { oldString, newString } = edit;
    if (oldString === '') throw new AccessError(`${label}oldString must not be empty (use ws_write_file to create or replace a whole file).`);
    if (oldString === newString) throw new AccessError(`${label}oldString and newString are identical.`);
    if (crlf && !oldString.includes('\r')) {
      oldString = toCrlf(oldString);
      newString = toCrlf(newString);
    }
    const count = out.split(oldString).length - 1;
    if (count === 0) {
      throw new AccessError(`${label}oldString was not found. Copy it exactly from the file, including whitespace and indentation.`);
    }
    if (count > 1 && !edit.replaceAll) {
      throw new AccessError(
        `${label}oldString matches ${count} places. Add surrounding context to make it unique, or set replaceAll=true.`,
      );
    }
    // split/join (not String.replace) keeps "$&" and "$1" in newString literal.
    out = out.split(oldString).join(newString);
    replacements += edit.replaceAll ? count : 1;
  });
  return { content: out, replacements };
}

// ---- line-numbered read --------------------------------------------------------

const MAX_LINE_CHARS = 2000;

/** `cat -n` style output for a 1-based `offset` and a line `limit`, with a note when more lines follow. */
export function numberLines(text: string, offset = 1, limit?: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, offset);
  if (start > lines.length) throw new AccessError(`offset ${start} is past the end of the file (${lines.length} lines).`);
  const end = limit ? Math.min(lines.length, start - 1 + limit) : lines.length;
  const width = String(end).length;
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}[line truncated]` : l}`)
    .join('\n');
  return end < lines.length ? `${body}\n[lines ${start}-${end} of ${lines.length}; use offset=${end + 1} to continue]` : body;
}

// ---- grep ----------------------------------------------------------------------

export type GrepMode = 'content' | 'files' | 'count';

export interface GrepOptions {
  /** Absolute directory to search (already checked to be inside the workspace). */
  dir: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  multiline?: boolean;
  context?: number;
  mode: GrepMode;
  maxResults: number;
  maxFileBytes?: number;
}

const MAX_PATTERN_CHARS = 500;
/** A quantified group that itself contains a quantifier, e.g. (a+)+ or (.*)*: the classic catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

/** Compile a user regex, refusing patterns long or nested enough to stall the event loop. */
export function compilePattern(pattern: string, ignoreCase: boolean, multiline: boolean): RegExp {
  if (pattern.length > MAX_PATTERN_CHARS) throw new AccessError(`Pattern is too long (max ${MAX_PATTERN_CHARS} characters).`);
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new AccessError('Pattern has a nested quantifier such as (a+)+, which can hang the server. Simplify it.');
  }
  try {
    return new RegExp(pattern, `g${ignoreCase ? 'i' : ''}${multiline ? 'ms' : ''}`);
  } catch (err) {
    throw new AccessError(`Invalid regular expression: ${(err as Error).message}`);
  }
}

const MAX_SCANNED_LINE = 5000;

/** Search file contents under `dir` with a JavaScript regex; skips binary files, links and oversized files. */
export async function grepFiles(opts: GrepOptions): Promise<string> {
  const re = compilePattern(opts.pattern, opts.ignoreCase ?? false, opts.multiline ?? false);
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const ctx = Math.max(0, Math.min(opts.context ?? 0, 10));
  const files = (
    await fg(opts.glob || '**/*', {
      cwd: opts.dir,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
  ).sort();

  const out: string[] = [];
  let hits = 0;
  let matchedFiles = 0;
  let scanned = 0;
  let full = false;

  for (const rel of files) {
    if (full) break;
    const abs = path.join(opts.dir, rel);
    const st = await fsp.lstat(abs).catch(() => undefined);
    if (!st || !st.isFile() || st.size > maxBytes) continue; // links, specials, huge files
    const buf = await fsp.readFile(abs).catch(() => undefined);
    if (!buf || buf.subarray(0, 8192).includes(0)) continue;
    scanned++;
    const text = buf.toString('utf8');
    const found: { line: number; text: string }[] = [];

    if (opts.multiline) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0] === '') re.lastIndex++;
        const line = text.slice(0, m.index).split('\n').length;
        found.push({ line, text: m[0].split('\n')[0] });
        if (found.length >= opts.maxResults) break;
      }
    } else {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > MAX_SCANNED_LINE) continue; // minified/generated line
        re.lastIndex = 0;
        if (re.test(lines[i])) found.push({ line: i + 1, text: lines[i] });
      }
    }
    if (!found.length) continue;
    matchedFiles++;
    hits += found.length;

    if (opts.mode === 'files') {
      out.push(rel);
      if (out.length >= opts.maxResults) full = true;
    } else if (opts.mode === 'count') {
      out.push(`${rel}: ${found.length}`);
      if (out.length >= opts.maxResults) full = true;
    } else {
      const lines = text.split(/\r?\n/);
      const show = new Set<number>();
      const isHit = new Set(found.map((f) => f.line));
      for (const f of found) {
        for (let n = Math.max(1, f.line - ctx); n <= Math.min(lines.length, f.line + ctx); n++) show.add(n);
      }
      let prev = 0;
      for (const n of [...show].sort((a, b) => a - b)) {
        if (ctx && prev && n > prev + 1) out.push('--');
        const line = lines[n - 1] ?? '';
        out.push(`${rel}${isHit.has(n) ? ':' : '-'}${n}${isHit.has(n) ? ':' : '-'} ${line.length > 500 ? `${line.slice(0, 500)}...` : line}`);
        prev = n;
        if (out.length >= opts.maxResults) {
          full = true;
          break;
        }
      }
    }
  }

  const summary = `${hits} match(es) in ${matchedFiles} file(s) (searched ${scanned} text file(s))`;
  if (!out.length) return `${summary}`;
  return `${summary}\n${out.join('\n')}${full ? `\n[stopped at ${opts.maxResults} result lines; narrow the pattern or glob]` : ''}`;
}

// ---- Jupyter notebooks ---------------------------------------------------------

export interface NotebookEditOptions {
  mode: 'replace' | 'insert' | 'delete';
  /** 0-based index. For insert: the new cell goes after this cell (omit to insert at the top). */
  cellIndex?: number | null;
  cellId?: string | null;
  source?: string | null;
  cellType?: 'code' | 'markdown' | null;
}

interface NbCell {
  id?: string;
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

/** Jupyter stores source as an array of lines that each keep their trailing newline. */
const toSourceLines = (s: string): string[] => s.split(/(?<=\n)/);

/** Edit one cell of an .ipynb document and return the new JSON text. */
export function editNotebook(json: string, opts: NotebookEditOptions): { json: string; message: string } {
  let nb: { cells?: NbCell[]; nbformat?: number; nbformat_minor?: number };
  try {
    nb = JSON.parse(json);
  } catch {
    throw new AccessError('The file is not valid notebook JSON.');
  }
  if (!Array.isArray(nb.cells)) throw new AccessError('The file has no "cells" array; is it a Jupyter notebook?');
  const cells = nb.cells;

  let index: number | undefined;
  if (opts.cellId) {
    index = cells.findIndex((c) => c.id === opts.cellId);
    if (index < 0) throw new AccessError(`No cell with id "${opts.cellId}".`);
  } else if (opts.cellIndex !== undefined && opts.cellIndex !== null) {
    index = opts.cellIndex;
    if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
      throw new AccessError(`cellIndex ${index} is out of range (the notebook has ${cells.length} cells, numbered from 0).`);
    }
  }

  if (opts.mode === 'insert') {
    if (opts.source === undefined || opts.source === null) throw new AccessError('source is required to insert a cell.');
    const type = opts.cellType ?? 'code';
    const cell: NbCell = { cell_type: type, metadata: {}, source: toSourceLines(opts.source) };
    if (type === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
    if ((nb.nbformat ?? 4) > 4 || (nb.nbformat_minor ?? 0) >= 5) cell.id = crypto.randomBytes(4).toString('hex');
    const at = index === undefined ? 0 : index + 1;
    cells.splice(at, 0, cell);
    return { json: `${JSON.stringify(nb, null, 1)}\n`, message: `Inserted a ${type} cell at index ${at}.` };
  }

  if (index === undefined) throw new AccessError('cellIndex or cellId is required.');
  if (opts.mode === 'delete') {
    cells.splice(index, 1);
    return { json: `${JSON.stringify(nb, null, 1)}\n`, message: `Deleted cell ${index}.` };
  }

  if (opts.source === undefined || opts.source === null) throw new AccessError('source is required to replace a cell.');
  const cell = cells[index];
  cell.source = toSourceLines(opts.source);
  if (opts.cellType && opts.cellType !== cell.cell_type) {
    cell.cell_type = opts.cellType;
    if (opts.cellType === 'markdown') {
      delete cell.outputs;
      delete cell.execution_count;
    }
  }
  if (cell.cell_type === 'code') {
    cell.outputs = []; // stale output no longer matches the new source
    cell.execution_count = null;
  }
  return { json: `${JSON.stringify(nb, null, 1)}\n`, message: `Replaced cell ${index} (${cell.cell_type}).` };
}

// ---- to-do list ----------------------------------------------------------------

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export interface TodoItem {
  content: string;
  status: (typeof TODO_STATUSES)[number];
}

export const MAX_TODOS = 100;

export function validateTodos(items: TodoItem[]): TodoItem[] {
  if (items.length > MAX_TODOS) throw new AccessError(`At most ${MAX_TODOS} to-do items.`);
  if (items.filter((t) => t.status === 'in_progress').length > 1) {
    throw new AccessError('Only one item can be in_progress at a time.');
  }
  return items.map((t) => {
    const content = t.content.trim();
    if (!content) throw new AccessError('Every to-do item needs content.');
    return { content: content.slice(0, 500), status: t.status };
  });
}

export function formatTodos(items: TodoItem[]): string {
  if (!items.length) return '(no to-do items)';
  const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  const done = items.filter((t) => t.status === 'completed').length;
  return `${done}/${items.length} done\n${items.map((t) => `${mark[t.status]} ${t.content}`).join('\n')}`;
}
