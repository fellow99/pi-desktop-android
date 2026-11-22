/**
 * sync-runtime.js — 进程内中枢服务同步运行时（pi-desktop-ark / pi-desktop-android / pi-desktop-hos 共用）。
 *
 * 为什么不是子进程：
 *   - ark / android 的应用内 Node 没有可用的 fork/exec 链路；
 *   - hos 的 fork+exec Node 脚本会触发 L1 seccomp（Signal 31 SIGSYS），子进程 exit/close 也不可靠。
 *
 * 形态：
 *   - 复用上游 `@pi-agent-hub/sync-daemon` 的 Daemon（hub 客户端 / 调度 / SSE / 下发 / 串行化）；
 *   - 用 `InProcessPluginManager` 替换 Daemon 的 PluginManager：直接 import `PiWebPlugin` 并按方法表调用，
 *     不 spawn、不用 stdio/JSON-RPC；
 *   - **不调用** `daemon.start()`：上游会在其中安装 `uncaughtException/unhandledRejection → process.exit(1)`
 *     的全局崩溃钩子，嵌入形态会杀掉整个 App。这里使用等价的嵌入式启动序列。
 *   - 自带控制面（127.0.0.1 + Bearer + control.json），供 pi-web 的 `/api/sync-daemon` route 代理；
 *     设置 UI 因此只走同源 HTTP，令牌不下发页面。
 *
 * 配置：<HOME>/.pi-desktop/sync-daemon.json（SyncDaemonConfig + enabled，与桌面版同构）
 * 控制：<HOME>/.pi-desktop/sync-daemon/control.json = { port, token }
 * 日志：<HOME>/.pi-desktop/sync-daemon/logs/sync-runtime.log
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// 路径必须**延迟解析**：三端的环境装配（HOME）发生在本模块加载之后；
// 在 require 时缓存 os.homedir() 会指向宿主默认目录，导致配置写到错误位置。
function homeDir() {
  return os.homedir();
}
function configPath() {
  return path.join(homeDir(), '.pi-desktop', 'sync-daemon.json');
}
function stateDir() {
  return path.join(homeDir(), '.pi-desktop', 'sync-daemon');
}
function controlPath() {
  return path.join(stateDir(), 'control.json');
}
function logPath() {
  return path.join(stateDir(), 'logs', 'sync-runtime.log');
}
function pluginRoot() {
  return stateDir();
}
const DEFAULT_HOST_NAME = os.hostname() || 'pi-device';
const SYNC_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 2_500;

/** @type {{ state: string, reason?: string }} */
let status = { state: 'disabled' };
/** @type {{ enabled: boolean, hubUrl: string, hostName: string, hubToken: string } | null} */
let settings = null;
let ctx = null; // { piDistRoot, serverUrl, agentDir, password? }
let daemon = null;
let pollTimer = null;
let controlServer = null;
let started = false;
let queue = Promise.resolve();

function stamp() {
  return new Date().toISOString();
}

function log(level, message, detail) {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  const line = `${stamp()} ${level} ${message}${suffix}`;
  console.log(`[sync-runtime] ${message}${suffix}`);
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主链路 */
  }
}

function describeError(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function setStatus(next, reason) {
  const changed = status.state !== next || status.reason !== reason;
  status = reason ? { state: next, reason } : { state: next };
  if (changed) log('info', '状态 → ' + next + (reason ? `（${reason}）` : ''));
}

function defaultSettings() {
  return { enabled: false, hubUrl: '', hostName: DEFAULT_HOST_NAME, hubToken: '' };
}

function settingsFromFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hub = raw.hub;
  const host = raw.host;
  if (!hub || typeof hub.url !== 'string' || typeof hub.token !== 'string') return null;
  if (!host || typeof host.name !== 'string') return null;
  return {
    enabled: raw.enabled === true,
    hubUrl: hub.url,
    hostName: host.name,
    hubToken: hub.token,
  };
}

async function readConfig() {
  try {
    const text = await fsp.readFile(configPath(), 'utf8');
    const raw = JSON.parse(text);
    const parsed = settingsFromFile(raw);
    if (!parsed) {
      log('warn', '配置文件缺少 hub.url/hub.token 或 host.name，按缺失处理');
      return null;
    }
    return { settings: parsed, raw };
  } catch (error) {
    if (error && error.code !== 'ENOENT') log('warn', `读取配置失败（按缺失处理）：${String(error)}`);
    return null;
  }
}

