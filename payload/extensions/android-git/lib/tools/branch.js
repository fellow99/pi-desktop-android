import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

export default {
  name: 'git_branch',
  label: 'git_branch',
  description: 'List / create / delete / rename branches.',
  promptSnippet: 'Manage git branches',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      action: { type: 'string', description: '"list"(default) | "create" | "delete" | "rename"', enum: ['list', 'create', 'delete', 'rename'] },
      name: { type: 'string', description: 'Branch name (create/delete/rename source)' },
      newName: { type: 'string', description: 'New branch name (rename target)' },
      checkout: { type: 'boolean', description: 'create 后是否切换过去（默认 false）' },
    },
      },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { git } = gitRuntime();
      const { root } = repoRoot(params, ctx);
      assertIsRepo(root);
      const fs = fsFor(root);
      const action = params.action || 'list';
      if (action === 'list') {
        const branches = await git.listBranches({ fs, dir: root });
        const cur = await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => '');
        const text = branches.map((b) => (b === cur ? `* ${b}` : `  ${b}`)).join('\n') || '(no branches)';
        return { content: [{ type: 'text', text }], details: { current: cur, branches } };
      }
      if (action === 'create') {
        if (!params.name) throw new Error('name is required for create');
        await git.branch({ fs, dir: root, ref: params.name, checkout: !!params.checkout });
        return { content: [{ type: 'text', text: `Created branch ${params.name}${params.checkout ? ' and checked it out' : ''}` }], details: { name: params.name } };
      }
      if (action === 'delete') {
        if (!params.name) throw new Error('name is required for delete');
        await git.deleteBranch({ fs, dir: root, ref: params.name });
        return { content: [{ type: 'text', text: `Deleted branch ${params.name}` }], details: { name: params.name } };
      }
      if (action === 'rename') {
        if (!params.name || !params.newName) throw new Error('name and newName are required for rename');
        await git.renameBranch({ fs, dir: root, ref: params.newName, oldref: params.name });
        return { content: [{ type: 'text', text: `Renamed branch ${params.name} → ${params.newName}` }], details: {} };
      }
      throw new Error(`unknown action ${action}`);
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_branch 失败：${e.message}` }], details: {}, isError: true };
    }
  },
};
