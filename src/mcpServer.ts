import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from './config.js';
import type { StateStore } from './db.js';
import { activity } from './activity.js';
import { assertUrlAllowed, loopbackVariants, type BrowserManager } from './browserManager.js';
import { CURL_METHODS, curl } from './curlTool.js';
import {
  MAX_TODOS,
  TODO_STATUSES,
  applyEdits,
  editNotebook,
  formatTodos,
  grepFiles,
  numberLines,
  validateTodos,
  type TextEdit,
  type TodoItem,
} from './fileTools.js';
import { webFetch, webSearch } from './webTools.js';
import { assertRef, assertRemote, git, gitPaths } from './gitTools.js';
import type { ManagedProcess, ProcessManager } from './processManager.js';
import { AccessError, assertSafeGlob, assertWritable, resolveInside, resolveUserPath, unquote } from './security.js';
import type { RequestContext, ResolvedWorkspace, WorkspaceSelector, WorkspaceService } from './workspaceManager.js';

export const SERVER_NAME = 'copilot-workspace-mcp';
export const SERVER_VERSION = '1.4.0';

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };
/** A tool body returns plain text, or text plus images (screenshots). */
type ToolOutput = string | { text: string; images: { data: string; mimeType: string }[] };

const MAX_INLINE_IMAGE_BYTES = 1.5 * 1024 * 1024;

const selectorShape = {
  workspace: z
    .string()
    .nullish()
    .describe(
      'Workspace alias to use for this call. Pass the alias returned by switch_workspace on every call ' +
        'when the client has no conversation id (Microsoft 365 Copilot). Omit to use the chat\'s current workspace.',
    ),
  conversationId: z
    .string()
    .nullish()
    .describe(
      'Conversation id. Copilot Studio: set as a custom value to System.Conversation.Id. Otherwise leave empty; never invent a value.',
    ),
};

/**
 * Alternative argument names for filePath. Agents often guess "path" or "file" (other
 * file servers use them), and an unknown/missing name used to fail schema validation
 * before the tool ran, so the call was neither executed nor audited.
 */
const filePathAliases = {
  path: z.string().nullish().describe('Same as filePath (accepted for compatibility).'),
  file: z.string().nullish().describe('Same as filePath (accepted for compatibility).'),
};

function pickFilePath(args: { filePath?: string | null; path?: string | null; file?: string | null }): string {
  const p = [args.filePath, args.path, args.file].find((v) => typeof v === 'string' && v.trim() !== '');
  if (!p) throw new AccessError('filePath is required (path relative to the workspace root, or an absolute path).');
  return p;
}

/** Write a file by renaming a temp file over it, so readers never see a half-written file. */
async function atomicWrite(target: string, content: string) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const tag = (ws: ResolvedWorkspace) => `[workspace: ${ws.alias}]`;

export interface McpDeps {
  config: AppConfig;
  store: StateStore;
  workspaces: WorkspaceService;
  /** Shared across requests (the MCP server itself is rebuilt per request). Set when ENABLE_BROWSER=true. */
  browser?: BrowserManager;
  /** Shared across requests. Set unless RUN_ALLOWED_COMMANDS is set to an empty list. */
  processes?: ProcessManager;
}

/**
 * Build an MCP server bound to one request context. In stateless HTTP mode a new
 * instance is created per request, so the context (headers) is fixed per instance.
 */
