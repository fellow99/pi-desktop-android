#!/usr/bin/env node
/**
 * regression.mjs —— Phase 3 回归四件套（规划 §F 第 3 级 #3；对标 ark 同名纪律）。
 *
 * 四件：
 *   ① 签名哈希（apksigner --print-certs 的 SHA-256；keystore 不变 ⇒ 值不变）
 *   ② 包体（APK 字节数）
 *   ③ 首启耗时（--firstlaunch-ms，由 adb 侧测量脚本传入：am start → 「引擎引导事实已写」）
 *   ④ /facts 关键字段（--facts engine-facts.json：node 版本/Intl 口径/WASM/载荷 sha）
 *
 * 用法：
 *   node scripts/regression.mjs --apk app/build/outputs/apk/release/app-release.apk \
 *        [--facts <engine-facts.json>] [--firstlaunch-ms <N>] [--out build/regression.json]
 * 输出：人读表 + 机器读 JSON（对比基线时 diff 之）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const apk = argOf('--apk');
const factsPath = argOf('--facts');
const firstLaunchMs = argOf('--firstlaunch-ms');
const outPath = argOf('--out') || path.join(ROOT, 'build', 'regression.json');

if (!apk || !fs.existsSync(apk)) {
  console.error('用法：node scripts/regression.mjs --apk <apk> [--facts <engine-facts.json>] [--firstlaunch-ms N] [--out build/regression.json]');
  process.exit(2);
}

const record = { at: new Date().toISOString(), apk: path.basename(apk) };

// ① 包体
record.apkBytes = fs.statSync(apk).size;
record.apkMiB = +(record.apkBytes / 1024 / 1024).toFixed(1);

// ② 签名哈希
{
  const signer = findTool('apksigner.bat') || findTool('apksigner');
  if (!signer) { record.certSha256 = null; console.log('⚠ apksigner 不在 build-tools（PATH 未含 build-tools？）'); }
  else {
    const res = spawnSync(signer, ['verify', '--print-certs', apk], { encoding: 'utf8', shell: true });
    const m = /SHA-256 digest:\s*([0-9a-f]{64})/i.exec(res.stdout || '');
    record.certSha256 = m ? m[1] : null;
    if (!record.certSha256) console.log(`⚠ apksigner 输出未解析：${(res.stdout || res.stderr || '').slice(0, 200)}`);
  }
}

// ③ 首启耗时（外部测量值；本脚本只记账）
record.firstLaunchMs = firstLaunchMs ? Number(firstLaunchMs) : null;

// ④ /facts 关键字段（本工程落点 = engine-facts.json）
if (factsPath && fs.existsSync(factsPath) && fs.statSync(factsPath).size > 0) {
  const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  const boot = facts.bootFacts && typeof facts.bootFacts === 'object' ? facts.bootFacts : null;
  record.facts = {
    node: boot?.node ?? null,
    intlPresent: boot?.intl?.present ?? null,
    intlPropertyEscape: boot?.intl?.propertyEscapeCompile ?? null,
    wasmValidateOk: boot?.wasm?.validateOk ?? null,
    abi: facts.platform?.abi ?? null,
    payloadSha256: facts.payloadSha256 ?? null,
  };
} else {
  record.facts = null;
}

function findTool(name) {
  const bt = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'build-tools') : null;
  if (bt && fs.existsSync(bt)) {
    const versions = fs.readdirSync(bt).sort().reverse();
    for (const v of versions) {
      const p = path.join(bt, v, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

console.log('── 回归四件套 ──────────────────────────────');
console.log(`① 包体        : ${record.apkMiB} MiB（${record.apkBytes} B）`);
console.log(`② 签名 SHA-256: ${record.certSha256 ? record.certSha256.slice(0, 32) + '…' : '(未取得)'}`);
console.log(`③ 首启耗时    : ${record.firstLaunchMs != null ? record.firstLaunchMs + ' ms' : '（未提供 --firstlaunch-ms）'}`);
console.log(`④ facts 关键字段: ${record.facts ? `node=${record.facts.node} intl=${record.facts.intlPresent} wasm=${record.facts.wasmValidateOk} abi=${record.facts.abi}` : '(未提供 --facts)'}`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
console.log(`\n已写 ${outPath}`);
