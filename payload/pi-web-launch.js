/**
 * pi-web-launch.js —— 本工程的 **Node 侧入口**（CommonJS；由库的 `payload/bootstrap.js` require）。
 *
 * 【Android 移植版】自 pi-desktop-ark 移植（同一上游启动协议），与 ark 版的差异只有一处结构区：
 *   「宿主桥」区块按 aosp-node-bridge 0.2.0 的 Node 侧 API（host.js = invoke/ping/loadAddon/setBridge）
 *   改写 —— ark 版的 `host.handle()` / `useFileMailbox()` / `setTransport()` 在 bridge 0.2.0 中不存在；
 *   Android 的传输是 JNI 直调（NODE_BRIDGE_BRIDGE_HANDLE 槽位表），宿主能力由 Kotlin 侧注册。
 *   其余（环境装配 / 端口探测 / 进程内 Next / 就绪轮询 / marker）与 ark 逐字同构。
 *
 * 它是旧壳 `pi-desktop-hos/src-main/main.js` 里「进程内 Next 宿主」那一段的移植版：
 *   · 环境装配（应用语义部分委托给 `./env.js`）        ← main.js:237-307
 *   · 端口：**先探一个空闲端口再交给服务端**（硬约束 ⑰） ← main.js:199-209
 *   · 预览密钥轮换（不轮换 = 任何拿到发布包的人可绕过鉴权） ← main.js:561-579
 *   · 进程内起 Next（`next/dist/server/lib/start-server`，绝不用 CLI） ← main.js:601-736
 *   · HTTP 轮询就绪（`/api/web-auth`）                ← main.js:851-873
 *   · 关停：交给库的宿主桥（Phase 1 传输不可用 —— 如实记录，不假装优雅关停） ← main.js:1304-1314
 *
 * 与旧壳的**刻意差异**（每条都有依据）：
 *   1. **不做候选手进程宿主**（旧壳 `main.js:739-816`）：平台层封死（规划 §0.3 / §8.4），
 *      进程内起不来就是失败，不引入「看起来能跑」的第二条路；
 *   2. **自己的日志通道**：额外写 `<HOME>/payload/app.log`（⑱：库的 stdio 通道会被 ArkWeb
 *      原生输出混流，payload 的错误必须有自己的落点）；
 *   3. **绑定 loopback + 免密**（规划 §6.2 路线 ①）：旧壳因 Electron 渲染进程的 loopback 隔离
 *      只能绑 0.0.0.0 + 密码；本形态由**同进程**本地服务提供 loopback，不再隔离。
 *   4. **不再把「就绪」写成 stdout 一行就算数**：同时落一个 marker 文件，让 ArkTS 侧能
 *      稳定读回**真实端口**（它是探活与 loadUrl 的唯一依据）。
 */

'use strict';

// ── Android 宿主保护：进程临时目录（必须最早，先于任何 os.tmpdir() 调用）─────────────
// 现象：Android 无 /tmp；Node 的 os.tmpdir() 在 Linux 读 TMPDIR 且**首次调用即缓存**。
//   vendored pnpm bundle 内嵌 temp-dir@2，require 即 realpathSync(os.tmpdir())（真机 2026-10-30
//   实测报 lstat '/tmp' ENOENT unhandledRejection，整个 pnpm 不可用）。故在进程入口、
//   任何模块加载前把 TMPDIR/TMP/TEMP 指到可写私有 tmp 并建目录。
(function ensureTmpdir() {
  try {
    const nodeFs = require('node:fs'); const nodePath = require('node:path'); const nodeOs = require('node:os');
    const base = process.env.HOME || (process.env.PI_ANDROID_HOME)
      || nodeOs.homedir() || (nodeOs.userInfo && nodeOs.userInfo())?.homedir;
    const tmp = nodePath.join(base || process.cwd(), 'tmp');
    nodeFs.mkdirSync(tmp, { recursive: true });
    process.env.TMPDIR = tmp;
    process.env.TMP = tmp;
    process.env.TEMP = tmp;
    // 关键：仅设 env 不够。Node 的 os.tmpdir()（libuv uv_os_tmpdir）在本内嵌宿主上读到的仍是
    // 不存在的 /tmp（首次调用可能早于此、或该构建不跟随运行期 TMPDIR）；而 vendored pnpm 内嵌
    // temp-dir@2 / tempy 在 bundle require 时立即 realpathSync(os.tmpdir())，lstat '/tmp' ENOENT
    // unhandledRejection 整个 bundle 崩。故直接冻结 os.tmpdir() 返回到可写私有 tmp。
    try {
      Object.defineProperty(nodeOs, 'tmpdir', { configurable: true, writable: true, value: () => tmp });
    } catch (_) { /* 不可重定义则依赖 env */ }
  } catch (_) { /* HOME/tmp 不可用则保持默认；pnpm 路径会如实报 ENOENT */ }
})();

// ── Android 宿主保护：冻结 process.title（真机根因修复 2026-10-29）──────────────────
// 现象：进程内 Node 内嵌于 app_process64（aosp-node-bridge 形态），任何对 process.title 的
//   赋值都会在真机（Xiaomi M2105K81C / Android 11 / arm64）**同步 SIGSEGV**（最小复现：
//   仅一行 `process.title = 'x'` 即崩，无 JS 异常）。libuv 设进程名会原地覆写 argv 内存，
//   该映射在本宿主形态不可写。Next 16 的 startServer() 同步第一行就是
//   `process.title = 'next-server (v…)'` ⇒ 此前真机必崩于 Next 引导起点。
// 处置：把 setter 冻结为 no-op（getter 保留语义，返回固定名）。必须在任何 next/dist
//   模块被 require **之前**安装。诊断价值（ps 名）在本平台以 app.log/pid 替代。
try {
  Object.defineProperty(process, 'title', {
    configurable: true,
    get() { return 'pi-web'; },
    set() { /* no-op：app_process 内嵌宿主下赋值即 SIGSEGV */ }
  });
} catch (_) { /* 定义失败则保持引擎默认；不阻断启动 */ }

// ── Android 宿主保护：补 AbortSignal.throwIfAborted（Node 25+ API）────────────
// 引擎已升 node-runtime:26.13.0（Node 26 ≥25，含原生 throwIfAborted）⇒ 此垫片已不需要（111-pty-integration）。
// 客户端（Chrome 94 WebView）的 throwIfAborted 垫片仍在 MainActivity polyfill-webview.js 保留。

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const envContract = require('./env.js');

// ── 常量（与旧壳同口径的部分标注出处）─────────────────────────────────────────
const TAG = '[pi-web]';
/** 就绪探测：HTTP 轮询（不监听 stdout 的 "Ready" —— 那是子进程方案的做法）。main.js:47-52 */
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 400;
const READY_PROBE_PATH = '/api/web-auth';
/** 幂等就绪 marker：ArkTS 侧读它拿**真实端口**（不猜、不硬编码 15577）。 */
const READY_MARKER_NAME = 'pi-web.ready.json';
/** 候选 A：Next 官方进程内启动入口（导出形态跨版本有差异，逐个探测）。main.js:601-604 */
const START_SERVER_ENTRIES = [
  path.join('node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'),
  path.join('node_modules', 'next', 'dist', 'server', 'lib', 'start-server', 'index.js')
];

const startedAt = Date.now();
/** 关闭器（拿到 server 句柄才有；拿不到就如实说明「关闭由进程退出代劳」） */
let closer = null;
/** 就绪后的真实端口（0 = 尚未就绪）；宿主桥的 shutdown 钩子与日志都读它 */
let readyPort = 0;
let shuttingDown = false;

// ── 日志：**双通道**（自己的 app.log + stdout/stderr）──────────────────────────
// 为什么必须有 app.log（⑱ / 契约 §3.4）：库的 stdio 落盘通道会把 ArkWeb 原生输出一起写进去，
// 载荷自己的错误如果只写 stdout，在 `node.log` 里会被淹没。
const appLogPath = () => path.join(homeDir(), 'payload', 'app.log');

function homeDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && home.length > 0 ? home : process.cwd();
}

function stamp() {
  return new Date().toISOString();
}

/** 追加写 app.log（永不抛：日志失败绝不能反过来打断载荷） */
function appendAppLog(line) {
  try {
    fs.appendFileSync(appLogPath(), line + '\n', 'utf8');
  } catch {
    /* 日志文件不可写时只保留 stdio 通道，不抛 */
  }
}

function log(text) {
  const line = `${TAG} ${stamp()} ${text}`;
  appendAppLog(line);
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* stdout 被关闭/阻塞：app.log 已留下记录 */
  }
}

function logWarn(text) {
  const line = `${TAG} WARN ${stamp()} ${text}`;
  appendAppLog(line);
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* 同上 */
  }
}

function logError(text) {
  const line = `${TAG} ERROR ${stamp()} ${text}`;
  appendAppLog(line);
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* 同上 */
  }
}

function describeError(err) {
  if (err === null || err === undefined) return String(err);
  const parts = [];
  const seen = new Set();
  const visit = (e, depth) => {
    if (e === null || e === undefined || depth > 6 || seen.has(e)) return;
    seen.add(e);
    if (e.message) parts.push(String(e.message).split('\n')[0]);
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub, depth + 1);
    if (e.cause) visit(e.cause, depth + 1);
  };
  visit(err, 0);
  if (parts.length > 0) return parts.join(' || ').slice(0, 2000);
  try {
    return JSON.stringify(err).slice(0, 2000);
  } catch {
    return String(err).slice(0, 2000);
  }
}

// ── 异常兜底（⑱ 的载荷侧一半；库的 bootstrap 还会再兜一层）─────────────────────
process.on('uncaughtException', (err) => {
  logError(`uncaughtException：${describeError(err)}\n${err && err.stack ? err.stack : '(无 stack)'}`);
  // 刻意不 process.exit：进程内 Node 没有优雅退出路径，退出码也换不来重启（硬约束 ⑥）。
  // 写进 app.log 与 stderr，让诊断面板与 /log 能读到现场。
});
process.on('unhandledRejection', (reason) => {
  logError(`unhandledRejection：${describeError(reason)}`);
});

