/**
 * runtime.js — 装载第三方运行时单文件 bundle（isomorphic-git + isomorphic-git/http/node + diff）。
 *
 * 为什么用 bundle：设备无 git、PI_OFFLINE=1 禁运行期安装；pi 经 jiti 从扩展目录解析兄弟模块，
 * pi-web 的 node_modules 不在解析路径上，因此 isomorphic-git 与 jsdiff 由构建期 esbuild 预打成
 * 单个 CJS 文件（vendor/isomorphic-git.bundle.cjs，scripts/build-git-vendor.mjs 产出）。
 *
 * 装载方式：本文件是 ESM，但 bundle 是 CJS —— 用 createRequire 从**本扩展目录** require 它
 * （jiti 对扩展内 CJS 同样适用，兄弟文件解析不依赖 pi-web/node_modules）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, '..', 'vendor', 'isomorphic-git.bundle.cjs');

let _cached = null;

/** 装载并断言 bundle 关键导出（fail-fast：缺入口/版本不符立即抛错，不半装载）。 */
export function loadGitRuntime() {
  if (_cached) return _cached;
  const require = createRequire(import.meta.url);
  const git = require(BUNDLE);
  const checks = {
    init: typeof git.init === 'function',
    clone: typeof git.clone === 'function',
    statusMatrix: typeof git.statusMatrix === 'function',
    log: typeof git.log === 'function',
    commit: typeof git.commit === 'function',
    http: typeof (git.http && git.http.request) === 'function',
    createTwoFilesPatch: typeof git.createTwoFilesPatch === 'function',
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length > 0) {
    throw new Error(`harmony-git: vendor bundle 缺入口：${failed.join(', ')}（重跑 scripts/build-git-vendor.mjs）`);
  }
  _cached = {
    git,                       // isomorphic-git 命名空间（平铺导出）
    http: git.http,            // isomorphic-git/http/node 客户端
    createTwoFilesPatch: git.createTwoFilesPatch,
    structuredPatch: git.structuredPatch,
    version: typeof git.version === 'function' ? git.version() : 'unknown',
  };
  return _cached;
}

/** 测试辅助：重置缓存（不影响生产单例语义）。 */
export function __resetGitRuntimeForTest() { _cached = null; }
