import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from './config.js';
import type { StateStore } from './db.js';
import { assertUrlAllowed, type BrowserManager } from './browserManager.js';
import type { ManagedProcess, ProcessManager } from './processManager.js';
import { AccessError, assertSafeGlob, assertWritable, resolveInside, resolveUserPath, unquote } from './security.js';
import type { RequestContext, ResolvedWorkspace, WorkspaceSelector, WorkspaceService } from './workspaceManager.js';

export const SERVER_NAME = 'm365-code-analyzer';
export const SERVER_VERSION = '1.3.0';

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

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const tag = (ws: ResolvedWorkspace) => `[workspace: ${ws.alias}]`;

export interface McpDeps {
  config: AppConfig;
  store: StateStore;
  workspaces: WorkspaceService;
  /** Shared across requests (the MCP server itself is rebuilt per request). Set when ENABLE_BROWSER=true. */
  browser?: BrowserManager;
  /** Shared across requests. Set when RUN_ALLOWED_COMMANDS is non-empty. */
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
    try {
      key = workspaces.conversationKey(ctx, sel);
      const out = await fn(audit);
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
          const resp = await p.goto(url.href, { waitUntil: args.waitUntil ?? 'load' });
          return `Opened (HTTP ${resp?.status() ?? 'n/a'})\n${await state(p)}`;
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
          const proc = pm.start(ownerKey(args), ws.alias, await fsp.realpath(ws.root), args.command);
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

  return server;
}