// ── 载荷根解析（库给 NODE_BRIDGE_*；缺席时退 <HOME>/payload/app）────────────────
/**
 * 运行根 = 本文件所在目录最可靠（库把入口解析成绝对路径后才 require 它）。
 * 仍按契约回退链检查一遍，并把**选中的理由**写进日志（错了才查得动）。
 */
function resolvePayloadRoot(entryHint) {
  const candidates = [];
  const here = __dirname;
  candidates.push({ dir: here, why: '__dirname（本入口脚本所在目录）' });
  const readonlyRoot = process.env.NODE_BRIDGE_READONLY_ROOT;
  if (readonlyRoot && readonlyRoot.length > 0) {
    const entry = entryHint && entryHint.length > 0 ? entryHint : 'pi-web/pi-web-launch.js';
    candidates.push({
      dir: path.resolve(readonlyRoot, path.dirname(entry)),
      why: `NODE_BRIDGE_READONLY_ROOT + entry 目录（${entry}）`
    });
  }
  const payloadRoot = process.env.NODE_BRIDGE_PAYLOAD_ROOT;
  if (payloadRoot && payloadRoot.length > 0) {
    candidates.push({ dir: path.join(payloadRoot, 'app'), why: 'NODE_BRIDGE_PAYLOAD_ROOT/app（契约 §3.1 的兜底约定）' });
  }
  candidates.push({ dir: path.join(homeDir(), 'payload', 'app'), why: '<HOME>/payload/app（最后兜底）' });

  for (const candidate of candidates) {
    const hasNext = fs.existsSync(path.join(candidate.dir, 'node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'));
    const hasPackage = fs.existsSync(path.join(candidate.dir, 'package.json'));
    if (hasNext || hasPackage) {
      log(`载荷根 = ${candidate.dir}（依据：${candidate.why}；next 入口=${hasNext} package.json=${hasPackage}）`);
      return candidate.dir;
    }
    log(`载荷根候选不可用：${candidate.dir}（依据：${candidate.why}）`);
  }
  logError(`未找到可用载荷根；候选依次为：${candidates.map((c) => `${c.dir} ← ${c.why}`).join(' | ')}`);
  return here;
}

// ── 空闲端口（硬约束 ⑰ 的第一道闸）───────────────────────────────────────────
/**
 * `listen(0)` 探一个空闲端口后释放，再交给 Next。
 * 为什么不是「直接用 0」：Next 的 startServer 接受 port=0，但**返回值不稳定地暴露实际端口**，
 * 而 ArkTS 侧必须拿到确切端口才能探活与 loadUrl；先探后给是旧壳已验证的做法（main.js:199-209）。
 */
function resolveFreePort(preferred) {
  if (typeof preferred === 'number' && Number.isInteger(preferred) && preferred > 0) {
    log(`PI_WEB_PORT 显式指定 ${preferred}（调试/回退用；正常路径应为 0 ⇒ 随机端口）`);
    return Promise.resolve(preferred);
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (err) => reject(new Error(`端口探测失败：${describeError(err)}`)));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('端口探测返回了非法端口'));
      });
    });
  });
}

// ── 预览密钥轮换（不轮换 = 发布包里固化着可跳闸门的密钥）────────────────────────
function rotatePreviewSecrets(payloadRoot) {
  const rotatePath = path.join(payloadRoot, 'bin', 'rotate-preview-secrets.js');
  if (!fs.existsSync(rotatePath)) {
    logWarn(`预览密钥轮换脚本缺失：${rotatePath}（跳过；请核对载荷是否为上游完整产物）`);
    return;
  }
  try {
    const mod = require(rotatePath);
    if (typeof mod.rotatePreviewSecrets !== 'function') {
      logWarn(`${rotatePath} 未导出 rotatePreviewSecrets（上游接口变化？）`);
      return;
    }
    const result = mod.rotatePreviewSecrets(path.join(payloadRoot, '.next'));
    if (result && result.ok) {
      log('预览密钥已轮换（.next/prerender-manifest.json）');
      return;
    }
    const warning = typeof mod.getRotationWarning === 'function'
      ? mod.getRotationWarning(result && result.reason)
      : `原因：${result && result.reason}`;
    logWarn(`预览密钥轮换失败：${String(warning).replace(/\n/g, ' ')}`);
  } catch (err) {
    logWarn(`预览密钥轮换抛错：${describeError(err)}`);
  }
}

// ── 进程内起 Next（换掉的所有 Electron 面都在这里）────────────────────────────
/** CJS require，必要时退 ESM 动态 import（Next 16 的 dist 仍有 CJS，但不做假设）。main.js:581-592 */
async function loadModule(absPath) {
  try {
    return require(absPath);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE' || code === 'ERR_REQUIRE_CYCLE_MODULE') {
      return import(pathToFileURL(absPath).href);
    }
    throw err;
  }
}

function pickStartServerFn(mod) {
  if (!mod) return null;
  if (typeof mod.startServer === 'function') return mod.startServer;
  const d = mod.default;
  if (d && typeof d.startServer === 'function') return d.startServer;
  if (typeof d === 'function') return d;
  if (typeof mod === 'function') return mod;
  return null;
}

async function startViaStartServerExport(dir, hostname, port) {
  const tried = [];
  for (const rel of START_SERVER_ENTRIES) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
      tried.push(`${rel}（不存在）`);
      continue;
    }
    const mod = await loadModule(abs);
    const startServer = pickStartServerFn(mod);
    if (!startServer) {
      tried.push(`${rel}（无 startServer 导出：${Object.keys(mod).slice(0, 12).join(',')}）`);
      continue;
    }
    // isDev / dev 两种键名都传：不同版本读的是其中之一，多余的键被忽略。
    const result = await startServer({
      dir,
      hostname,
      port,
      isDev: false,
      dev: false,
      allowRetry: false,
      keepAliveTimeout: 61_000
    });
    log(`startServer 返回：${result === undefined ? '(undefined)' : Object.prototype.toString.call(result)}`);
    return result;
  }
  throw new Error(`next/dist/server/lib/start-server 不可用：${tried.join('；')}`);
}

/** 候选 A′：NextServer（自定义服务器）API，同样进程内、不经 CLI。main.js:644-664 */
async function startViaNextServerApi(dir, hostname, port) {
  const abs = path.join(dir, 'node_modules', 'next', 'dist', 'server', 'next.js');
  if (!fs.existsSync(abs)) throw new Error(`NextServer 入口不存在：${abs}`);
  const mod = await loadModule(abs);
  const NextServer = mod && (mod.default || mod);
  if (typeof NextServer !== 'function') throw new Error(`${abs} 未导出 NextServer 构造函数`);
  const serverApp = NextServer({ dir, dev: false, hostname, port });
  await serverApp.prepare();
  const handler = serverApp.getRequestHandler();
  const httpServer = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logError(`请求处理失败：${describeError(err)}`);
      try {
        res.statusCode = 500;
        res.end('Internal Server Error');
      } catch {
        /* 连接已断 */
      }
    });
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, hostname, () => resolve());
  });
  return httpServer;
}

/** 从 startServer 的返回值里挖一个可关闭对象（版本间返回形状不同）。main.js:667-677 */
function makeCloser(result) {
  const candidates = [result, result && result.server, result && result.httpServer, result && result.app];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.close === 'function') {
      return () => new Promise((resolve) => {
        try {
          candidate.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
  return null;
}

async function startNextInProcess(dir, hostname, port) {
  const attempts = [
    ['next/dist/server/lib/start-server（候选 A）', startViaStartServerExport],
    ['next/dist/server/next 的 NextServer API（候选 A′）', startViaNextServerApi]
  ];
  const failures = [];
  for (const [label, run] of attempts) {
    try {
      const result = await run(dir, hostname, port);
      const close = makeCloser(result);
      if (!close) {
        logWarn(`${label}：未能取得 server 句柄，关闭服务将由进程退出代劳（已知限制，不假装优雅关停）`);
      }
      log(`Next 服务器已在进程内启动（${label}），监听 ${hostname}:${port}`);
      return close;
    } catch (err) {
      const detail = describeError(err);
      failures.push(`${label}: ${detail}`);
      logError(`候选入口启动失败（${label}）：${detail}`);
    }
  }
  // 刻意**不**退子进程方案：平台层封死（规划 §0.3 / §8.4），退过去只会把失败藏起来。
  throw new Error(`进程内 Next 启动失败，全部候选均不可用（不做子进程兜底）：${failures.join(' | ')}`);
}

// ── 就绪：HTTP 轮询 + marker 落盘 ─────────────────────────────────────────────
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(hostname, port) {
  const url = `http://${hostname}:${port}${READY_PROBE_PATH}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempt = 0;
  let last = '(尚未探测)';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await httpGet(url, 5000);
      if (res.status === 200) {
        log(`[ready] 第 ${attempt} 次探测通过：GET ${READY_PROBE_PATH} → 200 ${res.body.slice(0, 120)}`);
        return true;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = describeError(err);
    }
    if (attempt % 10 === 1) log(`[ready] 第 ${attempt} 次探测未就绪（${last}），${READY_INTERVAL_MS}ms 后重试`);
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error(`就绪探测超时（${READY_TIMEOUT_MS}ms / ${attempt} 次），最后结果：${last}`);
}

/**
 * 写就绪 marker：ArkTS 侧据此拿到**真实端口**（不在 ArkTS 侧硬编码端口）。
 * 内容刻意用扁平 JSON（键固定），解析失败=失败（不猜）。
 */
function writeReadyMarker(port, hostname, payloadRoot) {
  const markerPath = path.join(homeDir(), 'payload', READY_MARKER_NAME);
  const record = {
    ok: true,
    at: new Date().toISOString(),
    hostname,
    port,
    url: `http://${hostname}:${port}/`,
    payloadRoot,
    pid: process.pid,
    node: process.version,
    elapsedMs: Date.now() - startedAt,
    logPath: appLogPath()
  };
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    log(`就绪 marker 已写入：${markerPath}`);
  } catch (err) {
    logError(`就绪 marker 写入失败（ArkTS 侧将只能从日志解析端口）：${describeError(err)}`);
  }
  // 这行是截图/curl 都能断言的判据（端口在文本里可见）
  log(`PI_WEB_READY ${JSON.stringify({ port, hostname, url: record.url, elapsedMs: record.elapsedMs })}`);
  return markerPath;
}

// ── 宿主桥（Node → Kotlin）：bridge 0.2.0 适配 ─────────────────────────────────
/**
 * Android 的宿主桥是库主路：Node 侧 host.js（bridge AAR 内建）经 libnode_host_client.so
 * 直连槽位表（NODE_BRIDGE_BRIDGE_HANDLE），Kotlin 侧 Handler 分发。能力由 Kotlin 注册，
 * Node 侧只调用 host.invoke()。
 *
 * 与 ark 版的差异：bridge 0.2.0 的 host.js **没有** `handle(name, fn)`（Node 侧钩子注册）、
 * `useFileMailbox()`（文件信箱）与 `setTransport()`（自定义传输）——那三者是 ark 侧 API。
 * 因此本区块只做两件事，且都如实留痕：
 *   ① `host.ping()` —— 启动期取一次桥证据（pong 进 app.log，可 grep「宿主桥」）；
 *   ② 优雅关停：bridge 0.2.0 无 Node 侧钩子 ⇒ server.close() 由进程退出代劳（硬约束 ⑥），
 *      明说「拿不到优雅关停」，绝不假装关停被触发过。
 */
function registerShutdownHook(payloadRoot) {
  const candidates = [];
  const scriptDir = process.argv[1] ? path.dirname(process.argv[1]) : '';
  if (scriptDir.length > 0) candidates.push(path.join(scriptDir, 'host.js'));
  candidates.push(path.join(payloadRoot, 'host.js'));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const host = require(candidate);
      if (typeof host.handle === 'function') {
        // 未来 bridge 版本若提供 Node 侧钩子，这里自动恢复优雅关停
        host.handle('shutdown', async () => {
          await closeServer('host-bridge');
        });
        log(`已向宿主桥注册 shutdown 钩子（${candidate}）`);
      } else {
        log('优雅关停：bridge 0.2.0 的 host.js 无 handle() ⇒ server 生命周期随进程退出（硬约束 ⑥，如实登记）');
      }
      try {
        const ping = typeof host.ping === 'function' ? host.ping() : { ok: false, reason: 'no ping()' };
        log(`宿主桥证据（ping）：${JSON.stringify(ping).slice(0, 200)}`);
      } catch (err) {
        logWarn(`宿主桥 ping 抛错：${describeError(err)}`);
      }
      return true;
    } catch (err) {
      logWarn(`加载宿主桥客户端失败 ${candidate}：${describeError(err)}`);
    }
  }
  logWarn('未找到库的 payload/host.js：跳过宿主桥证据采集；监听端口随进程退出由内核回收');
  return false;
}

