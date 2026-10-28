/**
 * env.js —— **应用语义环境变量**的唯一事实源（CommonJS；由 `pi-web-launch.js` require）。
 *
 * Android 版（对标 ark 的 payload/env.js，差异均有规划 §7.3 依据）：
 *   · 根清单变量名 = `PI_ANDROID_ROOTS`（Kotlin 侧 `PiDesktopRuntime` 装配）；
 *   · `PI_OFFLINE` **刻意不设**（Android 有 INTERNET 权限，registry/LLM 出网可达），
 *     与 ark 的「设备离线」是刻意差异；需要离线时由设置项显式 `1`；
 *   · 兜底根只含 sandbox（`<filesDir>/workspace`）：Android 共享目录无 POSIX 路径，
 *     文档/下载类根随 Phase 2 SAF 桥接入后再声明；
 *   · 鉴权：路线 ① loopback 免密（规划 §6.1，与 ark 相同）。
 *
 * 纯函数：`buildEnv(base, options)` —— 不读 `process.env`（由调用方传入），不写任何东西。
 * ⚠️ 刻意不设（那是库的活）：HOME / USERPROFILE / TMPDIR / TMP / TEMP / NODE_ENV / NODE_OPTIONS。
 */

'use strict';

const path = require('node:path');

/** 变量名清单（**契约表**）。Kotlin 侧用同一批字面量；改名必须两处同时改。 */
const KEYS = Object.freeze({
  agentDir: 'PI_CODING_AGENT_DIR',
  offline: 'PI_OFFLINE',
  noProxy: 'NO_PROXY',
  noProxyLower: 'no_proxy',
  roots: 'PI_ANDROID_ROOTS',
  /** 单源别名：harmony-git（同步自 pi-desktop-hos，禁侧改）的围栏读 PI_HOS_ROOTS —— 同值别名，
   *  上游统一变量名后移除（规划 §10「单源」适配；android-pnpm 两个名字都认）。 */
  rootsHosAlias: 'PI_HOS_ROOTS',
  skipVersionCheck: 'PI_WEB_SKIP_VERSION_CHECK',
  appName: 'PI_WEB_APP_NAME',
  webHostname: 'PI_WEB_HOSTNAME',
  webPort: 'PI_WEB_PORT',
  webPassword: 'PI_WEB_PASSWORD'
});

/** 数据与扩展根目录名（相对 HOME 上一级 = filesDir） */
const AGENT_DIRNAME = 'pi-agent';
/** 兜底沙箱工作区根目录名（相对 filesDir） */
const SANDBOX_DIRNAME = 'workspace';

