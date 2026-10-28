import { gitRuntime, repoRoot, assertIsRepo, netFor, rethrowNet, fsFor, displayUrl, isAbortError, abortResult, mapOsError } from './ctx.js';

export default {
  name: 'git_push',
  label: 'Git 推送',
  description:
    'git push：推送当前分支到远端。默认拒绝非 fast-forward；force=true 时强推（危险，需用户确认）。需要网络与凭据。',
  promptSnippet: '推送提交。非 fast-forward 时先 git_pull；确认覆盖远端才用 force=true。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      remote: { type: 'string', description: '远端名，默认 origin' },
      url: { type: 'string', description: '显式远端 URL（可选）' },
      ref: { type: 'string', description: '本地分支（默认当前分支）' },
      remoteRef: { type: 'string', description: '远端分支名（默认同 ref）' },
      force: { type: 'boolean', description: '强制推送（覆盖远端历史）' },
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
      if (!ref) return { content: [{ type: 'text', text: '当前处于 detached HEAD，无法 push，请指定 ref。' }], isError: true };
      const net = netFor(root, url);
      const shownUrl = displayUrl(url);
      try {
        const res = await git.push({
          fs, http: net.http, dir: root, url, remote,
          ref, remoteRef: params.remoteRef || ref,
          force: params.force === true, signal: _signal,
          ...net.auth,
        });
        if (!res.ok) {
          const errText = (res.error || '').toString();
          const hintFf = /non-fast-forward|fetch first|rejected/i.test(errText)
            ? '远端被拒绝（非 fast-forward）。请先 git_pull 合并远端修改；确认要覆盖远端时再以 force=true 重试。'
            : '';
          return {
            content: [{ type: 'text', text: `push 未完成。${errText}${hintFf ? `\n${hintFf}` : ''}` }],
            details: { ok: false, error: errText },
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `push 完成：${ref} → ${shownUrl} ${params.remoteRef || ref}${params.force ? '（强制）' : ''}` }],
          details: { ok: true, ...(hint ? { hint } : {}), url: shownUrl, ref, remoteRef: params.remoteRef || ref, force: params.force === true },
        };
      } catch (e) {
        if (isAbortError(e, _signal)) return abortResult('git_push');
        rethrowNet(e, url);
      }
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_push 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