async function closeServer(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到关停请求（reason=${reason}）：调用 server.close() …`);
  if (typeof closer !== 'function') {
    logWarn('没有可用的 server 句柄：无法优雅关闭监听（已知限制；监听端口随进程退出释放）');
    return;
  }
  try {
    await closer();
    log('server.close() 已完成');
  } catch (err) {
    logWarn(`server.close() 失败：${describeError(err)}`);
  }
}

// ── agent 资源物化（extensions / skills → <PI_CODING_AGENT_DIR>）─────────────────────
/** 递归列出 `root` 下所有**文件的相对路径**（`/` 分隔，已排序；不含目录）。 */
function listFilesDeep(root) {
  const out = [];
  const stack = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch (err) {
      logWarn(`listFilesDeep 读取失败：${current.abs}（${describeError(err)}）`);
      continue;
    }
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const abs = path.join(current.abs, entry.name);
      // 平台禁止 symlink（应用域 EACCES），出现也一律不跟随——只认真实文件/目录
      if (entry.isDirectory()) stack.push({ abs, rel });
      else if (entry.isFile()) out.push(rel);
    }
  }
  out.sort();
  return out;
}

/**
 * 把随包的 `extensions/` 与 `skills/` **复制**到 `<PI_CODING_AGENT_DIR>`。
 *
 * 为什么必须做：pi **不会**从载荷目录加载扩展与技能 ——
 *   · `discoverAndLoadExtensions` 只看 `<agentDir>/extensions` 与 `<cwd>/.pi/extensions`
 *     （`pi-coding-agent/dist/core/extensions/loader.js`）；
 *   · 技能只看 `<agentDir>/skills` 与 `<cwd>/.pi/skills`（`dist/core/resource-loader.js`）。
 * 不做这一步的**真机现象**：同名顶替 `bash`/`grep`/`find` 与 `harmony-runtime-capabilities`
 * 技能全部不生效——模型可用工具只剩 `read`/`write`/`edit`/`bash`，`find`/`grep` **根本不存在**
 * （2026-10-17 实测，见 `docs/001-能力复刻评估.md` §K.9）。
 *
 * 纪律：① **幂等**——逐文件比对内容（不比 mtime：两个卷的时钟不可比），相同即跳过；
 * ② **原子写**（临时文件 + `rename`），平台禁止 symlink，一律真拷贝；
 * ③ **绝不抛**——物化失败只降级为「扩展/技能缺席」，不能拖垮主链路。
 */
function materializeAgentResources(payloadRoot) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    logWarn('PI_CODING_AGENT_DIR 未设置：跳过 agent 资源物化（扩展与技能将缺席）');
    return { copied: 0, skipped: 0 };
  }
  const pairs = [
    { name: 'extensions', src: path.join(payloadRoot, 'extensions'), dest: path.join(agentDir, 'extensions') },
    { name: 'skills', src: path.join(payloadRoot, 'skills'), dest: path.join(agentDir, 'skills') }
  ];
  let copied = 0;
  let skipped = 0;
  for (const pair of pairs) {
    if (!fs.existsSync(pair.src)) {
      logWarn(`agent 资源源目录不存在（${pair.name}）：${pair.src} —— 本次不物化这一类`);
      continue;
    }
    for (const rel of listFilesDeep(pair.src)) {
      const from = path.join(pair.src, rel);
      const to = path.join(pair.dest, rel);
      try {
        const buf = fs.readFileSync(from);
        let same = false;
        try {
          same = fs.readFileSync(to).equals(buf);
        } catch {
          same = false;
        }
        if (same) {
          skipped += 1;
          continue;
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const tmp = `${to}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, to);
        copied += 1;
      } catch (err) {
        logWarn(`agent 资源物化失败（${rel}）：${describeError(err)}`);
      }
    }
  }
  log(`agent 资源已物化：复制 ${copied} 个、跳过 ${skipped} 个（${payloadRoot} → ${agentDir}）`);
  return { copied, skipped };
}

/**
 * 112：移除已废弃纯 JS 扩展的旧物化残留。
 * 历史版本把 payload/extensions/android-git（isomorphic-git）与 android-pnpm（进程内 JS bundle）
 * 复制到 <agentDir>/extensions/；112 起二者由真实 git/pnpm CLI 取代，载荷里已删目录，但升级安装
 * 不会自动清掉旧物化副本（materializeAgentResources 只增不删）。启动期显式删除，避免旧扩展被
 * discoverAndLoadExtensions 再次注册。只删这两个具名目录，绝不碰其它扩展；任何失败只告警不阻断。
 */
function cleanupLegacyExtensions() {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return;
  for (const name of ['android-git', 'android-pnpm']) {
    const target = path.join(agentDir, 'extensions', name);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        log(`已清理废弃扩展残留：${target}`);
      }
    } catch (err) {
      logWarn(`清理废弃扩展残留失败（${target}）：${describeError(err)}`);
    }
  }
}

// ── 引擎引导事实（能力清单 §F P1-3/P1-4：形态事实落盘 + Intl 探针常态化）──────────
/**
 * 在 require 任何 Next 代码**之前**，把引擎的 as-built 事实写到
 * `<HOME>/payload/pi-web.boot-facts.json`（Kotlin 侧 EngineFacts 轮询合并进 engine-facts.json）。
 *
 * 为什么必须在引导最前面：翻译层 SEGV（能力清单 §E）发生在 Next require 风暴期——
 * 这份文件是那种场景下**唯一能落盘的引擎证据**（node 版本 / Intl 逐项 / WASM / execPath）。
 * 换引擎回归时比对 intl 块即可守门（devtest.mjs 的端上取证半边）。
 *
 * Intl 探针口径（与 docs/002 O2 同表）：
 *   · constructors 逐项 typeof（Collator/NumberFormat/DateTimeFormat/PluralRules/
 *     RelativeTimeFormat/Segmenter/ListFormat/DisplayNames）；
 *   · propertyEscapeCompile：`/\p{Script=Greek}/u` 与 `/\p{ID_Start}/u` 能否编译
 *     （no-icu 引擎在**编译期**抛 SyntaxError，垫片救不了 ⇒ 这是 O2 的第一死因）；
 *   · propertyEscapeExec：编译通过时再试匹配（small-icu 应 ok）；
 *   · defaultLocale / toLocaleString 语义抽查。
 * 全程不抛：探针失败本身就是事实。
 */
// ── PTY 常驻加载器（111-pty-integration）───────────────────────────────────
// 这是**产品化**加载器（区别于 runPtyNodeSelftest 的 selftest 专用探针）：在 pi-web server boot 前
// dlopen libpty_node.so（nativeLibraryDir，G3 合规执行位）并种子 require.cache，使
// lib/terminal-manager.ts#require("node-pty")（node-pty 1.1.0 JS，载荷 node_modules overlay）命中。
// 失败结构化上报（boot-facts pty.ready=false），绝不静默降级成假终端（宪法 A6）。
let ptyNative = null; // { ok, version, detail }；ensurePtyNative() 的缓存结果
function ensurePtyNative(payloadRoot) {
  try {
    const nativeLibDir = process.env.PI_ANDROID_NATIVE_LIB_DIR || '';
    if (!nativeLibDir) {
      return { ok: false, version: null, detail: 'PI_ANDROID_NATIVE_LIB_DIR 未注入（Kotlin 宿主未升级？）' };
    }
    const pkgDir = path.join(payloadRoot, 'node_modules', 'node-pty');
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const version = String(pkgJson.version);
    if (!version.startsWith('1.1.')) {
      return { ok: false, version, detail: `node-pty overlay 版本 ${version} 非 1.1.x（与 libpty_node.so 配对不符）` };
    }
    const nativePath = path.join(pkgDir, 'build', 'Release', 'pty.node');
    if (!fs.existsSync(nativePath)) {
      return { ok: false, version, detail: `node-pty overlay 占位缺失：${nativePath}` };
    }
    const soPath = fs.existsSync(path.join(nativeLibDir, 'libpty_node.so'))
      ? path.join(nativeLibDir, 'libpty_node.so')
      : 'libpty_node.so';
    const Module = require('node:module');
    const m = new Module(nativePath);
    m.filename = nativePath;
    m.paths = Module._nodeModulePaths(path.dirname(nativePath));
    process.dlopen(m, soPath);
    require.cache[require.resolve(nativePath)] = m;
    log(`PTY 常驻加载器：dlopen(${soPath.slice(-40)}) + 种子 require.cache（node-pty@${version}）`);
    return { ok: true, version, detail: `dlopen(libpty_node.so) + require.cache 种子（node-pty@${version}）` };
  } catch (err) {
    return { ok: false, version: null, detail: describeError(err) };
  }
}

