import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StateStore } from '../src/db.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

describe('state persistence and per-conversation isolation', () => {
  const sb = makeSandbox(['alpha', 'beta', 'gamma']);
  const config = testConfig(sb);
  after(() => sb.cleanup());

  it('isolates workspaces per conversation and survives a restart', async () => {
    let store = new StateStore(config.stateDbPath);
    let svc = new WorkspaceService(store, config);
    assert.deepEqual(await svc.seed(), []);
    assert.equal(svc.getDefault(), 'alpha', 'first seeded workspace becomes default');

    await svc.switchTo({ conversationKey: 'chat-A', client: 'test' }, { workspace: 'beta' });
    await svc.switchTo({ conversationKey: 'chat-B', client: 'test' }, { workspace: 'gamma' });

    assert.equal((await svc.resolve({ conversationKey: 'chat-A', client: 'test' }, {})).alias, 'beta');
    assert.equal((await svc.resolve({ conversationKey: 'chat-B', client: 'test' }, {})).alias, 'gamma');
    const other = await svc.resolve({ conversationKey: 'chat-C', client: 'test' }, {});
    assert.equal(other.alias, 'alpha');
    assert.equal(other.source, 'default');

    store.close();
    store = new StateStore(config.stateDbPath);
    svc = new WorkspaceService(store, config);
    await svc.seed();
    const a = await svc.resolve({ conversationKey: 'chat-A', client: 'test' }, {});
    assert.equal(a.alias, 'beta');
    assert.equal(a.source, 'conversation');
    assert.equal((await svc.resolve({ conversationKey: 'chat-B', client: 'test' }, {})).alias, 'gamma');
    store.close();
  });

  it('explicit workspace argument overrides the binding without changing it', async () => {
    const store = new StateStore(config.stateDbPath);
    const svc = new WorkspaceService(store, config);
    const ctx = { conversationKey: 'chat-A', client: 'test' };
    const r = await svc.resolve(ctx, { workspace: 'gamma' });
    assert.equal(r.alias, 'gamma');
    assert.equal(r.source, 'argument');
    assert.equal((await svc.resolve(ctx, {})).alias, 'beta');
    store.close();
  });

  it('conversationId argument takes precedence over the header', async () => {
    const store = new StateStore(config.stateDbPath);
    const svc = new WorkspaceService(store, config);
    const r = await svc.resolve({ conversationKey: 'chat-A', client: 'test' }, { conversationId: 'chat-B' });
    assert.equal(r.alias, 'gamma');
    store.close();
  });

  it('purges stale bindings by TTL', () => {
    const store = new StateStore(':memory:');
    store.upsertWorkspace('w', sb.workspaces.alpha);
    store.bind('chat-1', 'w', 'test');
    store.bind('chat-2', 'w', 'test');
    // Nothing is stale today.
    assert.equal(store.purgeBindings(30), 0);
    // 29 days later: still kept.
    assert.equal(store.purgeBindings(30, new Date(Date.now() + 29 * 86_400_000)), 0);
    // 31 days later: both expired.
    assert.equal(store.purgeBindings(30, new Date(Date.now() + 31 * 86_400_000)), 2);
    assert.equal(store.getBinding('chat-1'), undefined);
    store.close();
  });

  it('removing a workspace drops its bindings and clears it as default', async () => {
    const store = new StateStore(':memory:');
    const svc = new WorkspaceService(store, { ...config, seedWorkspaces: new Map(), defaultWorkspace: undefined });
    await svc.add('one', sb.workspaces.alpha, true);
    await svc.switchTo({ conversationKey: 'c1', client: 'test' }, { workspace: 'one' });
    assert.equal(svc.remove('one').removed, true);
    assert.equal(store.getBinding('c1'), undefined);
    assert.equal(svc.getDefault(), undefined);
    await assert.rejects(svc.resolve({ conversationKey: 'c1', client: 'test' }, {}), /No workspace selected/);
    store.close();
  });

  it('add_workspace is restricted to ALLOWED_ROOTS and validates input', async () => {
    const store = new StateStore(':memory:');
    const svc = new WorkspaceService(store, config);
    await assert.rejects(svc.add('outside', sb.stateDir), /outside the allowed roots/);
    await assert.rejects(svc.add('bad alias!', sb.workspaces.alpha), /alias/);
    await assert.rejects(svc.add('missing', sb.reposDir + '/nope'), /does not exist/);
    await assert.rejects(svc.add('rel', 'repos/alpha'), /absolute/);
    await svc.add('a1', sb.workspaces.alpha);
    await assert.rejects(svc.add('a2', sb.workspaces.alpha), /already registered as "a1"/);
    const disabled = new WorkspaceService(store, { ...config, allowedRoots: [] });
    await assert.rejects(disabled.add('x', sb.workspaces.beta), /disabled/);
    store.close();
  });

  it('unknown workspace errors list the available aliases', async () => {
    const store = new StateStore(config.stateDbPath);
    const svc = new WorkspaceService(store, config);
    await assert.rejects(svc.switchTo({ client: 'test' }, { workspace: 'nope' }), /Available workspaces: alpha, beta, gamma/);
    store.close();
  });
});
