import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

const DEFAULT_AUTHOR = { name: 'yourname', email: 'yourname@somehost' };

export default {
  name: 'git_commit',
  label: 'git_commit',
  description: 'Create a commit. Identity comes from repo config (git_config) or a placeholder default; never invent personal info.',
  promptSnippet: 'Commit staged changes',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      message: { type: 'string', description: 'Commit message' },
      author: { type: 'object', description: 'Optional {name,email}; overrides repo config for this commit' },
      amend: { type: 'boolean', description: 'Amend the previous commit' },
      stageAll: { type: 'boolean', description: 'Stage all changes before committing' },
    },
    required: ['message'],
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      if (params.stageAll) {
        const matrix = await git.statusMatrix({ fs, dir: root });
        for (const [fp, head, workdir] of matrix) {
          if (workdir === 0) await git.remove({ fs, dir: root, filepath: fp });
          else if (!(head === 1 && workdir === 1)) await git.add({ fs, dir: root, filepath: fp });
        }
      }
      let author = params.author;
      if (!author || !author.name) {
        const name = await git.getConfig({ fs, dir: root, path: 'user.name' }).catch(() => undefined);
        const email = await git.getConfig({ fs, dir: root, path: 'user.email' }).catch(() => undefined);
        author = { name: name || DEFAULT_AUTHOR.name, email: email || DEFAULT_AUTHOR.email };
      }
      const oid = await git.commit({ fs, dir: root, message: params.message, author, amend: !!params.amend });
      const text = `Created commit ${oid.slice(0, 12)} by ${author.name} <${author.email}>`;
      return { content: [{ type: 'text', text }], details: { oid, author } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_commit 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
