import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRepositoryFs } from '../lib/fs-adapter.js';
import { FenceError } from '../lib/fence.js';

test('适配器方法全部为 async（isomorphic-git 方言探测硬契约）', () => {
  const { promises } = createRepositoryFs('/root');
  for (const [k, v] of Object.entries(promises)) {
    assert.equal(v.constructor.name, 'AsyncFunction', `${k} 必须是 async`);
  }
});

test('chroot: 正常读写；越界写入抛 FenceError', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chroot-'));
  const afs = createRepositoryFs(root);
  await afs.promises.mkdir('sub', { recursive: true });
  await afs.promises.writeFile('sub/f.txt', 'data');
  assert.equal((await afs.promises.readFile('sub/f.txt', 'utf8')), 'data');
  await assert.rejects(() => afs.promises.writeFile('../escape.txt', 'x'), FenceError);
});

test('isPromiseFs 探测：无参调用 readFile 返回 promise 而非同步抛错', async () => {
  const { promises } = createRepositoryFs('/root');
  const r = promises.readFile();
  assert.equal(typeof r.then, 'function');
  await assert.rejects(r);
});


test('TC-H04: 根外软链读写必须拒绝（resolveWithinReal 已接线）', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chroot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(outside, link, 'dir');
  } catch (e) {
    t.skip(`平台不允许创建软链（${e.code}）`);
    return;
  }
  const afs = createRepositoryFs(root);
  await assert.rejects(() => afs.promises.readFile('link/secret.txt'), FenceError);
  await assert.rejects(() => afs.promises.writeFile('link/evil.txt', 'x'), FenceError);
  await assert.rejects(() => afs.promises.stat('link/secret.txt'), FenceError);
});
