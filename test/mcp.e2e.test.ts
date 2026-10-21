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
        'curl',
        'current_workspace',
        'git_add',
        'git_branch',
        'git_checkout',
        'git_commit',
        'git_diff',
        'git_log',
        'git_pull',
        'git_push',
        'git_status',
        'list_files',
        'list_workspaces',
        'notebook_edit',
        'remove_workspace',
        'switch_workspace',
        'todo_read',
        'todo_write',
        'ws_delete_file',
        'ws_edit_file',
        'ws_grep',
        'ws_read_file',
        'ws_write_file',
      ]);

      assert.match((await call(chatA, 'switch_workspace', { workspace: 'alpha' })).text, /keep using it/);
      assert.match((await call(chatB, 'switch_workspace', { workspace: 'beta' })).text, /keep using it/);

      assert.match((await call(chatA, 'ws_read_file', { filePath: 'hello.txt' })).text, /hello from alpha/);
      assert.match((await call(chatB, 'ws_read_file', { filePath: 'hello.txt' })).text, /hello from beta/);

      // Writes go to each chat's own workspace.
      assert.equal((await call(chatA, 'ws_write_file', { filePath: 'notes/a.md', content: 'A' })).isError, false);
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
      assert.match((await call(chatB2, 'ws_read_file', { filePath: 'hello.txt' })).text, /hello from beta/);
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
      assert.match((await call(m365, 'ws_read_file', { filePath: 'hello.txt', workspace: 'beta' })).text, /\[workspace: beta\][\s\S]*hello from beta/);
      // Without the argument it falls back to the default (alpha) and says so.
      assert.match((await call(m365, 'ws_read_file', { filePath: 'hello.txt' })).text, /\[workspace: alpha\]/);
      // A file that only exists in another workspace is found when the default was just a guess...
      fs.writeFileSync(path.join(sb.workspaces.beta, 'only-in-beta.md'), 'beta only');
      const fb = await call(m365, 'ws_read_file', { filePath: 'only-in-beta.md', workspace: null, conversationId: null });
      assert.equal(fb.isError, false, fb.text);
      assert.match(fb.text, /^\[workspace: beta\] only-in-beta\.md\nbeta only/);
      // ...but not when a workspace was chosen explicitly,
      assert.match((await call(m365, 'ws_read_file', { filePath: 'only-in-beta.md', workspace: 'alpha' })).text, /File not found/);
      // and an ambiguous fallback names the candidates instead of guessing.
      const gamma = path.join(sb.reposDir, 'Gamma Project');
      fs.mkdirSync(gamma, { recursive: true });
      fs.writeFileSync(path.join(gamma, 'only-in-beta.md'), 'gamma copy');
      assert.equal((await call(m365, 'add_workspace', { alias: 'gamma', path: gamma })).isError, false);
      try {
        const amb = await call(m365, 'ws_read_file', { filePath: 'only-in-beta.md' });
        assert.equal(amb.isError, true);
        assert.match(amb.text, /It exists in: (beta, gamma|gamma, beta)\. Pass workspace=/);
      } finally {
        await call(m365, 'remove_workspace', { alias: 'gamma' });
        fs.unlinkSync(path.join(sb.workspaces.beta, 'only-in-beta.md'));
      }
    } finally {
      await m365.close();
      await srv.stop();
    }
  });

  it('returns tool errors for escapes, protected folders and unknown workspaces, and audits them', async () => {
    const srv = await startServer(config);
    const chat = await connect(srv.url, { 'api-key': 'test-key', 'conversation-id': 'conv-X' });
    try {
      const esc = await call(chat, 'ws_read_file', { filePath: '../beta/hello.txt' });
      assert.equal(esc.isError, true);
      assert.match(esc.text, /escapes the workspace/);

      const git = await call(chat, 'ws_write_file', { filePath: '.git/config', content: 'x' });
      assert.equal(git.isError, true);
      assert.match(git.text, /\.git/);

      const glob = await call(chat, 'list_files', { pattern: '../**' });
      assert.equal(glob.isError, true);

      const unknown = await call(chat, 'switch_workspace', { workspace: 'nope' });
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /Available workspaces: alpha, beta/);

      const audit = srv.store.recentAudit(10) as { tool: string; ok: number; conversation_key: string }[];
      assert.ok(audit.some((a) => a.tool === 'ws_write_file' && a.ok === 0 && a.conversation_key === 'conv-X'));

      const list = await call(chat, 'list_files', { pattern: 'src/**/*.ts' });
      assert.match(list.text, /1 file\(s\)\nsrc\/index\.ts/);

      // Paths with spaces, as plain, quoted or URL-encoded input.
      assert.match((await call(chat, 'list_files', { pattern: '"My Docs/**"' })).text, /1 file\(s\)\nMy Docs\/Read Me\.md/);
      for (const filePath of ['My Docs/Read Me.md', '"My Docs/Read Me.md"', 'My%20Docs/Read%20Me.md']) {
        const r = await call(chat, 'ws_read_file', { filePath, workspace: 'alpha' });
        assert.equal(r.isError, false, filePath);
        assert.match(r.text, /docs for alpha/, filePath);
      }
      const w = await call(chat, 'ws_write_file', { filePath: 'My%20Docs/New%20Note.md', content: 'n', workspace: 'alpha' });
      assert.match(w.text, /Created My Docs\/New Note\.md/);
      assert.equal(fs.readFileSync(path.join(sb.workspaces.alpha, 'My Docs', 'New Note.md'), 'utf8'), 'n');
      // Absolute paths (what agents often send) are routed to the containing workspace.
      const abs = path.join(sb.workspaces.beta, 'My Docs', 'Read Me.md');
      const absRead = await call(chat, 'ws_read_file', { filePath: abs });
      assert.equal(absRead.isError, false, absRead.text);
      assert.match(absRead.text, /^\[workspace: beta\] My Docs\/Read Me\.md\ndocs for beta/);
      const absList = await call(chat, 'list_files', { pattern: `${sb.workspaces.beta.replace(/\\/g, '/')}/My Docs/**` });
      assert.match(absList.text, /\[workspace: beta\] 1 file\(s\)\nMy Docs\/Read Me\.md/);
      const absGit = await call(chat, 'ws_write_file', { filePath: path.join(sb.workspaces.beta, '.git', 'config'), content: 'x' });
      assert.equal(absGit.isError, true);
      assert.match(absGit.text, /\.git/);
      const absOut = await call(chat, 'ws_read_file', { filePath: sb.dbPath });
      assert.equal(absOut.isError, true);
      assert.match(absOut.text, /not inside any registered workspace/);

      // --- Inputs real clients send (each used to fail before the tool ran, unaudited) ---
      // 1. Copilot Studio sends null for optional inputs left empty.
      const nulls = await call(chat, 'ws_read_file', { filePath: 'hello.txt', workspace: null, conversationId: null });
      assert.equal(nulls.isError, false, nulls.text);
      assert.equal((await call(chat, 'list_files', { pattern: 'src/**', maxResults: null, workspace: null })).isError, false);
      // 2. "path" / "file" instead of "filePath".
      assert.match((await call(chat, 'ws_read_file', { path: 'My Docs/Read Me.md', workspace: 'beta' })).text, /docs for beta/);
      assert.match((await call(chat, 'ws_read_file', { file: 'hello.txt', workspace: 'beta' })).text, /hello from beta/);
      const none = await call(chat, 'ws_read_file', { workspace: 'beta' });
      assert.equal(none.isError, true);
      assert.match(none.text, /filePath is required/);
      // 3. Spaces dropped by the client: "MyDocs/ReadMe.md", "...\MyRepos\beta\...".
      assert.match((await call(chat, 'ws_read_file', { filePath: 'MyDocs/ReadMe.md', workspace: 'beta' })).text, /^\[workspace: beta\] My Docs\/Read Me\.md\ndocs for beta/);
      const squashed = path.join(sb.workspaces.beta, 'My Docs', 'Read Me.md').replace(/ /g, '');
      const sq = await call(chat, 'ws_read_file', { filePath: squashed });
      assert.equal(sq.isError, false, sq.text);
      assert.match(sq.text, /^\[workspace: beta\] My Docs\/Read Me\.md\ndocs for beta/);
      const sqList = await call(chat, 'list_files', { pattern: `${sb.workspaces.beta.replace(/ /g, '').replace(/\\/g, '/')}/My Docs/**` });
      assert.match(sqList.text, /\[workspace: beta\] 1 file\(s\)/);
      const sqWrite = await call(chat, 'ws_write_file', { filePath: 'MyDocs/Fresh Note.md', content: 'f', workspace: 'beta' });
      assert.match(sqWrite.text, /Created My Docs\/Fresh Note\.md/);
      // Ambiguous matches are not guessed.
      fs.mkdirSync(path.join(sb.workspaces.beta, 'a b'));
      fs.mkdirSync(path.join(sb.workspaces.beta, 'a  b'));
      fs.writeFileSync(path.join(sb.workspaces.beta, 'a b', 'x.txt'), '1');
      fs.writeFileSync(path.join(sb.workspaces.beta, 'a  b', 'x.txt'), '2');
      assert.match((await call(chat, 'ws_read_file', { filePath: 'ab/x.txt', workspace: 'beta' })).text, /File not found/);

      if (process.platform === 'win32') {
        const bad = await call(chat, 'ws_write_file', { filePath: '.git /config', content: 'x', workspace: 'alpha' });
        assert.equal(bad.isError, true);
        assert.equal(fs.existsSync(path.join(sb.workspaces.alpha, '.git ')), false);
      }
    } finally {
      await chat.close();
      await srv.stop();
    }
  });
});