function validateSettings(input) {
  if (!input || typeof input !== 'object') return '设置数据格式不正确，请重试';
  if (typeof input.enabled !== 'boolean') return '设置数据格式不正确，请重试';
  if (typeof input.hubUrl !== 'string' || typeof input.hostName !== 'string' || typeof input.hubToken !== 'string') {
    return '设置数据格式不正确，请重试';
  }
  if (!input.enabled) return null;
  const hubUrl = input.hubUrl.trim();
  if (!hubUrl) return '中枢服务地址不能为空';
  let parsed;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return '中枢服务地址不是合法 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '中枢服务地址必须是 http(s) URL';
  if (!input.hostName.trim()) return '本端名称不能为空';
  if (!input.hubToken.trim()) return '本端令牌不能为空';
  return null;
}

function normalizeSettings(input) {
  return {
    enabled: input.enabled === true,
    hubUrl: String(input.hubUrl).trim(),
    hostName: String(input.hostName).trim(),
    hubToken: String(input.hubToken).trim(),
  };
}

function toFileConfig(input) {
  return {
    enabled: input.enabled === true,
    hub: { url: input.hubUrl, token: input.hubToken },
    host: { name: input.hostName },
    plugins: ['@pi-agent-hub/sync-plugin-pi-web'],
    pluginRoot: pluginRoot(),
    pluginInstall: false,
    pluginAllowlist: ['@pi-agent-hub/*'],
    agents: {
      'pi-web': {
        instances: [{ name: 'default' }],
        options: {
          server: ctx ? ctx.serverUrl : '',
          agentDir: ctx ? ctx.agentDir : '',
          ...(ctx && ctx.password ? { password: ctx.password } : {}),
        },
      },
    },
  };
}

