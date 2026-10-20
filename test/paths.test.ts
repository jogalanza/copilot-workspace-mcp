import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { loadConfig, parseWorkspaceList } from '../src/config.js';
import { StateStore } from '../src/db.js';
import { cleanAbsolutePath, resolveInside, resolveUserPath, unquote } from '../src/security.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

const isWin = process.platform === 'win32';

describe('paths with spaces', () => {
  const sb = makeSandbox(['alpha', 'beta']);
  const root = sb.workspaces.alpha;
  after(() => sb.cleanup());

  it('sandbox really contains spaces', () => {
    assert.match(root, / /);
  });

  it('unquote / cleanAbsolutePath keep inner spaces and strip wrappers', () => {
    assert.equal(unquote('  "D:/Red Files/x"  '), 'D:/Red Files/x');
    assert.equal(unquote("'D:/Red Files/x'"), 'D:/Red Files/x');
    assert.equal(unquote('"\'a b\'"'), 'a b');
    assert.equal(unquote('"unbalanced'), '"unbalanced');
    assert.equal(cleanAbsolutePath(pathToFileURL(root).href), root);
  });

  it('config accepts plain, quoted and file:// paths with spaces', () => {
    const quoted = parseWorkspaceList(`a=${root};b="${sb.workspaces.beta}";'c'='${root}'`);
    assert.equal(quoted.get('a'), root);
    assert.equal(quoted.get('b'), sb.workspaces.beta);
    assert.equal(quoted.get('c'), root);
    assert.equal(parseWorkspaceList(`"w=${root}"`).get('w'), root);
    assert.equal(parseWorkspaceList(`u=${pathToFileURL(root).href}`).get('u'), root);
    const cfg = loadConfig({ ALLOWED_ROOTS: `"${sb.reposDir}"; ${sb.base} `, STATE_DB: `"${sb.dbPath}"`, MCP_API_KEY: 'k' });
    assert.deepEqual(cfg.allowedRoots, [sb.reposDir, sb.base]);
    assert.equal(cfg.stateDbPath, sb.dbPath);
    assert.throws(() => parseWorkspaceList('a=""'), /empty path/);
  });

  it('resolves relative paths with spaces, quotes and URL encoding', async () => {
    const expected = path.join(root, 'My Docs', 'Read Me.md');
    assert.equal(await resolveInside(root, 'My Docs/Read Me.md'), expected);
    assert.equal(await resolveInside(root, ' "My Docs/Read Me.md" '), expected);
    assert.equal((await resolveUserPath(root, 'My%20Docs/Read%20Me.md')).target, expected);
    // New file in an existing spaced folder: decoded because the literal folder does not exist.
    assert.equal((await resolveUserPath(root, 'My%20Docs/New%20File.md')).target, path.join(root, 'My Docs', 'New File.md'));
    // A literal "%20" file that exists wins over decoding.
    fs.writeFileSync(path.join(root, 'odd%20name.txt'), 'x');
    assert.equal((await resolveUserPath(root, 'odd%20name.txt')).target, path.join(root, 'odd%20name.txt'));
    // Encoded traversal is still blocked.
    await assert.rejects(resolveUserPath(root, '..%2F..%2Fbeta%2Fhello.txt'), /escapes the workspace/);
  });

  it('rejects names Windows would mangle (trailing space/dot, ADS, reserved chars)', { skip: !isWin }, async () => {
    for (const bad of ['.git /config', '.git./config', 'notes /a.md', 'a.md.', 'a.md:stream', 'a|b.md']) {
      await assert.rejects(resolveInside(root, bad), /Invalid file or folder name/, bad);
    }
    // Whitespace around the whole path is client noise and is trimmed, not rejected.
    assert.equal(await resolveInside(root, 'a.md '), path.join(root, 'a.md'));
    assert.ok(await resolveInside(root, 'My Docs/ leading space ok.md'));
  });

  it('add_workspace accepts quoted and file:// folders with spaces', async () => {
    const extra = path.join(sb.reposDir, 'Extra Project');
    fs.mkdirSync(extra, { recursive: true });
    const store = new StateStore(':memory:');
    try {
      const ws = new WorkspaceService(store, testConfig(sb));
      await ws.seed();
      assert.equal((await ws.add('extra', `"${extra}"`)).path, extra);
      ws.remove('extra');
      assert.equal((await ws.add('extra', pathToFileURL(extra).href)).path, extra);
      ws.remove('extra');
      // Client dropped the spaces: "...\MyRepos\ExtraProject" for "...\My Repos\Extra Project".
      assert.equal((await ws.add('extra', extra.replace(/ /g, ''))).path, extra);
      ws.remove('extra');
      await assert.rejects(ws.add('extra', path.join(sb.reposDir, 'NoSuchProject')), /Folder does not exist/);
    } finally {
      store.close();
    }
  });
});
