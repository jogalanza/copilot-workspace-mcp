import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyEdits, compilePattern, editNotebook, formatTodos, grepFiles, numberLines, validateTodos } from '../src/fileTools.js';
import { makeSandbox } from './helpers.js';

describe('applyEdits', () => {
  it('replaces a unique match and keeps $ patterns literal', () => {
    const r = applyEdits('a b c', [{ oldString: 'b', newString: '$& $1' }]);
    assert.equal(r.content, 'a $& $1 c');
    assert.equal(r.replacements, 1);
  });

  it('refuses missing, ambiguous, empty and no-op edits, and is all-or-nothing', () => {
    assert.throws(() => applyEdits('x', [{ oldString: 'y', newString: 'z' }]), /not found/);
    assert.throws(() => applyEdits('x x', [{ oldString: 'x', newString: 'z' }]), /matches 2 places/);
    assert.throws(() => applyEdits('x', [{ oldString: '', newString: 'z' }]), /must not be empty/);
    assert.throws(() => applyEdits('x', [{ oldString: 'x', newString: 'x' }]), /identical/);
    assert.throws(() => applyEdits('a b', [{ oldString: 'a', newString: 'c' }, { oldString: 'zzz', newString: 'q' }]), /Edit 2: .*not found/);
    assert.equal(applyEdits('x x', [{ oldString: 'x', newString: 'z', replaceAll: true }]).replacements, 2);
  });

  it('matches LF edits against a CRLF file and writes CRLF back', () => {
    const r = applyEdits('one\r\ntwo\r\n', [{ oldString: 'one\ntwo', newString: 'one\nTWO' }]);
    assert.equal(r.content, 'one\r\nTWO\r\n');
  });
});

describe('numberLines', () => {
  const text = 'a\nb\nc\nd\n';
  it('numbers a window and says how to continue', () => {
    assert.equal(numberLines(text, 2, 2), '2\tb\n3\tc\n[lines 2-3 of 4; use offset=4 to continue]');
    assert.equal(numberLines(text), '1\ta\n2\tb\n3\tc\n4\td');
    assert.throws(() => numberLines(text, 9), /past the end/);
  });
});

describe('grepFiles', () => {
  const sb = makeSandbox(['g']);
  const dir = sb.workspaces.g;
  before(() => {
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\nNeedle here\nthree\nfour\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'm', 'x.js'), 'Needle');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x4e, 0, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  });
  after(() => sb.cleanup());
  const grep = (o: Partial<Parameters<typeof grepFiles>[0]>) => grepFiles({ dir, pattern: 'Needle', mode: 'content', maxResults: 50, ...o });

  it('finds matches, skipping node_modules and binary files', async () => {
    const out = await grep({});
    assert.match(out, /1 match\(es\) in 1 file\(s\)/);
    assert.match(out, /src\/a\.ts:2: Needle here/);
    assert.doesNotMatch(out, /node_modules|bin\.dat/);
  });

  it('supports context, case-insensitivity, files and count modes, and globs', async () => {
    assert.match(await grep({ context: 1 }), /src\/a\.ts-1- one\nsrc\/a\.ts:2: Needle here\nsrc\/a\.ts-3- three/);
    assert.equal((await grep({ pattern: 'needle' })).startsWith('0 match'), true);
    assert.match(await grep({ pattern: 'needle', ignoreCase: true, mode: 'files' }), /\nsrc\/a\.ts$/);
    assert.match(await grep({ mode: 'count' }), /src\/a\.ts: 1/);
    assert.match(await grep({ glob: '**/*.md' }), /^0 match/);
  });

  it('matches across lines in multiline mode', async () => {
    assert.match(await grep({ pattern: 'one.Needle', multiline: true }), /src\/a\.ts:1:/);
  });

  it('rejects invalid and catastrophic patterns', () => {
    assert.throws(() => compilePattern('(', false, false), /Invalid regular expression/);
    assert.throws(() => compilePattern('(a+)+$', false, false), /nested quantifier/);
    assert.throws(() => compilePattern('a'.repeat(501), false, false), /too long/);
  });
});

describe('editNotebook', () => {
  const nb = () =>
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: 'c1', cell_type: 'code', metadata: {}, source: ['x = 1'], outputs: [{ output_type: 'stream' }], execution_count: 3 },
        { id: 'c2', cell_type: 'markdown', metadata: {}, source: ['# t'] },
      ],
    });

  it('replaces a code cell and clears its output', () => {
    const cells = JSON.parse(editNotebook(nb(), { mode: 'replace', cellIndex: 0, source: 'a\nb' }).json).cells;
    assert.deepEqual(cells[0].source, ['a\n', 'b']);
    assert.deepEqual(cells[0].outputs, []);
    assert.equal(cells[0].execution_count, null);
  });

  it('inserts after a cell (with an id) and deletes by id', () => {
    const ins = JSON.parse(editNotebook(nb(), { mode: 'insert', cellIndex: 0, source: 'new', cellType: 'markdown' }).json).cells;
    assert.equal(ins.length, 3);
    assert.equal(ins[1].cell_type, 'markdown');
    assert.match(ins[1].id, /^[0-9a-f]{8}$/);
    assert.equal(JSON.parse(editNotebook(nb(), { mode: 'delete', cellId: 'c2' }).json).cells.length, 1);
  });

  it('rejects bad input', () => {
    assert.throws(() => editNotebook('{', { mode: 'delete', cellIndex: 0 }), /not valid notebook JSON/);
    assert.throws(() => editNotebook('{}', { mode: 'delete', cellIndex: 0 }), /no "cells"/);
    assert.throws(() => editNotebook(nb(), { mode: 'delete', cellIndex: 5 }), /out of range/);
    assert.throws(() => editNotebook(nb(), { mode: 'replace', cellIndex: 0 }), /source is required/);
    assert.throws(() => editNotebook(nb(), { mode: 'delete', cellId: 'nope' }), /No cell with id/);
  });
});

describe('to-do list', () => {
  it('validates and formats', () => {
    const items = validateTodos([{ content: ' a ', status: 'completed' }, { content: 'b', status: 'in_progress' }]);
    assert.equal(formatTodos(items), '1/2 done\n[x] a\n[~] b');
    assert.throws(() => validateTodos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]), /Only one/);
    assert.throws(() => validateTodos([{ content: ' ', status: 'pending' }]), /needs content/);
  });
});