function writeBootFacts(payloadRoot, jitlessState, cliFacts) {
  const safe = (fn) => {
    try { return fn(); } catch (err) { return `error: ${describeError(err)}`; }
  };
  const intl = safe(() => {
    const present = typeof Intl !== 'undefined';
    const ctor = (name) => (present && typeof Intl[name] === 'function');
    const reEscape = (source) => {
      try { new RegExp(source, 'u'); return true; } catch { return false; }
    };
    return {
      present,
      constructors: {
        Collator: ctor('Collator'),
        NumberFormat: ctor('NumberFormat'),
        DateTimeFormat: ctor('DateTimeFormat'),
        PluralRules: ctor('PluralRules'),
        RelativeTimeFormat: ctor('RelativeTimeFormat'),
        Segmenter: ctor('Segmenter'),
        ListFormat: ctor('ListFormat'),
        DisplayNames: ctor('DisplayNames'),
      },
      propertyEscapeCompile: {
        scriptGreek: reEscape('\\p{Script=Greek}'),
        idStart: reEscape('\\p{ID_Start}'),
      },
      propertyEscapeExec: safe(() => {
        if (!reEscape('\\p{Script=Greek}')) return false;
        return new RegExp('\\p{Script=Greek}', 'u').test('Ω');
      }),
      defaultLocale: safe(() => (present ? Intl.DateTimeFormat().resolvedOptions().locale : null)),
      numberToLocaleString: safe(() => (1.23).toLocaleString('en-US') === '1.23'),
    };
  });
  const wasm = safe(() => {
    if (typeof WebAssembly === 'undefined') return { available: false };
    // 最小合法 wasm 模块（仅 magic+version 的空模块）；validate 需要完整模块形态
    const ok = WebAssembly.validate(Buffer.from('AGFzbQEAAAA=', 'base64'));
    return { available: true, validateOk: ok };
  });
  const facts = {
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execPathBasename: path.basename(String(process.execPath || '')),
    pid: process.pid,
    jitless: { active: jitlessState && jitlessState.active === true },
    pty: ptyNative ? { ready: ptyNative.ok, version: ptyNative.version, detail: ptyNative.detail } : { ready: false, detail: 'not-run' },
    // 112：五 CLI 在 App 真进程域的可达性/版本事实（runCliProbe；失败仅记录不阻断）
    cli: cliFacts || { skipped: true, detail: 'cli probe not run' },
    intl,
    wasm,
  };
  const out = path.join(homeDir(), 'payload', 'pi-web.boot-facts.json');
  try {
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(facts, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, out);
    log(`引擎引导事实已写：${out}（node=${facts.node} intl.present=${facts.intl.present}`
      + ` propertyEscape=${facts.intl.propertyEscapeCompile.scriptGreek && facts.intl.propertyEscapeCompile.idStart} wasm=${JSON.stringify(facts.wasm)}）`);
  } catch (err) {
    logWarn(`引擎引导事实写入失败（诊断资产，不影响主链路）：${describeError(err)}`);
  }
  return facts;
}

// ── 112 CLI 集成：五 CLI 常态化探针（App 真进程域裁决；并入 boot-facts.cli）──────────────
/**
 * 为什么必须在 App 真进程域裁决：run-as（runas_app 域）下纯 PIE ELF 经 symlink 调用会触发
 *   bionic realpath 自检失败（"Unable to get realpath of <name>"，rc=255；git 甚至不回 close），
 *   但产品的 TERM/PTY/EXEC 三通道都跑在 App 自身的 untrusted_app 域（P0 探针在该域 22/22 PASS）。
 *
 * 为什么用「常驻 sh + 哨兵帧」而不是逐命令 child_process 事件（2026-11-05 实测根因，与
 *   extensions/android-exec.js 头部记载的平台事实同一条）：app_process 内嵌 Node 的 libuv
 *   child_process 在本宿主上 **exit/close 事件永不送达** —— 子进程约 1.5s 变僵尸（ps 可见 Z 态），
 *   libuv 的 waitpid 回收不触发，连 setTimeout 兜底都会被卡死的事件路径拖住；spawnSync 更在首个
 *   调用即永久阻塞事件循环。逐命令 spawn 实测：5 个 ELF 偶发回收成功、5 个 sh 壳必僵尸，
 *   首启被拖到 139s。唯一在本平台验证可靠的执行形态是 android-exec.js 的常驻 /system/bin/sh +
 *   随机哨兵行：只 spawn 一次 shell，命令经 stdin 帧下发，结束判定**只看 stdout 哨兵**，
 *   完全不依赖任何进程事件。本探针沿用同一纪律（精简版，无 abort/进度/截断）。
 *
 * 为什么这也直接裁决了「终端敲短名」：常驻 sh 以产品 env（PATH 前置 $HOME/bin）启动，帧内直接
 *   写 `node --version` 等短名 —— 与用户在 TERM/PTY 里敲的解析路径完全一致（shell 做 PATH 搜索、
 *   内核解 symlink、sh 壳由 shell 按 shebang 处理），是比绝对路径 exec 更贴近产品的裁决。
 *
 * 纪律：① 常态化（不挂 selftest 门控），每次启动给版本/可达性事实；② 只跑离线 --version，
 *   不做网络动作；③ 单命令哨兵超时 + 整探针硬上限，超时只结构化标记不卡死；④ 全程 try/catch，
 *   任何失败落盘，绝不阻断 Next 主链路（宪法 A6）；⑤ 探针结束即销毁常驻 shell，不留长驻资源。
 */
