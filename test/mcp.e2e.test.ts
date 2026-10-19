import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    store,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}

async function connect(url: string, headers: Record<string, string>) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

describe('MCP over HTTP: two chats, restart, M365-style calls', () => {
  const sb = makeSandbox(['alpha', 'beta']);
  const config = testConfig(sb);
  after(() => sb.cleanup());

  it('rejects requests without a valid API key', async () => {
    const srv = await startServer(config);
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      assert.equal((await fetch(`${srv.url}/mcp`, { method: 'POST', headers, body })).status, 401);
      assert.equal(
        (await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { ...headers, 'api-key': 'wrong' }, body })).status,
        401,
      );
      assert.equal((await fetch(`${srv.url}/workspaces`)).status, 401);
      const health = await (await fetch(`${srv.url}/health`)).json();
      assert.equal(health.status, 'healthy');
      assert.equal(JSON.stringify(health).includes(sb.base), false, 'health must not leak paths');
    } finally {
      await srv.stop();
    }
  });

  it('keeps chats isolated and persists bindings across a restart (Copilot Studio style)', async () => {
    let srv = await startServer(config);
    const chatA = await connect(srv.url, { 'api-key': 'test-key', 'conversation-id': 'conv-A' });
    const chatB = await connect(srv.url, { 'api-key': 'test-key', 'conversation-id': 'conv-B' });
    try {
      const tools = (await chatA.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, [
        'add_workspace',
        'current_workspace',
        'list_files',
        'list_workspaces',
        'read_file',
        'remove_workspace',
        'switch_workspace',
        'write_file',
      ]);

      assert.match((await call(chatA, 'switch_workspace', { workspace: 'alpha' })).text, /keep using it/);
      assert.match((await call(chatB, 'switch_workspace', { workspace: 'beta' })).text, /keep using it/);

      assert.match((await call(chatA, 'read_file', { filePath: 'hello.txt' })).text, /hello from alpha/);
      assert.match((await call(chatB, 'read_file', { filePath: 'hello.txt' })).text, /hello from beta/);

      // Writes go to each chat's own workspace.
      assert.equal((await call(chatA, 'write_file', { filePath: 'notes/a.md', content: 'A' })).isError, false);
      assert.equal(fs.readFileSync(path.join(sb.workspaces.alpha, 'notes', 'a.md'), 'utf8'), 'A');
      assert.equal(fs.existsSync(path.join(sb.workspaces.beta, 'notes', 'a.md')), false);
    } finally {
      await chatA.close();
      await chatB.close();
      await srv.stop();
    }

    // Restart: a brand-new process state, same DB file.
    srv = await startServer(config);
    const chatA2 = await connect(srv.url, { authorization: 'Bearer test-key', 'conversation-id': 'conv-A' });
    const chatB2 = await connect(srv.url, { 'api-key': 'test-key', 'conversation-id': 'conv-B' });
    try {
      assert.match((await call(chatA2, 'current_workspace')).text, /"alias": "alpha"[\s\S]*"source": "conversation"/);
      assert.match((await call(chatB2, 'read_file', { filePath: 'hello.txt' })).text, /hello from beta/);
    } finally {
      await chatA2.close();
      await chatB2.close();
      await srv.stop();
    }
  });

  it('supports M365 Copilot style (no conversation id, explicit workspace argument)', async () => {
    const srv = await startServer(config);
    const m365 = await connect(srv.url, { 'api-key': 'test-key' });
    try {
      const sw = await call(m365, 'switch_workspace', { workspace: 'beta' });
      assert.match(sw.text, /pass workspace="beta" on every following call/);
      assert.match((await call(m365, 'read_file', { filePath: 'hello.txt', workspace: 'beta' })).text, /\[workspace: beta\][\s\S]*hello from beta/);
      // Without the argument it falls back to the default (alpha) and says so.
      assert.match((await call(m365, 'read_file', { filePath: 'hello.txt' })).text, /\[workspace: alpha\]/);
    } finally {
      await m365.close();
      await srv.stop();
    }
  });

  it('returns tool errors for escapes, protected folders and unknown workspaces, and audits them', async () => {
    const srv = await startServer(config);
    const chat = await connect(srv.url, { 'api-key': 'test-key', 'conversation-id': 'conv-X' });
    try {
      const esc = await call(chat, 'read_file', { filePath: '../beta/hello.txt' });
      assert.equal(esc.isError, true);
      assert.match(esc.text, /escapes the workspace/);

      const git = await call(chat, 'write_file', { filePath: '.git/config', content: 'x' });
      assert.equal(git.isError, true);
      assert.match(git.text, /\.git/);

      const glob = await call(chat, 'list_files', { pattern: '../**' });
      assert.equal(glob.isError, true);

      const unknown = await call(chat, 'switch_workspace', { workspace: 'nope' });
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /Available workspaces: alpha, beta/);

      const audit = srv.store.recentAudit(10) as { tool: string; ok: number; conversation_key: string }[];
      assert.ok(audit.some((a) => a.tool === 'write_file' && a.ok === 0 && a.conversation_key === 'conv-X'));

      const list = await call(chat, 'list_files', { pattern: 'src/**/*.ts' });
      assert.match(list.text, /1 file\(s\)\nsrc\/index\.ts/);
    } finally {
      await chat.close();
      await srv.stop();
    }
  });
});
