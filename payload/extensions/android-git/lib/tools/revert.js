import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';
import { renderConflicts } from '../report.js';

/**
 * git_revert — 反向提交（isomorphic-git 无此原语，按设计 §11.3 自建）。
 *
 * 语义：把 <ref> 相对其父提交的改动**反向**应用到当前 HEAD，并生成一个新提交。
 * fail-closed（FR-204-022）：受影响文件在工作区/暂存区有本地改动时**拒绝**，
 * 列出冲突路径，不留下半合并态（绝不写 MERGE_HEAD 之类状态）。
 *
 * 实现：walk 两棵树（parentTree vs commitTree）收差异 → 对工作区干净性做硬检查 →
 * 把 parent 侧内容写回工作区+暂存区（删除则在两侧移除）→ commit（message 默认 revert ...）。
 */
export default {
  name: 'git_revert',
  label: 'Git 反向提交',
  description:
    'git revert <ref>：创建一个新提交来撤销指定提交的改动。受影响文件有本地修改时拒绝执行并列出冲突路径（fail-closed，不污染工作区）。根提交（无父）不支持。',
  promptSnippet: '安全撤销某个历史提交：不改写历史，生成反向提交。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      ref: { type: 'string', description: '要撤销的提交（SHA/分支/tag）' },
      message: { type: 'string', description: '提交信息（默认 "Revert "<原主题>""）' },
      authorName: { type: 'string' },
      authorEmail: { type: 'string' },
      noCommit: { type: 'boolean', description: '只把工作区/暂存区改好，不提交' },
    },
    required: ['ref'],
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

      const oid = await resolveAny(git, fs, root, params.ref);
      const { commit } = await git.readCommit({ fs, dir: root, oid });
      if (!commit.parent || commit.parent.length === 0) {
        return { content: [{ type: 'text', text: '根提交没有父提交，无法 revert（该提交引入的改动请用 git_reset/rm 处理）。' }], isError: true };
      }
      if (commit.parent.length > 1) {
        return { content: [{ type: 'text', text: '合并提交的 revert 需要指定主线（-m），本平台不支持；请改用逐个 revert 普通提交。' }], isError: true };
      }
      const parentOid = commit.parent[0];

      // 1) 收集 parent↔commit 差异
      const changes = []; // { filepath, kind: 'A'|'M'|'D' }（相对 parent → commit 的方向）
      await git.walk({
        fs, dir: root,
        trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: oid })],
        map: async (filepath, [a, b]) => {
          if (filepath === '.') return undefined;
          const aType = a && (await a.type());
          const bType = b && (await b.type());
          if (aType === 'tree' || bType === 'tree') return undefined;
          if (aType !== 'blob' && bType !== 'blob') return undefined;
          const aOid = a && (await a.oid());
          const bOid = b && (await b.oid());
          if (aOid === bOid) return undefined;
          changes.push({ filepath, kind: aOid ? (bOid ? 'M' : 'A') : 'D' });
          return undefined;
        },
      });
      if (changes.length === 0) {
        return { content: [{ type: 'text', text: `提交 ${oid.slice(0, 7)} 相对其父没有内容差异（空提交），无需 revert。` }], details: { ok: true, ...(hint ? { hint } : {}), reverted: oid, files: [] } };
      }

      // 2) fail-closed：受影响文件的工作区/暂存区必须干净（与 HEAD 一致）
      const matrix = await git.statusMatrix({ fs, dir: root });
      const dirty = new Map();
      for (const [fp, head, workdir, stage] of matrix) {
        if (!(head === workdir && workdir === stage)) dirty.set(fp, true);
      }
      const conflicts = changes.filter((c) => dirty.has(c.filepath)).map((c) => c.filepath);
      if (conflicts.length > 0) {
        return {
          content: [{ type: 'text', text: `revert 被拒绝（fail-closed）：以下文件有未提交改动，先提交或储藏：\n${renderConflicts(conflicts)}` }],
          details: { ok: false, conflicts },
          isError: true,
        };
      }

      // 3) 反向应用：把 parent 侧内容写回工作区+暂存区
      const applied = [];
      for (const c of changes) {
        // parent 侧内容（kind=A 表示 commit 新增 → parent 无此文件 → 反向=删除）
        let parentBuf = null;
        if (c.kind !== 'A') {
          const { blob } = await git.readBlob({ fs, dir: root, oid: parentOid, filepath: c.filepath });
          parentBuf = Buffer.from(blob);
        }
        if (parentBuf === null) {
          await fs.promises.rm(`${root}/${c.filepath}`, { force: true });
          await git.remove({ fs, dir: root, filepath: c.filepath });
          applied.push({ filepath: c.filepath, action: 'delete' });
        } else {
          await fs.promises.writeFile(`${root}/${c.filepath}`, parentBuf);
          await git.add({ fs, dir: root, filepath: c.filepath });
          applied.push({ filepath: c.filepath, action: 'restore' });
        }
      }

      if (params.noCommit) {
        return {
          content: [{ type: 'text', text: `已把 ${oid.slice(0, 7)} 的反向改动写入工作区与暂存区（noCommit，未提交）。` }],
          details: { ok: true, reverted: oid, files: applied, committed: false },
        };
      }

      const subject = (commit.message || '').trim().split('\n')[0];
      const message = params.message || `Revert "${subject}"\n\nThis reverts commit ${oid}.`;
      const author = { name: params.authorName || 'yourname', email: params.authorEmail || 'yourname@somehost' };
      const newOid = await git.commit({ fs, dir: root, message, author });
      return {
        content: [{ type: 'text', text: `revert 完成：新提交 ${newOid.slice(0, 7)}（撤销 ${oid.slice(0, 7)}，${applied.length} 个文件）。` }],
        details: { ok: true, reverted: oid, oid: newOid, files: applied, committed: true },
      };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_revert 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
