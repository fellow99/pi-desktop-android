import { readCredentials, writeCredential, removeCredential, gitCredentialsPath } from '../git-credentials.js';
import { parseGitUrl, toHttpsUrl, safeOriginLabel } from '../url.js';

/** 脱敏：密码恒为 ********，永不回显明文。 */
function masked(c) {
  return `${c.protocol}://${c.host}${c.pathPrefix || ''}  用户 ${c.username}  密码 ********`;
}

export default {
  name: 'git_credentials',
  label: 'Git 凭据管理',
  description:
    '管理 HTTPS Git 凭据（git 原生格式，存于 $PI_CODING_AGENT_DIR/.git-credentials，0600）。action=list（脱敏）| set <url> <username> <password> | unset <url> [username]。token 永不明文回显。',
  promptSnippet: '克隆/拉取/推送私有仓库前，用 set 保存账号与访问令牌；仅支持 http/https。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'set', 'unset'], description: '必填' },
      url: { type: 'string', description: '仓库或主机地址（http/https；ssh 形式自动转 https）' },
      username: { type: 'string', description: '用户名（set 必填）' },
      password: { type: 'string', description: '密码或访问令牌（set 必填；仅写入凭据文件，不回显）' },
    },
    required: ['action'],
  },
  executionMode: 'sequential',
  async execute(_id, params) {
    try {
      const action = params.action;
      if (action === 'list') {
        const list = await readCredentials();
        const text = list.length ? list.map(masked).join('\n') : '（无凭据）';
        return {
          content: [{ type: 'text', text }],
          details: {
            ok: true, count: list.length, file: gitCredentialsPath(),
            credentials: list.map((c) => ({ protocol: c.protocol, host: c.host, pathPrefix: c.pathPrefix || '', username: c.username, password: '********' })),
          },
        };
      }
      if (!params.url) return { content: [{ type: 'text', text: '缺少 url 参数。' }], isError: true };
      const { url: httpsUrl, rewritten } = toHttpsUrl(params.url);
      const parsed = parseGitUrl(httpsUrl);

      if (action === 'set') {
        if (!params.username || typeof params.password !== 'string' || !params.password) {
          return { content: [{ type: 'text', text: 'set 需要 username 与非空 password。' }], isError: true };
        }
        await writeCredential({ protocol: parsed.protocol, host: parsed.host, username: params.username, password: params.password });
        const note = rewritten ? `（已把 SSH 形式改写为 ${httpsUrl}）` : '';
        return {
          content: [{ type: 'text', text: `已保存凭据：${safeOriginLabel(httpsUrl)}（用户 ${params.username}，密码已脱敏）。${note}` }],
          details: { ok: true, protocol: parsed.protocol, host: parsed.host, username: params.username, password: '********' },
        };
      }
      if (action === 'unset') {
        const removed = await removeCredential({ protocol: parsed.protocol, host: parsed.host, username: params.username });
        return {
          content: [{ type: 'text', text: removed ? `已删除 ${removed} 条凭据。` : '未找到匹配凭据。' }],
          details: { ok: true, removed },
        };
      }
      return { content: [{ type: 'text', text: `未知 action：${action}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `git_credentials 失败：${e.message}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