export function createMcpServer(deps: McpDeps, ctx: RequestContext): McpServer {
  const { config, store, workspaces, browser, processes } = deps;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Run a tool, convert errors to tool errors, and record an audit entry. */
  async function run(
    tool: string,
    sel: WorkspaceSelector,
    relPath: string | undefined,
    fn: (audit: { alias?: string }) => Promise<ToolOutput>,
  ): Promise<ToolResult> {
    const audit: { alias?: string } = {};
    let key: string | undefined;
    const started = Date.now();
    try {
      key = workspaces.conversationKey(ctx, sel);
      const out = await fn(audit);
      activity.complete(tool, { ok: true, ms: Date.now() - started, workspace: audit.alias ?? sel.workspace ?? undefined });
      store.audit({ conversationKey: key, tool, alias: audit.alias ?? sel.workspace, relPath, ok: true });
      if (typeof out === 'string') return text(out);
      return {
        content: [
          { type: 'text', text: out.text },
          ...out.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
        ],
      };
    } catch (err) {
      const message = err instanceof AccessError ? err.message : `${tool} failed: ${(err as Error).message}`;
      activity.complete(tool, {
        ok: false,
        ms: Date.now() - started,
        workspace: audit.alias ?? sel.workspace ?? undefined,
        error: message,
      });
      try {
        store.audit({ conversationKey: key, tool, alias: audit.alias ?? sel.workspace, relPath, ok: false, error: message });
      } catch {
        /* never let auditing mask the real error */
      }
      if (!(err instanceof AccessError)) console.error(`[${tool}]`, err);
      return { ...text(message), isError: true };
    }
  }

  server.registerTool(
    'list_workspaces',
    {
      description:
        'List the registered code workspaces (alias and folder), marking the default and the one bound to this chat.',
      inputSchema: { conversationId: selectorShape.conversationId },
    },
    async (args) =>
      run('list_workspaces', args, undefined, async () => {
        const rows = workspaces.list(ctx, args);
        if (!rows.length) return 'No workspaces are registered yet. Use add_workspace.';
        return JSON.stringify(rows, null, 2);
      }),
  );

  server.registerTool(
    'switch_workspace',
    {
      description:
        'Switch the workspace used by this chat. Each chat keeps its own workspace. Returns the alias to pass as ' +
        '"workspace" in later calls when the client has no conversation id.',
      inputSchema: {
        workspace: z.string().describe('Alias of a registered workspace (see list_workspaces).'),
        conversationId: selectorShape.conversationId,
        makeDefault: z
          .boolean()
          .nullish()
          .describe('Also make this the default for chats that have not chosen a workspace.'),
      },
    },
    async (args) =>
      run('switch_workspace', args, undefined, async (audit) => {
        const r = await workspaces.switchTo(ctx, args);
        audit.alias = r.alias;
        const lines = [`Switched to workspace "${r.alias}" (${r.root}).`];
        if (r.boundToConversation) lines.push('This chat will keep using it until switched again.');
        else
          lines.push(
            `No conversation id was provided, so pass workspace="${r.alias}" on every following call in this chat.`,
          );
        if (r.madeDefault) lines.push('It is now also the default workspace.');
        return lines.join(' ');
      }),
  );

  server.registerTool(
    'current_workspace',
    {
      description: 'Show which workspace this chat is using and why (argument, chat binding, or default).',
      inputSchema: selectorShape,
    },
    async (args) =>
      run('current_workspace', args, undefined, async (audit) => {
        const ws = await workspaces.resolve(ctx, args);
        audit.alias = ws.alias;
        return JSON.stringify({ alias: ws.alias, path: ws.root, source: ws.source }, null, 2);
      }),
  );

  server.registerTool(
    'add_workspace',
    {
      description:
        'Register a folder as a named workspace. The folder must be inside one of the server\'s allowed roots.',
      inputSchema: {
        alias: z.string().describe('Short name, e.g. "api" (letters, digits, ".", "_", "-").'),
        path: z
          .string()
          .describe('Absolute folder path on the server machine. Spaces are fine; do not quote or URL-encode it.'),
        makeDefault: z.boolean().nullish().describe('Make it the default workspace.'),
      },
    },
    async (args) =>
      run('add_workspace', {}, args.path, async (audit) => {
        const r = await workspaces.add(args.alias, args.path, args.makeDefault ?? false);
        audit.alias = r.alias;
        return `Registered workspace "${r.alias}" -> ${r.path}${r.isDefault ? ' (default)' : ''}.`;
      }),
  );

  server.registerTool(
    'remove_workspace',
    {
      description: 'Unregister a workspace alias (files are not touched). Chats bound to it lose their binding.',
      inputSchema: { alias: z.string().describe('Alias to remove.') },
    },
    async (args) =>
      run('remove_workspace', {}, undefined, async (audit) => {
        audit.alias = args.alias;
        const r = workspaces.remove(args.alias);
        if (!r.removed) throw new AccessError(`Unknown workspace "${args.alias}". ${workspaces.availableText()}`);
        return `Removed workspace "${args.alias}".${
          r.seeded ? ' Note: it is listed in the server WORKSPACES setting and will be re-added on restart.' : ''
        }`;
      }),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'List files in the current workspace matching a glob pattern (node_modules and .git are excluded). ' +
        'Paths are relative to the workspace root.',
      inputSchema: {
        pattern: z
          .string()
          .default('**/*')
          .describe(
            'Glob relative to the workspace root, e.g. "src/**/*.ts" or "My Folder/**/*.md", or starting with the ' +
              'absolute folder of a registered workspace. Default "**/*". Spaces are fine; do not quote it.',
          ),
        maxResults: z.number().int().positive().nullish().describe(`Maximum entries (cap ${config.maxListResults}).`),
        sortBy: z.enum(['name', 'modified']).nullish().describe('"name" (default) or "modified" (most recently changed first).'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('list_files', args, args.pattern, async (audit) => {
        const raw = unquote(args.pattern) || '**/*';
        assertSafeGlob(raw.replace(/^(?:[A-Za-z]:|\\\\|\/)+/, '')); // limits/nesting/".." before any routing
        const { ws, pattern } = await workspaces.resolveForPattern(ctx, args, raw);
        assertSafeGlob(pattern);
        audit.alias = ws.alias;
        const limit = Math.min(args.maxResults ?? config.maxListResults, config.maxListResults);
        const found = await fg(pattern, {
          cwd: ws.root,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          suppressErrors: true,
          stats: args.sortBy === 'modified',
          ignore: ['**/node_modules/**', '**/.git/**'],
        });
        const files =
          args.sortBy === 'modified'
            ? (found as unknown as { path: string; stats?: { mtimeMs: number } }[])
                .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
                .map((e) => e.path)
            : (found as string[]).sort();
        const shown = files.slice(0, limit);
        const note = files.length > limit ? `\n(showing ${limit} of ${files.length}; narrow the pattern)` : '';
        return `${tag(ws)} ${files.length} file(s)\n${shown.join('\n')}${note}`;
      }),
  );

  server.registerTool(
    'ws_read_file',
    {
      title: 'Read file',
      description:
        'Read a UTF-8 text file from a registered code workspace. Use this instead of any built-in file reader. ' +
        'Pass "filePath" relative to the workspace root (or an absolute path inside a registered workspace) and, ' +
        'if the client has no conversation id, pass the "workspace" alias returned by switch_workspace. ' +
        'Large files are truncated; binary files are reported, not returned. Use list_files first if unsure of the path.',
      inputSchema: {
        filePath: z
          .string()
          .nullish()
          .describe(
            'Required. Path relative to the workspace root, e.g. "src/My Notes.md", or an absolute path inside any ' +
              'registered workspace (it is routed to that workspace). Spaces are fine; do not quote or URL-encode.',
          ),
        ...filePathAliases,
        offset: z.number().int().positive().nullish().describe('First line to return (1-based). Implies line numbers.'),
        limit: z.number().int().positive().nullish().describe('Number of lines to return. Implies line numbers.'),
        lineNumbers: z.boolean().nullish().describe('Prefix each line with its number (useful before ws_edit_file).'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('ws_read_file', args, args.filePath ?? args.path ?? args.file ?? undefined, async (audit) => {
        const filePath = pickFilePath(args);
        const routed = await workspaces.resolveForPath(ctx, args, filePath);
        let ws = routed.ws;
        audit.alias = ws.alias;
        let { target, relPath: rel } = await resolveUserPath(ws.root, routed.relPath);
        let stat = await fsp.stat(target).catch((err: NodeJS.ErrnoException) => {
          // Diagnostics go to stderr (stdout is reserved for the stdio transport).
          console.error('[ws_read_file]', { root: ws.root, filePath, abs: target, code: err?.code, msg: err?.message });
          return undefined;
        });
        if (!stat && ws.source === 'default') {
          // No workspace was chosen for this call/chat (e.g. M365 Copilot omitted "workspace"), so the
          // default was only a guess: look in the other registered workspaces (read-only fallback).
          const found: { ws: ResolvedWorkspace; target: string; rel: string; stat: import('node:fs').Stats }[] = [];
          for (const other of workspaces.list(ctx, args)) {
            if (other.alias === ws.alias) continue;
            try {
              const ows = await workspaces.resolve(ctx, { ...args, workspace: other.alias });
              const r = await resolveUserPath(ows.root, routed.relPath);
              const s = await fsp.stat(r.target);
              if (s.isFile()) found.push({ ws: ows, target: r.target, rel: r.relPath, stat: s });
            } catch {
              /* not in this workspace */
            }
          }
          if (found.length === 1) {
            ({ ws, target, rel, stat } = found[0]);
            audit.alias = ws.alias;
          } else if (found.length > 1) {
            throw new AccessError(
              `File not found in the default workspace "${routed.ws.alias}". It exists in: ` +
                `${found.map((f) => f.ws.alias).join(', ')}. Pass workspace="<alias>".`,
            );
          }
        }
        if (!stat) throw new AccessError(`File not found: ${rel} ${tag(ws)}`);
        if (!stat.isFile()) throw new AccessError(`Not a file: ${rel}`);
        const fh = await fsp.open(target, 'r');
        try {
          const size = Math.min(stat.size, config.maxReadBytes);
          const buf = Buffer.alloc(size);
          await fh.read(buf, 0, size, 0);
          if (buf.subarray(0, 8192).includes(0)) return `${tag(ws)} ${rel} is a binary file (${stat.size} bytes).`;
          const truncated =
            stat.size > config.maxReadBytes ? `\n\n[truncated: showing ${size} of ${stat.size} bytes]` : '';
          let content = buf.toString('utf8');
          if (args.offset || args.limit || args.lineNumbers) content = numberLines(content, args.offset ?? 1, args.limit ?? undefined);
          return `${tag(ws)} ${rel}\n${content}${truncated}`;
        } finally {
          await fh.close();
        }
      }),
  );

  server.registerTool(
    'ws_write_file',
    {
      title: 'Write file',
      description:
        'Create or overwrite a UTF-8 text file in a registered code workspace (atomic write). Use this instead of ' +
        'any built-in file writer. Pass "filePath" relative to the workspace root, the full new "content", and, if ' +
        'the client has no conversation id, the "workspace" alias returned by switch_workspace. Missing parent ' +
        'folders are created by default. Writing inside .git or node_modules is not allowed.',
      inputSchema: {
        filePath: z
          .string()
          .nullish()
          .describe('Required. Path relative to the workspace root, or an absolute path inside a registered workspace.'),
        ...filePathAliases,
        content: z.string().describe('Full new file content (UTF-8).'),
        createDirs: z.boolean().nullish().describe('Create missing parent folders. Default true.'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('ws_write_file', args, args.filePath ?? args.path ?? args.file ?? undefined, async (audit) => {
        const filePath = pickFilePath(args);
        const routed = await workspaces.resolveForPath(ctx, args, filePath);
        const ws = routed.ws;
        audit.alias = ws.alias;
        const { target, relPath: rel } = await resolveUserPath(ws.root, routed.relPath);
        assertWritable(ws.root, target, [config.stateDbPath]);
        const bytes = Buffer.byteLength(args.content, 'utf8');
        if (bytes > config.maxWriteBytes) {
          throw new AccessError(`Content is ${bytes} bytes; the limit is ${config.maxWriteBytes}.`);
        }
        const existing = await fsp.stat(target).catch(() => undefined);
        if (existing && !existing.isFile()) throw new AccessError(`Not a file: ${rel}`);
        const dir = path.dirname(target);
        if (args.createDirs ?? true) await fsp.mkdir(dir, { recursive: true });
        // Re-check containment after creating folders (defends against races with links).
        await resolveInside(ws.root, rel);
        await atomicWrite(target, args.content);
        return `${tag(ws)} ${existing ? 'Updated' : 'Created'} ${rel} (${bytes} bytes).`;
      }),
  );

  /** Resolve an existing, writable text file for an in-place edit (ws_edit_file, notebook_edit). */
  async function editableFile(args: WorkspaceSelector & { filePath?: string | null; path?: string | null; file?: string | null }) {
    const routed = await workspaces.resolveForPath(ctx, args, pickFilePath(args));
    const { target, relPath: rel } = await resolveUserPath(routed.ws.root, routed.relPath);
    assertWritable(routed.ws.root, target, [config.stateDbPath]);
    const stat = await fsp.stat(target).catch(() => undefined);
    if (!stat) throw new AccessError(`File not found: ${rel} ${tag(routed.ws)}`);
    if (!stat.isFile()) throw new AccessError(`Not a file: ${rel}`);
    if (stat.size > config.maxWriteBytes) throw new AccessError(`File is ${stat.size} bytes; the edit limit is ${config.maxWriteBytes}.`);
    const original = await fsp.readFile(target, 'utf8');
    if (original.includes('\0')) throw new AccessError(`${rel} is a binary file.`);
    return { ws: routed.ws, target, rel, original };
  }

  /** Save an edited file, refusing results over the write limit. */
  async function saveEdited(f: { ws: ResolvedWorkspace; target: string; rel: string }, content: string) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > config.maxWriteBytes) throw new AccessError(`Result is ${bytes} bytes; the limit is ${config.maxWriteBytes}.`);
    await resolveInside(f.ws.root, f.rel); // re-check containment right before writing
    await atomicWrite(f.target, content);
    return bytes;
  }

  const editShape = z.object({
    oldString: z.string().describe('Exact text to replace, including whitespace. Must be unique in the file unless replaceAll is set.'),
    newString: z.string().describe('Replacement text.'),
    replaceAll: z.boolean().nullish().describe('Replace every occurrence instead of requiring a unique match.'),
  });

  server.registerTool(
    'ws_edit_file',
    {
      title: 'Edit file',
      description:
        'Change part of an existing text file by exact string replacement, without resending the whole file. Prefer this ' +
        'over ws_write_file for small changes. "oldString" must match exactly once (include enough surrounding lines to ' +
        'make it unique) unless replaceAll=true. Pass several changes in "edits" to apply them in order, all or nothing. ' +
        'Read the file first (ws_read_file) so oldString is copied exactly.',
      inputSchema: {
        filePath: z.string().nullish().describe('Required. Path relative to the workspace root, or absolute inside a registered workspace.'),
        ...filePathAliases,
        oldString: z.string().nullish().describe('Exact text to replace (single edit).'),
        newString: z.string().nullish().describe('Replacement text (single edit).'),
        replaceAll: z.boolean().nullish().describe('Replace every occurrence (single edit).'),
        edits: z.array(editShape).max(50).nullish().describe('Several edits applied in order, all or nothing. Use instead of oldString/newString.'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('ws_edit_file', args, args.filePath ?? args.path ?? args.file ?? undefined, async (audit) => {
        let edits: TextEdit[];
        if (args.edits?.length) {
          if (args.oldString != null || args.newString != null) throw new AccessError('Pass either "edits" or oldString/newString, not both.');
          edits = args.edits;
        } else {
          if (args.oldString == null || args.newString == null) throw new AccessError('oldString and newString are required.');
          edits = [{ oldString: args.oldString, newString: args.newString, replaceAll: args.replaceAll }];
        }
        const f = await editableFile(args);
        audit.alias = f.ws.alias;
        const { content, replacements } = applyEdits(f.original, edits);
        const bytes = await saveEdited(f, content);
        return `${tag(f.ws)} Edited ${f.rel}: ${replacements} replacement(s) (${bytes} bytes).`;
      }),
  );

  server.registerTool(
    'ws_grep',
    {
      title: 'Search file contents',
      description:
        'Search file contents in the workspace with a regular expression (JavaScript syntax). node_modules and .git are ' +
        'skipped, as are binary and very large files. Output modes: "content" (default; file:line: text, optionally with ' +
        'context lines), "files" (matching file names only) or "count" (matches per file). Narrow with "glob" ' +
        '(e.g. "**/*.ts") and "path" (a sub-folder).',
      inputSchema: {
        pattern: z.string().describe('Regular expression, e.g. "function\\s+handle\\w+". Use \\\\ to match a literal backslash.'),
        glob: z.string().nullish().describe('Only search files matching this glob, relative to "path", e.g. "**/*.{ts,tsx}".'),
        path: z.string().nullish().describe('Sub-folder of the workspace to search. Default: the whole workspace.'),
        ignoreCase: z.boolean().nullish().describe('Case-insensitive match.'),
        multiline: z.boolean().nullish().describe('Let "." match newlines and patterns span lines.'),
        context: z.number().int().min(0).max(10).nullish().describe('Lines of context around each match (content mode).'),
        outputMode: z.enum(['content', 'files', 'count']).nullish().describe('Default "content".'),
        maxResults: z.number().int().positive().nullish().describe(`Maximum output lines (cap ${config.maxListResults}).`),
        ...selectorShape,
      },
    },
    async (args) =>
      run('ws_grep', args, args.path ?? args.glob ?? undefined, async (audit) => {
        const ws = await workspaces.resolve(ctx, args);
        audit.alias = ws.alias;
        const sub = args.path && unquote(args.path) !== '.' ? await resolveUserPath(ws.root, args.path) : undefined;
        const dir = sub?.target ?? (await fsp.realpath(ws.root));
        if (sub && !(await fsp.stat(dir).catch(() => undefined))?.isDirectory()) throw new AccessError(`Not a folder: ${sub.relPath}`);
        const glob = args.glob ? unquote(args.glob) : undefined;
        if (glob) assertSafeGlob(glob);
        const body = await grepFiles({
          dir,
          pattern: args.pattern,
          glob,
          ignoreCase: args.ignoreCase ?? false,
          multiline: args.multiline ?? false,
          context: args.context ?? 0,
          mode: args.outputMode ?? 'content',
          maxResults: Math.min(args.maxResults ?? 200, config.maxListResults),
        });
        return `${tag(ws)} ${body}`;
      }),
  );

  server.registerTool(
    'notebook_edit',
    {
      title: 'Edit Jupyter notebook cell',
      description:
        'Replace, insert or delete one cell of a Jupyter notebook (.ipynb). Cells are numbered from 0 (read the notebook ' +
        'with ws_read_file to see them). mode "replace" sets the cell source (and clears a code cell\'s output); "insert" ' +
        'adds a new cell after cellIndex (or at the top when omitted); "delete" removes the cell.',
      inputSchema: {
        filePath: z.string().nullish().describe('Required. Path to the .ipynb file.'),
        ...filePathAliases,
        mode: z.enum(['replace', 'insert', 'delete']).describe('What to do with the cell.'),
        cellIndex: z.number().int().min(0).nullish().describe('0-based cell number.'),
        cellId: z.string().nullish().describe('Cell id, as an alternative to cellIndex.'),
        source: z.string().nullish().describe('New cell source (replace and insert).'),
        cellType: z.enum(['code', 'markdown']).nullish().describe('Cell type. Default: unchanged on replace, "code" on insert.'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('notebook_edit', args, args.filePath ?? args.path ?? args.file ?? undefined, async (audit) => {
        const f = await editableFile(args);
        audit.alias = f.ws.alias;
        if (!/\.ipynb$/i.test(f.rel)) throw new AccessError('notebook_edit only edits .ipynb files.');
        const r = editNotebook(f.original, {
          mode: args.mode,
          cellIndex: args.cellIndex,
          cellId: args.cellId,
          source: args.source,
          cellType: args.cellType,
        });
        await saveEdited(f, r.json);
        return `${tag(f.ws)} ${f.rel}: ${r.message}`;
      }),
  );

  const todoKey = (sel: WorkspaceSelector) => `todos:${ownerKey(sel)}`;
  const readTodos = (sel: WorkspaceSelector): TodoItem[] => {
    try {
      return JSON.parse(store.getSetting(todoKey(sel)) ?? '[]') as TodoItem[];
    } catch {
      return [];
    }
  };

  server.registerTool(
    'todo_write',
    {
      title: 'Write to-do list',
      description:
        'Keep a task list for this chat while working through a multi-step job. Each call REPLACES the whole list, so ' +
        'send every item with its current status ("pending", "in_progress" or "completed"). At most one item may be ' +
        'in_progress. Mark items completed as soon as they are done.',
      inputSchema: {
        todos: z
          .array(z.object({ content: z.string().describe('What needs doing, in imperative form.'), status: z.enum(TODO_STATUSES) }))
          .max(MAX_TODOS)
          .describe('The complete list.'),
        ...selectorShape,
      },
    },
    async (args) =>
      run('todo_write', args, undefined, async () => {
        const todos = validateTodos(args.todos);
        store.setSetting(todoKey(args), JSON.stringify(todos));
        return formatTodos(todos);
      }),
  );

  server.registerTool(
    'todo_read',
    {
      title: 'Read to-do list',
      description: 'Show the current to-do list for this chat (see todo_write).',
      inputSchema: { ...selectorShape },
    },
    async (args) => run('todo_read', args, undefined, async () => formatTodos(readTodos(args))),
  );

  /** Chats share one browser tab / process list per conversation id (or one shared bucket without it). */
  const ownerKey = (sel: WorkspaceSelector) => workspaces.conversationKey(ctx, sel) ?? 'shared';

  if (browser) {
    type Page = import('playwright-core').Page;
    const bm = browser;
    const session = (sel: WorkspaceSelector) => bm.session(ownerKey(sel));
    const page = async (sel: WorkspaceSelector) => (await session(sel)).page;
    const settle = (p: Page) => p.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
    const state = async (p: Page) => `url: ${p.url()}\ntitle: ${await p.title()}`;

    server.registerTool(
      'browser_open',
      {
        title: 'Open page in headless browser',
        description:
          'Open a URL in a headless browser (one tab per chat) and report its final URL, title and HTTP status. ' +
          'Only localhost is allowed unless the server admin extended the host allowlist. Typical use: start a dev server ' +
          'with run_command (background=true), open http://localhost:<port>/, then browser_screenshot. Elements are ' +
          'addressed with CSS selectors or Playwright text selectors such as "text=Sign in".',
        inputSchema: {
          url: z.string().describe('http(s) URL, e.g. http://localhost:5173/'),
          waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).nullish().describe('Default "load".'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_open', args, args.url, async () => {
          const url = assertUrlAllowed(args.url, bm.allowedHosts);
          const p = await page(args);
          const waitUntil = args.waitUntil ?? 'load';
          let resp;
          let note = '';
          try {
            resp = await p.goto(url.href, { waitUntil });
          } catch (err) {
            if (!/ERR_CONNECTION_REFUSED/.test((err as Error).message)) throw err;
            // Nothing answered on this address: try the other loopback spellings (IPv4 vs IPv6) before giving up.
            for (const alt of loopbackVariants(url)) {
              try {
                assertUrlAllowed(alt.href, bm.allowedHosts);
                // Chrome swaps in its error page asynchronously, which makes the next navigation report "interrupted".
                await p.goto('about:blank').catch(() => undefined);
                for (let tries = 0; !resp; tries++) {
                  try {
                    resp = await p.goto(alt.href, { waitUntil });
                  } catch (e) {
                    if (tries >= 2 || !/interrupted by another navigation/.test((e as Error).message)) throw e;
                    await new Promise((r) => setTimeout(r, 150));
                  }
                }
                note = `\n(${url.host} refused the connection, but ${alt.host} answered (the server listens on a different loopback address, IPv4 vs IPv6). Use ${alt.host} for later calls.)`;
                break;
              } catch {
                /* try the next spelling */
              }
            }
            if (!resp) {
              throw new AccessError(
                `Connection refused at ${url.origin}: nothing is listening on that port${loopbackVariants(url).length ? ' (localhost, 127.0.0.1 and [::1] were all tried)' : ''}. ` +
                  'Start the app first (run_command with background=true and readyText), check process_output for a crash or the real port, then call browser_open again.',
              );
            }
          }
          return `Opened (HTTP ${resp?.status() ?? 'n/a'})\n${await state(p)}${note}`;
        }),
    );

    server.registerTool(
      'browser_screenshot',
      {
        title: 'Take screenshot',
        description:
          'Take a PNG screenshot of the current page (or one element) in the headless browser. The image is returned ' +
          'and also saved in the workspace under .screenshots/ so it can be referenced later.',
        inputSchema: {
          fullPage: z.boolean().nullish().describe('Capture the whole scrollable page. Default false (viewport only).'),
          selector: z.string().nullish().describe('Screenshot only this element (CSS or Playwright selector).'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_screenshot', args, undefined, async (audit) => {
          const ws = await workspaces.resolve(ctx, args);
          audit.alias = ws.alias;
          const p = await page(args);
          if (p.url() === 'about:blank') throw new AccessError('No page is open. Call browser_open first.');
          const png = args.selector?.trim()
            ? await p.locator(args.selector.trim()).first().screenshot()
            : await p.screenshot({ fullPage: args.fullPage ?? false });
          const rel = `.screenshots/${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          const { target } = await resolveUserPath(ws.root, rel);
          assertWritable(ws.root, target, [config.stateDbPath]);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await resolveInside(ws.root, rel);
          await fsp.writeFile(target, png);
          const head = `${tag(ws)} Screenshot saved to ${rel} (${png.length} bytes)\n${await state(p)}`;
          if (png.length > MAX_INLINE_IMAGE_BYTES) {
            return `${head}\n(Image too large to return inline; use "selector" to capture a smaller area or fullPage=false.)`;
          }
          return { text: head, images: [{ data: png.toString('base64'), mimeType: 'image/png' }] };
        }),
    );

    server.registerTool(
      'browser_text',
      {
        title: 'Read page text',
        description: 'Read the visible text of the current page or of one element. Output is truncated.',
        inputSchema: {
          selector: z.string().nullish().describe('CSS or Playwright selector. Default: whole page body.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_text', args, undefined, async () => {
          const p = await page(args);
          const body = await p.locator(args.selector?.trim() || 'body').first().innerText();
          const limit = 20_000;
          const shown = body.length > limit ? `${body.slice(0, limit)}\n[truncated: ${body.length} chars]` : body;
          return `${await state(p)}\n\n${shown}`;
        }),
    );

    server.registerTool(
      'browser_click',
      {
        title: 'Click element',
        description: 'Click an element on the current page, then wait briefly for navigation or rendering to settle.',
        inputSchema: {
          selector: z.string().describe('CSS or Playwright selector, e.g. "button#save" or "text=Sign in".'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_click', args, undefined, async () => {
          const p = await page(args);
          await p.locator(args.selector.trim()).first().click();
          await settle(p);
          return `Clicked "${args.selector}"\n${await state(p)}`;
        }),
    );

    server.registerTool(
      'browser_type',
      {
        title: 'Type into field',
        description: 'Fill a text field (replacing its content), optionally pressing Enter afterwards.',
        inputSchema: {
          selector: z.string().describe('CSS or Playwright selector of the input.'),
          text: z.string().describe('Text to enter. Do not include secrets.'),
          pressEnter: z.boolean().nullish().describe('Press Enter after typing. Default false.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_type', args, undefined, async () => {
          const p = await page(args);
          const loc = p.locator(args.selector.trim()).first();
          await loc.fill(args.text);
          if (args.pressEnter) {
            await loc.press('Enter');
            await settle(p);
          }
          return `Typed into "${args.selector}"\n${await state(p)}`;
        }),
    );

    server.registerTool(
      'browser_logs',
      {
        title: 'Browser console and network errors',
        description:
          'Recent console errors/warnings, uncaught page errors, failed requests, HTTP 4xx/5xx responses and blocked ' +
          "requests from this chat's browser tab. Use it to debug a page that renders wrong.",
        inputSchema: {
          clear: z.boolean().nullish().describe('Clear the log after reading.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_logs', args, undefined, async () => {
          const { logs } = await session(args);
          const out = logs.length ? logs.join('\n') : '(no console errors or failed requests)';
          if (args.clear) logs.length = 0;
          return out;
        }),
    );

    server.registerTool(
      'browser_eval',
      {
        title: 'Run JavaScript in page',
        description:
          'Evaluate a JavaScript expression in the current page and return the JSON result, e.g. ' +
          '"document.title" or "[...document.querySelectorAll(\'a\')].map(a => a.href)". For several statements wrap them ' +
          'in an async function: "(async () => { ...; return value; })()". The script runs inside the page, so it can only ' +
          'reach hosts the browser is allowed to load, and it cannot touch the server or the file system.',
        inputSchema: {
          expression: z.string().describe('JavaScript expression; its (awaited) value is returned as JSON.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('browser_eval', args, undefined, async () => {
          const p = await page(args);
          if (p.url() === 'about:blank') throw new AccessError('No page is open. Call browser_open first.');
          // Wrapped so a bare expression, a promise, or "await x" style async IIFE all work.
          const value = await p.evaluate(`(async () => (${args.expression}\n))()`);
          const json = JSON.stringify(value, null, 2) ?? 'undefined';
          const limit = 20_000;
          return json.length > limit ? `${json.slice(0, limit)}\n[truncated: ${json.length} chars]` : json;
        }),
    );

    server.registerTool(
      'browser_close',
      {
        title: 'Close browser tab',
        description: "Close this chat's browser session (cookies and page state are discarded).",
        inputSchema: { ...selectorShape },
      },
      async (args) =>
        run('browser_close', args, undefined, async () => {
          await bm.closeSession(ownerKey(args));
          return 'Browser session closed.';
        }),
    );
  }

  if (processes) {
    const pm = processes;
    const fmt = (p: ManagedProcess, tail = 4000) => {
      const running = p.exitCode === undefined && !p.signal;
      const status = running ? 'running' : `exited (code ${p.exitCode ?? 'null'}${p.signal ? `, ${p.signal}` : ''})`;
      const cut = p.truncated || p.output.length > tail;
      const out = p.output.length > tail ? p.output.slice(-tail) : p.output;
      return `process ${p.id} [${status}] in workspace ${p.alias}: ${p.command}\n--- output${cut ? ' (tail)' : ''} ---\n${out || '(no output yet)'}`;
    };

    server.registerTool(
      'run_command',
      {
        title: 'Run command',
        description:
          'Run an allowlisted command (such as "npm run dev", "npm test" or "npm run build") in the workspace root. ' +
          'Only commands the server admin allowlisted are accepted, and arguments may not contain shell operators, quotes or pipes. ' +
          'For servers and watchers set background=true: the call returns a process id once "readyText" appears in the ' +
          'output (or after a few seconds); then use browser_open on the printed URL, process_output to read logs, and ' +
          'process_stop when done. Foreground calls wait for the command to finish and return its exit code and output.',
        inputSchema: {
          command: z.string().describe('Command line, e.g. "npm run dev -- --port 5173".'),
          background: z.boolean().nullish().describe('Keep running after the call returns. Default false.'),
          userApproved: z
            .boolean()
            .nullish()
            .describe(
              'Set true ONLY after the user has explicitly agreed, in this chat, to run this exact command that is not on the ' +
                'allowlist (or is risky). Never set it without asking first.',
            ),
          readyText: z.string().nullish().describe('Background only: return as soon as this text appears, e.g. "Local:".'),
          timeoutSeconds: z
            .number()
            .int()
            .positive()
            .nullish()
            .describe('Foreground: time limit. Background: how long to wait for readyText (max 60, default 5).'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('run_command', args, args.command, async (audit) => {
          const ws = await workspaces.resolve(ctx, args);
          audit.alias = ws.alias;
          const proc = pm.start(ownerKey(args), ws.alias, await fsp.realpath(ws.root), args.command, args.userApproved ?? false);
          if (args.background) {
            const how = await pm.waitFor(proc, Math.min(args.timeoutSeconds ?? 5, 60) * 1000, args.readyText ?? undefined);
            return `${tag(ws)} started in background (${how})\n${fmt(proc)}`;
          }
          const limit = Math.min(args.timeoutSeconds ?? config.runTimeoutSeconds, config.runTimeoutSeconds);
          if ((await pm.waitFor(proc, limit * 1000)) === 'timeout') {
            await pm.stop(proc);
            return `${tag(ws)} timed out after ${limit}s and was stopped\n${fmt(proc)}`;
          }
          return `${tag(ws)} ${fmt(proc)}`;
        }),
    );

    server.registerTool(
      'process_output',
      {
        title: 'Read process output',
        description: 'Show the status and the latest output of a process started by run_command in this chat.',
        inputSchema: {
          id: z.string().describe('Process id returned by run_command.'),
          tailChars: z.number().int().positive().nullish().describe('Trailing characters to return. Default 4000.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('process_output', args, undefined, async () =>
          fmt(pm.get(ownerKey(args), args.id), Math.min(args.tailChars ?? 4000, config.maxProcessOutputBytes)),
        ),
    );

    server.registerTool(
      'process_wait',
      {
        title: 'Wait for process',
        description:
          'Block until a process started by run_command exits, or until "untilText" appears in its output, or the time ' +
          'limit passes; then return its status and latest output. Use it to wait for a build, test run or server to be ready ' +
          'instead of polling process_output. The process keeps running on timeout.',
        inputSchema: {
          id: z.string().describe('Process id returned by run_command.'),
          untilText: z.string().nullish().describe('Return as soon as this text appears in the output, e.g. "Local:" or "Compiled".'),
          timeoutSeconds: z.number().int().positive().nullish().describe(`Maximum wait (cap ${config.runTimeoutSeconds}, default 30).`),
          tailChars: z.number().int().positive().nullish().describe('Trailing output characters to return. Default 4000.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('process_wait', args, undefined, async () => {
          const proc = pm.get(ownerKey(args), args.id);
          const limit = Math.min(args.timeoutSeconds ?? 30, config.runTimeoutSeconds);
          const how = await pm.waitFor(proc, limit * 1000, args.untilText ?? undefined);
          const verdict = how === 'timeout' ? `still running after ${limit}s` : how === 'ready' ? `"${args.untilText}" appeared` : 'process exited';
          return `${verdict}\n${fmt(proc, Math.min(args.tailChars ?? 4000, config.maxProcessOutputBytes))}`;
        }),
    );

    server.registerTool(
      'process_stop',
      {
        title: 'Stop process',
        description: 'Stop a background process (and its child processes) started by run_command in this chat.',
        inputSchema: { id: z.string().describe('Process id returned by run_command.'), ...selectorShape },
      },
      async (args) =>
        run('process_stop', args, undefined, async () => {
          const proc = pm.get(ownerKey(args), args.id);
          await pm.stop(proc);
          return fmt(proc, 1000);
        }),
    );

    server.registerTool(
      'list_processes',
      {
        title: 'List processes',
        description: 'List processes started by run_command in this chat, with their status.',
        inputSchema: { ...selectorShape },
      },
      async (args) =>
        run('list_processes', args, undefined, async () => {
          const list = pm.list(ownerKey(args));
          if (!list.length) return '(no processes)';
          return list
            .map((p) => `${p.id}  ${p.exitCode === undefined && !p.signal ? 'running' : 'exited'}  [${p.alias}] ${p.command}`)
            .join('\n');
        }),
    );
  }

  if (config.enableGit) {
    const timeoutMs = config.runTimeoutSeconds * 1000;
    /** Resolve the workspace, run git there, and prefix the output with the workspace tag. */
    const gitCall = (
      tool: string,
      args: WorkspaceSelector,
      relPath: string | undefined,
      build: (root: string) => Promise<string[]> | string[],
    ) =>
      run(tool, args, relPath, async (audit) => {
        const ws = await workspaces.resolve(ctx, args);
        audit.alias = ws.alias;
        const root = await fsp.realpath(ws.root);
        return `${tag(ws)}\n${await git(root, await build(root), timeoutMs)}`;
      });
    const pathsShape = z.array(z.string()).nullish();

    server.registerTool(
      'git_status',
      {
        title: 'Git status',
        description: 'Show the git status of the workspace (branch, upstream, staged/unstaged/untracked files).',
        inputSchema: { ...selectorShape },
      },
      async (args) => gitCall('git_status', args, undefined, () => ['status', '--short', '--branch']),
    );

    server.registerTool(
      'git_diff',
      {
        title: 'Git diff',
        description:
          'Show changes. Default: unstaged changes. staged=true shows what is staged. "ref" (and optional "ref2") ' +
          'compares against a commit/branch. Limit with "paths". Output is truncated.',
        inputSchema: {
          staged: z.boolean().nullish().describe('Show staged changes (--cached).'),
          ref: z.string().nullish().describe('Commit or branch to compare with, e.g. "main" or "HEAD~1".'),
          ref2: z.string().nullish().describe('Second ref, to diff ref..ref2.'),
          paths: pathsShape.describe('Limit to these files/folders (relative to the workspace root).'),
          stat: z.boolean().nullish().describe('Only a per-file summary (--stat).'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_diff', args, args.paths?.join(', '), async (root) => {
          const a = ['diff', '--no-ext-diff', '--no-textconv'];
          if (args.stat) a.push('--stat');
          if (args.staged) a.push('--cached');
          if (args.ref) a.push(assertRef(args.ref));
          if (args.ref2) a.push(assertRef(args.ref2));
          if (args.paths?.length) a.push('--', ...(await gitPaths(root, args.paths)));
          return a;
        }),
    );

    server.registerTool(
      'git_log',
      {
        title: 'Git log',
        description: 'Show recent commits (hash, author, date, subject), newest first.',
        inputSchema: {
          maxCount: z.number().int().positive().nullish().describe('Number of commits (default 20, max 200).'),
          ref: z.string().nullish().describe('Branch or commit to start from. Default HEAD.'),
          path: z.string().nullish().describe('Only commits touching this file/folder.'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_log', args, args.path ?? undefined, async (root) => {
          const a = ['log', `--max-count=${Math.min(args.maxCount ?? 20, 200)}`, '--date=short', '--format=%h %ad %an  %s%d'];
          if (args.ref) a.push(assertRef(args.ref));
          if (args.path) a.push('--', ...(await gitPaths(root, [args.path])));
          return a;
        }),
    );

    server.registerTool(
      'git_add',
      {
        title: 'Git add',
        description: 'Stage files for commit. Pass explicit paths (use "." for everything).',
        inputSchema: {
          paths: z.array(z.string()).min(1).describe('Files or folders relative to the workspace root, or ["."].'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_add', args, args.paths.join(', '), async (root) => [
          'add',
          '--',
          ...(await gitPaths(root, args.paths)),
        ]),
    );

    server.registerTool(
      'git_commit',
      {
        title: 'Git commit',
        description:
          'Commit the staged changes with the given message (stage first with git_add). all=true also stages ' +
          'modifications to already-tracked files (git commit -a). Uses the git identity configured on the server.',
        inputSchema: {
          message: z.string().min(1).describe('Commit message.'),
          all: z.boolean().nullish().describe('Stage tracked, modified files automatically.'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_commit', args, undefined, () => {
          if (!args.message.trim()) throw new AccessError('Commit message is required.');
          return ['commit', ...(args.all ? ['-a'] : []), '-m', args.message];
        }),
    );

    server.registerTool(
      'git_branch',
      {
        title: 'Git branch',
        description:
          'List branches (default), create a branch (name), or safely delete a merged branch (name + delete=true). ' +
          'Creating does not switch to it; use git_checkout.',
        inputSchema: {
          name: z.string().nullish().describe('Branch to create or delete. Omit to list.'),
          delete: z.boolean().nullish().describe('Delete the named branch (only if fully merged).'),
          from: z.string().nullish().describe('Start point for a new branch. Default HEAD.'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_branch', args, args.name ?? undefined, () => {
          if (!args.name) return ['branch', '-vv', '--all'];
          const name = assertRef(args.name, 'branch name');
          if (args.delete) return ['branch', '-d', name];
          return ['branch', name, ...(args.from ? [assertRef(args.from)] : [])];
        }),
    );

    server.registerTool(
      'git_checkout',
      {
        title: 'Git checkout',
        description:
          'Switch to a branch (git switch). create=true creates it first. Refuses to overwrite uncommitted changes.',
        inputSchema: {
          branch: z.string().describe('Branch name.'),
          create: z.boolean().nullish().describe('Create the branch (git switch -c).'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_checkout', args, args.branch, () => [
          'switch',
          ...(args.create ? ['-c'] : []),
          assertRef(args.branch, 'branch name'),
        ]),
    );

    server.registerTool(
      'git_pull',
      {
        title: 'Git pull',
        description: 'Fetch and fast-forward the current branch from its remote (fast-forward only; never creates merge commits).',
        inputSchema: {
          remote: z.string().nullish().describe('Remote name, e.g. "origin". Default: the branch\'s upstream.'),
          branch: z.string().nullish().describe('Remote branch. Requires "remote".'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_pull', args, args.branch ?? undefined, () => {
          const a = ['pull', '--ff-only'];
          if (args.remote) {
            a.push(assertRemote(args.remote));
            if (args.branch) a.push(assertRef(args.branch, 'branch name'));
          } else if (args.branch) {
            throw new AccessError('"branch" requires "remote".');
          }
          return a;
        }),
    );

    server.registerTool(
      'git_push',
      {
        title: 'Git push',
        description:
          'Push the current branch to a remote. Force-push is not available. setUpstream=true sets the tracking ' +
          'branch on first push. Credentials come from the server\'s git credential helper; it never prompts.',
        inputSchema: {
          remote: z.string().nullish().describe('Remote name. Default "origin".'),
          branch: z.string().nullish().describe('Branch to push. Default: the current branch.'),
          setUpstream: z.boolean().nullish().describe('Pass -u to set the upstream.'),
          ...selectorShape,
        },
      },
      async (args) =>
        gitCall('git_push', args, args.branch ?? undefined, async (root) => {
          const remote = assertRemote(args.remote ?? 'origin');
          let branch = args.branch ? assertRef(args.branch, 'branch name') : undefined;
          if (!branch) {
            const cur = (await git(root, ['branch', '--show-current'], timeoutMs)).trim();
            if (!cur || cur === '(no output)') throw new AccessError('Detached HEAD: pass "branch" explicitly.');
            branch = assertRef(cur, 'branch name');
          }
          return ['push', ...(args.setUpstream ? ['-u'] : []), remote, branch];
        }),
    );
  }

  if (config.enableCurl) {
    server.registerTool(
      'curl',
      {
        title: 'HTTP request (curl)',
        description:
          'Send an HTTP request to test an API endpoint, like curl -i. Supports GET, POST, PUT, PATCH, DELETE, HEAD and ' +
          'OPTIONS with custom headers and a text body. Returns the status line, response headers and body (JSON is ' +
          `pretty-printed). Only hosts the server admin allowed (${config.curlAllowedHosts.join(', ')}) can be called; ` +
          'use run_command with background=true to start the API first.',
        inputSchema: {
          url: z.string().describe('Full http(s) URL, e.g. "http://localhost:3000/api/users?limit=5".'),
          method: z.enum(CURL_METHODS).nullish().describe('HTTP method. Default GET.'),
          headers: z
            .record(z.string(), z.string())
            .nullish()
            .describe('Request headers, e.g. {"Authorization": "Bearer ...", "Accept": "application/json"}.'),
          body: z.string().nullish().describe('Request body text. For JSON pass the JSON string and set Content-Type.'),
          json: z
            .unknown()
            .optional()
            .describe('Alternative to body: a JSON value that is serialized and sent with Content-Type application/json.'),
          followRedirects: z.boolean().nullish().describe('Follow redirects (each hop must be an allowed host). Default false.'),
          timeoutSeconds: z.number().int().positive().nullish().describe(`Time limit (cap ${config.curlTimeoutSeconds}).`),
          ...selectorShape,
        },
      },
      async (args) =>
        run('curl', args, args.url, async () => {
          const headers = { ...(args.headers ?? {}) };
          let body = args.body ?? undefined;
          if (args.json !== undefined && args.json !== null) {
            if (body !== undefined) throw new AccessError('Pass either "body" or "json", not both.');
            body = JSON.stringify(args.json);
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
              headers['Content-Type'] = 'application/json';
            }
          }
          const limit = Math.min(args.timeoutSeconds ?? config.curlTimeoutSeconds, config.curlTimeoutSeconds);
          return curl({
            url: args.url,
            method: args.method ?? 'GET',
            headers,
            body,
            timeoutMs: limit * 1000,
            allowedHosts: config.curlAllowedHosts,
            followRedirects: args.followRedirects ?? false,
          });
        }),
    );
  }

  if (config.enableWebFetch) {
    server.registerTool(
      'web_fetch',
      {
        title: 'Fetch web page',
        description:
          'Download a public web page (or JSON/text URL) and return it as readable text: HTML is converted to markdown-style ' +
          'text with headings, links and lists. Use it to read documentation or an article given its URL. Local and private ' +
          'network addresses are blocked. Long pages are cut; pass "offset" to read on.',
        inputSchema: {
          url: z.string().describe('Full http(s) URL, e.g. "https://example.com/docs/page".'),
          offset: z.number().int().min(0).nullish().describe('Character offset to continue a long page.'),
          maxChars: z.number().int().positive().nullish().describe('Characters to return (default 50000, max 100000).'),
          raw: z.boolean().nullish().describe('Return HTML source as received instead of converting it.'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('web_fetch', args, args.url, async () =>
          webFetch({
            url: args.url,
            timeoutMs: config.webTimeoutSeconds * 1000,
            trustedHosts: config.webAllowedHosts,
            offset: args.offset ?? undefined,
            maxChars: Math.min(args.maxChars ?? 50_000, 100_000),
            raw: args.raw ?? false,
          }),
        ),
    );
  }

  if (config.braveApiKey) {
    const apiKey = config.braveApiKey;
    server.registerTool(
      'web_search',
      {
        title: 'Search the web',
        description:
          'Search the web and return the top results (title, URL, snippet). Follow up with web_fetch to read a result. ' +
          'Use it for current information or documentation you do not already know.',
        inputSchema: {
          query: z.string().describe('Search query.'),
          count: z.number().int().min(1).max(20).nullish().describe('Number of results (default 8).'),
          ...selectorShape,
        },
      },
      async (args) =>
        run('web_search', args, args.query, async () =>
          webSearch({
            query: args.query,
            endpoint: config.webSearchUrl,
            apiKey,
            count: args.count ?? 8,
            timeoutMs: config.webTimeoutSeconds * 1000,
          }),
        ),
    );
  }

  return server;
}
