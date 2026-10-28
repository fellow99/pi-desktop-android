/**
 * report.js — 把 isomorphic-git 各 API 返回值渲染成模型可读文本。
 * statusMatrix 行 = [filepath, HEAD, workdir, stage]（0/1/2 组合，见 isomorphic-git 文档）。
 */

/** statusMatrix → 分组 { staged, modified, deleted, untracked, conflicted }。 */
export function groupStatus(matrix) {
  const g = { staged: [], modified: [], deleted: [], untracked: [], conflicted: [] };
  for (const [fp, head, workdir, stage] of matrix) {
    // 未跟踪：HEAD=0, workdir=2, stage=0
    if (head === 0 && workdir === 2 && stage === 0) { g.untracked.push(fp); continue; }
    if (stage === 3) { g.conflicted.push(`${fp}（暂存区与 HEAD/工作区均不一致，非合并冲突标记）`); continue; }
    // 已删除（工作区 0，HEAD 有）
    if (head === 1 && workdir === 0) { g.deleted.push(fp); continue; }
    // 已暂存（stage >= 2 且与 HEAD 不同）
    if (head === 0 && stage === 2) { g.staged.push(`A ${fp}`); continue; }
    if (head === 1 && stage === 2 && workdir === 1) { g.staged.push(`M ${fp}`); continue; }
    // 已暂存且工作区与暂存一致（如 soft reset 后）：HEAD=1, workdir=2, stage=2
    if (head === 1 && stage === 2 && workdir === 2) { g.staged.push(`M ${fp}`); continue; }
    // 新增文件已暂存后又改：HEAD=0, workdir=2, stage=2
    if (head === 0 && stage === 2 && workdir === 2) { g.staged.push(`A ${fp}`); continue; }
    if (head === 1 && stage === 0) { g.staged.push(`D ${fp}`); continue; }
    // 工作区改动未暂存
    if (head === 1 && workdir === 2) { g.modified.push(fp); continue; }
  }
  return g;
}

/** statusMatrix → 文本。 */
export function renderStatus(matrix, branchLine = '') {
  const g = groupStatus(matrix);
  const parts = [];
  if (branchLine) parts.push(branchLine);
  const empty = Object.values(g).every((a) => a.length === 0);
  if (empty) { parts.push('No changes（工作区干净）'); return parts.join('\n'); }
  if (g.staged.length) parts.push(`Staged for commit (${g.staged.length}):`, ...g.staged.map((s) => `  ${s}`));
  if (g.modified.length) parts.push(`Modified not staged (${g.modified.length}):`, ...g.modified.map((s) => `  M ${s}`));
  if (g.deleted.length) parts.push(`Deleted (${g.deleted.length}):`, ...g.deleted.map((s) => `  D ${s}`));
  if (g.untracked.length) parts.push(`Untracked (${g.untracked.length}):`, ...g.untracked.map((s) => `  ?? ${s}`));
  if (g.conflicted.length) parts.push(`Conflicted (${g.conflicted.length}):`, ...g.conflicted.map((s) => `  !! ${s}`));
  return parts.join('\n');
}

/** 提交对象 → 摘要行。 */
export function renderCommit(c) {
  const author = c.commit && c.commit.author ? `${c.commit.author.name} <${c.commit.author.email}>` : '';
  const when = c.commit && c.commit.author && c.commit.author.timestamp
    ? new Date(c.commit.author.timestamp * 1000).toISOString() : '';
  const msg = c.commit ? (c.commit.message || '').trim().split('\n')[0] : '';
  return `${c.oid.slice(0, 10)}  ${when}  ${author}  ${msg}`;
}

/** 冲突路径列表 → 文本。 */
export function renderConflicts(paths) {
  if (!paths || paths.length === 0) return '';
  return ['冲突路径（未污染工作区，可用 git_merge abort 中止或手工解决）:', ...paths.map((p) => `  ${p}`)].join('\n');
}
