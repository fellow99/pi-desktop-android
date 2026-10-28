import { gitRuntime, fsFor, repoRoot, mapOsError } from './ctx.js';

export default {
  name: 'git_init',
  label: 'git_init',
  description: 'Initialize an empty git repository in the given directory (pure JS, no git binary needed).',
  promptSnippet: 'Initialize a git repository',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      defaultBranch: { type: 'string', description: 'Initial branch name (default "main")' },
    },
      },
  executionMode: 'sequential',
  annotations: { destructiveHint: false },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root, hint } = repoRoot(params, ctx);
      const defaultBranch = params.defaultBranch || 'main';
      await git.init({ fs: fsFor(root), dir: root, defaultBranch });
      const text = `Initialized empty git repository in ${root} (default branch "${defaultBranch}")${hint ? '\n' + hint : ''}`;
      return { content: [{ type: 'text', text }], details: { dir: root, defaultBranch } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_init 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
