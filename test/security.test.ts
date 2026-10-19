import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { assertSafeGlob, assertWritable, extractApiKey, resolveInside, safeEqual } from '../src/security.js';
import { makeSandbox } from './helpers.js';

describe('path containment', () => {
  const sb = makeSandbox(['alpha', 'beta']);
  const root = sb.workspaces.alpha;
  after(() => sb.cleanup());

  it('allows normal relative paths, including new files', async () => {
    assert.equal(await resolveInside(root, 'src/index.ts'), path.join(root, 'src', 'index.ts'));
    assert.equal(await resolveInside(root, 'new/dir/file.txt'), path.join(root, 'new', 'dir', 'file.txt'));
    assert.equal(await resolveInside(root, 'src/../hello.txt'), path.join(root, 'hello.txt'));
  });

  it('rejects traversal and absolute paths', async () => {
    await assert.rejects(resolveInside(root, '../beta/hello.txt'), /escapes the workspace/);
    await assert.rejects(resolveInside(root, 'src/../../beta/hello.txt'), /escapes the workspace/);
    if (process.platform === 'win32') {
      await assert.rejects(resolveInside(root, '..\\beta\\hello.txt'), /escapes the workspace/);
    }
    await assert.rejects(resolveInside(root, sb.workspaces.beta), /relative/);
    await assert.rejects(resolveInside(root, 'C:/Windows/win.ini'), /relative/);
    await assert.rejects(resolveInside(root, '\\\\server\\share\\x'), /relative/);
    await assert.rejects(resolveInside(root, ''), /required/);
  });

  it('rejects escapes through a junction/symlink', async (t) => {
    const link = path.join(root, 'link-to-beta');
    try {
      fs.symlinkSync(sb.workspaces.beta, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('cannot create links on this machine');
      return;
    }
    await assert.rejects(resolveInside(root, 'link-to-beta/hello.txt'), /via a link/);
    await assert.rejects(resolveInside(root, 'link-to-beta/new.txt'), /via a link/);
  });

  it('blocks writes into .git, node_modules, the root and the state DB', () => {
    assert.throws(() => assertWritable(root, path.join(root, '.git', 'config')), /\.git/);
    assert.throws(() => assertWritable(root, path.join(root, 'a', 'node_modules', 'x.js')), /node_modules/);
    assert.throws(() => assertWritable(root, path.join(root, '.GIT', 'HEAD')), /\.git/);
    assert.throws(() => assertWritable(root, root), /root/);
    const db = path.join(root, 'state.db');
    assert.throws(() => assertWritable(root, db, [db]), /state database/);
    assert.throws(() => assertWritable(root, db + '-wal', [db]), /state database/);
    assert.doesNotThrow(() => assertWritable(root, path.join(root, 'src', 'gitignore.ts')));
  });

  it('rejects unsafe glob patterns', () => {
    assert.throws(() => assertSafeGlob('../**/*'), /\.\./);
    assert.throws(() => assertSafeGlob('src/../../**'), /\.\./);
    assert.throws(() => assertSafeGlob('/etc/**'), /relative/);
    assert.throws(() => assertSafeGlob('C:/**'), /relative/);
    assert.doesNotThrow(() => assertSafeGlob('src/**/*.ts'));
  });
});

describe('api key helpers', () => {
  it('extracts keys from header, bearer and query', () => {
    assert.equal(extractApiKey({ 'api-key': 'k1' }, {}), 'k1');
    assert.equal(extractApiKey({ authorization: 'Bearer k2' }, {}), 'k2');
    assert.equal(extractApiKey({}, { api_key: 'k3' }), 'k3');
    assert.equal(extractApiKey({}, {}), undefined);
  });
  it('compares in constant time', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});
