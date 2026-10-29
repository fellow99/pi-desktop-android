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
 * @param {{ cwd: string, env?: Record<string,string>, timeoutMs?: number,
 *           silent?: boolean,
 *           expectArtifacts?: Array<string|{path:string,minBytes?:number,waitMs?:number}>,
 *           until?: (poll: () => boolean) => Promise<boolean>|boolean }} opts
 *   silent：true 时丢弃 pnpm 对 stdout/stderr 的写入（仍保留最多 8KB 到 output 供失败诊断），
 *           不污染 pi 主进程日志（C1：输出静默）。
 *   expectArtifacts：产物路径（相对 cwd）数组；完成判据不再只信 exit 信号，而是以产物落盘为准
 *           （R8-1：本环境 CLI 终止信号不落地）。runPnpm 会在 install 后等到全部产物出现/超时。
 *   until：自定义完成谓词（收一个 poll 函数，可在内部轮询）；给非产物型完成信号留口。
 * @returns {Promise<{ code: number, ms: number, output: string, timedOut?: boolean,
 *                     artifacts?: Record<string,boolean>, artifactSatisfied?: boolean }>}
 */
export function runPnpm(args, opts) {
  if (!existsSync(BUNDLE)) {
    return Promise.reject(new PnpmRunnerError(`vendored bundle 缺失：${BUNDLE}（载荷不完整？）`));
  }
  const { cwd, timeoutMs = 120_000, silent = false, expectArtifacts = [], until = null } = opts;
  if (!cwd) return Promise.reject(new PnpmRunnerError('opts.cwd 必填（工作目录围栏在 index.js 层做）'));

  // 产物断言状态（C1：exit 信号不可信时的替代完成判据）。静默完成靠它而非 code。
  const artList = expectArtifacts.map((a) => (typeof a === 'string' ? { path: a } : a));
  const artAbs = (p) => path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const fsSync = createRequire(import.meta.url)('node:fs');
  const probeArtifacts = () => {
    const status = {};
    for (const a of artList) {
      try {
        const st = fsSync.statSync(artAbs(a.path));
        // kind 默认 file；'dir' 只要求目录存在；'any' 二者皆可
        const kind = a.kind || 'file';
        const typeOk = kind === 'dir' ? st.isDirectory() : kind === 'any' ? true : st.isFile();
        status[a.path] = typeOk && (!a.minBytes || st.size >= a.minBytes);
      } catch { status[a.path] = false; }
    }
    return status;
  };

  return new Promise((resolve) => {
    const started = Date.now();
    const origArgv = process.argv;
    const origExit = process.exit;
    const origCwd = process.cwd();
    const origExitCode = process.exitCode;
    const chunks = [];
    let captured = 0;
    let done = false;
    let artifactPoll = null;
    const origOutWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    // silent：仍捕获最多 8KB 供诊断，但不写入真实 fd（完成静默）；非 silent 保持 tee 落 app.log
    const tee = (orig) => (chunk, ...rest) => {
      if (captured < 8192) {
        const s = typeof chunk === 'string' ? chunk : chunk.toString();
        chunks.push(s.slice(0, 8192 - captured));
        captured += s.length;
      }
      return silent ? true : orig(chunk, ...rest);
    };
    // 完成时附加产物断言（C1）：即便 exit 信号缺失/超时，只要产物齐即判成功
    const artifactSnapshot = () => (artList.length ? probeArtifacts() : undefined);
    const artifactsOk = (snapshot) => !artList.length || Object.values(snapshot || {}).every(Boolean);
    const finish = (code, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (artifactPoll) clearInterval(artifactPoll);
      process.off('exit', onRealExit);
      process.stdout.write = origOutWrite;
      process.stderr.write = origErrWrite;
      process.argv = origArgv;
      process.exit = origExit;
      process.exitCode = origExitCode;
      try { process.chdir(origCwd); } catch { /* cwd 已失效 */ }
      const artifacts = artifactSnapshot();
      const artifactSatisfied = artifactsOk(artifacts);
      // 有产物断言时以产物为准（exit 信号在本环境不可靠）：产物齐 → code 归一为 0
      const effectiveCode = artList.length ? (artifactSatisfied ? 0 : (code === 0 ? 1 : code)) : code;
      resolve({ code: effectiveCode, ms: Date.now() - started, output: chunks.join(''), artifacts, artifactSatisfied, ...extra });
    };
    const timer = setTimeout(() => finish(124, { timedOut: true }), timeoutMs);
    const onRealExit = (code) => { if (!done) finish(typeof code === 'number' ? code : 0); };
    process.on('exit', onRealExit);

    // 产物轮询：CLI 一旦把全部产物落盘即可提前完成（不等本环境不可靠的 exit 信号，C1）。
    // 给 CLI 500ms 发动宽限，之后每 120ms 探一次；产物齐即经 finish 归一成 code 0。
    if (artList.length) {
      setTimeout(() => {
        if (done) return;
        artifactPoll = setInterval(() => { if (artifactsOk(probeArtifacts())) finish(0, { via: 'artifacts' }); }, 120);
      }, 500);
    }

    try {
      process.stdout.write = tee(origOutWrite);
      process.stderr.write = tee(origErrWrite);
      process.argv = [origArgv[0], 'pnpm', ...args];
      process.chdir(cwd);
      // Android 无 /tmp：依赖 temp-dir 的包（pnpm 内嵌 .pnpm/temp-dir）在 lstat('/tmp') 处
      // unhandledRejection ⇒ 整个 bundle 崩溃（真机实测）。恒把 TMPDIR/TMP/TEMP 指到可写缓存目录。
      const os = createRequire(import.meta.url)('node:os');
      const tmpBase = (process.env.PI_ANDROID_HOME && (process.env.PI_ANDROID_HOME + '/tmp'))
        || path.join(os.homedir() || cwd, 'tmp');
      try { fsSync.mkdirSync(tmpBase, { recursive: true }); } catch { /* 建不了则 pnpm 自报错 */ }
      process.env.TMPDIR = tmpBase;
      process.env.TMP = tmpBase;
      process.env.TEMP = tmpBase;
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
