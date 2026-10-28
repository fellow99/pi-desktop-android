import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';
import { renderCommit } from '../report.js';

export default {
  name: 'git_show',
  label: 'git_show',
  description: 'Show a commit: metadata and message summary.',
  promptSnippet: 'Show a git object',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      ref: { type: 'string', description: 'Commit/branch/tag/oid to show (default HEAD)' },
    },
      },
  annotations: { readOnlyHint: true },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      const ref = params.ref || 'HEAD';
      const oid = await resolveAny(git, fs, root, ref);
      let commit;
      try {
        commit = await git.readCommit({ fs, dir: root, oid });
      } catch {
        return { content: [{ type: 'text', text: `Ref ${ref} → ${oid}（非 commit 对象；本工具展示 commit 元信息）` }], details: { oid } };
      }
      const lines = [renderCommit({ oid, commit: commit.commit })];
      const msg = (commit.commit.message || '').trim();
      const parents = commit.commit.parent || [];
      lines.push(`parents: ${parents.length ? parents.map((p) => p.slice(0, 10)).join(', ') : '(none, root commit)'}`);
      if (msg) lines.push('message:\n' + msg);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { oid, parents } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_show 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
