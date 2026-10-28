#!/usr/bin/env node
/**
 * 引擎投放：aosp-node-runtime 的 libnode.so / libc++_shared.so → app/src/main/jniLibs/arm64-v8a/
 *
 * 为什么不用 Maven 的 io.github.fellow99:node-runtime:24.2.0：
 *   该构建为 --with-intl=none ⇒ Intl 全缺 ⇒ Next16 compiled 产物的 Unicode 属性转义在**编译期**
 *   SyntaxError ⇒ 进程内 Next 必炸（O2 ⚠️ / Phase 1 E2E 实测）；且翻译层模拟器上引导期 SEGV。
 *   参考工程（dsh-desktop-android docs/010 阶段2）同墙同解：上游 aosp-node-runtime 重编
 *   `--with-intl=small-icu` 的 v24.22.1（runtime.lock.json active，sha256 be1d16414a1e…），
 *   同一模拟器（x86_64+ARM 转译）DeepSeek 对话/看图全通。
 *
 * 事实源：<runtime-dir>/runtime.lock.json（active.release）。校验：sha256+size 完全一致，不符 exit 2。
 * 二进制不入库（.gitignore）；`node scripts/provision-engine.mjs --check` 校验当前状态。
 * 移植自 dsh-desktop-android/scripts/provision-engine.mjs（同门工程，同源同判据）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'app/src/main/jniLibs/arm64-v8a');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const check = process.argv.includes('--check');
const runtimeDir = argOf('--runtime-dir')
  || process.env.PDA_ANDROID_RUNTIME_DIR
  || 'D:/node-bridge-workspace/aosp-node-runtime';

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function fail(code, msg) {
  console.error(`[provision-engine] ${msg}`);
  process.exit(code);
}

const lockPath = join(runtimeDir, 'runtime.lock.json');
if (!existsSync(lockPath)) fail(2, `找不到 runtime.lock.json：${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const nodeVersion = lock.active.node;
const rel = lock.releases.find((r) => r.node === nodeVersion);
if (!rel) fail(2, `lock 中无 ${nodeVersion} 条目`);

const want = {
  'libnode.so': { sha256: rel.sha256, size: rel.size },
  'libc++_shared.so': { sha256: rel.libcxx.sha256, size: rel.libcxx.size },
};

const sourceDir = join(runtimeDir, 'node-runtime/src/main/jniLibs/arm64-v8a');

if (check) {
  let ok = true;
  for (const [name, expect] of Object.entries(want)) {
    const dst = join(OUT, name);
    if (!existsSync(dst)) { console.error(`[provision-engine] 缺失：${dst}`); ok = false; continue; }
    const stat = statSync(dst);
    const sha = sha256Of(dst);
    if (stat.size !== expect.size || sha !== expect.sha256) {
      console.error(`[provision-engine] 不匹配：${name}（${stat.size}B/${sha.slice(0, 12)} ≠ ${expect.size}B/${expect.sha256.slice(0, 12)}）`);
      ok = false;
    }
  }
  console.log(ok ? `[provision-engine] 引擎在位且校验通过（${nodeVersion}）` : '[provision-engine] 校验失败');
  process.exit(ok ? 0 : 2);
}

if (!existsSync(sourceDir)) fail(2, `投放源不存在：${sourceDir}（先在 aosp-node-runtime 跑 tools/provision.mjs）`);
mkdirSync(OUT, { recursive: true });
for (const [name, expect] of Object.entries(want)) {
  const src = join(sourceDir, name);
  if (!existsSync(src)) fail(2, `投放源缺文件：${src}`);
  const stat = statSync(src);
  const sha = sha256Of(src);
  if (stat.size !== expect.size || sha !== expect.sha256) {
    fail(2, `投放源与 lock 不符：${name}（${stat.size}B/${sha.slice(0, 12)} ≠ ${expect.size}B/${expect.sha256.slice(0, 12)}）`);
  }
  copyFileSync(src, join(OUT, name));
  console.log(`[provision-engine] ${name} → ${OUT}（${stat.size}B，sha256 ✓）`);
}
console.log(`[provision-engine] 引擎 ${nodeVersion}（small-icu）投放完成`);