async function writeConfig(next) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${configPath()}.tmp-${process.pid}`;
  const text = `${JSON.stringify(toFileConfig(next), null, 2)}\n`;
  await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await fsp.chmod(tmp, 0o600);
  } catch {
    /* Windows/部分沙箱不支持 chmod：文件系统 ACL 兜底 */
  }
  await fsp.rename(tmp, configPath());
}

async function loadPackages(piDistRoot) {
  const scope = path.join(piDistRoot, 'node_modules', '@pi-agent-hub');
  const daemonDir = path.join(scope, 'sync-daemon', 'dist');
  const pluginDir = path.join(scope, 'sync-plugin-pi-web', 'dist');
  const daemonEntry = path.join(daemonDir, 'daemon.js');
  const pluginEntry = path.join(pluginDir, 'plugin.js');
  if (!fs.existsSync(daemonEntry)) throw new Error(`缺少 sync-daemon：${daemonEntry}`);
  if (!fs.existsSync(pluginEntry)) throw new Error(`缺少 sync-plugin-pi-web：${pluginEntry}`);
  const daemonMod = await import(pathToFileURL(daemonEntry).href);
  const managerMod = await import(pathToFileURL(path.join(daemonDir, 'plugin-manager.js')).href);
  const executorMod = await import(pathToFileURL(path.join(daemonDir, 'deliver-executor.js')).href);
  const pluginMod = await import(pathToFileURL(pluginEntry).href);
  if (typeof daemonMod.Daemon !== 'function') throw new Error('sync-daemon 未导出 Daemon');
  if (typeof managerMod.PluginManager !== 'function' || typeof managerMod.stableAgentId !== 'function') {
    throw new Error('sync-daemon/plugin-manager 导出不符合预期');
  }
  if (typeof executorMod.DeliverExecutor !== 'function') throw new Error('sync-daemon 未导出 DeliverExecutor');
  if (typeof pluginMod.PiWebPlugin !== 'function') throw new Error('sync-plugin-pi-web 未导出 PiWebPlugin');
  return {
    Daemon: daemonMod.Daemon,
    PluginManager: managerMod.PluginManager,
    stableAgentId: managerMod.stableAgentId,
    DeliverExecutor: executorMod.DeliverExecutor,
    PiWebPlugin: pluginMod.PiWebPlugin,
  };
}

function readDaemonVersion(piDistRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(piDistRoot, 'node_modules', '@pi-agent-hub', 'sync-daemon', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 进程内插件客户端：与 `sync-plugin-pi-web/dist/main.js` 的方法表一一对应。
 * `request()` 的签名与上游 RpcClient 一致，Daemon/Executor 无需感知传输差异。
 */
class InProcessClient {
  constructor(plugin, initParams, onLog, label) {
    this.plugin = plugin;
    this.initParams = initParams;
    this.onLog = onLog;
    this.label = label;
    this.closed = false;
    this.initialized = false;
    this.handlers = {
      detect: () => this.plugin.detect(),
      list_sessions: () => this.plugin.listSessions(),
      read_session: (params) => this.plugin.readSession(params || {}),
      deliver: (params) => this.plugin.deliver(params || {}),
      get_model_info: (params) => this.plugin.getModelInfo(params || {}),
      check_idle: (params) => this.plugin.checkIdle(params || {}),
      import_session: (params) => this.plugin.importSession(params || {}),
      export_native: (params) => this.plugin.exportNative(params || {}),
      ping: () => ({ pong: true, uptimeMs: Math.round(process.uptime() * 1000) }),
      shutdown: () => ({}),
    };
  }

  async start() {
    await withTimeout(this.plugin.initialize(this.initParams), 20_000, `${this.label}:initialize`);
    this.initialized = true;
  }

  async request(method, params, timeoutMs = 30_000) {
    if (this.closed) throw new Error('plugin client closed');
    if (method === 'initialize') return this.initParams;
    const handler = this.handlers[method];
    if (!handler) throw new Error(`method not found: ${method}`);
    return withTimeout(handler(params || {}), timeoutMs, `${this.label}:${method}`);
  }

  async close() {
    this.closed = true;
  }
}

class InProcessPluginManager {
  constructor(options, deps) {
    this.options = options;
    this.deps = deps;
    this.runtimes = [];
    this.upstream = new deps.PluginManager(options);
  }

  async start(specs) {
    for (const raw of specs) {
      const spec = typeof raw === 'string' ? { package: raw } : raw;
      const resolved = await this.upstream.resolve(spec);
      if (resolved.metadata.kind !== 'pi-web') {
        throw new Error(`嵌入形态仅支持 pi-web 插件，收到：${resolved.metadata.kind}`);
      }
      const instance = this.options.agents[resolved.metadata.kind]?.instances?.[0] ?? { name: 'default' };
      const agentId = this.deps.stableAgentId(this.options.hostId, resolved.metadata.kind, instance.name);
      const initParams = {
        protocolVersion: '1.0',
        daemonVersion: this.deps.daemonVersion,
        hostId: this.options.hostId,
        agentId,
        kind: resolved.metadata.kind,
        workDir: path.join(this.options.pluginRoot, '.work', resolved.metadata.kind),
        config: {
          options: { ...(this.options.agents[resolved.metadata.kind]?.options || {}), ...(spec.options || {}) },
          instance,
        },
      };
      const plugin = new this.deps.PiWebPlugin();
      const client = new InProcessClient(plugin, initParams, (line) => {
        void this.options.logger.info(`[${resolved.metadata.kind}] ${line}`);
      }, resolved.metadata.kind);
      await client.start();
      const detected = await client.request('detect', {}, 20_000);
      const detectedInstance = (detected.instances && detected.instances[0]) || {
        instanceId: agentId,
        displayName: instance.name,
        homeDir: '',
      };
      this.runtimes.push({
        agentId,
        kind: resolved.metadata.kind,
        instanceId: detectedInstance.instanceId,
        displayName: detectedInstance.displayName,
        homeDir: detectedInstance.homeDir,
        plugin: resolved,
        client,
        capabilities: resolved.metadata.capabilities,
      });
      await this.options.logger.info('plugin ready', { kind: resolved.metadata.kind, version: resolved.version });
    }
  }

  list() {
    return this.runtimes;
  }

  async stop() {
    await Promise.allSettled(this.runtimes.map((runtime) => runtime.client.close()));
    this.runtimes = [];
  }
}

async function startDaemon(config, piDistRoot) {
  const pkgs = await loadPackages(piDistRoot);
  const daemonConfig = config;
  const instance = new pkgs.Daemon(daemonConfig);
  const manager = new InProcessPluginManager(instance.manager.options, {
    PluginManager: pkgs.PluginManager,
    stableAgentId: pkgs.stableAgentId,
    PiWebPlugin: pkgs.PiWebPlugin,
    daemonVersion: readDaemonVersion(piDistRoot),
  });
  const executor = new pkgs.DeliverExecutor({
    hub: instance.hub,
    manager,
    logger: instance.logger,
    workDir: pluginRoot(),
    stateDir: pluginRoot(),
  });
  instance.manager = manager;
  instance.executor = executor;

  // 嵌入式启动序列（等价于上游 Daemon.start，但跳过 installCrashHandlers 与控制服务器）。
  await instance.logger.init();
  await manager.start(daemonConfig.plugins);
  await executor.init();
  instance.controlState = { paused: false };
  void instance.runEvents();
  void instance.syncAll().catch((error) => instance.logger.error('initial sync failed', { error: String(error) }));
  const timer = setInterval(() => {
    if (!instance.controlState?.paused) {
      void instance.syncAll().catch((error) => instance.logger.error('scheduled sync failed', { error: String(error) }));
    }
  }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return { daemon: instance, timer };
}

async function stopDaemon() {
  const current = daemon;
  daemon = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!current) return;
  try {
    await current.stop();
  } catch (error) {
    log('warn', `停止同步运行时失败：${String(error)}`);
  }
}

async function startRuntimeInternal() {
  if (!ctx) return;
  const loaded = await readConfig();
  settings = loaded ? loaded.settings : defaultSettings();
  if (!settings.enabled) {
    setStatus('disabled');
    return;
  }
  setStatus('starting');
  try {
    const startedDaemon = await startDaemon(toFileConfig(settings), ctx.piDistRoot);
    daemon = startedDaemon.daemon;
    pollTimer = startedDaemon.timer;
    setStatus('running');
  } catch (error) {
    log('error', `同步运行时启动失败：${describeError(error)}`);
    setStatus('stopped', String(error instanceof Error ? error.message : error));
  }
}

function enqueue(task) {
  queue = queue.then(task, task);
  return queue;
}

async function applyInternal(nextSettings) {
  const validationError = validateSettings(nextSettings);
  if (validationError) throw new Error(validationError);
  const normalized = normalizeSettings(nextSettings);
  await writeConfig(normalized);
  settings = normalized;
  await stopDaemon();
  if (normalized.enabled) {
    setStatus('starting');
    try {
      const startedDaemon = await startDaemon(toFileConfig(normalized), ctx.piDistRoot);
      daemon = startedDaemon.daemon;
      pollTimer = startedDaemon.timer;
      setStatus('running');
    } catch (error) {
      log('error', `应用后启动失败：${describeError(error)}`);
      setStatus('stopped', String(error instanceof Error ? error.message : error));
    }
  } else {
    setStatus('disabled');
  }
  return { settings, status };
}

function snapshot() {
  return { settings: settings || defaultSettings(), status };
}

function startControlServer() {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end('unauthorized');
        return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const json = (code, value) => {
        response.writeHead(code, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'GET' && url.pathname === '/local/status') {
        json(200, snapshot());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/local/apply') {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json(400, { error: '设置数据格式不正确，请重试' });
            return;
          }
          void enqueue(() => applyInternal(body))
            .then((result) => json(200, { ok: true, ...result }))
            .catch((error) => json(400, { error: error instanceof Error ? error.message : String(error) }));
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/local/quit') {
        void enqueue(async () => {
          await stopDaemon();
          setStatus('disabled');
        }).then(() => json(200, { ok: true }));
        return;
      }
      response.writeHead(404).end('not found');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      void fsp.mkdir(path.dirname(controlPath()), { recursive: true })
        .then(() => fsp.writeFile(controlPath(), `${JSON.stringify({ port, token })}\n`, { encoding: 'utf8', mode: 0o600 }))
        .then(() => {
          controlServer = server;
          log('info', `控制面已就绪（127.0.0.1:${port}）`);
          resolve();
        })
        .catch(reject);
    });
  });
}

async function startSyncRuntime(options) {
  if (started) {
    ctx = { ...ctx, ...options };
    return snapshot();
  }
  started = true;
  ctx = {
    piDistRoot: options.piDistRoot,
    serverUrl: options.serverUrl,
    agentDir: options.agentDir,
    password: options.password || undefined,
  };
  await fsp.mkdir(path.dirname(logPath()), { recursive: true });
  log('info', `同步运行时启动：piDist=${ctx.piDistRoot}｜server=${ctx.serverUrl}｜agentDir=${ctx.agentDir}`);
  try {
    await startControlServer();
  } catch (error) {
    log('error', `控制面启动失败：${describeError(error)}`);
  }
  void enqueue(() => startRuntimeInternal()).catch((error) => {
    log('error', `同步运行时初始化失败：${describeError(error)}`);
    setStatus('stopped', String(error instanceof Error ? error.message : error));
  });
  return snapshot();
}

async function stopSyncRuntime() {
  if (!started) return;
  started = false;
  await enqueue(async () => {
    await stopDaemon();
    if (controlServer) {
      try {
        await new Promise((resolve) => controlServer.close(() => resolve()));
      } catch {
        /* 忽略关闭错误 */
      }
      controlServer = null;
    }
    try {
      await fsp.rm(controlPath(), { force: true });
    } catch {
      /* 忽略 */
    }
    setStatus('disabled');
  });
}

function getSyncRuntimeSnapshot() {
  return snapshot();
}

module.exports = {
  startSyncRuntime,
  stopSyncRuntime,
  getSyncRuntimeSnapshot,
  POLL_INTERVAL_MS,
};
