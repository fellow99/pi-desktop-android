#!/usr/bin/env node
/**
 * devtest.mjs —— 宿主侧回归守门（能力清单 §F 第 1 级 #4「Intl 探针常态化」的 CI 半边）。
 *
 * 换引擎/换载荷后必跑；任一断言失败即 exit 非 0。判据全部可复核（宪法 C5）：
 *
 *   G1 引擎在位       ：`provision-engine.mjs --check`（jniLibs 与 runtime.lock.json 的 sha256/size）
 *   G2 载荷资产一致   ：assets/pi-web/pi-web.tar.gz 的 SHA-256 == pi-web.version 记录
 *   G3 裁剪规则自审   ：crop-rules.assertKeepSound()（keep/标记/跳过前缀真的生效）
 *   G4 vendor Intl 残留：载荷 stage 的 4 个 vendor compiled 文件不得再有 Unicode 属性转义
 *                        （small-icu 引擎原生支持 ⇒ 残留即组装流程被绕过的信号）
 *   G5 裁剪账目       ：--facts <engine-facts.json> 时，校验端上落盘事实的 Intl 块
 *                        （bootFacts.intl.propertyEscapeCompile 双 true + node 版本前缀）
 *
 * 用法：
 *   node scripts/devtest.mjs
 *   node scripts/devtest.mjs --facts <device-dump>/engine-facts.json   # 追加 G5（端上取证）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKeepSound } from './crop-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'app', 'src', 'main', 'assets', 'pi-web');
const STAGE_ROOT = path.join(PROJECT_ROOT, 'build', 'payload-stage', 'pi-web');

const VENDOR_COMPAT_FILES = [
  'node_modules/next/dist/compiled/@edge-runtime/primitives/url.js.text.js',
  'node_modules/next/dist/compiled/edge-runtime/index.js',
  'node_modules/next/dist/compiled/terser/bundle.min.js',
  'node_modules/next/dist/compiled/zod-validation-error/index.js',
];

const argv = process.argv.slice(2);
const factsArg = argv.includes('--facts') ? argv[argv.indexOf('--facts') + 1] : null;

let failures = 0;
const say = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// G1 引擎在位（sha256 门禁的权威判定在 provision 脚本本身）
{
  const res = spawnSync(process.execPath, [path.join(HERE, 'provision-engine.mjs'), '--check'], { encoding: 'utf8' });
  say(res.status === 0, 'G1 引擎在位（provision --check）', (res.stdout + res.stderr).trim().split('\n').pop() ?? '');
}

// G2 载荷资产一致
{
  const tar = path.join(ASSETS_DIR, 'pi-web.tar.gz');
  const ver = path.join(ASSETS_DIR, 'pi-web.version');
  if (!fs.existsSync(tar) || !fs.existsSync(ver)) {
    say(false, 'G2 载荷资产一致', `缺 ${tar} 或 ${ver}（先跑 assemble-payload.mjs --apply）`);
  } else {
    const actual = createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
    const expected = fs.readFileSync(ver, 'utf8').trim();
    say(actual === expected, 'G2 载荷资产一致', actual === expected ? `sha256 ${actual.slice(0, 12)}…` : `version=${expected.slice(0, 12)}… 实际=${actual.slice(0, 12)}…（需重跑 --apply）`);
  }
}

// G3 裁剪规则自审
{
  const problems = assertKeepSound();
  say(problems.length === 0, 'G3 裁剪规则自审（assertKeepSound）', problems.join('；'));
}

// G4 vendor Intl 残留（stage 存在才查——stage 是 assemble 的中间产物，可复跑后检查）
{
  if (!fs.existsSync(STAGE_ROOT)) {
    console.log('⏭  G4 vendor Intl 残留 —— stage 不存在（跑一次 assemble-payload.mjs 后再验）');
  } else {
    let residual = [];
    for (const rel of VENDOR_COMPAT_FILES) {
      const p = path.join(STAGE_ROOT, rel);
      if (!fs.existsSync(p)) continue; // 上游产物结构变化时以 assemble 的覆盖断言为准
      const text = fs.readFileSync(p, 'utf8');
      if (text.includes('\\p{ID_Start}') || text.includes('\\p{ID_Continue}')) residual.push(rel);
    }
    say(residual.length === 0, 'G4 vendor Intl 残留（属性转义应已做 ASCII 等价替换）', residual.length ? residual.join('；') : '4 文件 0 残留');
  }
}

// G6 pty.node 锁（路线 A 原生件；存在才验——lock 与产物必须成对）
{
  const lock = path.join(PROJECT_ROOT, 'payload', 'extensions', 'android-pty', 'vendor', 'pty.node.lock.json');
  const bin = path.join(PROJECT_ROOT, 'payload', 'extensions', 'android-pty', 'vendor', 'node-pty', 'build', 'Release', 'pty.node');
  if (!fs.existsSync(lock)) {
    console.log('⏭  G6 pty.node 锁 —— 未投放（路线 A 未执行）');
  } else {
    const want = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (!fs.existsSync(bin)) {
      say(false, 'G6 pty.node 锁', 'lock 在而产物缺：' + bin);
    } else {
      const sha = createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
      say(sha === want.sha256, 'G6 pty.node sha256 锁（路线 A）', `${sha.slice(0, 16)}… / ${want.version}`);
    }
  }
}

// G5 端上 engine-facts（可选：--facts 指向 run-as 拉回的 engine-facts.json）
if (factsArg) {
  try {
    const facts = JSON.parse(fs.readFileSync(factsArg, 'utf8'));
    const boot = facts.bootFacts;
    if (!boot || typeof boot === 'string') {
      say(false, 'G5 端上形态事实（engine-facts.json）', 'bootFacts 缺席/仍为 pending（launch 脚本没跑到？）');
    } else {
      const intl = boot.intl ?? {};
      const escapeOk = intl.propertyEscapeCompile?.scriptGreek === true && intl.propertyEscapeCompile?.idStart === true;
      say(escapeOk, 'G5 端上 Intl 探针：属性转义可编译（small-icu 判据）', JSON.stringify(intl.propertyEscapeCompile));
      say(boot.intl?.present === true, 'G5 端上 Intl 探针：Intl 存在', `node=${boot.node}`);
      say(String(boot.node ?? '').startsWith('v24.22.1'), 'G5 端上引擎版本口径（lock active）', `node=${boot.node}`);
      const wasm = boot.wasm ?? {};
      say(wasm.available === true && wasm.validateOk === true, 'G5 端上 WASM 探针（O1 口径）', JSON.stringify(wasm));
    }
  } catch (err) {
    say(false, 'G5 端上形态事实（engine-facts.json）', `读取失败：${err.message}`);
  }
}

console.log(failures === 0 ? '\ndevtest：全部通过 ✔' : `\ndevtest：${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
