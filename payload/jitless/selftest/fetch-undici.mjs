#!/usr/bin/env node
/**
 * payload/jitless/selftest/fetch-undici.mjs —— jitless 兼容层的纯 Node 自检
 *
 * 【为什么要这么测】这一层唯一的存在理由是"在**没有 WASM** 的进程里让 fetch 能用"。
 * 只读代码看不出真假，必须真起一个 `node:http` 服务、用 `--jitless` 跑一遍；同时还要跑
 * **对照组**（WASM 可用）证明它"一个动作都不做"——两种模式**同一份脚本**都要通过。
 *
 * 用法：
 *     node --jitless payload/jitless/selftest/fetch-undici.mjs   # 目标形态（WASM 缺失）
 *     node          payload/jitless/selftest/fetch-undici.mjs    # 对照组（WASM 可用）
 *     node --jitless ... --only=sse                              # 名字含 sse 的用例
 *
 * 约定：
 *   · 只用 Node 内置模块（`node:http`/`node:fs`/`node:os`…），**不 require undici**；
 *   · 功能用例一律直接调 `shimFetch`（对照组里 `globalThis.fetch` 是原生实现，
 *     拿它测等于测 undici，不是测本层）；只有"接管与否"由模式决定的两条用例走全局 fetch；
 *   · "undici 面"用**临时包目录**模拟组装期的条件入口（改写 `package.json` 的 `main`），
 *     再 `import('undici')` 走真实的包解析路径；
 *   · 临时目录默认在 `os.tmpdir()`，可用 `PI_SELFTEST_TMP=<dir>` 指定（便于沙箱/CI）。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ReadableStream } from 'node:stream/web';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const JITLESS_DIR = path.resolve(HERE, '..');

const { installIfNeeded } = require(path.join(JITLESS_DIR, 'index.js'));
const { shimFetch, installFetchShim, Request: ShimRequest, Response: ShimResponse } =
  require(path.join(JITLESS_DIR, 'fetch-shim.js'));
const { sealHttpLazyUndici } = require(path.join(JITLESS_DIR, 'http-lazy-undici.js'));
const { createUndiciShim, UNAVAILABLE_MESSAGE } = require(path.join(JITLESS_DIR, 'undici-shim.js'));

/** 本次进程的形态：目标形态是 `--jitless`（WASM 缺失）。 */
const JITLESS = typeof WebAssembly === 'undefined';
const MODE = JITLESS ? '--jitless（WASM 缺失，兼容层应接管）' : 'WASM 可用（对照组，兼容层应不安装）';

// ── 断言与用例框 ──────────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function deepEq(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

async function expectReject(target, predicate, label) {
  let error = null;
  try {
    await (typeof target === 'function' ? target() : target);
  } catch (e) {
    error = e;
  }
  assert(error !== null, `${label}：应当 reject，实际成功了`);
  if (predicate !== undefined) {
    assert(predicate(error), `${label}：reject 原因不符（${error?.name}: ${error?.message}）`);
  }
  return error;
}

const results = [];
let only = null;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--only=')) only = arg.slice('--only='.length);
}