async function runCliProbe() {
  const { spawn } = require('node:child_process');
  const crypto = require('node:crypto');
  const started = Date.now();
  const PROBE_TIMEOUT_MS = 12_000;   // 单条命令哨兵等待上限
  const HARD_DEADLINE_MS = 150_000;  // 整探针硬上限（10 条 --version + PATH 探测 + git 工作流冒烟；探针在 Next 就绪后异步跑，不阻塞首启）
  // [短名, 参数, 预期输出正则]
  const commands = [
    ['node', ['--version'], /^v\d+\.\d+\.\d+/],
    ['npm', ['--version'], /^\d+\.\d+\.\d+/],
    ['npx', ['--version'], /^\d+\.\d+\.\d+/],
    ['corepack', ['--version'], /^\d+\.\d+\.\d+/],
    ['python', ['--version'], /Python 3\.\d+\.\d+/],
    ['pip', ['--version'], /^pip \d+\.\d+/],
    ['pip3', ['--version'], /^pip \d+\.\d+/],
    ['git', ['--version'], /git version \d+\.\d+/],
    ['uv', ['--version'], /uv \d+\.\d+\.\d+/],
    ['pnpm', ['--version'], /^\d+\.\d+\.\d+/],
  ];
  const hardDeadline = started + HARD_DEADLINE_MS;
  let proc = null;
  let buffer = '';
  let shellDied = false;
  try {
    // 只 spawn 一次常驻 **login shell**（sh -l）：mksh 启动自动 source $HOME/.profile，加载 CliTools
    // 生成的 10 个 CLI 函数（函数体 exec 绝对 ELF/壳，argv[0] 绝对，规避 bionic 裸短名 realpath 失败）。
    // 继承产品 process.env（PATH 已前置 $HOME/bin，勿传 env 副本——与 android-exec.js 同纪律）；stdio 全管道、
    // stdin 喂帧；detached 建新进程组，使本宿主下管道回送与 waitpid 与已验证可靠的 EXEC 通道一致。
    proc = spawn('/system/bin/sh', ['-l'], { cwd: homeDir(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    proc.stdout.setEncoding('utf8');
    // 翻译层/部分路径可能输出 CRLF：入口统一归一化为 LF，哨兵与版本解析只需处理 LF（CR 不跨 chunk 残留，因 \r 必紧邻 \n）。
    proc.stdout.on('data', (chunk) => { buffer += String(chunk).replace(/\r\n/g, '\n'); });
    proc.stderr.on('data', () => { /* 帧内 2>&1 已合并；排空防反压 */ });
    proc.on('error', () => { shellDied = true; });
    proc.stdout.on('end', () => { shellDied = true; });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 单条命令：下发哨兵帧 → 轮询 stdout 找本 token 的 END 哨兵（不依赖任何进程事件）。
    const runOne = async (name, args, expectRe) => {
      const t0 = Date.now();
      const token = crypto.randomBytes(6).toString('hex');
      const begin = `__PI_CLIBEGIN__${token}`;
      const end = `__PI_CLIEND__${token}`;
      const quotedArgs = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
      // 子 shell 括号组：隔离 cd/变量；</dev/null 防读 stdin 的命令吃掉帧；2>&1 合并流。
      const frame = `printf '\\n${begin}\\n'; ( ${name} ${quotedArgs} ) </dev/null 2>&1; __rc=$?; printf '\\n${end} %s\\n' "$__rc"\n`;
      try {
        proc.stdin.write(frame);
      } catch (err) {
        return { name, ok: false, code: null, timedOut: false, ms: Date.now() - t0, version: '', versionMatch: false, error: `stdin write: ${describeError(err)}` };
      }
      const beginMarker = `\n${begin}\n`;
      const endMarker = `\n${end} `;
      while (Date.now() < Math.min(t0 + PROBE_TIMEOUT_MS, hardDeadline)) {
        if (shellDied) {
          return { name, ok: false, code: null, timedOut: false, ms: Date.now() - t0, version: '', versionMatch: false, error: 'resident shell died' };
        }
        const endAt = buffer.indexOf(endMarker);
        if (endAt >= 0) {
          // 从 endAt+1 起找行尾换行：endAt 指向 END 标记的前导 \n，若从 endAt 搜会立刻命中该 \n（实测 bug）。
          const lineEnd = buffer.indexOf('\n', endAt + 1);
          if (lineEnd >= 0) {
            // 翻译层/PTY 可能输出 CRLF：剥离 rc 尾部 \r，保证 /^\d+$/ 命中。
            const rcText = buffer.slice(endAt + endMarker.length, lineEnd).replace(/\r$/, '').trim();
            const beginAt = buffer.lastIndexOf(beginMarker, endAt);
            const body = beginAt >= 0 ? buffer.slice(beginAt + beginMarker.length, endAt) : '';
            const firstLine = body.split('\n').map((s) => s.replace(/\r$/, '').trim()).find(Boolean) || '';
            const code = /^\d+$/.test(rcText) ? Number(rcText) : null;
            return {
              name,
              ok: code === 0 && expectRe.test(firstLine),
              code,
              timedOut: false,
              ms: Date.now() - t0,
              version: firstLine.slice(0, 120),
              versionMatch: expectRe.test(firstLine),
              error: null,
            };
          }
        }
        await sleep(20); // eslint-disable-line no-await-in-loop
      }
      return { name, ok: false, code: null, timedOut: true, ms: Date.now() - t0, version: '', versionMatch: false, error: `sentinel timeout ${PROBE_TIMEOUT_MS}ms` };
    };

    const checks = [];
    for (const [name, args, expectRe] of commands) {
      if (Date.now() >= hardDeadline) {
        checks.push({ name, ok: false, code: null, timedOut: true, ms: 0, version: '', versionMatch: false, error: 'probe hard deadline reached' });
      } else {
        checks.push(await runOne(name, args, expectRe)); // eslint-disable-line no-await-in-loop
      }
    }

    // PATH 短名可达性：同一常驻 shell 批量 command -v（走产品 PATH，与终端敲短名同路径）。
    const names = commands.map((c) => c[0]);
    const pathResolution = await (async () => {
      const token = crypto.randomBytes(6).toString('hex');
      const begin = `__PI_PATHBEGIN__${token}`;
      const end = `__PI_PATHEND__${token}`;
      const endMarker = `\n${end} `;
      const probe = names.map((n) => `printf '%s=' '${n}'; command -v '${n}' || echo MISSING`).join('; ');
      try {
        // 与 runOne 完全同构：BEGIN/END 双 printf、单引号 '\n'（真换行），杜绝字面 \\n 的异类帧。
        proc.stdin.write(`printf '\n${begin}\n'; ( ${probe} ) </dev/null 2>&1; __rc=$?; printf '\n${end} %s\n' "$__rc"\n`);
      } catch (err) {
        return names.map((name) => ({ name, onPath: false, resolved: null, detail: describeError(err) }));
      }
      // while+await sleep 轮询（本宿主内嵌引擎下与常驻 shell 管道兼容的唯一可靠形态）。
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (shellDied) return names.map((name) => ({ name, onPath: false, resolved: null, detail: 'shell died' }));
        const endAt = buffer.indexOf(endMarker);
        if (endAt >= 0 && buffer.indexOf('\n', endAt + 1) >= 0) {
          const map = new Map();
          for (const line of buffer.slice(0, endAt).split('\n')) {
            const m = /^([^=]+)=(.*)$/.exec(line.replace(/\r$/, '').trim());
            if (m && names.includes(m[1])) map.set(m[1], m[2] === 'MISSING' ? null : m[2].replace(/\r$/, ''));
          }
          return names.map((name) => {
            const resolved = map.has(name) ? map.get(name) : null;
            return { name, onPath: !!resolved, resolved };
          });
        }
        await sleep(20); // eslint-disable-line no-await-in-loop
      }
      return names.map((name) => ({ name, onPath: false, resolved: null, detail: 'path probe timeout' }));
    })();


    // 真域 git 工作流冒烟交给**独立的全新 login shell**（见模块级 runGitSmoke）：不与上面的主探针
    // 常驻 shell 共享 buffer/解析状态。/proc 取证表明主 shell 在多帧累积后会卡在 unix_stream_read_generic
    // （mksh 续行等待，Node 流仍健康），独立短生命周期 shell 从根本上规避该长会话状态污染。
    const gitSmoke = await runGitSmoke(spawn, crypto, hardDeadline, sleep, homeDir());
    const envSnapshot = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'PYTHONHOME', 'GIT_EXEC_PATH', 'NODE_HOME', 'PNPM_HOME', 'UV_CACHE_DIR', 'LD_LIBRARY_PATH']) {
      envSnapshot[key] = process.env[key] || null;
    }
    const summary = {
      total: checks.length,
      ok: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
      timedOut: checks.filter((c) => c.timedOut).length,
      onPath: pathResolution.filter((p) => p.onPath).length,
      gitCommitOk: gitSmoke.commitOk,
      gitCommitSegfault: gitSmoke.commitSegfault,
      gitSmokeOk: gitSmoke.ok,
      elapsedMs: Date.now() - started,
    };
    const report = {
      at: new Date().toISOString(),
      domain: 'app-untrusted（常驻 login shell sh -l 自动 source $HOME/.profile 的 CLI 函数 + 哨兵帧；短名经函数 exec 绝对 ELF，与 TERM/PTY/EXEC 同路径）',
      env: envSnapshot,
      pathResolution,
      checks,
      gitSmoke,
      summary,
    };
    log(`[cli-probe] 执行 ${summary.ok}/${summary.total} 可用｜PATH 短名 ${summary.onPath}/${summary.total}（${summary.elapsedMs}ms，超时 ${summary.timedOut}）`);
    for (const c of checks) {
      log(`[cli-probe] ${c.ok ? 'OK ' : 'FAIL'} ${c.name}（code=${c.code}，${c.ms}ms）${c.version ? ' :: ' + c.version : (c.error ? ' :: ' + c.error : '')}`);
    }
    log(`[cli-probe] git 工作流冒烟 ${gitSmoke.ok ? 'OK' : 'FAIL'}（commit=${gitSmoke.commitOk ? 'ok' : (gitSmoke.commitSegfault ? 'SEGFAULT(139)' : 'fail')}，log=${gitSmoke.logOk ? 'ok' : 'fail'}，${gitSmoke.elapsedMs}ms，${gitSmoke.steps.length} 步）`);
    return report;
  } catch (err) {
    // 整体异常绝不拖垮主链路：返回结构化失败，boot-facts 仍落盘。
    logWarn(`CLI 探针整体异常（不阻断启动）：${describeError(err)}`);
    return { at: new Date().toISOString(), skipped: true, detail: `cli probe threw: ${describeError(err)}`, elapsedMs: Date.now() - started };
  } finally {
    // 探针结束即销毁常驻 shell（进程组），不留长驻资源；忽略清理错误。
    try {
      if (proc) {
        try { proc.stdin.destroy(); } catch { /* 已关 */ }
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* 已退 */ } }
      }
    } catch { /* 清理尽力而为 */ }
  }
}

// ── 112 CLI 集成：真域 git 工作流冒烟（独立短生命周期 login shell）──────────────────────
/**
 * 为什么独立 shell：D6 主探针的常驻 login shell 在累积 10 条 --version + PATH 探测帧后，mksh 会进入
 *   续行等待（/proc/<sh>/wchan = unix_stream_read_generic），此时 Node 侧 stdin/stdout 流仍健康
 *   （未销毁、可写、writableLength=0），但 shell 不再执行/回送，bufLen 恒定。该长会话解析状态污染与
 *   内嵌引擎（libnode.so v24）libuv 的 socketpair 生命周期相关，run-as + CLI Node(v26) 无法复现。
 *   用一个全新、短生命周期、只跑 7 个 git 帧的 login shell 从根本上规避：它没有历史累积帧，启动即干净。
 *
 * 裁决目标：run-as（runas_app 域）实测 git commit 因 SELinux 禁 link 而段错误（rc=139）；产品三通道
 *   跑在 App 自身 untrusted_app 域，git 在 link(2) 失败时应回退 rename/复制写对象。此处给出真域事实，
 *   若仍 139 则记为翻译层/域差异，留 P4 原生 arm64 真机对照。
 * 纪律：全程离线；仓库在应用私有 TMPDIR，结束即 rm -rf；每步独立哨兵帧；git 在子 shell 内运行，
 *   段错误只杀子进程；整段 try/catch，失败结构化返回，绝不阻断 Next 主链路（宪法 A6）。
 */
