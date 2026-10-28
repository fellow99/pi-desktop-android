import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

export default {
  name: 'git_add',
  label: 'git_add',
  description: 'Stage paths; also supports remove (register deletion) and unstage.',
  promptSnippet: 'Stage changes for commit',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      filepath: { type: 'string', description: 'Path relative to repo root to stage (omit with all=true)' },
      all: { type: 'boolean', description: 'Stage all changes (default false)' },
      remove: { type: 'boolean', description: 'Register deletion of filepath instead' },
      unstage: { type: 'boolean', description: 'Unstage filepath (reset index to HEAD)' },
    },
      },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      if (params.unstage) {
        if (!params.filepath) throw new Error('filepath is required for unstage');
        await git.resetIndex({ fs, dir: root, filepath: params.filepath });
        return { content: [{ type: 'text', text: `Unstaged ${params.filepath}` }], details: {} };
      }
      if (params.remove) {
        if (!params.filepath) throw new Error('filepath is required for remove');
        await git.remove({ fs, dir: root, filepath: params.filepath });
        return { content: [{ type: 'text', text: `Removed (staged deletion) ${params.filepath}` }], details: {} };
      }
      if (params.all) {
        const matrix = await git.statusMatrix({ fs, dir: root });
        let n = 0;
        for (const [fp, head, workdir] of matrix) {
          if (workdir === 0) { await git.remove({ fs, dir: root, filepath: fp }); n++; }
          else if (!(head === 1 && workdir === 1)) { await git.add({ fs, dir: root, filepath: fp }); n++; }
        }
        return { content: [{ type: 'text', text: `Staged ${n} path(s)` }], details: { count: n } };
      }
      if (!params.filepath) throw new Error('filepath is required (or set all=true)');
      await git.add({ fs, dir: root, filepath: params.filepath });
      return { content: [{ type: 'text', text: `Staged for commit: A ${params.filepath}` }], details: {} };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_add 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
