import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveRepoRoot, resolveWithin, isWithin, FenceError } from '../lib/fence.js';

test('resolveRepoRoot: dir 缺省回落 cwd', () => {
  const { root } = resolveRepoRoot(undefined, '/ws/proj');
  assert.equal(root, path.resolve('/ws/proj'));
});

test('resolveRepoRoot: 相对 dir 基于 cwd 归一', () => {
  const { root } = resolveRepoRoot('sub/repo', '/ws/proj');
  assert.equal(root, path.resolve('/ws/proj/sub/repo'));
});

test('resolveWithin: 根内路径放行', () => {
  const abs = resolveWithin('/repo', 'a/b.txt');
  assert.equal(abs, path.resolve('/repo/a/b.txt'));
});

test('resolveWithin: .. 逃逸拒绝', () => {
  assert.throws(() => resolveWithin('/repo', '../evil.txt'), FenceError);
});

test('resolveWithin: 绝对路径越界拒绝', () => {
  const outside = process.platform === 'win32' ? 'C:/Windows/evil' : '/etc/evil';
  assert.throws(() => resolveWithin('/repo', outside), FenceError);
});

test('isWithin: 同级目录不算包含', () => {
  assert.equal(isWithin('/repo', '/repo2'), false);
  assert.equal(isWithin('/repo', '/repo/sub'), true);
  assert.equal(isWithin('/repo', '/repo'), true);
});
