'use strict';
/*
 * `undici` 垫片（需求 108-jitless）：**以真实导出为底，只覆写危险面**
 *
 * 【问题】`--jitless` 下 `WebAssembly === undefined`，而 undici 的 HTTP 解析器是 WASM 版
 * llhttp ⇒ 任何真正发出去的请求都会抛 `WebAssembly is not defined`。上游却经常**不用全局
 * fetch**：它 `require('undici')` / `import { fetch } from 'undici'` 自己拿 dispatcher、
 * `new Agent(...)`、`setGlobalDispatcher(...)`。所以只垫 `globalThis.fetch` 不够。
 *
 * 【实测前提（决定策略）】`node --jitless` 下 `require('undici')` **能正常加载**；
 * 构造 `EnvHttpProxyAgent` / `Client`、调用 `setGlobalDispatcher` 都**不抛错**
 * —— 只有真正发起请求时才炸。因此不重写整个模块（重写会把上游要用的十几个具名导出丢光，
 * 而具名导入在解析阶段就校验存在性，缺一个名字会让**整个模块图** `failed to import`），
 * 而是：
 *   · 以**真实导出为底**（`{...real}`）；
 *   · 只把"一发请求就炸"的那几个面覆写成纯 JS 实现或**明确失败**的实现。
 *
 * 【危险面清单】
 *   · `install()`         —— **空操作**。它会把 `globalThis.fetch` 覆写成 WASM 版实现，
 *                            那等于把已经装好的纯 JS 垫片顶掉，属于"最坏的一步"。
 *   · `fetch`             —— 换成 `fetch-shim.js` 的 `shimFetch`。
 *   · `setGlobalDispatcher` / `getGlobalDispatcher` —— 惰性内存记录，绝不抛错
 *                            （上游常见写法是启动时 `setGlobalDispatcher(new Agent(...))`，
 *                            那一步不该失败；失败会把整个插件激活打断）。
 *   · `request` / `stream` / `pipeline` / `connect` / `upgrade` —— 返回**明确 reject** 的
 *                            Promise。理由：它们的返回形态是 undici 特有的
 *                           `{statusCode, headers, body, trailers}`，用 `Response` 冒充会
 *                           **静默给错类型**，比"明确报错"难查得多。故错误信息里直接指路：
 *                           改用 fetch（已由纯 JS 垫片接管）。
 *   · 其余键（`Headers`/`Request`/`Response`/`FormData`/`Agent`/`Dispatcher`/`Pool`/
 *     `Client`/`ProxyAgent`/`EnvHttpProxyAgent`/`RetryAgent`/`MockAgent`/`errors`/
 *     `interceptors`/…）原样透出：它们构造起来不碰 WASM，透出即可。
 *
 * 【一个已知边界】真实 `Agent` 的实例方法 `agent.dispatch(...)` / `agent.request(...)`
 * 仍是 undici 自己的实现 ⇒ 走到那一步仍会抛 WASM 错。**不**去 patch 真实类的原型：
 * 那会污染真实模块（同进程有 WASM 的桌面场景也必须干净），而且 `fetch({dispatcher})` 这条
 * 常用路径已经被我们的 `shimFetch` 接管（我们忽略 `dispatcher`）。
 *
 * 本文件不 require `undici`，也不触碰 `WebAssembly`。
 */

const { shimFetch } = require('./fetch-shim.js');

const LOG_PREFIX = '[jitless]';

/** 危险面的统一错误文案（明确写清"为什么不可用 + 该怎么改"）。 */
const UNAVAILABLE_MESSAGE = 'jitless 形态：undici 的 HTTP 解析器是 WASM，请改用 fetch（已由纯 JS 垫片接管）';

/**
 * 造一个"明确失败"的 Promise。
 * @param {string} op undici 上的方法名
 * @returns {Promise<never>}
 */
function unavailable(op) {
  const error = new Error(`${UNAVAILABLE_MESSAGE}；被调用的入口是 undici.${op}`);
  error.name = 'JitlessUndiciUnavailable';
  error.code = 'ERR_JITLESS_UNDICI_WASM';
  error.undiciEntry = `undici.${op}`;
  return Promise.reject(error);
}

/**
 * 构造 undici 垫片对象。
 *
 * @param {object|null|undefined} real 真实 undici 模块对象（`require('undici')` 的结果）。
 *   传 `undefined`/`null` 也安全（得到只有覆写面的对象），便于自检与降级。
 * @returns {object} **普通对象**（`{...real}` 后再覆写），可直接 `module.exports =`
 */
function createUndiciShim(real) {
  const base = real !== null && typeof real === 'object' ? { ...real } : {};

  /* 全局 dispatcher：只记在内存里。初始值沿用真实模块给的那个（如果有），
   * 这样上游"先 get 再 set"的写法也能跑，且不会因为取默认值而触发 WASM。 */
  let globalDispatcher;
  try {
    globalDispatcher = typeof real?.getGlobalDispatcher === 'function' ? real.getGlobalDispatcher() : undefined;
  } catch (error) {
    globalDispatcher = undefined;
  }

  /*
   * 惰性的兜底 dispatcher：上游若真拿它去 `dispatch()`，会收到与 request 同一族的明确错误；
   * 而 `close()`/`destroy()`（清理阶段最常调的两个）必须安静成功，否则关停流程会炸。
   */
  const fallbackDispatcher = {
    dispatch: () => unavailable('dispatch'),
    close: async () => {},
    destroy: async () => {},
  };

  const shim = {
    ...base,

    /*
     * 【绝不能真调】真实 undici 的 `install()` 会做 `globalThis.fetch = undici.fetch`，
     * 在 jitless 下等于把纯 JS 垫片顶掉，随后每次请求都炸。空操作是这里唯一正确的行为。
     */
    install() {
      try {
        console.error(`${LOG_PREFIX} undici.install() 已被纯 JS 垫片接管：空操作（不覆写 globalThis.fetch）`);
      } catch {
        /* 忽略 */
      }
      return undefined;
    },

    fetch: shimFetch,

    setGlobalDispatcher(dispatcher) {
      globalDispatcher = dispatcher;
      return undefined;
    },

    getGlobalDispatcher() {
      return globalDispatcher === undefined ? fallbackDispatcher : globalDispatcher;
    },

    /* 以下五个**明确失败**：返回形态与 fetch 不同，不能冒充（见文件头）。 */
    request: () => unavailable('request'),
    stream: () => unavailable('stream'),
    pipeline: () => unavailable('pipeline'),
    connect: () => unavailable('connect'),
    upgrade: () => unavailable('upgrade'),
  };

  return shim;
}

module.exports = { createUndiciShim, UNAVAILABLE_MESSAGE };
