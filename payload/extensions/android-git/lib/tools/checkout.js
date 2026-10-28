import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

export default {
  name: 'git_checkout',
  label: 'git_checkout',
  description: 'Switch branch / checkout a ref / restore paths.',
  promptSnippet: 'Checkout a branch or ref',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      ref: { type: 'string', description: 'Branch/tag/oid to checkout' },
      filepaths: { type: 'array', items: { type: 'string' }, description: 'Restore these paths from ref (restore semantics)' },
      force: { type: 'boolean', description: 'Discard local changes (force checkout)' },
    },
    required: ['ref'],
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      await git.checkout({ fs, dir: root, ref: params.ref, filepaths: params.filepaths, force: !!params.force });
      const text = params.filepaths && params.filepaths.length
        ? `Restored ${params.filepaths.length} path(s) from ${params.ref}`
        : `Checked out ${params.ref}`;
      return { content: [{ type: 'text', text }], details: { ref: params.ref } };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_checkout 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