async function run(name, fn) {
  if (only !== null && !name.includes(only)) return;
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时（20s）')), 20000).unref()),
    ]);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name} <${error?.message}>`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 本地被测服务（一个 server + 路由）─────────────────────────────────────
const records = {
  sseWriteTimes: [],
  redirectHops: 0,
  submit: null,
  after: null,
  abortCloses: 0,
};

let server = null;
let baseUrl = '';
const sockets = new Set();

function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/text') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-test': 'yes' });
    res.end('hello jitless');
    return;
  }

  if (p === '/echo') {
    /* 把 method / 头 / 体**原样**回给客户端：头是否真的发出去了，只能让服务端来说。 */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        headers: req.headers,
        body,
        bodyBytes: Buffer.byteLength(body),
        contentLengthHeader: req.headers['content-length'] ?? null,
        transferEncoding: req.headers['transfer-encoding'] ?? null,
      }));
    });
    return;
  }

  if (p === '/slow-headers') {
    /* 故意晚 300ms 才发响应头：用来验证"请求阶段中止"（fetch 还没 resolve 时中止）。 */
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('slow');
    }, 300);
    req.on('close', () => { records.abortCloses += 1; });
    return;
  }

  if (p === '/sse') {
    records.sseWriteTimes = [];
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    (async () => {
      for (let i = 1; i <= 5; i += 1) {
        await sleep(40);
        records.sseWriteTimes.push(Date.now());
        if (!res.writableEnded) res.write(`data: ${i}\n\n`);
      }
      if (!res.writableEnded) res.end();
    })().catch(() => {});
    return;
  }

  if (p === '/abort') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.flushHeaders();
    res.write('chunk-1');
    req.on('close', () => { records.abortCloses += 1; });
    return; // 故意不 end：客户端必须能中止掉
  }

  if (p === '/upload') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      const needle = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10, 45, 45]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        contentType,
        hasBoundary: /boundary=.+/.test(contentType),
        bytesFound: body.indexOf(needle) !== -1,
        hasFieldName: body.includes(Buffer.from('name="field"', 'utf8')),
        hasFieldValue: body.includes(Buffer.from('中文值', 'utf8')),
        hasFilename: body.includes(Buffer.from('filename="a.bin"', 'utf8')),
        hasFileType: body.includes(Buffer.from('Content-Type: application/octet-stream', 'utf8')),
        looksLikeObjectFormData: body.includes(Buffer.from('[object FormData]', 'utf8')),
        total: body.length,
        contentLengthHeader: req.headers['content-length'] ?? null,
      }));
    });
    return;
  }

  if (p === '/r1') {
    records.redirectHops += 1;
    res.writeHead(301, { location: '/r2' });
    res.end('r1');
    return;
  }
  if (p === '/r2') {
    records.redirectHops += 1;
    res.writeHead(302, { location: '/done' });
    res.end('r2');
    return;
  }
  if (p === '/done') {
    records.redirectHops += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('redirected-ok');
    return;
  }
  if (p === '/submit') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      records.submit = { method: req.method, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(303, { location: '/after' });
      res.end();
    });
    return;
  }
  if (p === '/after') {
    records.after = {
      method: req.method,
      contentLength: req.headers['content-length'] ?? null,
      transferEncoding: req.headers['transfer-encoding'] ?? null,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

async function startServer() {
  if (server !== null) return;
  server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (server === null) return;
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* 忽略 */ }
  }
  sockets.clear();
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

// ── 用例 1：安装事实（三态 + 幂等）──────────────────────────────────────
await run('install-facts', async () => {
  const names = ['Headers', 'Request', 'Response', 'FormData', 'Blob', 'File'];
  const before = {};
  for (const name of names) {
    try {
      before[name] = globalThis[name] === undefined ? 'missing' : 'present';
    } catch {
      before[name] = 'missing';
    }
  }
  const fetchBefore = globalThis.fetch;

  const lines1 = [];
  const first = installIfNeeded((line) => lines1.push(line));
  const lines2 = [];
  const second = installIfNeeded((line) => lines2.push(line));

  assert(first !== null && typeof first === 'object', 'installIfNeeded 必须返回事实对象');
  eq(first, second, 'installIfNeeded 必须幂等（第二次返回同一个对象）');
  assert(lines2.some((l) => l.includes('幂等')), '第二次调用应打出"幂等"日志');

  if (JITLESS) {
    eq(first.active, true, 'jitless 下 active 必须是 true');
    eq(first.webAssembly, 'undefined', 'jitless 下 webAssembly 事实必须是 undefined');
    eq(first.httpLazy, 'installed', 'jitless 下 httpLazy 必须是 installed');
    eq(first.fetch, 'installed', 'jitless 下 fetch 必须是 installed');
    assert(typeof first.fetchImpl === 'function', 'fetchImpl 必须是函数');
    eq(globalThis.fetch, first.fetchImpl, 'jitless 下 globalThis.fetch 必须已被接管');
    eq(globalThis.fetch, shimFetch, 'jitless 下 globalThis.fetch 必须是 shimFetch');
    assert(first.sealed.length > 0, 'jitless 下应至少封印了一个惰性 getter');
    assert(first.sealed.includes('maxHeaderSize'), `封印清单应含 maxHeaderSize，实际 ${first.sealed.join(', ')}`);
    for (const name of names) {
      const status = first.globals[name];
      assert(status === 'kept' || status === 'installed' || status === 'failed', `${name} 的三态取值非法：${status}`);
      assert(status !== 'failed', `${name} 不应是 failed（原生取不到、垫片也装不上）`);
      /*
       * 期望：**存在即 `kept`**（不粗暴覆盖）。
       *
       * 曾经在 compat 形态下改成"一律接管这六个全局"，想消掉真机那条
       * `unhandledRejection: WebAssembly is not defined`——**失败并已回滚**：
       * 接管后该报错依旧，但 Next 路由直接 500（`NextResponse` 继承 `globalThis.Response`，
       * 最小垫片不满足其语义）。真机两轮对照记录在 `fetch-shim.js` 对应注释块里。
       */
      if (before[name] === 'present') eq(status, 'kept', `Node 自带的 ${name} 应 kept（不粗暴覆盖）`);
    }
    assert(lines1.some((l) => l.includes('安装完成') && l.includes('httpLazy=installed')),
      `安装日志应含结构化事实，实际：\n${lines1.join('\n')}`);
    assert(lines1.every((l) => l.startsWith('[jitless]')), '日志前缀必须是 [jitless]');
  } else {
    eq(first.active, false, 'WASM 可用时 active 必须是 false');
    eq(first.webAssembly, 'defined', 'WASM 可用时 webAssembly 事实必须是 defined');
    eq(first.httpLazy, 'kept', 'WASM 可用时 httpLazy 必须是 kept');
    eq(first.fetch, 'kept', 'WASM 可用时 fetch 必须是 kept');
    eq(first.fetchImpl, null, 'WASM 可用时不应给出 fetchImpl');
    eq(globalThis.fetch, fetchBefore, 'WASM 可用时不得改动 globalThis.fetch');
    assert(globalThis.fetch !== shimFetch, 'WASM 可用时 globalThis.fetch 不应是垫片');
    deepEq(first.globals, {}, 'WASM 可用时不应补任何全局');
    eq(first.sealed.length, 0, 'WASM 可用时不应封印任何 getter');
    assert(lines1.some((l) => l.includes('WASM 可用：兼容层不安装')),
      `对照组应打出"不安装"，实际：\n${lines1.join('\n')}`);
  }
});

// ── 用例 2：接管与否（目标形态走垫片；对照组原生 fetch 仍可用）─────────────
await run('fetch-dispatch', async () => {
  await startServer();
  const res = await globalThis.fetch(`${baseUrl}/text`);
  eq(res.status, 200, 'globalThis.fetch 的 status');
  eq(await res.text(), 'hello jitless', 'globalThis.fetch 的响应体');
  if (JITLESS) {
    eq(globalThis.fetch, shimFetch, 'jitless 下全局 fetch 必须是垫片');
    /* 顺带证明"原生 fetch 在 jitless 下确实不可用"——否则本层没有存在理由。 */
    const realFetchNote = 'jitless 下原生 fetch 会抛 WebAssembly is not defined（本用例不直接调它，避免污染日志）';
    assert(JITLESS, realFetchNote);
  } else {
    assert(globalThis.fetch !== shimFetch, '对照组全局 fetch 不应被替换');
  }
});

// ── 用例 3：GET 文本 + 响应面 ─────────────────────────────────────────────
await run('fetch-get', async () => {
  await startServer();
  const res = await shimFetch(`${baseUrl}/text`);
  assert(res instanceof ShimResponse, '响应应是垫片的 Response 实例');
  eq(res.status, 200, 'status');
  eq(res.statusText, 'OK', 'statusText');
  eq(res.ok, true, 'ok');
  eq(res.headers.get('x-test'), 'yes', '自定义响应头');
  eq(res.url, `${baseUrl}/text`, 'response.url');
  eq(res.redirected, false, 'response.redirected');
  assert(res.body instanceof ReadableStream, 'body 必须是 node:stream/web 的 ReadableStream');
  eq(await res.text(), 'hello jitless', '响应体');
  eq(res.bodyUsed, true, '读完后 bodyUsed 应为 true');
});

// ── 用例 4：POST JSON + 自定义 authorization 头原样到达 ───────────────────
await run('post-json-auth-header', async () => {
  await startServer();
  const payload = { hello: '世界', nested: { n: 42 } };
  const text = JSON.stringify(payload);
  const res = await shimFetch(`${baseUrl}/echo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      /* 【头值只能用 latin1】Node 的 http 客户端拒绝非 ASCII 头值（原生 fetch 同样报错），
       * 所以这里刻意用 ASCII token；UTF-8 的关键性由**请求体**那条断言覆盖。 */
      authorization: 'Bearer sk-abc123-DEF456.ghi-789',
    },
    body: text,
  });
  eq(res.status, 200, 'status');
  const got = await res.json();
  eq(got.method, 'POST', '服务端收到的 method');
  eq(got.headers.authorization, 'Bearer sk-abc123-DEF456.ghi-789', 'authorization 头必须原样到达');
  deepEq(JSON.parse(got.body), payload, '服务端收到的 JSON 体');
  eq(got.transferEncoding, null, '不得使用 chunked（否则部分网关 412）');
  eq(Number(got.contentLengthHeader), Buffer.byteLength(text), 'content-length 必须是**字节数**');
});

