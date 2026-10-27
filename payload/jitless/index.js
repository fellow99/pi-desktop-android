'use strict';
/*
 * jitless 兼容层的**唯一出口**（需求 108-jitless）
 *
 * 【为什么需要这一层】OHOS 不允许 W^X 的 JIT 页 ⇒ 宿主以 `--jitless` 启动 ⇒ 在 V8 里连带
 * 关掉了 WASM ⇒ `WebAssembly === undefined`。于是 Node 自带的 undici 全线不可用：
 *   · 原生 `fetch`（解析器是 WASM 版 llhttp）一连接就抛 `WebAssembly is not defined`；
 *   · `node:http`/`node:https` 的惰性 getter（`lazyUndici`）会把 undici 拉起来；
 *   · 上游直接 `require('undici')` / `import { fetch } from 'undici'` 的包也走同一条死路。
 * 本目录下的四个文件就是这三条缺口的纯 JS 补齐：`http-lazy-undici.js`（封印惰性 getter）、
 * `fetch-shim.js`（基于原生 `node:http/https` 的 fetch 实现）、`undici-shim.js`（以真实导出
 * 为底、只覆写危险面）。
 *
 * 【判据只有一个】`typeof WebAssembly === 'undefined'`。WASM 可用时**一个动作都不做**
 * —— 桌面侧（有 WASM）必须保持 100% 原生行为，任何"顺手装一下"都会让原生 undici 与
 * 我们的垫片打架（例如 `maxHeaderSize` 被换掉后原生 fetch 直接报
 * `http module header size invalid`）。
 *
 * 【调用方式】入口脚本（组装期生成的条件入口）：
 *     const { installIfNeeded } = require(process.env.PI_JITLESS_DIR + '/index.js');
 *     const facts = installIfNeeded((line) => writeLog(line));
 * 本模块**不写任何文件**：`log` 回调由调用方负责落盘。
 *
 * 【返回事实（结构化三态）】`installed` / `kept` / `failed`：
 *     {
 *       active: boolean,        // 兼容层是否接管（= WASM 是否缺失）
 *       webAssembly: 'undefined' | 'defined',
 *       httpLazy: 'installed' | 'kept' | 'failed',   // 惰性 getter 封印结果
 *       sealed: string[],                            // 被封印的属性名清单
 *       fetch: 'installed' | 'kept' | 'failed',      // globalThis.fetch 是否被接管
 *       globals: { Headers: ..., Request: ..., Response: ..., FormData: ..., Blob: ..., File: ... },
 *       fetchImpl: Function | null,                  // 接管后的 fetch（未接管时为 null）
 *     }
 * 幂等：重复调用返回**同一个对象**，不重复安装。
 */

/** 兼容层自身所在目录：组装期生成的条件入口靠它定位本目录。 */
/**
 * 兼容层自身所在目录：组装期生成的条件入口（`pi-jitless-entry.cjs`）靠它定位本目录。
 *
 * 【为什么不在模块顶层无条件设置】jit 形态（有 ACL）下条件入口走 `require(REAL_MAIN)`，
 * 根本不需要这个变量；无条件设置等于给进程环境多塞一个绝对路径（子进程可见），
 * 与 NFR-108-001「jit 形态零可观察差异」相悖 ⇒ 只在 compat 分支里设（见 installIfNeeded）。
 */
const SHIM_DIR = __dirname;
const { sealHttpLazyUndici } = require('./http-lazy-undici.js');
const { installFetchShim } = require('./fetch-shim.js');

const LOG_PREFIX = '[jitless]';
const NOOP = () => {};

/** 幂等缓存：`null` = 还没跑过。 */
let state = null;

/** 把各阶段的结果画成一行（日志里一眼能看出三态与细节）。 */
function describe(facts) {
  const globals = Object.entries(facts.globals)
    .map(([name, status]) => `${name}:${status}`)
    .join(', ');
  return `httpLazy=${facts.httpLazy}（${facts.sealed.length > 0 ? facts.sealed.join(', ') : '无'}）`
    + ` fetch=${facts.fetch}`
    + ` globals=${globals.length > 0 ? globals : '(无)'}`;
}

