/**
 * auth.js — 把 git 远端 URL 映射为 isomorphic-git 的 onAuth/onAuthFailure（HTTPS Basic）。
 *
 * 凭据来源：$PI_CODING_AGENT_DIR/.git-credentials（git 原生格式，git-credentials.js）。
 * 明文仅在进程内存流转；缺凭据/被拒给可照抄指引；不抛裸 401、不猜测、不匿名重试；被拒最多重试 1 次。
 */
import { matchCredential, readCredentialsSync, gitCredentialsPath } from './git-credentials.js';
import { toHttpsUrl, normalizeHostKey, safeOriginLabel } from './url.js';

/** 组装 isomorphic-git 的认证回调。返回 { onAuth, onAuthFailure }。 */
export function makeAuth(url) {
  const file = gitCredentialsPath();
  let retries = 0;
  return {
    onAuth: () => {
      const all = readCredentialsSync(file);
      const cred = matchCredential(all, url);
      if (cred) return { username: cred.username, password: cred.password };
      return { cancel: true }; // 未配置：让 isomorphic-git 抛错，由工具层转为指引
    },
    onAuthFailure: () => {
      retries += 1;
      if (retries > 1) return { cancel: true };
      // 允许 isomorphic-git 再触发一次 onAuth（若文件刚被更新）；之后放弃
      const all = readCredentialsSync(file);
      const cred = matchCredential(all, url);
      if (cred) return { username: cred.username, password: cred.password };
      return { cancel: true };
    },
  };
}

/** 缺凭据时的可照抄指引（不含任何真实凭据）。 */
export function missingCredentialMessage(url) {
  const file = gitCredentialsPath();
  const https = toHttpsUrl(url).url;
  const origin = safeOriginLabel(url);
  const key = normalizeHostKey(url);
  return [
    `该主机未配置凭据：${origin}（凭据键 ${key}）。`,
    `任选其一：`,
    `  ① 用 git_credentials 工具：set url=${https} username=<user> password=<pass>`,
    `  ② 编辑凭据文件 ${file}，加一行：`,
    `     <协议>://<username>:<password>@<host>`,
    `凭据只存在该文件（0600），不会进入对话或日志。`,
  ].join('\n');
}

/** 凭据被拒时的指引。 */
export function rejectedCredentialMessage(url) {
  const file = gitCredentialsPath();
  return `凭据被拒绝（认证失败）：请用 git_credentials 更新 ${file} 中 ${safeOriginLabel(url)} 的用户名/密码（最多重试 1 次，已停止）。`;
}

/** 把 isomorphic-git 认证类错误归因（在工具层 catch 里调用；非认证错误原样抛出）。 */
export function rethrowAuthError(err, url) {
  const msg = err && (err.code === 'HttpError' || err.name === 'HttpError')
    ? `HTTP ${err.data && err.data.statusCode}` : (err && err.message) || String(err);
  if (/401|403|Auth|credentials|cancel/i.test(String(err && (err.code || err.name)) + ' ' + msg)) {
    // 已有匹配凭据 → 说明是被拒；没有 → 缺凭据指引
    const had = matchCredential(readCredentialsSync(), toHttpsUrl(url).url);
    throw new Error(had ? rejectedCredentialMessage(url) : missingCredentialMessage(url));
  }
  throw err;
}

export { toHttpsUrl };