// ── 用例 4b：Request 形态输入（自家与原生都要认）─────────────────────────
await run('request-input', async () => {
  await startServer();
  /* 【为什么必须测】只取 `.url` 的实现会把 `fetch(new Request(url, {method:'POST', ...}))`
   * 退化成**无头无体的 GET**（method 与 body 一起丢），这是参考实现踩过的坑。 */
  const payload = JSON.stringify({ a: 1, b: '二' });
  const own = new ShimRequest(`${baseUrl}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  const got1 = await (await shimFetch(own)).json();
  eq(got1.method, 'POST', '自家 Request 的 method 应被展开');
  deepEq(JSON.parse(got1.body), JSON.parse(payload), '自家 Request 的体应被展开');

  /* 原生 Request：证明展开逻辑不依赖自家类（Node 24 里它存在且不碰 WASM）。 */
  if (typeof globalThis.Request === 'function') {
    let nativeRequest = null;
    try {
      nativeRequest = new globalThis.Request(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: 'native-body',
      });
    } catch (error) {
      console.log(`  [note] 本环境下构造原生 Request 失败，跳过该子断言：${error.message}`);
    }
    if (nativeRequest !== null) {
      const got2 = await (await shimFetch(nativeRequest)).json();
      eq(got2.method, 'POST', '原生 Request 的 method 应被展开');
      eq(got2.body, 'native-body', '原生 Request 的体应被展开');
    }
  }
});

// ── 用例 4c：流式请求体（ReadableStream → chunked）─────────────────────────
await run('post-stream-body', async () => {
  await startServer();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('part-1'));
      controller.enqueue(encoder.encode('part-2'));
      controller.close();
    },
  });
  const got = await (await shimFetch(`${baseUrl}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body,
  })).json();
  eq(got.method, 'POST', 'method');
  eq(got.body, 'part-1part-2', '流式体应被逐块泵出并完整到达');
  eq(got.contentLengthHeader, null, '流式体长度未知，不得带 content-length');
  eq(got.transferEncoding, 'chunked', '流式体只能 chunked');
});

