#!/usr/bin/env node
/**
 * provision-pty.mjs —— 路线 A 原生件投放（镜像 provision-engine.mjs 纪律）。
 *
 * 把交叉编译产物 pty.node（canonical：payload/extensions/android-pty/vendor/node-pty/build/Release/）
 * 复制为 app/src/main/jniLibs/arm64-v8a/libpty_node.so。
 *
 * 为什么必须走 jniLibs（而不是从 filesDir dlopen）：Android targetSdk≥29 的 SELinux
 * neverallow execute:app_data_file ⇒ 从应用可写目录 dlopen 被拒（G3 纪律线）；
 * nativeLibraryDir（APK 解压的只读目录）是唯一合规执行位（与 libnode.so 同路）。
 * 二进制不入库（jniLibs 已 gitignore，与引擎同口径）；lock=vendor/pty.node.lock.json。
 *
 * 用法：node scripts/provision-pty.mjs [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'payload', 'extensions', 'android-pty', 'vendor', 'node-pty', 'build', 'Release', 'pty.node');
const LOCK = join(ROOT, 'payload', 'extensions', 'android-pty', 'vendor', 'pty.node.lock.json');
const OUT = join(ROOT, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a', 'libpty_node.so');
const check = process.argv.includes('--check');

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const fail = (c, m) => { console.error(`[provision-pty] ${m}`); process.exit(c); };

if (!existsSync(LOCK)) fail(2, `lock 不存在：${LOCK}（路线 A 未构建？）`);
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

if (check) {
  let ok = true;
  for (const f of [SRC, OUT]) {
    if (!existsSync(f)) { console.error(`[provision-pty] 缺失：${f}`); ok = false; continue; }
    if (statSync(f).size !== lock.size || sha(f) !== lock.sha256) {
      console.error(`[provision-pty] 不匹配：${f}（${sha(f).slice(0, 12)} ≠ ${lock.sha256.slice(0, 12)}）`);
      ok = false;
    }
  }
  console.log(ok ? `[provision-pty] pty.node 在位且校验通过（${lock.version}）` : '[provision-pty] 校验失败');
  process.exit(ok ? 0 : 2);
}

if (!existsSync(SRC)) fail(2, `源不存在：${SRC}（先交叉编译）`);
if (statSync(SRC).size !== lock.size || sha(SRC) !== lock.sha256) {
  fail(2, `源与 lock 不符：${sha(SRC).slice(0, 12)} ≠ ${lock.sha256.slice(0, 12)}`);
}
const fs = await import('node:fs');
fs.mkdirSync(join(OUT, '..'), { recursive: true });
copyFileSync(SRC, OUT);
console.log(`[provision-pty] libpty_node.so → ${OUT}（${statSync(OUT).size}B，sha256 ✓；lock=${lock.version}）`);
