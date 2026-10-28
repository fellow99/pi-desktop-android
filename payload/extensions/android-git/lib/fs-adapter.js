/**
 * fs-adapter.js — isomorphic-git 的文件系统适配器：node:fs/promises + 仓库根 chroot。
 *
 * ⚠️ 硬契约（复刻 dsh 真机发现①，设计 §3 F4 / FR-204-011）：
 *   isomorphic-git 用 `isPromiseFs()` 判 fs 方言 —— 它**无参调用 `fs.readFile()`** 并看返回是否
 *   promise-like。适配器方法若**同步抛错**（例如对 undefined 路径做 path.resolve）会被判成
 *   **callback 风格**：所有命令被 pify 包成「等回调」，回调永不触发 → **所有 git 调用永久挂起**
 *   （不崩、不超时、只是不返回）。
 *   ⇒ **本文件 `promises.*` 每个方法都必须声明为 `async`**（async 函数不能同步抛错，探测即得 promise）。
 *
 * 每个真实路径都经 `resolveWithin(root, rel)` 做 chroot 前缀包含校验；越界（.. 逃逸/绝对路径）即拒。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { resolveWithin, resolveWithinReal } from './fence.js';

/**
 * 创建 isomorphic-git 期望的 fs 形（{ promises: {...} }），chroot 到 root。
 * isomorphic-git 的 FileSystem 同时接受裸 promises 对象或 { promises }；这里给 { promises }。
 */
export function createRepositoryFs(root) {
  const w = (rel) => resolveWithin(root, rel);
  // 软链防护（FR-204-010）：读写真实数据的路径必须 realpath 复核，防根外软链。
  // lstat/readlink/symlink 只操作链接本身，不跟随目标，用词法校验即可。
  const wr = (rel) => resolveWithinReal(root, rel);
  const promises = {
    // —— 读 ——
    async readFile(rel, opts) { return fsp.readFile(await wr(rel), opts); },
    async readdir(rel) { return fsp.readdir(await wr(rel)); },
    async stat(rel) { return fsp.stat(await wr(rel)); },
    async lstat(rel) { return fsp.lstat(w(rel)); },
    async readlink(rel) { return fsp.readlink(w(rel)); },
    // —— 写 ——
    async writeFile(rel, data, opts) { return fsp.writeFile(await wr(rel), data, opts); },
    async mkdir(rel, opts) { return fsp.mkdir(w(rel), opts); },
    async rmdir(rel) { return fsp.rmdir(await wr(rel)); },
    async unlink(rel) { return fsp.unlink(w(rel)); },
    async rename(from, to) { return fsp.rename(await wr(from), w(to)); },
    async symlink(target, rel) { return fsp.symlink(target, w(rel)); },
    async chmod(rel, mode) { return fsp.chmod(await wr(rel), mode); },
    // isomorphic-git 的 bindFs 递归删除首选 rm；rmSync 兜底用 rmdir/unlink 组合。
    async rm(rel, opts) { return fsp.rm(w(rel), opts); },
  };
  return { promises };
}

/** 返回与 node:fs 兼容的 `promises` 直出形式（isomorphic-git 也接受直接把 promises 当 fs 传）。 */
export function createRepositoryFsDirect(root) {
  return createRepositoryFs(root).promises;
}

/** 供 statusMatrix/log 等读操作用的原始 node:fs（isomorphic-git 部分 API 走 fs.promises）。 */
export { fs, fsp };
