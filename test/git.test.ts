import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { StateStore } from '../src/db.js';
import { assertRef, assertRemote } from '../src/gitTools.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('git tools', () => {
  const sb = makeSandbox(['repo']);
  const dir = sb.workspaces.repo;
  const bare = path.join(sb.base, 'remote.git');
  const config = testConfig(sb, { enableGit: true });
  after(() => sb.cleanup());

  it('validates refs and remotes', () => {
    for (const bad of ['-D', '--force', 'a b', 'x..y', '+main', 'a:b', '']) assert.throws(() => assertRef(bad), bad);
    for (const bad of ['https://evil/x', '../x', '-u', 'a/b']) assert.throws(() => assertRemote(bad), bad);
    assert.equal(assertRef('feature/x-1'), 'feature/x-1');
    assert.equal(assertRemote('origin'), 'origin');
  });

  it('runs status, add, commit, branch, checkout, log, diff and push', async () => {
    g(sb.base, 'init', '--bare', '-b', 'main', bare);
    g(dir, 'init', '-b', 'main');
    g(dir, 'config', 'user.email', 't@example.com');
    g(dir, 'config', 'user.name', 'Tester');
    g(dir, 'remote', 'add', 'origin', bare);

    const store = new StateStore(config.stateDbPath);
    const workspaces = new WorkspaceService(store, config);
    await workspaces.seed();
    const app = createApp({ config, store, workspaces });
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new Client({ name: 'git', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { 'api-key': 'test-key' } } }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: { workspace: 'repo', ...args } })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    try {
      assert.match((await call('git_status')).text, /\?\? hello\.txt/);
      assert.equal((await call('git_add', { paths: ['.'] })).isError, false);
      assert.match((await call('git_diff', { staged: true, stat: true })).text, /hello\.txt/);
      assert.equal((await call('git_commit', { message: 'first; $(touch pwned)' })).isError, false);
      assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
      assert.match((await call('git_log')).text, /first; \$\(touch pwned\)/);

      assert.equal((await call('git_checkout', { branch: 'feat/x', create: true })).isError, false);
      fs.writeFileSync(path.join(dir, 'hello.txt'), 'changed');
      assert.match((await call('git_diff')).text, /\+changed/);
      assert.equal((await call('git_commit', { message: 'second', all: true })).isError, false);
      const push = await call('git_push', { setUpstream: true });
      assert.equal(push.isError, false, push.text);
      assert.match(g(bare, 'branch'), /feat\/x/);
      assert.match((await call('git_branch')).text, /feat\/x/);

      // injection / escape attempts are rejected
      assert.equal((await call('git_checkout', { branch: '--orphan' })).isError, true);
      assert.equal((await call('git_push', { remote: 'https://evil.example/x' })).isError, true);
      assert.equal((await call('git_add', { paths: ['../outside'] })).isError, true);
      assert.equal((await call('git_add', { paths: ['.git/config'] })).isError, true);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    }
  });
});
