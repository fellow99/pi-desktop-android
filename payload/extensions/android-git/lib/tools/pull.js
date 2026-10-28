import { gitRuntime, repoRoot, assertIsRepo, netFor, rethrowNet, fsFor, displayUrl, isAbortError, abortResult, mapOsError } from './ctx.js';
import { renderConflicts } from '../report.js';

export default {
  name: 'git_pull',
  label: 'Git 拉取',
  description: 'git pull：fetch + merge/fast-forward 到当前分支。需要网络与凭据。冲突时返回冲突清单。',
  promptSnippet: '拉取远端并合并。冲突时展示冲突文件，建议用户先提交或储藏本地修改。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      remote: { type: 'string', description: '远端名，默认 origin' },
      url: { type: 'string', description: '显式远端 URL（可选）' },
      ref: { type: 'string', description: '远端分支（默认当前分支名）' },
      authorName: { type: 'string' },
      authorEmail: { type: 'string' },
    },
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { root, outsideRoot, hint } = repoRoot(params, ctx);
      // FR-204-012：越出工作区根只提示不阻断（pi 信任模型无逐写审批）；hint 追加到成功输出
      const hintSuffix = hint ? '\n' + hint : '';
      const { git } = gitRuntime();
      await assertIsRepo(root);
      const remote = params.remote || 'origin';
      const fs = fsFor(root);
      let url = params.url;
      if (!url) {
        const remotes = await git.listRemotes({ fs, dir: root });
        const hit = remotes.find((r) => r.remote === remote);
        if (!hit) return { content: [{ type: 'text', text: `远端 ${remote} 不存在，先用 git_remote add 添加。` }], isError: true };
        url = hit.url;
      }
      const ref = params.ref || (await git.currentBranch({ fs, dir: root, fullname: false }));
      if (!ref) return { content: [{ type: 'text', text: '当前处于 detached HEAD，无法 pull，请指定 ref。' }], isError: true };
      const net = netFor(root, url);
      const shownUrl = displayUrl(url);
      try {
        await git.pull({
          fs, http: net.http, dir: root, url, remote, ref,
          singleBranch: true, fastForward: true, signal: _signal,
          author: { name: params.authorName || 'yourname', email: params.authorEmail || 'yourname@somehost' },
          ...net.auth,
        });
        const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
        return {
          content: [{ type: 'text', text: `pull 完成：${shownUrl} ${ref} → HEAD ${head.slice(0, 7)}` }],
          details: { ok: true, ...(hint ? { hint } : {}), url: shownUrl, ref, head },
        };
      } catch (e) {
        if (isAbortError(e, _signal)) return abortResult('git_pull');
        if (e && e.data && Array.isArray(e.data.filepaths)) {
          const conflictText = renderConflicts(e.data.filepaths);
          return {
            content: [{ type: 'text', text: `pull 合并冲突（isomorphic-git 未写入工作区）：\n${conflictText}` }],
            details: { ok: false, conflicts: e.data.filepaths },
            isError: true,
          };
        }
        rethrowNet(e, url);
      }
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_pull 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