/**
 * 按需安装 jitless 兼容层。
 *
 * @param {(line: string) => void} [log] 日志回调（调用方负责落盘；本模块不写文件）
 * @returns {{active: boolean, webAssembly: 'undefined'|'defined', httpLazy: string, sealed: string[],
 *   fetch: string, globals: Record<string, string>, fetchImpl: Function|null}}
 */
function installIfNeeded(log = NOOP) {
  const say = typeof log === 'function' ? log : NOOP;
  /* 幂等：第二次进来只回报事实，不再动任何全局/模块对象。**事实照打**：
   * 首次调用可能来自上游库（默认 NOOP 日志），那样结构化安装结果就永远进不了 app.log
   * （FR-108-002/008 要求"可 grep 的三态事实"），所以这里也 describe 一遍。 */
  if (state !== null) {
    say(`${LOG_PREFIX} 兼容层已安装过（幂等）：${describe(state)}`);
    return state;
  }


  if (typeof WebAssembly !== 'undefined') {
    say(`${LOG_PREFIX} WASM 可用：兼容层不安装`);
    state = {
      active: false,
      webAssembly: 'defined',
      httpLazy: 'kept',
      sealed: [],
      fetch: 'kept',
      globals: {},
      fetchImpl: null,
    };
    return state;
  }

  /*
   * compat 分支的入口动作之一：把本目录告诉组装期生成的条件入口（`pi-jitless-entry.cjs`）。
   * 放在这里而不是模块顶层 —— jit 形态不需要它，也不该给进程环境增变量（NFR-108-001）。
   */
  process.env.PI_JITLESS_DIR = SHIM_DIR;

  /*
   * 顺序是承重的：**先封 getter、再接管 fetch**。
   * 反过来的话 `installFetchShim()` 里读 `globalThis.Headers` 之类的惰性属性时，
   * 可能先把 undici 拉起来（那一步在 jitless 下的表现取决于 Node 版本：本机是"能物化、
   * 发请求才炸"，但端侧不保证）。
   */
  let httpLazy = 'failed';
  let sealed = [];
  let httpDetail = null;
  try {
    const report = sealHttpLazyUndici(say);
    sealed = Array.from(report);
    httpLazy = typeof report.status === 'string' ? report.status : 'installed';
    httpDetail = report.detail === undefined ? null : report.detail;
    if (httpDetail !== null && Array.isArray(httpDetail.failed) && httpDetail.failed.length > 0) {
      say(`${LOG_PREFIX} 惰性 getter 封印有失败项：${httpDetail.failed.join('；')}`);
    }
  } catch (error) {
    /* 【为什么兜住】入口脚本没有第二次机会：这里抛出去就等于宿主起不来。
     * 记一行 failed 事实，继续装 fetch —— fetch 才是"能不能调模型"的决定项。 */
    say(`${LOG_PREFIX} 封印 node:http/https 惰性 getter 失败（继续安装 fetch）：${String(error)}`);
  }

  let fetchStatus = 'failed';
  let globals = {};
  let fetchImpl = null;
  try {
    const result = installFetchShim();
    fetchStatus = result.status;
    globals = result.globals;
    fetchImpl = result.fetch === undefined ? null : result.fetch;
  } catch (error) {
    say(`${LOG_PREFIX} 安装 fetch 垫片失败：${String(error)}`);
  }

  state = {
    active: true,
    webAssembly: 'undefined',
    httpLazy,
    sealed,
    fetch: fetchStatus,
    globals,
    fetchImpl,
  };

  say(`${LOG_PREFIX} 兼容层安装完成：${describe(state)}`);
  return state;
}

module.exports = { installIfNeeded };
