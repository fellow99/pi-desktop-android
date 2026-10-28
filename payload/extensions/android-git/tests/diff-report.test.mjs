import test from 'node:test';
import assert from 'node:assert/strict';
import { isBinary, twoFilePatch, patchStat } from '../lib/diff.js';
import { groupStatus, renderStatus, renderConflicts } from '../lib/report.js';

test('isBinary: NUL 采样', () => {
  assert.equal(isBinary(Buffer.from('plain text')), false);
  assert.equal(isBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01])), true);
  assert.equal(isBinary(null), false);
});

test('twoFilePatch: unified diff 含 +/- 行', () => {
  const patch = twoFilePatch('a/f.txt', 'b/f.txt', Buffer.from('old\n'), Buffer.from('new\n'));
  assert.match(patch, /--- a\/f\.txt/);
  assert.match(patch, /\+\+\+ b\/f\.txt/);
  assert.match(patch, /-old/);
  assert.match(patch, /\+new/);
});

test('twoFilePatch: 二进制只标注', () => {
  const patch = twoFilePatch('a/b.bin', 'b/b.bin', Buffer.from([0, 1]), Buffer.from([0, 2]));
  assert.match(patch, /^Binary files/);
});

test('patchStat: 增删行统计', () => {
  const { add, del } = patchStat(Buffer.from('a\nb\n'), Buffer.from('a\nc\nd\n'));
  assert.equal(add, 2);
  assert.equal(del, 1);
});

test('groupStatus: 各状态分组', () => {
  const g = groupStatus([
    ['new.txt', 0, 2, 0],
    ['staged.txt', 0, 2, 2],
    ['mod.txt', 1, 2, 1],
    ['del.txt', 1, 0, 1],
    ['softreset.txt', 1, 2, 2],
  ]);
  assert.deepEqual(g.untracked, ['new.txt']);
  assert.deepEqual(g.staged, ['A staged.txt', 'M softreset.txt']);
  assert.deepEqual(g.modified, ['mod.txt']);
  assert.deepEqual(g.deleted, ['del.txt']);
});

test('renderStatus: 干净仓库文案', () => {
  assert.match(renderStatus([]), /No changes/);
});

test('renderConflicts: 路径逐行列出', () => {
  const t = renderConflicts(['a.txt', 'b/c.txt']);
  assert.match(t, /a\.txt/);
  assert.match(t, /b\/c\.txt/);
});
