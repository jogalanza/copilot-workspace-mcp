import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { StateStore } from '../src/db.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

async function startServer(config: AppConfig) {
  const store = new StateStore(config.stateDbPath);
  const workspaces = new WorkspaceService(store, config);
  await workspaces.seed();
  const app = createApp({ config, store, workspaces });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}

async function connect(url: string, conversationId: string) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  const headers = { 'api-key': 'test-key', 'conversation-id': conversationId };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

describe('MCP file-editing, search and to-do tools', () => {
  const sb = makeSandbox(['alpha']);
  const config = testConfig(sb);
  after(() => sb.cleanup());
  const file = (rel: string) => path.join(sb.workspaces.alpha, rel);

  it('edits, searches, edits notebooks and tracks to-dos per chat', async () => {
    const srv = await startServer(config);
    const chat = await connect(srv.url, 'conv-tools');
    try {
      await call(chat, 'switch_workspace', { workspace: 'alpha' });
      await call(chat, 'ws_write_file', { filePath: 'src/app.ts', content: 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n' });

      assert.match((await call(chat, 'ws_read_file', { filePath: 'src/app.ts', offset: 2, limit: 1 })).text, /2\tconst b = 2;/);

      const ambiguous = await call(chat, 'ws_edit_file', { filePath: 'src/app.ts', oldString: '= 1;', newString: '= 9;' });
      assert.equal(ambiguous.isError, true);
      assert.match(ambiguous.text, /matches 2 places/);
      const ok = await call(chat, 'ws_edit_file', {
        filePath: 'src/app.ts',
        edits: [
          { oldString: 'const b = 2;', newString: 'const b = 3;' },
          { oldString: '= 1;', newString: '= 9;', replaceAll: true },
        ],
      });
      assert.equal(ok.isError, false, ok.text);
      assert.equal(fs.readFileSync(file('src/app.ts'), 'utf8'), 'const a = 9;\nconst b = 3;\nconst a2 = 9;\n');
      assert.equal((await call(chat, 'ws_edit_file', { filePath: '../x.txt', oldString: 'a', newString: 'b' })).isError, true);
      assert.equal((await call(chat, 'ws_edit_file', { filePath: 'src/app.ts', oldString: 'a' })).isError, true);

      const grep = await call(chat, 'ws_grep', { pattern: 'const a\\d?', glob: '**/*.ts', path: 'src' });
      assert.match(grep.text, /2 match\(es\) in 1 file\(s\)[\s\S]*app\.ts:1: const a = 9;/);
      assert.equal((await call(chat, 'ws_grep', { pattern: '(a+)+$' })).isError, true);
      assert.equal((await call(chat, 'ws_grep', { pattern: 'x', path: '../' })).isError, true);

      const sorted = await call(chat, 'list_files', { pattern: 'src/**', sortBy: 'modified' });
      assert.match(sorted.text, /src\/app\.ts\nsrc\/index\.ts/);

      fs.writeFileSync(
        file('n.ipynb'),
        JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'c1', cell_type: 'code', metadata: {}, source: ['x = 1'], outputs: [], execution_count: null }] }),
      );
      const nb = await call(chat, 'notebook_edit', { filePath: 'n.ipynb', mode: 'insert', cellIndex: 0, source: '# hi', cellType: 'markdown' });
      assert.equal(nb.isError, false, nb.text);
      assert.equal(JSON.parse(fs.readFileSync(file('n.ipynb'), 'utf8')).cells.length, 2);
      assert.equal((await call(chat, 'notebook_edit', { filePath: 'src/app.ts', mode: 'delete', cellIndex: 0 })).isError, true);

      await call(chat, 'todo_write', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] });
      assert.match((await call(chat, 'todo_read')).text, /1\/2 done[\s\S]*\[x\] one[\s\S]*\[~\] two/);
      const other = await connect(srv.url, 'conv-other');
      try {
        assert.match((await call(other, 'todo_read')).text, /no to-do items/);
      } finally {
        await other.close();
      }
    } finally {
      await chat.close();
      await srv.stop();
    }
  });

  it('registers web_fetch and web_search only when configured, and serves them', async () => {
    const web = http.createServer((req, res) => {
      if (req.url?.startsWith('/search')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ web: { results: [{ title: 'Hit', url: 'https://h.test/', description: 'd' }] } }));
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Doc</title><h1>Welcome</h1>');
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    const off = await startServer(config);
    const on = await startServer({ ...config, enableWebFetch: true, webAllowedHosts: ['127.0.0.1'], braveApiKey: 'k', webSearchUrl: `${base}/search` });
    const a = await connect(off.url, 'w1');
    const b = await connect(on.url, 'w2');
    try {
      const names = (c: Client) => c.listTools().then((t) => t.tools.map((x) => x.name));
      assert.deepEqual((await names(a)).filter((n) => n.startsWith('web_')), []);
      assert.deepEqual((await names(b)).filter((n) => n.startsWith('web_')).sort(), ['web_fetch', 'web_search']);
      assert.match((await call(b, 'web_fetch', { url: base + '/page' })).text, /title: Doc[\s\S]*# Welcome/);
      assert.match((await call(b, 'web_search', { query: 'q' })).text, /1\. Hit\n\s+https:\/\/h\.test\//);
      const blocked = await call(b, 'web_fetch', { url: 'http://169.254.169.254/' });
      assert.equal(blocked.isError, true);
      assert.match(blocked.text, /private or local/);
    } finally {
      await a.close();
      await b.close();
      await off.stop();
      await on.stop();
      web.close();
    }
  });
});
