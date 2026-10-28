/**
 * url.js — git 远端 URL 解析与规整（凭据键、ssh→https 改写、host 提取）。
 *
 * isomorphic-git 没有 SSH 客户端（git@host:path / ssh:// 只能转 https），见设计 §3 F2。
 */

/** 解析远端 URL 为 { protocol, host, path }。支持 http(s)://、git@host:path、ssh://。 */
export function parseGitUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('git url is required');
  const u = url.trim();
  // scp 风格：git@host:path 或 user@host:path
  const scp = /^([^@/:]+)@([^:/]+):(.+)$/.exec(u);
  if (scp) {
    return { protocol: 'ssh', host: scp[2].toLowerCase(), path: scp[3], original: u };
  }
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`无法解析 git 远端 URL：${u}`);
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.host.toLowerCase(); // 含端口
  const path = parsed.pathname.replace(/^\//, '');
  return { protocol, host, path, original: u };
}

/** ssh / git@ / ssh:// 一律转 https（isomorphic-git 只支持 http(s)）。返回 { url, rewritten }。 */
export function toHttpsUrl(url) {
  const p = parseGitUrl(url);
  if (p.protocol === 'http' || p.protocol === 'https') {
    return { url: `${p.protocol}://${p.host}/${p.path}`, rewritten: false };
  }
  // ssh/git → https（丢弃用户名，见设计 F2/L2）
  return { url: `https://${p.host}/${p.path}`, rewritten: true };
}

/**
 * 凭据键规整（用于 git_credentials list 展示/匹配的人类可读键）：
 * `host[:port]` 大写化、非字母数字 → `_`。
 * 例：git.example.com:8443 → GIT_EXAMPLE_COM_8443
 */
export function normalizeHostKey(url) {
  const { host } = parseGitUrl(url);
  return host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** 取出协议+host（脱敏展示用，不含任何 userinfo/path）。 */
export function safeOriginLabel(url) {
  const { protocol, host } = parseGitUrl(url);
  return `${protocol}://${host}`;
}
