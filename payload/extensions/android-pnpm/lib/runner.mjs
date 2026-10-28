/**
 * runner.mjs —— 进程内 pnpm 执行器（规划 §11「vendored pnpm 进程内」的唯一执行路径）。
 *
 * 为什么这么写（每条都有依据）：
 *  · pnpm 官方单文件 bundle（dist/pnpm.cjs，9.15.9）**没有 require.main 守卫** —— require 即执行
 *    CLI（消费 process.argv）。因此进程内调用 = 「改 argv → 删 require 缓存 → 重新 require」，
 *    每次 都是新一次 CLI 生命周期（宿主与设备同路径，R8-1 探针即测这个）。
 *  · bundle 输出走 fd 直写（绕开 console 拦截）⇒ 不劫持输出：它自然落 app.log/node_bridge.log
 *    （⑱ 双通道纪律），工具返回值只带结构化事实（exit code / 产物断言），不搬运文本。
 *  · process.exit 必须劫持成 throw：CLI 完成路径会 exit(0)，不拦会把整个 pi 进程带走。
 *  · 每次调用后**必须恢复** argv/cwd/exit —— runner 跑在 pi 主进程内，任何泄漏都是全局污染。
 *  · ⚠️ 已知边界（如实，规划 R8-2/R8-4）：@pnpm 内部若走子进程（prepare 脚本/bin 运行）在设备
 *    spawn 受限下不可用 ⇒ 本执行器**永远**注入 --ignore-scripts（除非显式 scripts:true，
 *    那也会被 index.js 拒绝）。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, '..', 'vendor', 'pnpm.cjs');

export const PNPM_VERSION_BUNDLED = '9.15.9';

export class PnpmRunnerError extends Error {
  constructor(message, code = 'PNPM_RUNNER') { super(message); this.name = 'PnpmRunnerError'; this.code = code; }
}

/**
 * 进程内跑一次 pnpm CLI（**等待式**）。
 *
 * ⚠️ 关键事实（R8-1 探针实测，模拟器 berberis + bridge 进程内 Node）：bundle 的 require()
 * 返回 ≠ CLI 完成 —— CLI 主体是异步的，require 只把异步机器发动起来。若同步返回，调用方会在
 * pnpm 真正完成前拿到结果（且其尾部 process.exit 会打回真 exit）。因此本函数返回 **Promise**：
 * 以「exit 调用 / exit 事件 / 超时」三者为完成信号。
 *
 * @param {string[]} args CLI 参数（不含 'pnpm' 本身）
 * @param {{ cwd: string, env?: Record<string,string>, timeoutMs?: number }} opts
 * @returns {Promise<{ code: number, ms: number, output: string, timedOut?: boolean }>}
 */
export function runPnpm(args, opts) {
  if (!existsSync(BUNDLE)) {
    return Promise.reject(new PnpmRunnerError(`vendored bundle 缺失：${BUNDLE}（载荷不完整？）`));
  }
  const { cwd, timeoutMs = 120_000 } = opts;
  if (!cwd) return Promise.reject(new PnpmRunnerError('opts.cwd 必填（工作目录围栏在 index.js 层做）'));

  return new Promise((resolve) => {
    const started = Date.now();
    const origArgv = process.argv;
    const origExit = process.exit;
    const origCwd = process.cwd();
    const origExitCode = process.exitCode;
    const chunks = [];
    let captured = 0;
    let done = false;
    const origOutWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    const tee = (orig) => (chunk, ...rest) => {
      if (captured < 8192) {
        const s = typeof chunk === 'string' ? chunk : chunk.toString();
        chunks.push(s.slice(0, 8192 - captured));
        captured += s.length;
      }
      return orig(chunk, ...rest);
    };
    const finish = (code, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.off('exit', onRealExit);
      process.stdout.write = origOutWrite;
      process.stderr.write = origErrWrite;
      process.argv = origArgv;
      process.exit = origExit;
      process.exitCode = origExitCode;
      try { process.chdir(origCwd); } catch { /* cwd 已失效 */ }
      resolve({ code, ms: Date.now() - started, output: chunks.join(''), ...extra });
    };
    const timer = setTimeout(() => finish(124, { timedOut: true }), timeoutMs);
    const onRealExit = (code) => { if (!done) finish(typeof code === 'number' ? code : 0); };
    process.on('exit', onRealExit);

    try {
      process.stdout.write = tee(origOutWrite);
      process.stderr.write = tee(origErrWrite);
      process.argv = [origArgv[0], 'pnpm', ...args];
      process.chdir(cwd);
      if (opts.env) for (const [k, v] of Object.entries(opts.env)) process.env[k] = v;
      process.exit = (c) => finish(typeof c === 'number' ? c : 0);
      const req = createRequire(import.meta.url);
      delete req.cache[req.resolve(BUNDLE)];
      try {
        req(BUNDLE);
      } catch (err) {
        if (err && typeof err === 'object' && '__pnpmExit' in err) finish(err.__pnpmExit);
        else { chunks.push(String((err && err.stack) || err)); finish(1); }
      }
      // 同步返回 ≠ 完成：完成信号 = patched exit / 真实 exit 事件 / 超时（三者都在上面接线）
    } catch (err) {
      chunks.push(String((err && err.stack) || err));
      finish(1);
    }
  });
}

/** bundle 可装载性冒烟（不跑 CLI：只断言文件在且可读）。 */
export function assertBundlePresent() {
  if (!existsSync(BUNDLE)) throw new PnpmRunnerError(`vendor/pnpm.cjs 缺失：${BUNDLE}`);
  return BUNDLE;
}
