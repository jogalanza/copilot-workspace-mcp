import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activity } from '../src/activity.js';

describe('activity tracker', () => {
  it('counts requests, names tool calls, ignores notifications and pushes to subscribers', () => {
    const seen: number[] = [];
    const off = activity.subscribe((s) => seen.push(s.count));
    const before = activity.snapshot().count;
    activity.recordBody({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_status' } });
    activity.recordBody([{ method: 'tools/list' }, { method: 'notifications/initialized' }]);
    off();
    const s = activity.snapshot();
    assert.equal(s.count, before + 2);
    assert.equal(s.last?.name, 'tools/list');
    assert.equal(seen.length, 2);
  });
});

describe('activity details', () => {
  it('keeps arguments and attaches the tool outcome to the right call', async () => {
    const calls = activity.recordBody(
      { method: 'tools/call', params: { name: 'ws_read_file', arguments: { filePath: 'a.txt' } } },
      { conversation: 'c1', client: 'ua' },
    );
    assert.equal(activity.snapshot().last?.status, 'pending');
    await activity.track(calls, async () => {
      await Promise.resolve();
      activity.complete('ws_read_file', { ok: false, ms: 7, workspace: 'alpha', error: 'File not found' });
    });
    const last = activity.snapshot().last!;
    assert.equal(last.status, 'error');
    assert.equal(last.ms, 7);
    assert.equal(last.workspace, 'alpha');
    assert.equal(last.conversation, 'c1');
    assert.match(last.args ?? '', /a\.txt/);
  });
});

describe('activity over real MCP HTTP', () => {
  it('records a tool call with its outcome', async () => {
    const { createApp } = await import('../src/app.js');
    const { StateStore } = await import('../src/db.js');
    const { WorkspaceService } = await import('../src/workspaceManager.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { makeSandbox, testConfig } = await import('./helpers.js');
    const sb = makeSandbox(['alpha']);
    const config = testConfig(sb);
    const store = new StateStore(config.stateDbPath);
    const workspaces = new WorkspaceService(store, config);
    await workspaces.seed();
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = createApp({ config, store, workspaces }).listen(0, () => r(s));
    });
    const port = (server.address() as import('node:net').AddressInfo).port;
    const client = new Client({ name: 't', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { 'api-key': 'test-key', 'conversation-id': 'conv-X' } },
      }),
    );
    try {
      await client.callTool({ name: 'ws_read_file', arguments: { filePath: 'hello.txt', workspace: 'alpha' } });
      let last = activity.snapshot().last!;
      assert.equal(last.name, 'ws_read_file');
      assert.equal(last.status, 'ok');
      assert.equal(last.workspace, 'alpha');
      assert.equal(last.conversation, 'conv-X');
      assert.ok((last.ms ?? -1) >= 0);
      await client.callTool({ name: 'ws_read_file', arguments: { filePath: 'nope.txt', workspace: 'alpha' } });
      last = activity.snapshot().last!;
      assert.equal(last.status, 'error');
      assert.match(last.error ?? '', /not found/i);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
      sb.cleanup();
    }
  });
});

describe('activity stats', () => {
  it('aggregates finished tool calls per minute and per tool', async () => {
    const before = activity.statsSnapshot();
    const baseCalls = before.buckets.reduce((n, b) => n + b.calls, 0);
    const mk = (name: string) => activity.recordBody({ method: 'tools/call', params: { name, arguments: {} } });
    await activity.track(mk('stat_slow'), async () => activity.complete('stat_slow', { ok: true, ms: 300 }));
    await activity.track(mk('stat_slow'), async () => activity.complete('stat_slow', { ok: false, ms: 100, error: 'x' }));
    await activity.track(mk('stat_fast'), async () => activity.complete('stat_fast', { ok: true, ms: 10 }));
    const snap = activity.statsSnapshot();
    assert.equal(snap.buckets.reduce((n, b) => n + b.calls, 0), baseCalls + 3);
    const slow = snap.tools.find((t) => t.name === 'stat_slow')!;
    assert.equal(slow.calls, 2);
    assert.equal(slow.errors, 1);
    assert.equal(slow.avgMs, 200);
    assert.equal(slow.maxMs, 300);
    assert.equal(snap.tools.find((t) => t.name === 'stat_fast')!.avgMs, 10);
  });
});
