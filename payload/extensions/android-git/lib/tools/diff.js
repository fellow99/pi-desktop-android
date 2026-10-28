import { gitRuntime, fsFor, repoRoot, assertIsRepo, resolveAny, mapOsError } from './ctx.js';
import { twoFilePatch, patchStat, isBinary } from '../diff.js';

const MAX_PATCH_CHARS_DEFAULT = 60000;
const MAX_FILE_BYTES = 512 * 1024; // 单文件超此大小只给 stat，不出补丁

/** 读某 ref 下文件内容；不存在返回 null。 */
async function readAtRef(git, fs, dir, refOid, filepath) {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: refOid, filepath });
    return Buffer.from(blob);
  } catch {
    return null;
  }
}

async function readWorkdir(fs, dir, filepath) {
  try {
    return Buffer.from(await fs.promises.readFile(`${dir}/${filepath}`));
  } catch {
    return null;
  }
}

/** 两棵树的差异清单：[{ filepath, kind, aOid, bOid }]（a=base 侧，b=head 侧） */
async function treeChanges(git, fs, dir, aOid, bOid, filepathFilter) {
  const changes = [];
  await git.walk({
    fs, dir,
    trees: [git.TREE({ ref: aOid }), git.TREE({ ref: bOid })],
    map: async (filepath, [a, b]) => {
      if (filepath === '.') return undefined;
      const aType = a && (await a.type());
      const bType = b && (await b.type());
      if (aType === 'tree' || bType === 'tree') return undefined;
      if (aType !== 'blob' && bType !== 'blob') return undefined;
      const ao = a && (await a.oid());
      const bo = b && (await b.oid());
      if (ao === bo) return undefined;
      if (filepathFilter && filepath !== filepathFilter) return undefined;
      changes.push({ filepath, kind: ao ? (bo ? 'M' : 'A') : 'D', aOid: ao, bOid: bo });
      return undefined;
    },
  });
  return changes;
}

/** statusMatrix 收集差异。 */
async function statusChanges(git, fs, dir, mode, filepathFilter) {
  const matrix = await git.statusMatrix({ fs, dir, filepaths: filepathFilter ? [filepathFilter] : undefined });
  const rows = [];
  for (const [fp, h, w, s] of matrix) {
    if (mode === 'workdir-index') {
      if (h === 0 && w === 2 && s === 0) rows.push({ filepath: fp, kind: 'A', untracked: true });
      else if (w === 0 && (h === 1 || s !== 0)) rows.push({ filepath: fp, kind: 'D' });
      else if (w === 2 && (h === 1 || s === 2)) rows.push({ filepath: fp, kind: 'M' });
    } else if (mode === 'index-head') {
      if (h === 0 && s === 2) rows.push({ filepath: fp, kind: 'A' });
      else if (h === 1 && s === 0 && w === 1) rows.push({ filepath: fp, kind: 'D' });
      else if (h === 1 && s === 2 && w === 1) rows.push({ filepath: fp, kind: 'M' });
      else if (h === 1 && w === 2 && s === 2) rows.push({ filepath: fp, kind: 'M', partiallyStaged: true });
    } else {
      if (h === 0 && w === 2) rows.push({ filepath: fp, kind: 'A' });
      else if (h === 1 && w === 0) rows.push({ filepath: fp, kind: 'D' });
      else if (h === 1 && w === 2) rows.push({ filepath: fp, kind: 'M' });
    }
  }
  return rows;
}