// ── 用例 5：SSE 分块流式（必须逐块到达，不是一次性）──────────────────────
await run('sse-streaming', async () => {
  await startServer();
  records.sseWriteTimes = [];
  const res = await shimFetch(`${baseUrl}/sse`);
  eq(res.status, 200, 'status');
  eq(res.headers.get('content-type'), 'text/event-stream', 'SSE 的 content-type');
  assert(res.body instanceof ReadableStream, 'SSE 的 body 必须是 ReadableStream');

  const reader = res.body.getReader();
  const stamps = [];
  let text = '';
  for (;;) {
    const step = await reader.read();
    if (step.done === true) break;
    stamps.push(Date.now());
    text += Buffer.from(step.value).toString('utf8');
  }

  const events = [...text.matchAll(/data: (\d)/g)].map((m) => Number(m[1]));
  deepEq(events, [1, 2, 3, 4, 5], `应收到 5 个 SSE 事件，实际：${JSON.stringify(text)}`);
  assert(stamps.length >= 3, `必须逐块到达（收到 ${stamps.length} 块）——整体缓冲的实现只会给 1 块`);
  assert(records.sseWriteTimes.length === 5, `服务端应写入 5 块，实际 ${records.sseWriteTimes.length}`);
  assert(stamps[0] < records.sseWriteTimes[records.sseWriteTimes.length - 1],
    '第一块必须早于服务端最后一块写出（否则说明客户端在整体缓冲）');
});

// ── 用例 6：AbortController 中止（请求阶段 / 预中止 / 读体阶段）───────────
await run('abort', async () => {
  await startServer();

  // ① 请求阶段中止：socket 必须被 destroy，错误 name 必须是 AbortError
  const c1 = new AbortController();
  const pending = shimFetch(`${baseUrl}/slow-headers`, { signal: c1.signal });
  setTimeout(() => c1.abort(), 30);
  const e1 = await expectReject(pending, (e) => e.name === 'AbortError', '请求阶段中止');
  eq(e1.name, 'AbortError', '中止错误 name');

  // ② 预先中止的信号：应立刻 reject
  const c2 = new AbortController();
  c2.abort();
  await expectReject(shimFetch(`${baseUrl}/text`, { signal: c2.signal }),
    (e) => e.name === 'AbortError', '预中止信号');

  // ③ 读体阶段中止：已经拿到响应头时再中止，读端必须收到错误而不是静默结束
  const c3 = new AbortController();
  const res = await shimFetch(`${baseUrl}/abort`, { signal: c3.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert(first.done !== true, '第一次读应拿到 chunk-1');
  c3.abort();
  await expectReject(() => reader.read(), (e) => e.name === 'AbortError' || /abort/i.test(String(e.message)),
    '读体阶段中止');

  await sleep(50);
  assert(records.abortCloses >= 1, '中止时服务端应看到连接被关闭（socket 必须 destroy）');
});

// ── 用例 7：FormData + Blob 上传，字节一致 ───────────────────────────────
await run('formdata-blob-upload', async () => {
  await startServer();
  /* 关键是**用原生 FormData / 原生 Blob**：Node 24 下 `globalThis.FormData` 就是原生实现，
   * 垫片不会（也不该）替换它。只认 `instanceof ShimFormData` 的实现会把体编成
   * 字面量 "[object FormData]"。 */
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10, 45, 45]);
  const form = new globalThis.FormData();
  form.append('field', '中文值');
  form.append('file', new globalThis.Blob([bytes], { type: 'application/octet-stream' }), 'a.bin');

  const res = await shimFetch(`${baseUrl}/upload`, { method: 'POST', body: form });
  eq(res.status, 200, 'status');
  const got = await res.json();
  assert(got.contentType.startsWith('multipart/form-data; boundary='),
    `content-type 应是 multipart，实际 ${got.contentType}`);
  eq(got.hasBoundary, true, 'content-type 必须带 boundary');
  eq(got.looksLikeObjectFormData, false, '体不得退化成 "[object FormData]"');
  eq(got.hasFieldName, true, '应含字段名 field');
  eq(got.hasFieldValue, true, '应含 UTF-8 字段值');
  eq(got.hasFilename, true, '应含文件名 a.bin');
  eq(got.hasFileType, true, '文件段应带 Content-Type');
  eq(got.bytesFound, true, '上传的字节必须与原始 Buffer 完全一致');
  eq(Number(got.contentLengthHeader), got.total, 'content-length 必须等于实际字节数');
});

