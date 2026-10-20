import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import fg from 'fast-glob';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, SERVER_VERSION, type McpDeps } from './mcpServer.js';
import { AccessError, extractApiKey, safeEqual } from './security.js';
import type { RequestContext } from './workspaceManager.js';

/** Header carrying the chat id (no "X-" prefix: Copilot Studio MCP connectors drop X- headers). */
export const CONVERSATION_HEADER = 'conversation-id';

export function requestContext(req: Request): RequestContext {
  const conversationKey = req.get(CONVERSATION_HEADER)?.trim() || undefined;
  const client = req.get('mcp-client')?.trim() || (conversationKey ? 'copilot-studio' : 'http');
  return { conversationKey, client: client.slice(0, 64) };
}

const clip = (v: unknown, n: number) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};

function traceMcp(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const body = req.body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
    const args = body?.params?.arguments
      ? Object.fromEntries(Object.entries(body.params.arguments).map(([k, v]) => [k, k === 'content' ? clip(v, 80) : v]))
      : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const capture = (chunk: unknown) => {
      if (chunk && size < 4096) {
        const b =
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
        chunks.push(b);
        size += b.length;
      }
    };
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
    (res as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => (capture(chunk), origWrite(chunk, ...rest));
    (res as unknown as { end: unknown }).end = (chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'function') capture(chunk);
      return origEnd(chunk, ...rest);
    };
    res.on('finish', () => {
      const line = {
        ts: new Date(started).toISOString(),
        ms: Date.now() - started,
        http: `${req.method} ${res.statusCode}`,
        rpc: body?.method,
        tool: body?.params?.name,
        args,
        conversationId: req.get(CONVERSATION_HEADER),
        client: req.get('mcp-client') ?? req.get('user-agent'),
        response: clip(Buffer.concat(chunks).toString('utf8'), 1500),
      };
      fs.appendFile(file, JSON.stringify(line) + '\n', () => {});
    });
    next();
  };
}

export function createApp(deps: McpDeps) {
  const { config, store, workspaces } = deps;
  const app = express();
  app.disable('x-powered-by');
  // write_file content is JSON-escaped; allow headroom over MAX_WRITE_BYTES.
  app.use(express.json({ limit: config.maxWriteBytes * 6 + 64 * 1024 }));

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiKey) return next(); // only possible with MCP_ALLOW_ANONYMOUS=true (enforced at startup)
    const provided = extractApiKey(req.headers, req.query);
    if (provided && safeEqual(provided, config.apiKey)) return next();
    // Never log the key itself; only say which of the two failure modes this was.
    console.error(
      '[copilot-mcp]',
      `401 ${req.method} ${req.path}: ` +
        (provided
          ? `API key did not match (received ${provided.length} chars; check for pasted spaces or an old key)`
          : 'no API key received (expected header "api-key", "Authorization: Bearer <key>" or ?api_key=)'),
    );
    res.status(401).json({ error: 'Missing or invalid API key.' });
  };

  // Unauthenticated liveness probe; reveals no paths.
  app.get('/health', (_req, res) => res.json({ status: 'healthy', version: SERVER_VERSION }));

  // ---- MCP Streamable HTTP (stateless) ----------------------------------
  // Opt-in request trace (MCP_TRACE=true): records every /mcp request and the exact response,
  // including calls rejected before a tool runs (auth, schema validation, unknown tool).
  if (config.traceFile) app.use('/mcp', traceMcp(config.traceFile));

  app.post('/mcp', requireApiKey, async (req, res) => {
    const server = createMcpServer(deps, requestContext(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ---- Admin REST API ---------------------------------------------------
  const admin = express.Router();
  admin.use(requireApiKey);

  admin.get('/workspaces', (req, res) => {
    res.json({ default: workspaces.getDefault() ?? null, workspaces: workspaces.list(requestContext(req), {}) });
  });

  admin.post('/workspaces', async (req, res) => {
    const { alias, path, makeDefault } = req.body ?? {};
    if (typeof alias !== 'string' || typeof path !== 'string') {
      return res.status(400).json({ error: 'Body must be {"alias": string, "path": string, "makeDefault"?: boolean}' });
    }
    res.status(201).json(await workspaces.add(alias, path, makeDefault === true));
  });

  admin.delete('/workspaces/:alias', (req, res) => {
    const r = workspaces.remove(req.params.alias as string);
    if (!r.removed) return res.status(404).json({ error: `Unknown workspace "${req.params.alias}".` });
    res.json(r);
  });

  /** Default workspace (legacy endpoint). */
  admin.get('/workspace', (_req, res) => res.json({ workspace: workspaces.getDefault() ?? null }));

  /** Set the default workspace: {"workspace": "<alias>"} (legacy {"path": "..."} accepted if registered). */
  admin.post('/workspace', (req, res) => {
    const { workspace, path } = req.body ?? {};
    let alias: string | undefined = typeof workspace === 'string' ? workspace : undefined;
    if (!alias && typeof path === 'string') {
      alias = workspaces.list(requestContext(req), {}).find((w) => w.path.toLowerCase() === path.toLowerCase())?.alias;
      if (!alias) return res.status(400).json({ error: 'Path is not a registered workspace; use POST /workspaces first.' });
    }
    if (!alias) return res.status(400).json({ error: 'Body must be {"workspace": "<alias>"}' });
    workspaces.setDefault(alias);
    res.json({ workspace: alias });
  });

  admin.get('/repository-summary', async (req, res) => {
    const ws = await workspaces.resolve(requestContext(req), {
      workspace: typeof req.query.workspace === 'string' ? req.query.workspace : undefined,
    });
    const files = await fg(['**/*.ts', '**/*.js', '**/*.cs', '**/*.java', '**/*.py'], {
      cwd: ws.root,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      suppressErrors: true,
    });
    res.json({ workspace: ws.alias, path: ws.root, fileCount: files.length });
  });

  admin.get('/audit', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json(store.recentAudit(limit));
  });

  app.use(admin);

  // Map validation/access errors to 400, everything else to 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AccessError) return res.status(400).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return res.status(status).json({ error: (err as Error).message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