/** 取环境值（空串按「未设置」对待） */
function read(base, key) {
  if (base === null || base === undefined) return undefined;
  const value = base[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 拼绝对路径（一律 `/` 分隔） */
function joinPath(...parts) {
  return path.posix.join(...parts.filter((part) => typeof part === 'string' && part.length > 0));
}

/**
 * 代理绕过清单：保留继承值，追加 loopback 与本机地址。
 * 本工程一切请求都是本机同源请求，走代理等于把服务端请求送出去。
 */
function buildNoProxy(base, extra) {
  const current = read(base, KEYS.noProxy) || read(base, KEYS.noProxyLower) || '';
  const items = new Set(
    current
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
  for (const host of ['127.0.0.1', 'localhost', '::1']) items.add(host);
  for (const host of extra) if (typeof host === 'string' && host.length > 0) items.add(host);
  return [...items].join(',');
}

/** 词法「在根之内」判定（相等或以 `根/` 为前缀；带分隔符边界） */
function isInsideRoot(rootPath, targetPath) {
  const root = String(rootPath).replace(/\/+$/, '');
  if (!root) return false;
  return targetPath === root || targetPath.startsWith(`${root}/`);
}

/**
 * Android 的基座一致性检查：HOME 由库注入为 `<filesDir>/node-bridge`，
 * sandbox 兜底根派生自 `path.dirname(HOME)`（= `<filesDir>`）。宿主主路传入的
 * `PI_ANDROID_ROOTS`（外存 workspace）**允许**在 HOME 之外 —— 这是 Android 与 ark
 * 的刻意差异（app-specific 外存是真实 POSIX 路径且免权限，规划 §5 #10），
 * 因此这里只检查「兜底根与 filesDir 同基座」，不做 ark 的 C2 HOME 包含检查。
 */
function sandboxRootOutsideHome(roots, home) {
  const sandbox = roots.find((root) => root && root.id === 'sandbox');
  if (!sandbox) return `缺少 id=sandbox 的根`;
  const sandboxPath = typeof sandbox.path === 'string' ? sandbox.path : '';
  if (!sandboxPath) return `id=sandbox 的 path 为空`;
  const filesDir = path.dirname(home);
  if (!isInsideRoot(filesDir, sandboxPath) && !isInsideRoot(path.dirname(filesDir), sandboxPath)) {
    return `sandbox=${sandboxPath}（既不在 filesDir=${filesDir} 之内，也不在 app-specific 外存之内，请核对宿主装配）`;
  }
  return null;
}

/**
 * 工作区根清单：宿主（Kotlin）已给就原样保留 —— 选择器结果是权威来源。
 * 清单缺失/非法时构造兜底：仅 sandbox（`<filesDir>/workspace`），带 `fallback: true`
 * 机器可读标记（不是用户的选择，必须能被程序分辨）。
 */
function buildRoots(base, home, warn) {
  const inherited = read(base, KEYS.roots);
  if (inherited !== undefined) {
    try {
      const parsed = JSON.parse(inherited);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const outside = sandboxRootOutsideHome(parsed, home);
        if (outside !== null) {
          warn(`${KEYS.roots} 基座一致性存疑：${outside}`);
        }
        return { value: inherited, fallback: false };
      }
      warn(`${KEYS.roots} 不是非空数组，改用沙箱兜底清单`);
    } catch (err) {
      warn(`${KEYS.roots} 不是合法 JSON（${err && err.message}），改用沙箱兜底清单`);
    }
  }
  const filesDir = path.dirname(home);
  const fallbackRoots = [
    { id: 'sandbox', label: '工作区', path: joinPath(filesDir, SANDBOX_DIRNAME), permType: null, fallback: true },
  ];
  return { value: JSON.stringify(fallbackRoots), fallback: true };
}

/**
 * 装配应用语义环境。
 *
 * @param {Record<string, string|undefined>} base 继承来的环境（通常是 `process.env`）
 * @param {{ route?: 'loopback'|'lan', lanIp?: string, warn?: (msg: string) => void }} [options]
 *   Android v1 只实现 `loopback`（路线 ①）；`lan` 与 ark 同口径（必须显式密码 + 具体网卡）。
 * @returns {Record<string, string>} 只含**本工程负责**的变量
 */
function buildEnv(base, options) {
  const opts = options === undefined || options === null ? {} : options;
  const warn = typeof opts.warn === 'function' ? opts.warn : (msg) => console.warn(`[env] ${msg}`);
  const route = opts.route === 'lan' ? 'lan' : 'loopback';
  const source = base === undefined || base === null ? {} : base;

  const home = read(source, 'HOME') || read(source, 'USERPROFILE');
  if (home === undefined) {
    warn('HOME/USERPROFILE 未设置（库应注入）；路径类变量将退化为相对路径，请检查 NodeRuntime.start 的 homeDir');
  }
  const homeRoot = home === undefined ? '.' : home;

  const env = {};
  // Android 刻意**不设** PI_OFFLINE（规划 §7.3）：出网是硬需求（LLM/registry）。
  if (read(source, KEYS.offline) === '1') {
    env[KEYS.offline] = '1'; // 用户显式要求离线时尊重之
  }
  env[KEYS.agentDir] = read(source, KEYS.agentDir) || joinPath(path.dirname(homeRoot), AGENT_DIRNAME);
  env[KEYS.noProxy] = buildNoProxy(source, [opts.lanIp]);
  env[KEYS.noProxyLower] = env[KEYS.noProxy];
  const roots = buildRoots(source, homeRoot, warn);
  env[KEYS.roots] = roots.value;
  env[KEYS.rootsHosAlias] = roots.value; // 单源别名（harmony-git fence 提示用；同值同生命周期）
  if (roots.fallback) {
    warn(`${KEYS.roots} 产自**兜底清单**（不是选择器结果）：带 "fallback": true 机器可读标记`);
  }
  // 品牌化与「不检查更新」（上游开关，零改动）
  env[KEYS.skipVersionCheck] = read(source, KEYS.skipVersionCheck) || '1';
  env[KEYS.appName] = read(source, KEYS.appName) || 'Pi Desktop';

  if (route === 'lan') {
    const password = read(source, KEYS.webPassword);
    if (password === undefined) {
      throw new Error(`${KEYS.webPassword} 缺失：路线 ②（局域网）必须由宿主应用生成强密码后再设置该变量`);
    }
    const inheritedHostname = read(source, KEYS.webHostname);
    if (inheritedHostname !== undefined) {
      env[KEYS.webHostname] = inheritedHostname;
    } else {
      const lanIp = typeof opts.lanIp === 'string' ? opts.lanIp.trim() : '';
      if (lanIp.length === 0 || lanIp === '0.0.0.0') {
        throw new Error(`${KEYS.webHostname} 缺失且 lanIp 不可用：路线 ② 必须给出具体网卡地址；0.0.0.0 已拒绝`);
      }
      env[KEYS.webHostname] = lanIp;
    }
    env[KEYS.webPort] = read(source, KEYS.webPort) || '0';
    env[KEYS.webPassword] = password;
  } else {
    // 路线 ①（首选）：只监听 loopback、不设密码（上游对 loopback 免密已核，ark §6.1 同源）。
    env[KEYS.webHostname] = read(source, KEYS.webHostname) || '127.0.0.1';
    // 端口交给 Node 侧随机取（硬约束 ⑰：固定端口一旦被占 ⇒ EADDRINUSE ⇒ 进程 abort）。
    env[KEYS.webPort] = read(source, KEYS.webPort) || '0';
    const inheritedPassword = read(source, KEYS.webPassword);
    if (inheritedPassword !== undefined) {
      warn(`${KEYS.webPassword} 在 loopback 路线下被显式设置（长度 ${inheritedPassword.length}），将启用密码闸门`);
      env[KEYS.webPassword] = inheritedPassword;
    }
  }
  return env;
}

/** 人读报告（**密码只报长度**） */
function formatReport(env) {
  const password = env[KEYS.webPassword];
  return [
    `${KEYS.agentDir} = ${env[KEYS.agentDir]}`,
    `${KEYS.offline} = ${env[KEYS.offline] === undefined ? '(未设置 ⇒ 出网可用)' : env[KEYS.offline]}`,
    `${KEYS.roots} = ${env[KEYS.roots]}`,
    `${KEYS.noProxy} = ${env[KEYS.noProxy]}`,
    `${KEYS.webHostname} = ${env[KEYS.webHostname]}｜${KEYS.webPort} = ${env[KEYS.webPort]}`,
    `${KEYS.webPassword} = ${password === undefined ? '(未设置 ⇒ 免密)' : `${password.length} 字符（不回显）`}`,
    `${KEYS.appName} = ${env[KEYS.appName]}｜${KEYS.skipVersionCheck} = ${env[KEYS.skipVersionCheck]}`
  ].join('\n  ');
}

module.exports = { KEYS, buildEnv, formatReport, AGENT_DIRNAME, SANDBOX_DIRNAME };
