import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from './config.js';
import type { StateStore } from './db.js';
import { AccessError, assertSafeGlob, assertWritable, resolveInside, resolveUserPath, unquote } from './security.js';
import type { RequestContext, ResolvedWorkspace, WorkspaceSelector, WorkspaceService } from './workspaceManager.js';

export const SERVER_NAME = 'm365-code-analyzer';
export const SERVER_VERSION = '1.3.0';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

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

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const tag = (ws: ResolvedWorkspace) => `[workspace: ${ws.alias}]`;

export interface McpDeps {
  config: AppConfig;
  store: StateStore;
  workspaces: WorkspaceService;
}

/**
 * Build an MCP server bound to one request context. In stateless HTTP mode a new
 * instance is created per request, so the context (headers) is fixed per instance.
 */
export function createMcpServer(deps: McpDeps, ctx: RequestContext): McpServer {
  const { config, store, workspaces } = deps;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Run a tool, convert errors to tool errors, and record an audit entry. */
  async function run(
    tool: string,
    sel: WorkspaceSelector,
    relPath: string | undefined,
    fn: (audit: { alias?: string }) => Promise<string>,
  ): Promise<ToolResult> {
    const audit: { alias?: string } = {};
    let key: string | undefined;
    try {
      key = workspaces.conversationKey(ctx, sel);
      const out = await fn(audit);
      store.audit({ conversationKey: key, tool, alias: audit.alias ?? sel.workspace, relPath, ok: true });
      return text(out);
    } catch (err) {
      const message = err instanceof AccessError ? err.message : `${tool} failed: ${(err as Error).message}`;
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
        const files = (
          await fg(pattern, {
            cwd: ws.root,
            dot: true,
            onlyFiles: true,
            followSymbolicLinks: false,
            suppressErrors: true,
            ignore: ['**/node_modules/**', '**/.git/**'],
          })
        ).sort();
        const shown = files.slice(0, limit);
        const note = files.length > limit ? `\n(showing ${limit} of ${files.length}; narrow the pattern)` : '';
        return `${tag(ws)} ${files.length} file(s)\n${shown.join('\n')}${note}`;
      }),
  );

  server.registerTool(
    'ws_read_file',
    {
      description: 'Read a UTF-8 text file from the current workspace.',
      inputSchema: {
        filePath: z
          .string()
          .nullish()
          .describe(
            'Required. Path relative to the workspace root, e.g. "src/My Notes.md", or an absolute path inside any ' +
              'registered workspace (it is routed to that workspace). Spaces are fine; do not quote or URL-encode.',
          ),
        ...filePathAliases,
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
          return `${tag(ws)} ${rel}\n${buf.toString('utf8')}${truncated}`;
        } finally {
          await fh.close();
        }
      }),
  );

  server.registerTool(
    'ws_write_file',
    {
      description:
        'Create or overwrite a text file in the current workspace (atomic write). Writing inside .git or ' +
        'node_modules is not allowed.',
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
        const tmp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        try {
          await fsp.writeFile(tmp, args.content, { encoding: 'utf8', flag: 'wx' });
          await fsp.rename(tmp, target);
        } catch (err) {
          await fsp.rm(tmp, { force: true });
          throw err;
        }
        return `${tag(ws)} ${existing ? 'Updated' : 'Created'} ${rel} (${bytes} bytes).`;
      }),
  );

  return server;
}
