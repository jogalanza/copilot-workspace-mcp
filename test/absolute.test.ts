import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { StateStore } from '../src/db.js';
import { resolveUserPath } from '../src/security.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

describe('absolute paths are routed to the containing workspace', () => {
  const sb = makeSandbox(['alpha', 'beta']);
  // A nested workspace inside alpha, to check "deepest match" routing.
  const nested = path.join(sb.workspaces.alpha, 'My Docs');
  const store = new StateStore(':memory:');
  const svc = new WorkspaceService(store, testConfig(sb));
  const ctx = { client: 'test', conversationKey: 'conv-1' };
  after(() => {
    store.close();
    sb.cleanup();
  });

  it('seeds', async () => {
    assert.deepEqual(await svc.seed(), []);
    await svc.switchTo(ctx, { workspace: 'alpha' });
  });

  it('keeps relative paths on the chat workspace', async () => {
    const r = await svc.resolveForPath(ctx, {}, 'My Docs/Read Me.md');
    assert.equal(r.ws.alias, 'alpha');
    assert.equal(r.relPath, 'My Docs/Read Me.md');
  });

  it('routes absolute paths (backslash, forward slash, quoted, file://, different case)', async () => {
    const file = path.join(sb.workspaces.beta, 'src', 'index.ts');
    const variants = [file, file.replace(/\\/g, '/'), `"${file}"`, pathToFileURL(file).href];
    if (process.platform === 'win32') variants.push(file.toUpperCase());
    for (const v of variants) {
      const r = await svc.resolveForPath(ctx, {}, v);
      assert.equal(r.ws.alias, 'beta', v);
      assert.equal(r.relPath.toLowerCase(), 'src/index.ts', v);
      const { target } = await resolveUserPath(r.ws.root, r.relPath);
      assert.equal(fs.readFileSync(target, 'utf8'), "export const name = 'beta';\n");
    }
  });

  it('routes even when another workspace was passed explicitly, and handles new files', async () => {
    const r = await svc.resolveForPath(ctx, { workspace: 'alpha' }, path.join(sb.workspaces.beta, 'new dir', 'x.md'));
    assert.equal(r.ws.alias, 'beta');
    assert.equal(r.relPath, 'new dir/x.md');
  });

  it('prefers the chat workspace, then the deepest root, for nested workspaces', async () => {
    await svc.add('docs', nested);
    const p = path.join(nested, 'Read Me.md');
    assert.equal((await svc.resolveForPath(ctx, {}, p)).ws.alias, 'alpha'); // chat is on alpha
    assert.equal((await svc.resolveForPath(ctx, { workspace: 'beta' }, p)).ws.alias, 'docs'); // deepest
    svc.remove('docs');
  });

  it('rejects absolute paths outside every workspace, incl. ".." and link escapes', async () => {
    await assert.rejects(svc.resolveForPath(ctx, {}, sb.stateDir), /not inside any registered workspace/);
    await assert.rejects(
      svc.resolveForPath(ctx, {}, path.join(sb.workspaces.alpha, '..', '..', 'state', 'state.db')),
      /not inside any registered workspace/,
    );
    const outside = path.join(sb.base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(sb.workspaces.alpha, 'link-out');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // links not available on this machine
    }
    await assert.rejects(svc.resolveForPath(ctx, {}, path.join(link, 'secret.txt')), /not inside any registered workspace/);
  });

  it('routes absolute glob patterns', async () => {
    const r = await svc.resolveForPattern(ctx, {}, `${sb.workspaces.beta.replace(/\\/g, '/')}/src/**/*.ts`);
    assert.equal(r.ws.alias, 'beta');
    assert.equal(r.pattern, 'src/**/*.ts');
    if (process.platform === 'win32') {
      const back = await svc.resolveForPattern(ctx, {}, `${sb.workspaces.beta}\\src\\**`);
      assert.equal(back.pattern, 'src/**');
    }
    assert.equal((await svc.resolveForPattern(ctx, {}, sb.workspaces.beta)).pattern, '**/*');
    assert.equal((await svc.resolveForPattern(ctx, {}, 'src/**')).ws.alias, 'alpha');
    await assert.rejects(svc.resolveForPattern(ctx, {}, 'C:/Windows/**'), /not inside any registered workspace/);
  });
});
