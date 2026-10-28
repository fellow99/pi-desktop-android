/**
 * git-credentials.js — 设备自管的 **git 原生凭据文件**（$PI_CODING_AGENT_DIR/.git-credentials）。
 *
 * 参考 git 的 credential-store（git-scm.com「Git Tools → Credential Storage」）：一行一条带
 * userinfo 的 URL —— `<协议>://<username>:<password>@<host[:port]>`。userinfo 两字段都做百分号
 * 编码，因此口令里的 `:`、`@`、`/` 可原样往返。文件可手工编辑、可随配置目录整份拷走。
 *
 * 写入：临时文件 + rename 原子替换，保留其余行与注释；强制 0600。
 * 解析容忍：空行 / # 注释 / 非 URL 行 / 无 userinfo 行一律跳过而不抛错（手编文件不该让所有操作失败）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 凭据文件路径：$PI_CODING_AGENT_DIR/.git-credentials；未设时退回 ~/.pi/agent/.git-credentials。 */
export function gitCredentialsPath(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.pi', 'agent');
  return path.join(agentDir, '.git-credentials');
}

const pct = encodeURIComponent;
const unpct = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** 解析一行为 { protocol, host, username, password, pathPrefix } 或 null（跳过）。 */
export function parseCredentialLine(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  if (!u.username) return null; // 无 userinfo 跳过
  const protocol = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.host.toLowerCase(); // 含端口
  const pathPrefix = u.pathname && u.pathname !== '/' ? u.pathname : '';
  return { protocol, host, username: unpct(u.username), password: unpct(u.password), pathPrefix };
}

/** 读取全部凭据（解析失败行跳过）。返回凭据对象数组（按文件顺序）。 */
export async function readCredentials(file = gitCredentialsPath()) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const c = parseCredentialLine(line);
    if (c) out.push(c);
  }
  return out;
}

/** 同步版（auth.js 在 isomorphic-git onAuth 同步上下文里用）。 */
export function readCredentialsSync(file = gitCredentialsPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const c = parseCredentialLine(line);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 匹配（对齐 git credential-store）：
 *  - 协议与 host（含端口，大小写不敏感）必须一致；
 *  - 带路径的行按前缀匹配且优先于裸主机行；
 *  - 同分则文件里靠后的行覆盖靠前的（git 的覆盖规则）。
 * 返回最匹配的一条凭据或 null。
 */
export function matchCredential(credentials, url) {
  let target;
  try { target = new URL(url); } catch { return null; }
  const protocol = target.protocol.replace(/:$/, '').toLowerCase();
  const host = target.host.toLowerCase();
  const tpath = target.pathname || '/';
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < credentials.length; i++) {
    const c = credentials[i];
    if (c.protocol !== protocol || c.host !== host) continue;
    if (c.pathPrefix && !tpath.startsWith(c.pathPrefix)) continue;
    // 分数：路径前缀长度优先，其次文件顺序（后者覆盖）
    const score = (c.pathPrefix ? c.pathPrefix.length * 1000 : 0) + i;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** 格式化一行为凭据行（userinfo 百分号编码）。 */
export function formatCredentialLine({ protocol, host, username, password }) {
  return `${protocol}://${pct(username)}:${pct(password)}@${host}`;
}

/**
 * 写入/替换一条凭据（同一 协议+host+用户名 视为同一条替换；同 host 异用户是第二条）。
 * 原子：临时文件 + rename；强制 0600；保留其余行与注释。
 */
export async function writeCredential(cred, file = gitCredentialsPath()) {
  const lines = [];
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const line of text.split(/\r?\n/)) {
    const c = parseCredentialLine(line);
    const same = c && c.protocol === cred.protocol && c.host === cred.host && c.username === cred.username;
    if (!same && line.trim() !== '') lines.push(line);
  }
  lines.push(formatCredentialLine(cred));
  await writeFileAtomic(file, lines.join('\n') + '\n');
}

/** 删除匹配行（协议+host[+username]）。删空则删文件本身。返回删除条数。 */
export async function removeCredential({ protocol, host, username }, file = gitCredentialsPath()) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return 0; throw err; }
  const keep = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const c = parseCredentialLine(line);
    const match = c && c.protocol === protocol && c.host === host
      && (username === undefined || c.username === username);
    if (match) { removed++; continue; }
    if (line.trim() !== '') keep.push(line);
  }
  if (removed === 0) return 0;
  if (keep.length === 0) {
    await fsp.rm(file, { force: true });
    return removed;
  }
  await writeFileAtomic(file, keep.join('\n') + '\n');
  return removed;
}

/** 原子写：临时文件 + rename，并强制 0600。 */
async function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.git-credentials.${randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, content, { mode: 0o600 });
  try { await fsp.chmod(tmp, 0o600); } catch { /* hmfs 可能不保证 chmod，尽力而为 */ }
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch { /* 同上 */ }
}
