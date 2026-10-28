import { gitRuntime, fsFor, repoRoot, assertIsRepo, assertNoUserinfo, mapOsError } from './ctx.js';

export default {
  name: 'git_remote',
  label: 'Git 远端管理',
  description: 'git remote：list（默认）| add <name> <url> | remove <name>。仅支持 http/https 地址。',
  promptSnippet: '管理远端。拉取/推送用 git_fetch/git_pull/git_push。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      action: { type: 'string', enum: ['list', 'add', 'remove'], description: '默认 list' },
      name: { type: 'string', description: '远端名（add/remove 必填）' },
      url: { type: 'string', description: '远端 URL（add 必填，http/https）' },
    },
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { root, outsideRoot, hint } = repoRoot(params, ctx);
      // FR-204-012：越出工作区根只提示不阻断（pi 信任模型无逐写审批）；hint 追加到成功输出
      const hintSuffix = hint ? '\n' + hint : '';
      const { git } = gitRuntime();
      const fs = fsFor(root);
      await assertIsRepo(root);
      const action = params.action || 'list';

      if (action === 'list') {
        const remotes = await git.listRemotes({ fs, dir: root });
        const text = remotes.length ? remotes.map((r) => `${r.remote}\t${r.url}`).join('\n') : '（无远端）';
        return { content: [{ type: 'text', text }], details: { ok: true, ...(hint ? { hint } : {}), remotes } };
      }
      if (!params.name) return { content: [{ type: 'text', text: '缺少 name 参数。' }], isError: true };

      if (action === 'add') {
        if (!params.url) return { content: [{ type: 'text', text: '缺少 url 参数。' }], isError: true };
        if (!/^https?:\/\//i.test(params.url)) {
          return { content: [{ type: 'text', text: '仅支持 http/https 远端地址（不支持 SSH）。' }], isError: true };
        }
        try { assertNoUserinfo(params.url); } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
        await git.addRemote({ fs, dir: root, remote: params.name, url: params.url });
        return { content: [{ type: 'text', text: `已添加远端 ${params.name} → ${params.url}` }], details: { ok: true, name: params.name, url: params.url } };
      }
      if (action === 'remove') {
        await git.deleteRemote({ fs, dir: root, remote: params.name });
        return { content: [{ type: 'text', text: `已移除远端 ${params.name}。` }], details: { ok: true, name: params.name } };
      }
      return { content: [{ type: 'text', text: `未知 action：${action}` }], isError: true };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_remote 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
