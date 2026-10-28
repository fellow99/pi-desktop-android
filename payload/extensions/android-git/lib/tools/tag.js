import { gitRuntime, fsFor, repoRoot, assertIsRepo, mapOsError } from './ctx.js';

export default {
  name: 'git_tag',
  label: 'Git 标签',
  description: 'git tag：list（默认）| create <name> [--ref] [--annotate] | delete <name>。',
  promptSnippet: '列出、创建或删除标签。annotated 标签需要 tagger 信息。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      action: { type: 'string', enum: ['list', 'create', 'delete'], description: '默认 list' },
      name: { type: 'string', description: '标签名（create/delete 必填）' },
      ref: { type: 'string', description: 'create 时指向的提交，默认 HEAD' },
      annotate: { type: 'boolean', description: '创建附注标签' },
      message: { type: 'string', description: '附注标签信息' },
      taggerName: { type: 'string' },
      taggerEmail: { type: 'string' },
      force: { type: 'boolean', description: '覆盖同名标签' },
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
      const action = params.action || 'list';

      if (action === 'list') {
        const tags = await git.listTags({ fs, dir: root });
        const text = tags.length ? tags.join('\n') : '（无标签）';
        return { content: [{ type: 'text', text }], details: { ok: true, ...(hint ? { hint } : {}), count: tags.length, tags } };
      }
      if (!params.name) return { content: [{ type: 'text', text: '缺少 name 参数。' }], isError: true };

      if (action === 'create') {
        if (params.annotate) {
          await git.annotatedTag({
            fs, dir: root, ref: params.name, object: params.ref || 'HEAD',
            message: params.message || params.name,
            tagger: { name: params.taggerName || 'yourname', email: params.taggerEmail || 'yourname@somehost' },
            force: params.force === true,
          });
        } else {
          await git.tag({
            fs, dir: root, ref: params.name, object: params.ref || 'HEAD',
            force: params.force === true,
          });
        }
        return { content: [{ type: 'text', text: `已创建标签 ${params.name}${params.annotate ? '（附注）' : ''}。` }], details: { ok: true, name: params.name, annotated: !!params.annotate } };
      }
      if (action === 'delete') {
        await git.deleteRef({ fs, dir: root, ref: `refs/tags/${params.name}` });
        return { content: [{ type: 'text', text: `已删除标签 ${params.name}。` }], details: { ok: true, name: params.name } };
      }
      return { content: [{ type: 'text', text: `未知 action：${action}` }], isError: true };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_tag 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
