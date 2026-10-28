import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';
import { renderConflicts } from '../report.js';

export default {
  name: 'git_merge',
  label: 'Git 合并',
  description:
    'git merge <theirs>：将指定分支/提交合并进当前分支。失败时返回结构化冲突清单（conflicts[].path），不会写入坏状态。',
  promptSnippet: '合并前先 git_status 确认工作区干净；冲突时向用户展示冲突文件并建议处理方式。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      theirs: { type: 'string', description: '要合并进来的分支名或提交' },
      authorName: { type: 'string', description: '合并提交作者名' },
      authorEmail: { type: 'string', description: '合并提交作者邮箱' },
      message: { type: 'string', description: '合并提交信息（默认自动生成）' },
    },
    required: ['theirs'],
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
      const author = {
        name: params.authorName || 'yourname',
        email: params.authorEmail || 'yourname@somehost',
      };
      try {
        // ours 必须传分支名而非 'HEAD'：isomorphic-git 用 ours=HEAD 时 FF 合并不更新
        // 分支 ref 且把 .git/HEAD 写成裸 oid（detached），后续 status/commit 全乱。
        const ours = await git.currentBranch({ fs, dir: root, fullname: false });
        if (!ours) {
          return { content: [{ type: 'text', text: '当前处于 detached HEAD，无法 merge；请先 git_checkout 到分支。' }], isError: true };
        }
        const res = await git.merge({
          fs, dir: root, ours, theirs: params.theirs, author,
          message: params.message, fastForward: true,
        });
        // isomorphic-git merge 只更新 index+ref，不写工作区（_pull 内部会再 checkout）；
        // 不同步会让磁盘文件停在合并前，status 出现幽灵 modified/deleted → 必须补 checkout。
        if (!res.alreadyMerged) {
          await git.checkout({ fs, dir: root, ref: ours, force: true });
        }
        const kind = res.fastForward ? 'fast-forward' : (res.alreadyMerged ? '已是最新（无需合并）' : '合并提交');
        return {
          content: [{ type: 'text', text: `合并完成（${kind}）：${(res.oid || '').slice(0, 7) || '—'}` }],
          details: { ok: true, ...(hint ? { hint } : {}), ...res },
        };
      } catch (e) {
        if (e && e.data && Array.isArray(e.data.filepaths)) {
          const conflictText = renderConflicts(e.data.filepaths);
          return {
            content: [{ type: 'text', text: `合并发生冲突（isomorphic-git 未写入工作区）：\n${conflictText}` }],
            details: { ok: false, conflicts: e.data.filepaths },
            isError: true,
          };
        }
        throw e;
      }
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_merge 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
