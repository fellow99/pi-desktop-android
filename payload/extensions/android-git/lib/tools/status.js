import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';
import { renderStatus } from '../report.js';

export default {
  name: 'git_status',
  label: 'git_status',
  description: 'Show working-tree status grouped by staged/modified/deleted/untracked/conflicted.',
  promptSnippet: 'Show git working-tree status',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
    },
      },
  annotations: { readOnlyHint: true },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root, hint } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      const matrix = await git.statusMatrix({ fs, dir: root });
      let branchLine = '';
      try {
        const b = await git.currentBranch({ fs, dir: root, fullname: false });
        const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => '');
        branchLine = `On branch ${b || '(detached)'}${head ? ' (HEAD ' + String(head).slice(0, 10) + ')' : ''}`;
      } catch { /* detached/unborn */ }
      const text = renderStatus(matrix, branchLine) + (hint ? '\n' + hint : '');
      return { content: [{ type: 'text', text }], details: { branchLine, ...{} } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_status 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