async function runGitSmoke(spawnFn, cryptoMod, hardDeadline, sleepFn, home) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const STEP_TIMEOUT_MS = 12_000;
  const started = Date.now();
  const steps = [];
  let sh = null;
  let buf = '';
  let died = false;
  try {
    // 独立 login shell：与主探针同形态（sh -l 自动 source $HOME/.profile 的 git 函数）、同 env（继承产品
    // process.env，不传副本）、独立进程组（detached），cwd 为产品 HOME。
    sh = spawnFn('/system/bin/sh', ['-l'], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    sh.stdout.setEncoding('utf8');
    sh.stdout.on('data', (chunk) => { buf += String(chunk).replace(/\r\n/g, '\n'); });
    sh.stderr.on('data', () => { /* 帧内 2>&1 已合并；排空防反压 */ });
    sh.on('error', () => { died = true; });
    sh.stdout.on('end', () => { died = true; });

    const runStep = async (step, cmd) => {
      const t0 = Date.now();
      const token = cryptoMod.randomBytes(6).toString('hex');
      const begin = `__PI_GITBEGIN__${token}`;
      const end = `__PI_GITEND__${token}`;
      // 与 runOne 同构的 subshell 哨兵帧（printf 单引号 \n 真换行，</dev/null 防吞帧，2>&1 合流）。
      const frame = `printf '\n${begin}\n'; ( ${cmd} ) </dev/null 2>&1; __rc=$?; printf '\n${end} %s\n' "$__rc"\n`;
      try {
        sh.stdin.write(frame);
      } catch (err) {
        steps.push({ step, ok: false, code: null, timedOut: false, ms: Date.now() - t0, out: `stdin write: ${describeError(err)}` });
        return;
      }
      const beginMarker = `\n${begin}\n`;
      const endMarker = `\n${end} `;
      while (Date.now() < Math.min(t0 + STEP_TIMEOUT_MS, hardDeadline)) {
        if (died) { steps.push({ step, ok: false, code: null, timedOut: false, ms: Date.now() - t0, out: 'git shell died' }); return; }
        const endAt = buf.indexOf(endMarker);
        if (endAt >= 0) {
          const lineEnd = buf.indexOf('\n', endAt + 1);
          if (lineEnd >= 0) {
            const rcText = buf.slice(endAt + endMarker.length, lineEnd).replace(/\r$/, '').trim();
            const beginAt = buf.lastIndexOf(beginMarker, endAt);
            const out = (beginAt >= 0 ? buf.slice(beginAt + beginMarker.length, endAt) : '').replace(/\r/g, '').trim();
            const code = /^\d+$/.test(rcText) ? Number(rcText) : null;
            steps.push({ step, ok: code === 0, code, timedOut: false, ms: Date.now() - t0, out: out.slice(0, 400) });
            return;
          }
        }
        await sleep(20); // eslint-disable-line no-await-in-loop
      }
      steps.push({ step, ok: false, code: null, timedOut: true, ms: Date.now() - t0, out: `sentinel timeout ${STEP_TIMEOUT_MS}ms` });
    };

    const smokeBase = `${process.env.TMPDIR || '/data/local/tmp'}/pi-gitsmoke`;
    const q = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
    const guard = async (step, cmd) => {
      if (Date.now() >= hardDeadline) steps.push({ step, ok: false, code: null, timedOut: true, ms: 0, out: 'probe hard deadline reached' });
      else await runStep(step, cmd);
    };
    await guard('setup', `rm -rf ${q(smokeBase)} && mkdir -p ${q(`${smokeBase}/repo`)} ${q(`${smokeBase}/tpl`)}`);
    await guard('init', `cd ${q(`${smokeBase}/repo`)} && GIT_TEMPLATE_DIR=${q(`${smokeBase}/tpl`)} git init`);
    await guard('config', `cd ${q(`${smokeBase}/repo`)} && git config user.email probe@pi.local && git config user.name 'PI Probe'`);
    await guard('add', `cd ${q(`${smokeBase}/repo`)} && printf 'hello pi\n' > README.md && git add README.md`);
    await guard('commit', `cd ${q(`${smokeBase}/repo`)} && git commit -m 'pi cli smoke'`);
    await guard('log', `cd ${q(`${smokeBase}/repo`)} && git log --oneline -1`);
    await guard('cleanup', `rm -rf ${q(smokeBase)}`);

    const commitStep = steps.find((s) => s.step === 'commit');
    const logStep = steps.find((s) => s.step === 'log');
    return {
      steps,
      commitOk: !!commitStep && commitStep.ok,
      commitSegfault: !!commitStep && commitStep.code === 139,
      logOk: !!logStep && logStep.ok,
      ok: steps.every((s) => s.ok),
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    logWarn(`git 冒烟整体异常（不阻断启动）：${describeError(err)}`);
    return { steps, commitOk: false, commitSegfault: false, logOk: false, ok: false, skipped: true, detail: `git smoke threw: ${describeError(err)}`, elapsedMs: Date.now() - started };
  } finally {
    // 独立 shell 用完即销毁（进程组），不留长驻资源；忽略清理错误。
    try {
      if (sh) {
        try { sh.stdin.destroy(); } catch { /* 已关 */ }
        try { process.kill(-sh.pid, 'SIGKILL'); } catch { try { sh.kill('SIGKILL'); } catch { /* 已退 */ } }
      }
    } catch { /* 清理尽力而为 */ }
  }
}

// ── 宿主能力自检（调试/验收通道；默认关闭）────────────────────────────────────
/**
 * `PI_ANDROID_SELFTEST=1` 时（Kotlin 侧仅当 `am start --ez selftest true` 注入），
 * 在 startNext 之前逐个调用宿主能力并把结果落
 * `<HOME>/payload/pi-web.selftest.json`。
 *
 * 选择 dryRun/只读动作：自检验证「注册面 + 通路 + 契约形状」，**不弹**选择器/权限窗
 * （那需要人守着）；交互路径由 `/saf-pick-folder` 等扩展命令人工验收。
 * 自检失败**不阻断启动**（写完报告继续）——它是诊断资产。
 */
async function runHostSelftest(payloadRoot) {
  if (process.env.PI_ANDROID_SELFTEST !== '1') return null;
  const candidates = [];
  const scriptDir = process.argv[1] ? path.dirname(process.argv[1]) : '';
  if (scriptDir.length > 0) candidates.push(path.join(scriptDir, 'host.js'));
  candidates.push(path.join(payloadRoot, 'host.js'));
  let host = null;
  let hostPath = '';
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try { host = require(candidate); hostPath = candidate; break; } catch { /* 下一个 */ }
  }
  const calls = [
    ['runtime.facts', {}],
    ['runtime.keepAlive', { dryRun: true, enable: true }],
    // 真实启动前台服务（selftest 是受控验收通道；POST_NOTIFICATIONS 未授权时通知被系统隐藏，服务仍在）
    ['runtime.keepAlive', { enable: true }],
    ['perm.check', { permType: 'sandbox' }],
    ['perm.check', { permType: 'notification' }],
    ['perm.check', { permType: 'saf' }],
    ['perm.check', { permType: 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY' }],
    ['perm.request', { permissions: ['ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY'] }],
    ['fs.pickFolder', { dryRun: true }],
    ['fs.pickFiles', { dryRun: true, mimeTypes: ['text/plain'] }],
    ['notify.show', { title: 'Pi Desktop 自检', body: 'notify.show 通路验证（selftest）' }],
    ['log.hilog', { level: 'info', text: 'selftest: log.hilog 通路' }],
    ['terminal.pty', {}],
    ['shell.openExternal', { dryRun: true, url: 'https://example.com/' }],
  ];
  const results = [];
  for (const [name, args] of calls) {
    const started = Date.now();
    let entry;
    if (!host || typeof host.invoke !== 'function') {
      entry = { capability: name, ok: false, error: 'host.js 不可用' };
    } else {
      try {
        const value = await Promise.race([
          Promise.resolve(host.invoke(name, args)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('invoke 超时(5s)')), 5000)),
        ]);
        entry = { capability: name, ok: true, result: value };
      } catch (err) {
        entry = { capability: name, ok: false, error: describeError(err) };
      }
    }
    entry.elapsedMs = Date.now() - started;
    results.push(entry);
  }
  const report = {
    at: new Date().toISOString(),
    hostPath: hostPath || null,
    selftest: 'dryRun/read-only',
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
  };
  const out = path.join(homeDir(), 'payload', 'pi-web.selftest.json');
  try {
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (err) {
    logWarn(`自检报告写入失败：${describeError(err)}`);
  }
  log(`宿主能力自检（selftest）：${report.summary.ok}/${report.summary.total} 通过，报告 ${out}`);
  return report;
}

// ── 设备侧自检公共辅助（pty/ptynode 探针仍在用；git/pnpm 纯 JS 扩展已于 112 移除）────────
/**
 * 历史上这里还有 git204-lite（isomorphic-git）与 pnpm O8（进程内 bundle）两个 selftest；
 * 112 引入真实 git/pnpm CLI 后两套纯 JS 扩展删除，其 selftest 一并移除。
 * 下列辅助仍被 runPtySelftest / runPtyNodeSelftest 使用，故保留。
 */
function selftestAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homeDir(), 'pi-agent');
}

