import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';
import { renderConflicts } from '../report.js';

export default {
  name: 'git_cherry_pick',
  label: 'Git 摘取提交',
  description: 'git cherry-pick <oid>：将单个提交应用到当前分支。冲突时返回冲突清单且不污染工作区。',
  promptSnippet: '用于把某个提交单独搬到当前分支。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      oid: { type: 'string', description: '要摘取的提交 SHA' },
      authorName: { type: 'string', description: '提交作者名（默认占位 yourname）' },
      authorEmail: { type: 'string', description: '提交作者邮箱（默认占位 yourname@somehost）' },
    },
    required: ['oid'],
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
      // isomorphic-git cherryPick 保留原提交的 author，只接受 committer
      const committer = {
        name: params.authorName || 'yourname',
        email: params.authorEmail || 'yourname@somehost',
      };
      try {
        const oid = await resolveAny(git, fs, root, params.oid);
        const res = await git.cherryPick({ fs, dir: root, oid, committer });
        // isomorphic-git cherryPick 直接返回新提交 oid 字符串（或 undefined）
        const newOid = typeof res === 'string' ? res
          : await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => oid);
        return {
          content: [{ type: 'text', text: `cherry-pick 完成：${newOid.slice(0, 7)}` }],
          details: { ok: true, ...(hint ? { hint } : {}), oid: newOid },
        };
      } catch (e) {
        if (e && e.data && Array.isArray(e.data.filepaths)) {
          const conflictText = renderConflicts(e.data.filepaths);
          return {
            content: [{ type: 'text', text: `cherry-pick 冲突（isomorphic-git 未写入工作区）：\n${conflictText}` }],
            details: { ok: false, conflicts: e.data.filepaths },
            isError: true,
          };
        }
        throw e;
      }
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_cherry_pick 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
