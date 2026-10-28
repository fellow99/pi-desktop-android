import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';

export default {
  name: 'git_reset',
  label: 'Git 重置',
  description:
    'git reset：将当前分支重置到指定提交。mode=soft 保留工作区与暂存区；mixed 保留工作区；hard 工作区与暂存区一并回退（hard 需 confirm=true）。',
  promptSnippet: '回退到某个提交。hard 模式会丢失未提交修改，必须经用户确认。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      ref: { type: 'string', description: '目标提交（SHA 或引用），默认 HEAD' },
      mode: { type: 'string', enum: ['soft', 'mixed', 'hard'], description: '默认 mixed' },
      filepath: { type: 'string', description: '仅重置指定文件的暂存区（等价 git reset <file>）' },
      confirm: { type: 'boolean', description: 'mode=hard 时必须为 true' },
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
      const ref = params.ref || 'HEAD';
      const mode = params.mode || 'mixed';

      if (params.filepath) {
        // Unstage a single file: reset index entry to HEAD (or remove if absent in HEAD).
        let headCommit = null;
        try { headCommit = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }); } catch { /* unborn */ }
        await git.resetIndex({ fs, dir: root, filepath: params.filepath, ref: headCommit || undefined });
        return {
          content: [{ type: 'text', text: `已重置暂存区文件：${params.filepath}` }],
          details: { ok: true, ...(hint ? { hint } : {}), filepath: params.filepath },
        };
      }

      const oid = await resolveAny(git, fs, root, ref);
      const branch = await git.currentBranch({ fs, dir: root, fullname: false });
      if (!branch) return { content: [{ type: 'text', text: '当前处于 detached HEAD，无法 reset 分支。' }], isError: true };

      if (mode === 'hard' && params.confirm !== true) {
        return {
          content: [{ type: 'text', text: `将以 hard 模式重置到 ${ref}（${oid.slice(0, 7)}），未提交修改将丢失。请确认后以 confirm=true 重试。` }],
          details: { ok: false, needsConfirm: true, target: oid },
          isError: true,
        };
      }

      // 1) move branch ref
      await git.writeRef({ fs, dir: root, ref: `refs/heads/${branch}`, value: oid, force: true });
      // 2) index：resetIndex 只支持单文件 → 对目标提交的文件清单 + 暂存区已有路径逐个重置
      if (mode !== 'soft') {
        const paths = new Set();
        try { for (const f of await git.listFiles({ fs, dir: root, ref: oid })) paths.add(f); } catch { /* 空树 */ }
        for (const [fp] of await git.statusMatrix({ fs, dir: root })) paths.add(fp);
        for (const fp of paths) {
          await git.resetIndex({ fs, dir: root, filepath: fp, ref: oid }).catch(() => {});
        }
      }
      // 3) workdir
      if (mode === 'hard') {
        await git.checkout({ fs, dir: root, ref: branch, force: true });
      }
      return {
        content: [{ type: 'text', text: `已重置 ${branch} 到 ${oid.slice(0, 7)}（${mode}）。` }],
        details: { ok: true, branch, target: oid, mode },
      };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_reset 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