export default {
  name: 'git_diff',
  label: 'Git 差异',
  description:
    'git diff：输出 unified diff。mode=workdir-index（默认）| index-head | workdir-head | refs（需 ref+ref2）。stat=true 只给增删行统计。二进制文件如实标记 "Binary files ... differ"。非 refs 模式传 ref/ref2 会报错。',
  promptSnippet: '查看修改内容；比较两个提交用 mode=refs。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '仓库目录（默认会话当前目录）' },
      mode: { type: 'string', enum: ['workdir-index', 'index-head', 'workdir-head', 'refs'], description: '默认 workdir-index' },
      ref: { type: 'string', description: 'refs 模式的起点（SHA/分支/tag）' },
      ref2: { type: 'string', description: 'refs 模式的终点（默认 HEAD）' },
      stat: { type: 'boolean', description: '只输出每个文件的增删行统计' },
      filepath: { type: 'string', description: 'pathspec：只看某个文件' },
      maxPatchChars: { type: 'number', description: '补丁文本总上限（默认 60000）' },
    },
  },
  annotations: { readOnlyHint: true },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const { root, outsideRoot, hint } = repoRoot(params, ctx);
      // FR-204-012：越出工作区根只提示不阻断（pi 信任模型无逐写审批）；hint 追加到成功输出
      const hintSuffix = hint ? '\n' + hint : '';
      const { git } = gitRuntime();
      const fs = fsFor(root);
      await assertIsRepo(root);
      const mode = params.mode || 'workdir-index';

      // FR-204-021：非 refs 模式传 ref/ref2 必须报错而非忽略
      if (mode !== 'refs' && (params.ref || params.ref2)) {
        return { content: [{ type: 'text', text: `mode=${mode} 不接受 ref/ref2 参数（仅 mode=refs 使用）。` }], isError: true };
      }
      if (mode === 'refs' && !params.ref) {
        return { content: [{ type: 'text', text: 'mode=refs 需要 ref 参数（可选 ref2，默认 HEAD）。' }], isError: true };
      }
      const maxPatchChars = typeof params.maxPatchChars === 'number' ? params.maxPatchChars : MAX_PATCH_CHARS_DEFAULT;
      const statOnly = params.stat === true;

      let rows;
      let readSides;
      if (mode === 'refs') {
        const aOid = await resolveAny(git, fs, root, params.ref);
        const bOid = await resolveAny(git, fs, root, params.ref2 || 'HEAD');
        rows = await treeChanges(git, fs, root, aOid, bOid, params.filepath);
        const aLabel = params.ref;
        const bLabel = params.ref2 || 'HEAD';
        readSides = async (row) => ({
          oldBuf: row.aOid ? await readAtRef(git, fs, root, aOid, row.filepath) : null,
          newBuf: row.bOid ? await readAtRef(git, fs, root, bOid, row.filepath) : null,
          oldLabel: `${aLabel}:${row.filepath}`,
          newLabel: `${bLabel}:${row.filepath}`,
        });
      } else {
        rows = await statusChanges(git, fs, root, mode, params.filepath);
        let headOid = null;
        try { headOid = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }); } catch { /* unborn */ }
        readSides = async (row) => {
          if (mode === 'index-head') {
            // 暂存内容无公开读 API：以工作区近似（部分暂存时已标注 partiallyStaged）
            return {
              oldBuf: headOid ? await readAtRef(git, fs, root, headOid, row.filepath) : null,
              newBuf: await readWorkdir(fs, root, row.filepath),
              oldLabel: `HEAD:${row.filepath}`,
              newLabel: `INDEX≈WORKDIR:${row.filepath}`,
            };
          }
          const oldLabel = mode === 'workdir-head' ? `HEAD:${row.filepath}` : `a/${row.filepath}`;
          const newLabel = mode === 'workdir-head' ? `WORKDIR:${row.filepath}` : `b/${row.filepath}`;
          return {
            oldBuf: headOid ? await readAtRef(git, fs, root, headOid, row.filepath) : null,
            newBuf: await readWorkdir(fs, root, row.filepath),
            oldLabel,
            newLabel,
          };
        };
      }

      if (!rows.length) {
        return { content: [{ type: 'text', text: '（无差异）' }], details: { ok: true, ...(hint ? { hint } : {}), mode, fileCount: 0, files: [] } };
      }

      const parts = [];
      const files = [];
      let used = 0;
      let truncated = false;
      let omittedLargeBinary = 0;

      for (const row of rows) {
        const { oldBuf, newBuf, oldLabel, newLabel } = await readSides(row);
        const tooBig = (oldBuf && oldBuf.length > MAX_FILE_BYTES) || (newBuf && newBuf.length > MAX_FILE_BYTES);
        const binary = isBinary(oldBuf) || isBinary(newBuf);

        if (statOnly) {
          if (tooBig || binary) {
            files.push({ filepath: row.filepath, kind: row.kind, binary: true });
            parts.push(` ${row.filepath} | Binary${tooBig ? '（超大）' : ''}`);
            omittedLargeBinary++;
          } else {
            const { add, del } = patchStat(oldBuf, newBuf);
            files.push({ filepath: row.filepath, kind: row.kind, add, del });
            parts.push(` ${row.filepath} | +${add} -${del}`);
          }
          continue;
        }

        let patch;
        if (tooBig || binary) {
          patch = `Binary files ${oldLabel} and ${newLabel} differ`;
          omittedLargeBinary++;
        } else {
          patch = twoFilePatch(oldLabel, newLabel, oldBuf, newBuf);
        }
        files.push({
          filepath: row.filepath, kind: row.kind,
          ...(row.partiallyStaged ? { partiallyStaged: true } : {}),
          bytes: { old: oldBuf ? oldBuf.length : 0, new: newBuf ? newBuf.length : 0 },
        });
        if (!patch) continue;
        if (used + patch.length > maxPatchChars) { truncated = true; continue; }
        used += patch.length;
        parts.push(patch.endsWith('\n') ? patch : patch + '\n');
      }

      const summary = `${rows.length} 个文件有差异（mode=${mode}${statOnly ? '，stat' : ''}）`
        + (omittedLargeBinary ? `，其中 ${omittedLargeBinary} 个二进制/超大文件仅标注` : '')
        + (truncated ? '，补丁过长已截断（可用 filepath 或调大 maxPatchChars）' : '');
      const text = parts.length ? `${summary}\n\n${parts.join('\n')}` : summary;
      return {
        content: [{ type: 'text', text }],
        details: { ok: true, mode, stat: statOnly, fileCount: rows.length, files, truncated, omittedLargeBinary },
      };
    } catch (e) {
      mapOsError(e, typeof root === 'undefined' ? undefined : root);
      return { content: [{ type: 'text', text: `git_diff 失败：${e.message}${hintSuffix}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
