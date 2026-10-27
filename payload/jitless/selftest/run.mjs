#!/usr/bin/env node
/**
 * selftest/run.mjs —— 108-jitless 兼容层的**统一自检入口**（`specs/108-jitless/test-cases.md` 的 TC-108-xx 都从这里跑）。
 *
 * 为什么要有这层转发：两半兼容层（HTTP/undici 与图片 photon）由不同脚本覆盖，但验收文档
 * 只该记住**一个**入口。这里只做"选哪几支 + 透传参数 + 汇总退出码"，不重复任何断言
 * （断言留在各自脚本里，改一处就够）。
 *
 * 用法：
 *   node --jitless payload/jitless/selftest/run.mjs              # 全部（compat 形态）
 *   node payload/jitless/selftest/run.mjs                        # 对照组（WASM 可用，兼容层应不安装）
 *   node --jitless payload/jitless/selftest/run.mjs --only=fetch
 *   node --jitless payload/jitless/selftest/run.mjs --suite=photon
 *
 * 判据：退出码 0 = 全绿。**两种形态都必须绿**（jitless 下兼容层接管、对照组下不接管）。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  { id: 'fetch', file: 'fetch-undici.mjs', label: 'HTTP / undici 面（fetch 垫片）' },
  { id: 'photon', file: 'photon.mjs', label: '图片面（photon 同步垫片）' }
];

function parseArgs(argv) {
  const opts = { suite: 'all', only: '', extra: [] };
  for (const arg of argv) {
    if (arg.startsWith('--suite=')) opts.suite = arg.slice('--suite='.length);
    else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length);
    else opts.extra.push(arg);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const selected = opts.suite === 'all' ? SUITES : SUITES.filter((suite) => suite.id === opts.suite);
if (selected.length === 0) {
  console.error(`✗ 未知 --suite=${opts.suite}（可选：all / ${SUITES.map((s) => s.id).join(' / ')}）`);
  process.exit(2);
}

const mode = typeof WebAssembly === 'undefined'
  ? 'compat（--jitless，兼容层应接管）'
  : 'jit（WASM 可用，兼容层应不安装）';
console.log(`── 108-jitless 兼容层自检｜node ${process.version}｜形态：${mode} ─────────────`);

const results = [];
for (const suite of selected) {
  const abs = path.join(HERE, suite.file);
  // 必须把父进程的 execArgv 透传下去：`--jitless` 是**进程级** V8 开关，不继承就会出现
  // "父进程 compat、子进程 jit"的假绿（本轮实测踩到过：子进程打印 jit 却报 PASS）。
  const args = [...process.execArgv, abs];
  if (opts.only.length > 0) args.push(`--only=${opts.only}`);
  args.push(...opts.extra);
  console.log(`\n=== ${suite.label}（${suite.file}）===`);
  const started = Date.now();
  const child = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.resolve(HERE, '..', '..', '..') });
  results.push({ suite, code: child.status === null ? 1 : child.status, ms: Date.now() - started });
}

console.log('\n── 汇总 ────────────────────────────────────────────────────────────');
let failed = 0;
for (const item of results) {
  const ok = item.code === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.suite.id}（${item.suite.label}，${item.ms} ms，exit=${item.code}）`);
}
console.log(failed === 0
  ? `结论：全部通过（${results.length} 支 / 形态=${mode}）`
  : `结论：${failed} 支失败（形态=${mode}）——不得当作"兼容层正常"`);
process.exit(failed === 0 ? 0 : 1);