function writeSelftestReport(name, report) {
  const out = path.join(homeDir(), 'payload', name);
  try {
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (err) {
    logWarn(`${name} 写入失败：${describeError(err)}`);
  }
  return out;
}

/** 单步带超时（挂起的工具调用不该拖垮整个窗口；pc 侧教训：诊断面必须可超时）。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

// ── O6 PTY 探针（规划 §14.2 O6；Phase 4 暂缓项重启评估的第一步）──────────────────
/**
 * 背景：ark（OHOS）应用域 /dev/ptmx 全 EACCES（无 devpts 挂载）⇒ PTY 死路；
 * dsh（Android 同门）实测 /dev/ptmx **可开** —— 两口径相反，Android 侧真相由本探针定分晓。
 *
 * 测什么（每步都能独立成立为结论，任何一步失败不影响后续）：
 *   ① SELinux 判定：fs.openSync('/dev/ptmx','r+') 能否拿到 fd（O6 核心问题）；
 *   ② devpts 挂载与 /dev/pts 枚举（spawn /system/bin/sh，O5 已证通道）；
 *   ③ slave 可开性：无 ioctl 的 JS 限制下，盲试 /dev/pts/0..5（unlockpt 缺失 ⇒ 预期 EIO；
 *      若意外可开 ⇒ 纯 JS PTY 路线成立，升级结论）；
 *   ④ toybox `script` 桥：`script -qfc sh /dev/null` 可用 ⇒ 零原生件 PTY 路线成立（R-PTY-B）；
 *   ⑤ stty 在位性（终终端属性设置的传统通道）。
 *
 * 本探针**只评估不改变行为**：terminal.pty 能力维持结构化 unsupported，复活与否由评估结论+用户决策。
 */
async function runPtySelftest() {
  if (process.env.PI_ANDROID_SELFTEST !== '1') return null;
  const started = Date.now();
  const report = { at: new Date().toISOString(), suite: 'O6 PTY 探针（规划 §14.2；暂缓项重启评估）', results: [], summary: null };
  const push = (name, r) => { report.results.push(r); log(`[pty-selftest] ${r.ok === true ? 'OK' : r.ok === false ? 'NO' : 'INFO'} ${name}${r.detail ? ' :: ' + String(r.detail).slice(0, 200) : ''}`); };
  const sh = (cmd, timeoutMs = 8000) => new Promise((resolve) => {
    try {
      const { spawn } = require('node:child_process');
      const child = spawn('/system/bin/sh', ['-c', cmd], { cwd: homeDir() });
      let out = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } resolve(out); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', () => { clearTimeout(timer); resolve(out); });
      child.on('error', () => { clearTimeout(timer); resolve(out + '\n[spawn-error]'); });
    } catch (err) { resolve('[throw] ' + describeError(err)); }
  });
  try {
    // ① SELinux 判定：/dev/ptmx open
    try {
      const fd = fs.openSync('/dev/ptmx', 'r+');
      fs.closeSync(fd);
      push('ptmx-open', { name: 'ptmx-open', ok: true, detail: '/dev/ptmx open 成功（应用域 SELinux 放行；dsh 口径成立）' });
    } catch (err) {
      push('ptmx-open', { name: 'ptmx-open', ok: false, detail: `/dev/ptmx open 失败：${err.code || err.message}（ark 更严口径成立）` });
    }
    // ② devpts 挂载 + /dev/pts 枚举
    {
      const mounts = await sh('grep devpts /proc/mounts || echo NO_DEVPTS');
      const pts = await sh('ls /dev/pts 2>&1 || echo LS_FAIL');
      push('devpts', { name: 'devpts', ok: mounts.includes('devpts') && !pts.includes('LS_FAIL'), detail: `mounts=${mounts.trim().slice(0, 120)} | /dev/pts=${pts.trim().slice(0, 80)}` });
    }
    // ③ slave 盲试（无 ioctl/unlockpt 的 JS 限制：unlock 缺失 ⇒ 预期 EIO；意外可开 ⇒ 升级结论）
    {
      let slave = null;
      const errs = [];
      for (let n = 0; n <= 5; n += 1) {
        try {
          const sfd = fs.openSync(`/dev/pts/${n}`, 'r+');
          fs.closeSync(sfd);
          slave = `/dev/pts/${n}`;
          break;
        } catch (err) { errs.push(`${n}:${err.code}`); }
      }
      push('slave-open', { name: 'slave-open', ok: slave !== null, detail: slave ? `slave 可开：${slave}（纯 JS PTY 路线成立）` : `0..5 全失败（${errs.join(' ')}；无 ioctl unlockpt 的预期限制）` });
    }
    // ④ toybox script 桥
    {
      const w = await sh('command -v script && echo HAS_SCRIPT || echo NO_SCRIPT');
      push('toybox-script', { name: 'toybox-script', ok: w.includes('HAS_SCRIPT'), detail: w.trim().slice(0, 120) || '(空)' });
    }
    // ⑤ stty
    {
      const w = await sh('command -v stty && echo HAS_STTY || echo NO_STTY');
      push('stty', { name: 'stty', ok: w.includes('HAS_STTY'), detail: w.trim().slice(0, 80) });
    }
    report.summary = {
      total: report.results.length,
      pass: report.results.filter((r) => r.ok === true).length,
      fail: report.results.filter((r) => r.ok === false).length,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    report.summary = { error: describeError(err), elapsedMs: Date.now() - started };
  }
  writeSelftestReport('pi-web.pty-selftest.json', report);
  log(`O6 PTY 探针：pass=${report.summary.pass} fail=${report.summary.fail}（${report.summary.elapsedMs}ms），报告 pi-web.pty-selftest.json`);
  return report;
}

// ── 路线 A 原生件装载探针（Phase 4；node-pty android-arm64 自建产物的决定性验证）────────
/**
 * 测：vendored pty.node（NDK r28c 交叉编译，sha256 锁）能否在本进程内
 *   ① require 装载（ABI/NODE_MODULE_VERSION 对齐判定）；
 *   ② node-pty.spawn → forkpty（ioctl unlockpt/TIOCSCTTY —— O6 纯 JS 缺口由原生件补上）
 *      → exec /system/bin/sh → pty 回显 PTY_ROUNDTRIP_OK。
 * 任何失败（ABI/符号/SELinux/fork）都结构化落盘 —— 这就是路线 A 的 Go/No-Go 证据。
 */
async function runPtyNodeSelftest() {
  if (process.env.PI_ANDROID_SELFTEST !== '1') return null;
  const started = Date.now();
  const report = { at: new Date().toISOString(), suite: '路线 A：pty.node 装载 + 真 PTY 回程（node-pty@1.1.0 自建）', results: [], summary: null };
  const push = (r) => { report.results.push(r); log(`[ptynode-selftest] ${r.step} ok=${r.ok}${r.detail ? ' :: ' + String(r.detail).slice(0, 250) : ''}`); };
  try {
    const agentDir = selftestAgentDir();
    const vendor = path.join(agentDir, 'extensions', 'android-pty', 'vendor', 'node-pty');
    if (!fs.existsSync(path.join(vendor, 'build', 'Release', 'pty.node'))) {
      push({ step: 'vendor-present', ok: false, detail: 'vendored pty.node 缺失：' + vendor });
      report.summary = { total: 1, ok: 0, failed: 1, elapsedMs: Date.now() - started };
      writeSelftestReport('pi-web.ptynode-selftest.json', report);
      return report;
    }
    push({ step: 'vendor-present', ok: true, detail: vendor });
    const { createRequire } = require('node:module');
    const Module = require('node:module');
    const req = createRequire(path.join(vendor, 'package.json'));
    const dataNode = path.join(vendor, 'build', 'Release', 'pty.node');
    let pty = null;
    // 路线 1（诊断保留）：数据目录直接 require —— targetSdk≥29 SELinux 预期拒（G3 线）
    try {
      req(dataNode);
      pty = req(vendor);
      push({ step: 'require-ptynode', ok: true, detail: '数据目录直接 require 成功（该环境未强制 W^X）' });
    } catch (directErr) {
      push({ step: 'require-ptynode', ok: false, detail: '数据目录 require 失败（预期内）：' + describeError(directErr).slice(0, 140) });
      // 路线 2（G3 合规执行位）：libpty_node.so 在 nativeLibraryDir（随 APK），process.dlopen
      // 装载后把 exports 种进 require 缓存 ⇒ node-pty 的 loadNativeModule 直接命中缓存
      const libDir = process.env.PI_ANDROID_NATIVE_LIB_DIR || '';
      if (!libDir) {
        push({ step: 'dlopen-native-lib-dir', ok: false, detail: 'PI_ANDROID_NATIVE_LIB_DIR 未注入（Kotlin 宿主未升级？）' });
        report.summary = { total: 3, ok: 1, failed: 2, elapsedMs: Date.now() - started };
        writeSelftestReport('pi-web.ptynode-selftest.json', report);
        return report;
      }
      try {
        // 未压缩 libs 时代 nativeLibraryDir 是空壳，真身在 APK 内 ⇒ 先试实体路径，失败回落 soname
        // （soname 解析走应用 linker namespace，与 libnode.so 同目录族）
        const soPath = fs.existsSync(path.join(libDir, 'libpty_node.so'))
          ? path.join(libDir, 'libpty_node.so')
          : 'libpty_node.so';
        const m = new Module(dataNode);
        m.filename = dataNode;
        m.paths = Module._nodeModulePaths(path.dirname(dataNode));
        process.dlopen(m, soPath);
        req.cache[req.resolve(dataNode)] = m;
        pty = req(vendor);
        push({ step: 'dlopen-native-lib-dir', ok: true, detail: 'nativeLibraryDir dlopen + 缓存种子成功（' + soPath.slice(-40) + '）' });
      } catch (err2) {
        push({ step: 'dlopen-native-lib-dir', ok: false, detail: describeError(err2) });
        report.summary = { total: 3, ok: 1, failed: 2, elapsedMs: Date.now() - started };
        writeSelftestReport('pi-web.ptynode-selftest.json', report);
        return report;
      }
    }
    const roundtrip = await new Promise((resolve) => {
      let out = '';
      let term;
      try {
        term = pty.spawn('/system/bin/sh', ['-c', 'echo PTY_ROUNDTRIP_OK; id; tty'], {
          name: 'xterm-color',
          cwd: homeDir(),
          env: process.env,
        });
      } catch (err) {
        resolve({ out: '', error: 'spawn 抛错：' + describeError(err) });
        return;
      }
      const timer = setTimeout(() => {
        try { term.kill(); } catch { /* 已退 */ }
        resolve({ out, timedOut: true });
      }, 15_000);
      term.onData((data) => {
        out += data;
        if (out.includes('PTY_ROUNDTRIP_OK')) {
          clearTimeout(timer);
          setTimeout(() => { try { term.kill(); } catch { /* 已退 */ } resolve({ out, timedOut: false }); }, 400);
        }
      });
    });
    const ok = !roundtrip.error && roundtrip.out.includes('PTY_ROUNDTRIP_OK');
    push({
      step: 'pty-roundtrip', ok,
      detail: roundtrip.error ? roundtrip.error
        : (ok ? `回显命中（${roundtrip.timedOut ? 'kill 后' : '正常'}）输出前 160 字：` + roundtrip.out.replace(/\s+/g, ' ').slice(0, 160)
             : '未捕获回显（timedOut=' + !!roundtrip.timedOut + '）输出：' + roundtrip.out.replace(/\s+/g, ' ').slice(0, 160)),
    });
    report.summary = {
      total: report.results.length,
      ok: report.results.filter((r) => r.ok).length,
      failed: report.results.filter((r) => !r.ok).length,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    report.summary = { error: describeError(err), elapsedMs: Date.now() - started };
  }
  writeSelftestReport('pi-web.ptynode-selftest.json', report);
  log(`路线 A pty.node 探针：${report.summary.ok}/${report.summary.total} 通过（${report.summary.elapsedMs}ms），报告 pi-web.ptynode-selftest.json`);
  return report;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  log(`启动：node=${process.version} pid=${process.pid} cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(0, 3))}`);
  log(`平台事实：platform=${process.platform} arch=${process.arch} execPath=${process.execPath}`
    + `（execPath 只用于日志，绝不参与任何重启逻辑）`);

  /*
   * 108-jitless：**纯 JS 兼容层必须在这里装**（任何 Next 代码被 require 之前）。
   *
   * 为什么顺序是承重的：无 ACL 时 V8 以 `--jitless` 运行 ⇒ `WebAssembly` 不存在 ⇒
   *   ① `node:http` 的惰性 undici getter 一旦被读到，就会实例化 WASM 版 llhttp 并抛错；
   *   ② Next 启动期会用 SWC 转译 `next.config.ts`（载荷里 SWC 只有 WASM 版）；
   *   ③ `undici.install()`（Next instrumentation 与 pi SDK 都会调）会把 `globalThis.fetch`
   *      换成 WASM 版实现。
   * 兼容层只做"WASM 不存在时"的三件事（封印 getter / 纯 JS fetch 垫片 / 事实入日志），
   * WASM 可用时**一个动作都不做**（有 ACL 的设备行为不变）。
   * 入口签名与三态日志见 `payload/jitless/index.js`；策略与取证见 `docs/108-jitless-方案决策.md`。
   */
  let jitless = { active: false };
  try {
    jitless = require('./jitless').installIfNeeded((line) => log(line));
  } catch (err) {
    // 装不上也要继续：随后的真实失败（Next 起不来 / fetch 抛错）会给出更准确的现场
    logError(`jitless 兼容层安装失败（继续启动，等真实错误暴露）：${describeError(err)}`);
  }
  log(`jitless 兼容层：active=${jitless.active === true}`
    + `（WebAssembly=${typeof WebAssembly}；active=false 表示有 JIT 可用、按现役形态运行）`);

  const entryHint = process.env.NODE_BRIDGE_ENTRY || '';
  const payloadRoot = resolvePayloadRoot(entryHint);

  // 111-pty-integration：把载荷的 node_modules 加入 NODE_PATH，使**任意** `require("node-pty")`
  // （包括从 <agentDir>/extensions 物化加载的 android-pty 扩展）都回落到 启动期 ensurePtyNative
  // 种子过的**同一副本**（payload/node_modules/node-pty，require.cache 命中 dlopen 的 libpty_node.so）。
  // 背景：SDK 从物化目录加载扩展，其 createRequire(import.meta.url) 只沿 <agentDir> 向上解析，
  // 够不着 payload/node_modules（分离树）⇒ `require("node-pty")` MODULE_NOT_FOUND。
  // （终端面 terminal-manager 本就在 payload 树内，不受影响。）
  try {
    const payloadNodeModules = path.join(payloadRoot, 'node_modules');
    // 绝对路径 env：android-pty 扩展（从 <agentDir>/extensions 物化加载，与载荷分离树）
    // 直接 require 该绝对包路径，绕开一切模块解析歧义（NODE_PATH 对 jiti 转译的 ESM 扩展不可靠），
    // 且命中启动期 ensurePtyNative 种子过的**同一节点**（node-pty 内部 require build/Release/pty.node
    // 会解析回被种子 absolute nativePath，命中 dlopen 的 libpty_node.so）。
    process.env.PI_PTY_PKG_ABS = path.join(payloadNodeModules, 'node-pty');
    process.env.NODE_PATH = process.env.NODE_PATH
      ? process.env.NODE_PATH + path.delimiter + payloadNodeModules
      : payloadNodeModules;
    require('node:module').Module._initPaths(); // 让当前进程立即采用新的 NODE_PATH
  } catch (err) {
    logWarn(`NODE_PATH/PI_PTY_PKG_ABS 注入失败（继续启动，android-pty 扩展可能因找不到 node-pty 而不可用）：${describeError(err)}`);
  }

  // 应用语义环境（唯一事实源：./env.js）。库负责 HOME/TMPDIR/NODE_ENV/NODE_OPTIONS，
  // 这里**只补应用语义**，并把最终值写进日志（错了才查得动）。
  const desired = envContract.buildEnv(process.env, { route: 'loopback', warn: (msg) => logWarn(msg) });
  for (const key of Object.keys(desired)) process.env[key] = desired[key];
  log(`环境契约（来自 payload/env.js）：\n  ${envContract.formatReport(desired)}`);

  // `process.cwd() = /`（真机实测）：载荷里所有 `resolve(cwd,'package.json')` 类约定都要求
  // cwd 落在载荷目录。库的 bootstrap 会按 NODE_BRIDGE_CWD chdir；这里做**幂等兜底**。
  const desiredCwd = process.env.NODE_BRIDGE_CWD && process.env.NODE_BRIDGE_CWD.length > 0
    ? process.env.NODE_BRIDGE_CWD
    : payloadRoot;
  try {
    if (process.cwd() !== desiredCwd) {
      process.chdir(desiredCwd);
      log(`cwd 已切到载荷根：${desiredCwd}`);
    }
  } catch (err) {
    logError(`chdir(${desiredCwd}) 失败：${describeError(err)}（继续用绝对路径，不静默依赖相对路径）`);
  }

  rotatePreviewSecrets(payloadRoot);
  cleanupLegacyExtensions();
  materializeAgentResources(payloadRoot);

  // PTY 常驻加载器（111-pty-integration）：在 pi-web server boot 之前 dlopen libpty_node.so
  // （nativeLibraryDir）并种子 require.cache（node-pty 的 build/Release/pty.node 绝对路径），使
  // lib/terminal-manager.ts#require("node-pty") 命中。失败结构化上报，不阻断启动（boot-facts pty.ready=false）。
  ptyNative = ensurePtyNative(payloadRoot);
  // terminal-capability.ts（Next 路由，同一进程）经 globalThis 读真装载结果（宪法 A6）
  globalThis.__piWebPty = ptyNative;

  // 112：五 CLI 探针**延迟**到 Next 就绪后非阻塞执行（不在 boot 关键路径 await）。
  // 平台时机约束（2026-11-05 实测）：app_process 内嵌 Node 在 Next 引导前的早期事件循环上，
  // child_process 的 stdin 写入/setInterval 轮询不被调度，常驻 sh 哨兵探针会卡死且硬超时也不触发；
  // 而 Next 就绪后事件循环健康（与 android-exec.js 首次工具调用惰性 spawn 的可靠时机一致）。
  // 故 boot-facts 先落 deferred 标记，真实结果就绪后写独立 pi-web.cli-facts.json。
  const cliFacts = { status: 'deferred', detail: 'probe runs after Next ready; see pi-web.cli-facts.json' };
  // 引擎引导事实（P1-3/P1-4）：必须在任何 Next 代码被 require 之前落盘（112 的 cli 块为 deferred 占位）
  writeBootFacts(payloadRoot, jitless, cliFacts);

  const hostname = process.env.PI_WEB_HOSTNAME && process.env.PI_WEB_HOSTNAME.length > 0
    ? process.env.PI_WEB_HOSTNAME
    : '127.0.0.1';
  const preferred = Number.parseInt(process.env.PI_WEB_PORT || '0', 10);
  const port = await resolveFreePort(Number.isFinite(preferred) ? preferred : 0);
  log(`服务端口 = ${port}（${preferred > 0 ? '来自 PI_WEB_PORT' : 'listen(0) 探测得到的空闲端口'}）`);

  // 必须在起服务**之前**设置：pi-web 的 proxy.ts 与 lib/request-security.ts 在**每个请求**时读它们。
  process.env.PI_WEB_HOSTNAME = hostname;
  process.env.PI_WEB_PORT = String(port);
  log(`PI_WEB_HOSTNAME = ${hostname}｜PI_WEB_PASSWORD = `
    + `${process.env.PI_WEB_PASSWORD ? `${process.env.PI_WEB_PASSWORD.length} 字符（不回显）` : '(未设置 ⇒ 免密)'}`);

  registerShutdownHook(payloadRoot);

  // 宿主能力自检（仅 PI_ANDROID_SELFTEST=1；诊断资产，失败不阻断启动）
  await runHostSelftest(payloadRoot);

  // Phase 4 O6 PTY 探针（暂缓项重启评估第一步；只测不改行为）
  await runPtySelftest();

  // Phase 4 路线 A：pty.node 装载 + 真 PTY 回程（决定性 Go/No-Go 证据）
  await runPtyNodeSelftest();

  closer = await startNextInProcess(payloadRoot, hostname, port);
  await waitForReady(hostname, port);
  readyPort = port;
  writeReadyMarker(port, hostname, payloadRoot);
  log(`本进程已就绪：http://${hostname}:${port}/（同源 HTTP + SSE；ArkWeb 侧 loadUrl 目标）`);
  log(`日志读回：ArkTS 诊断面板用 Logger.tail(logPath)，或 hdc fport 后 curl /log（node.log ↔ app.log 双通道）`);

  // 112：Next 就绪后非阻塞跑五 CLI 探针（事件循环已健康，常驻 sh 哨兵模式才可靠）。
  // 不 await、不 reject：探针在后台跑完自行落盘 pi-web.cli-facts.json，绝不影响就绪与主服务。
  setImmediate(() => {
    runCliProbe()
      .then((report) => {
        const out = path.join(homeDir(), 'payload', 'pi-web.cli-facts.json');
        try {
          const tmp = `${out}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
          fs.renameSync(tmp, out);
          log(`CLI 探针结果已落盘：${out}（${report.summary ? report.summary.ok + '/' + report.summary.total : 'n/a'} 可用）`);
        } catch (err) {
          logWarn(`CLI 探针结果落盘失败（诊断资产，不影响主链路）：${describeError(err)}`);
        }
      })
      .catch((err) => logWarn(`CLI 探针后台异常（不阻断）：${describeError(err)}`));
  });
}
main().catch((err) => {
  // 顶层失败：**刻意不 process.exit**（契约 §3.3 FR-004-033 的取舍）——
  // 让库的崩溃记录与 /log 读回通道都还有机会被读到（谁写谁读）。
  const detail = describeError(err);
  logError(`FATAL 载荷引导失败：${detail}`);
  if (err && err.stack) logError(err.stack);
  logError(`诊断：载荷根存在=${fs.existsSync(path.join(__dirname, 'package.json'))}`
    + ` node=${process.version} platform=${process.platform} arch=${process.arch}`
    + ` home=${homeDir()} tmpdir=${os.tmpdir()} log=${appLogPath()}`);
});
