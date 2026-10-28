import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

export default {
  name: 'git_stash',
  label: 'Git 储藏',
  description: 'git stash：储藏/恢复工作区修改。op=push（默认）| pop | apply | list | drop | clear。',
  promptSnippet: '临时收起未提交修改或恢复之前的储藏。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      op: { type: 'string', enum: ['push', 'pop', 'apply', 'list', 'drop', 'clear'], description: '默认 push' },
      message: { type: 'string', description: 'push 时的储藏备注' },
    },
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    // hintSuffix 原在 try 内声明、却在 catch 里使用 ⇒ 失败路径退化成 ReferenceError（2026-10-20 单测抓到）
    let hintSuffix = '';
    try {
      const { root, outsideRoot, hint } = repoRoot(params, ctx);
      // FR-204-012：越出工作区根只提示不阻断（pi 信任模型无逐写审批）；hint 追加到成功输出
      hintSuffix = hint ? '\n' + hint : '';
      const { git } = gitRuntime();
      const fs = fsFor(root);
      await assertIsRepo(root);
      const op = params.op || 'push';

      if (op === 'list') {
        const list = await git.stash({ fs, dir: root, op: 'list' });
        const text = list.length
          ? list.join('\n')
          : '（无储藏）';
        return { content: [{ type: 'text', text }], details: { ok: true, ...(hint ? { hint } : {}), count: list.length, stashes: list } };
      }

      if (op === 'push') {
        await git.stash({ fs, dir: root, op: 'push', message: params.message || '' });
        return { content: [{ type: 'text', text: '已储藏当前修改。' }], details: { ok: true, op } };
      }
      if (op === 'pop' || op === 'apply') {
        await git.stash({ fs, dir: root, op });
        return { content: [{ type: 'text', text: op === 'pop' ? '已恢复并移除最新储藏。' : '已应用最新储藏（保留记录）。' }], details: { ok: true, op } };
      }
      if (op === 'drop') {
        await git.stash({ fs, dir: root, op: 'drop' });
        return { content: [{ type: 'text', text: '已丢弃最新储藏。' }], details: { ok: true, op } };
      }
      if (op === 'clear') {
        await git.stash({ fs, dir: root, op: 'clear' });
        return { content: [{ type: 'text', text: '已清空全部储藏。' }], details: { ok: true, op } };
      }
      return { content: [{ type: 'text', text: `未知 op：${op}` }], isError: true };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      let msg = e.message;
      if (/nothing to stash/i.test(msg)) msg = '没有可储藏的修改（工作区干净）。';
      if (/MissingNameError|No name was provided/i.test(e.code || msg)) msg = 'stash 需要提交作者信息：请先 git_config set user.name / user.email。';
      return { content: [{ type: 'text', text: `git_stash 失败：${msg}${hintSuffix}` }], details: { ok: false, message: msg }, isError: true };
    }
  },
};