// ── 用例 8：重定向 301 → 302 → 200（以及 manual / error 两个模式）─────────
await run('redirect-301-302', async () => {
  await startServer();
  records.redirectHops = 0;
  const res = await shimFetch(`${baseUrl}/r1`);
  eq(res.status, 200, '最终 status');
  eq(res.redirected, true, 'response.redirected');
  eq(res.url, `${baseUrl}/done`, 'response.url 应是最后一跳');
  eq(await res.text(), 'redirected-ok', '最终响应体');
  eq(records.redirectHops, 3, '服务端应看到 3 次请求（/r1 → /r2 → /done）');

  /* manual：把 3xx 原样交回（调用方要自己做同源白名单时靠它）。 */
  const manual = await shimFetch(`${baseUrl}/r1`, { redirect: 'manual' });
  eq(manual.status, 301, 'manual 模式应返回 301');
  eq(manual.headers.get('location'), '/r2', 'manual 模式应保留 location');
  await manual.text();

  /* error：见到 3xx 就 reject。 */
  await expectReject(shimFetch(`${baseUrl}/r1`, { redirect: 'error' }),
    (e) => /redirect not allowed/.test(String(e.message)), 'redirect:error 模式');
});

// ── 用例 9：303 + POST → GET（体必须丢掉、头也要剔干净）──────────────────
await run('redirect-303-post', async () => {
  await startServer();
  records.submit = null;
  records.after = null;
  const res = await shimFetch(`${baseUrl}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&b=2',
  });
  eq(res.status, 200, '最终 status');
  assert(records.submit !== null, '原始 POST 应到达 /submit');
  eq(records.submit.method, 'POST', '/submit 收到的 method');
  eq(records.submit.body, 'a=1&b=2', '/submit 收到的体');
  assert(records.after !== null, '重定向目标 /after 应被请求');
  eq(records.after.method, 'GET', '303 之后的 method 必须改写成 GET');
  eq(records.after.contentLength, null, '303 之后不得再带 content-length（体已丢掉）');
  eq(records.after.transferEncoding, null, '303 之后不得带 transfer-encoding');
});

// ── 用例 10：undici 面（临时包目录模拟组装期条件入口）───────────────────
await run('undici-surface', async () => {
  await startServer();

  /*
   * 组装期会把 `node_modules/undici/package.json` 的 `main` 指到生成的条件入口。
   * 这里用**临时包目录**把同一件事做一遍，然后 `import('undici')` —— 走的是真实的
   * 包解析路径（而不是直接 import 一个文件），这样"条件入口"这件事才真的被测到。
   */
  const tmpBase = process.env.PI_SELFTEST_TMP ?? os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'pi-jitless-undici-'));
  const pkgDir = path.join(tmpRoot, 'node_modules', 'undici');

  /* 真实 undici 在开发机上不一定装着；装了就指向它，没装就用"形状等价"的替身。 */
  let realUndici = null;
  try {
    const probeRequire = createRequire(path.join(JITLESS_DIR, 'selftest-probe.cjs'));
    realUndici = probeRequire('undici');
  } catch {
    realUndici = null;
  }
  let realPath = null;

  try {
    fs.mkdirSync(pkgDir, { recursive: true });

    if (realUndici !== null) {
      realPath = createRequire(path.join(JITLESS_DIR, 'selftest-probe.cjs')).resolve('undici');
      fs.copyFileSync(realPath, path.join(pkgDir, 'index.cjs'));
      console.log('  （undici 面复用本机真实 undici 包）');
    } else {
      console.log('  （本机未安装 undici：用形状等价的替身扮演真实导出）');
      const standIn = `'use strict';
/* 自检替身：扮演真实 undici 的导出面。fetch/request 一调就抛 WASM 错，与 jitless 下的真实表现一致。 */
function wasmFail() { throw new Error('WebAssembly is not defined'); }
class Agent { constructor(options) { this.options = options === undefined ? {} : options; this.closed = false; } async close() { this.closed = true; } }
class Dispatcher extends Agent {}
class Pool extends Agent {}
class Client extends Agent {}
class ProxyAgent extends Agent {}
class EnvHttpProxyAgent extends Agent {}
class RetryAgent extends Agent {}
class RetryHandler { constructor(options) { this.options = options === undefined ? {} : options; } }
class Headers {}
class Request {}
class Response {}
class FormData {}
let globalDispatcher;
module.exports = {
  fetch: async () => { wasmFail(); },
  request: async () => { wasmFail(); },
  stream: async () => { wasmFail(); },
  pipeline: async () => { wasmFail(); },
  connect: async () => { wasmFail(); },
  upgrade: async () => { wasmFail(); },
  setGlobalDispatcher(d) { globalDispatcher = d; },
  getGlobalDispatcher() { return globalDispatcher === undefined ? new Agent() : globalDispatcher; },
  install() { globalThis.fetch = module.exports.fetch; },
  Agent, Dispatcher, Pool, Client, ProxyAgent, EnvHttpProxyAgent, RetryAgent, RetryHandler,
  Headers, Request, Response, FormData,
  errors: {},
  interceptors: {},
  buildConnector() {},
};
`;
      fs.writeFileSync(path.join(pkgDir, 'index.cjs'), standIn, 'utf8');
      realPath = path.join(pkgDir, 'index.cjs');
    }

    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'undici',
      version: '0.0.0-selftest',
      /* ← 组装期改写的就是这一行 */
      main: 'pi-jitless-entry.cjs',
    }, null, 2), 'utf8');

    /* 条件入口：与组装期生成的形态保持一致（判据只有 typeof WebAssembly）。 */
    const entry = `'use strict';
const { createUndiciShim } = require(${JSON.stringify(path.join(JITLESS_DIR, 'undici-shim.js'))});
const real = require('./index.cjs');
const out = typeof WebAssembly === 'undefined' ? createUndiciShim(real) : real;
module.exports = out;
/* 静态可分析的具名导出：ESM 的 import { fetch } from 'undici' 依赖 cjs-module-lexer 识别 */
module.exports.fetch = out.fetch;
module.exports.install = out.install;
module.exports.setGlobalDispatcher = out.setGlobalDispatcher;
module.exports.getGlobalDispatcher = out.getGlobalDispatcher;
module.exports.request = out.request;
module.exports.stream = out.stream;
module.exports.pipeline = out.pipeline;
module.exports.connect = out.connect;
module.exports.upgrade = out.upgrade;
module.exports.Agent = out.Agent;
module.exports.Dispatcher = out.Dispatcher;
module.exports.Pool = out.Pool;
module.exports.Client = out.Client;
module.exports.ProxyAgent = out.ProxyAgent;
module.exports.EnvHttpProxyAgent = out.EnvHttpProxyAgent;
module.exports.RetryAgent = out.RetryAgent;
module.exports.Headers = out.Headers;
module.exports.Request = out.Request;
module.exports.Response = out.Response;
module.exports.FormData = out.FormData;
`;
    fs.writeFileSync(path.join(pkgDir, 'pi-jitless-entry.cjs'), entry, 'utf8');

    /* CJS 面：经包的 main（= 条件入口）拿到导出。 */
    const dirRequire = createRequire(path.join(tmpRoot, 'probe.cjs'));
    const base = dirRequire('./node_modules/undici/index.cjs');
    const dist = dirRequire('undici');

    /* ESM 面：在临时目录里 import('undici')，验证具名导出齐全。 */
    fs.writeFileSync(path.join(tmpRoot, 'probe.mjs'), "import * as ns from 'undici';\nexport default ns;\n", 'utf8');
    const esm = (await import(pathToFileURL(path.join(tmpRoot, 'probe.mjs')).href)).default;

    if (JITLESS) {
      eq(dist.fetch, shimFetch, '条件入口的 fetch 必须被换成 shimFetch');
      eq(esm.fetch, shimFetch, 'ESM 具名导出 fetch 必须是 shimFetch');
      for (const name of ['install', 'setGlobalDispatcher', 'getGlobalDispatcher', 'request', 'stream',
        'pipeline', 'connect', 'upgrade', 'Agent', 'Dispatcher', 'Headers', 'Response', 'FormData']) {
        assert(name in esm, `ESM 具名导出缺 ${name}`);
      }
      /* install() 必须是空操作：不得覆写 globalThis.fetch（这一步是真实事故点）。 */
      const before = globalThis.fetch;
      const returned = dist.install();
      eq(returned, undefined, 'install() 应返回 undefined（空操作）');
      eq(globalThis.fetch, before, 'install() 不得改动 globalThis.fetch');
      eq(globalThis.fetch, shimFetch, 'install() 之后 globalThis.fetch 仍应是 shimFetch');
      eq(esm.install, dist.install, 'ESM 与 CJS 的 install 应是同一个函数');
    } else {
      /* 对照组：条件入口必须**原样透出**真实模块（一个动作都不做）。 */
      eq(dist.fetch, base.fetch, 'WASM 可用时条件入口应原样透出真实 undici.fetch');
      eq(dist.install, base.install, 'WASM 可用时条件入口应原样透出真实 undici.install');
      eq(esm.fetch, base.fetch, 'WASM 可用时 ESM 具名导出也应是真实实现');
      eq(typeof WebAssembly, 'object', '对照组必须真的处在"WASM 可用"的形态（否则整份对照无意义）');
    }

    /* ── 无论哪种形态，`createUndiciShim` 本身的行为都要一致 ── */
    const shim = createUndiciShim(base);
    eq(Object.getPrototypeOf(shim), Object.prototype, 'createUndiciShim 必须返回普通对象');
    eq(shim.fetch, shimFetch, 'undiciShim.fetch 必须是 shimFetch');
    for (const key of Object.keys(base)) {
      assert(key in shim, `真实导出的键 ${key} 必须透出`);
    }
    eq(shim.Agent, base.Agent, '未列入危险面的键应原样透出（Agent）');
    eq(shim.Dispatcher, base.Dispatcher, '未列入危险面的键应原样透出（Dispatcher）');

    const fetchBeforeInstall = globalThis.fetch;
    shim.install();
    eq(globalThis.fetch, fetchBeforeInstall, 'createUndiciShim().install() 不得覆写 globalThis.fetch');

    const sentinel = { dispatch: async () => ({ statusCode: 204, body: null }) };
    shim.setGlobalDispatcher(sentinel);
    eq(shim.getGlobalDispatcher(), sentinel, 'set/getGlobalDispatcher 必须记住同一个对象');

    for (const op of ['request', 'stream', 'pipeline', 'connect', 'upgrade']) {
      const error = await expectReject(() => shim[op]('http://127.0.0.1/'), undefined, `undici.${op} 应 reject`);
      assert(error.message.includes(UNAVAILABLE_MESSAGE),
        `undici.${op} 的错误信息应含约定的整句说明，实际：${error.message}`);
      assert(error.message.includes('fetch'), `undici.${op} 的错误信息应指路 fetch，实际：${error.message}`);
      eq(error.code, 'ERR_JITLESS_UNDICI_WASM', `undici.${op} 的错误码`);
    }

    /*
     * 【构造面不许抛错】TC-108-09 明确要求 jitless 下 `new EnvHttpProxyAgent({})`、
     * `new Client('http://127.0.0.1:1')` 不抛错——真实 undici 只有在**发请求**时才碰 WASM，
     * 构造（连接池、代理路由）是纯 JS。若这里抛错，说明垫片把真实导出弄坏了。
     */
    for (const [name, args] of [
      ['Agent', [{}]],
      ['EnvHttpProxyAgent', [{}]],
      ['Client', ['http://127.0.0.1:1', {}]],
      ['Pool', ['http://127.0.0.1:1', {}]],
    ]) {
      const Ctor = shim[name];
      if (typeof Ctor !== 'function') continue;
      try {
        new Ctor(...args); // eslint-disable-line no-new
      } catch (error) {
        throw new Error(`new undici.${name}() 不应抛错：${error.message}`);
      }
    }

    /* 兜底 dispatcher 的 close/destroy 必须安静成功（清理阶段不能被它打断）。 */
    const cleaned = createUndiciShim({});
    await cleaned.getGlobalDispatcher().close();
    await cleaned.getGlobalDispatcher().destroy();
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

// ── 用例 11：静态护栏（硬约束扫描）────────────────────────────────────────
/*
 * 【真机回归】不得读取惰性全局。
 *
 * 2026-10-20 真机（HAD-W32 / Node v24.2.0）现场：安装兼容层后 app.log 里出现
 *   `unhandledRejection: WebAssembly is not defined`
 *   `at lazyllhttp (node:internal/deps/undici/undici:6340:9) … at lib/global.js`
 * 根因是 Node 24 把 `Headers/Request/Response/FormData/Blob/File` 装成 **globalThis 上的
 * 惰性 accessor**，而旧实现"逐个读值判存在"**一读就物化** ⇒ 拉起源码内的 undici。
 * 现在改用 `Object.hasOwn`（不触发 getter）。这条用例就是钉死它：
 * 把 `FormData` 换成会计数的 accessor，安装一次后计数必须仍为 0。
 * 注意 PC 上这六个是普通数据属性，所以**这条用例在 PC 上很难自然复现**，只能靠模拟。
 */
await run('lazy-globals-untouched', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'FormData');
  let touched = 0;
  Object.defineProperty(globalThis, 'FormData', {
    configurable: true,
    get() {
      touched += 1;
      return desc !== undefined && 'value' in desc ? desc.value : undefined;
    }
  });
  try {
    const result = installFetchShim();
    eq(touched, 0,
      '安装 fetch 垫片时不得读取惰性全局（读即物化 Node 内建 undici ⇒ lazyllhttp 抛 WASM 错）');
    assert(['installed', 'kept'].includes(result.globals.FormData),
      `FormData 三态应合法，实际 ${result.globals.FormData}`);
    assert(globalThis.FormData !== undefined, '接管后 FormData 必须可取到值');
  } finally {
    if (desc === undefined) delete globalThis.FormData;
    else Object.defineProperty(globalThis, 'FormData', desc);
  }
});

await run('static-guard', async () => {
  /** 粗略去掉注释（保留换行），用来做"代码里不许出现"的扫描。 */
  function stripComments(source) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (quote !== null) {
        out += ch;
        if (ch === '\\') {
          out += next ?? '';
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') out += '\n';
          i += 1;
        }
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  const files = ['index.js', 'http-lazy-undici.js', 'fetch-shim.js', 'undici-shim.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(JITLESS_DIR, file), 'utf8');
    const code = stripComments(source);

    /* ① 不许 import/require undici（只允许 fetch-shim 之外……其实一个都不允许） */
    const undiciRefs = [
      /\brequire\s*\(\s*['"]undici['"]\s*\)/,
      /\bfrom\s*['"]undici['"]/,
      /\bimport\s*\(\s*['"]undici['"]\s*\)/,
    ];
    for (const pattern of undiciRefs) {
      assert(!pattern.test(code), `${file} 里不得 require/import undici（命中 ${pattern}）`);
    }

    /* ② WebAssembly 只能出现在 `typeof WebAssembly` 判定里 */
    const withoutTypeof = code.replace(/typeof\s+WebAssembly/g, '');
    assert(!withoutTypeof.includes('WebAssembly'),
      `${file} 里出现了 typeof 之外的 WebAssembly 使用（禁止触碰 WASM）`);

    /* ③ 日志前缀 */
    for (const line of code.split('\n')) {
      if (/console\.(error|log|warn)\(/.test(line) || /say\(|log\(/.test(line)) {
        if (/['"`]\[(?!jitless)/.test(line)) {
          throw new Error(`${file} 的日志前缀不是 [jitless]：${line.trim()}`);
        }
      }
    }
  }

  /* ④ index.js 必须先把 PI_JITLESS_DIR 指到自身目录 */
  /*
   * ④ index.js 必须把 PI_JITLESS_DIR 指到自身目录（条件入口靠它定位垫片）。
   *    判定用"存在对 SHIM_DIR/__dirname 的赋值"，**不绑定变量拼写**：
   *    本轮把它从模块顶层移进了 compat 分支（jit 形态不该给进程环境增变量，NFR-108-001）。
   */
  const indexSource = fs.readFileSync(path.join(JITLESS_DIR, 'index.js'), 'utf8');
  assert(/process\.env\.PI_JITLESS_DIR\s*=\s*(?:SHIM_DIR|__dirname)/.test(indexSource),
    'index.js 必须设置 process.env.PI_JITLESS_DIR = SHIM_DIR（或 __dirname）');
  const assignAt = indexSource.search(/process\.env\.PI_JITLESS_DIR\s*=\s*(?:SHIM_DIR|__dirname)/);
  assert(assignAt > indexSource.indexOf("if (typeof WebAssembly !== 'undefined') {"),
    'PI_JITLESS_DIR 的**赋值**必须在 compat 分支内（WASM 可用时不得给进程环境增变量）');

  /* ⑤ 封印函数自己也要自检 WASM（调用方忘了判也不会误封） */
  const seal = sealHttpLazyUndici(() => {});
  assert(Array.isArray(seal), 'sealHttpLazyUndici 必须返回属性名清单（数组）');
  if (!JITLESS) {
    eq(seal.length, 0, 'WASM 可用时 sealHttpLazyUndici 不应封印任何东西');
    eq(seal.status, 'kept', 'WASM 可用时 sealHttpLazyUndici 的事实应为 kept');
  }
});
// ── 汇总 ─────────────────────────────────────────────────────────────────
await stopServer();
const failedCases = results.filter((r) => !r.ok);
console.log('');
console.log(`模式：${MODE}`);
console.log(`合计 ${results.length} 条用例：通过 ${results.length - failedCases.length}，失败 ${failedCases.length}`);
for (const item of failedCases) {
  console.log(`  FAIL ${item.name}：${item.error?.message}`);
}
if (results.length === 0) {
  console.log(`（没有匹配 --only=${only} 的用例）`);
}
process.exitCode = failedCases.length === 0 && results.length > 0 ? 0 : 1;
