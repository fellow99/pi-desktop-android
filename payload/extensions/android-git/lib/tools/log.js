import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';
import { renderCommit } from '../report.js';

export default {
  name: 'git_log',
  label: 'git_log',
  description: 'Show commit history (newest first).',
  promptSnippet: 'Show git commit history',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      depth: { type: 'number', description: 'Max commits to show (default 20)' },
      ref: { type: 'string', description: 'Starting ref (branch/tag/HEAD/oid, default HEAD)' },
    },
      },
  annotations: { readOnlyHint: true },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      // (16) 未出生 HEAD（空仓库）→ 「No commits yet.」而非报错
      try {
        await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
      } catch {
        return { content: [{ type: 'text', text: 'No commits yet.' }], details: { count: 0, commits: [] } };
      }
      // 缩写 SHA 先展开（resolveRef 不支持短 SHA）
      let ref = params.ref;
      if (ref && !/^(HEAD|refs\/|[0-9a-f]{40}$)/i.test(ref) && /^[0-9a-f]{4,39}$/i.test(ref)) {
        ref = await resolveAny(git, fs, root, ref);
      }
      const commits = await git.log({ fs, dir: root, depth: params.depth ?? 20, ref });
      if (commits.length === 0) return { content: [{ type: 'text', text: 'No commits yet.' }], details: {} };
      const text = commits.map(renderCommit).join('\n');
      return { content: [{ type: 'text', text }], details: { count: commits.length, commits: commits.map((c) => ({ oid: c.oid, message: (c.commit.message || '').trim().split('\n')[0] })) } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_log 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
