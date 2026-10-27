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
  materializeAgentResources(payloadRoot);

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

  closer = await startNextInProcess(payloadRoot, hostname, port);
  await waitForReady(hostname, port);
  readyPort = port;
  writeReadyMarker(port, hostname, payloadRoot);
  log(`本进程已就绪：http://${hostname}:${port}/（同源 HTTP + SSE；ArkWeb 侧 loadUrl 目标）`);
  log(`日志读回：ArkTS 诊断面板用 Logger.tail(logPath)，或 hdc fport 后 curl /log（node.log ↔ app.log 双通道）`);
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
