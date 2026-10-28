/**
 * fence.js — 仓库根解析 + chroot 校验 + 工作区根合理性提示。
 *
 * 安全属性（设计 §8）：pi 无 dsh 式逐写审批（唯一门禁是 project trust），因此这里**不做审批**，
 * 只做两层纯防御：
 *  ① chroot：fs 适配器内每个路径 join(root,rel) 后做前缀包含校验，防 `..` 逃逸/绝对路径/根外软链；
 *  ② 合理性：dir 落在 PI_HOS_ROOTS（sandbox/desktop/documents/download）之外时给清晰提示文本（非阻断）。
 * OS 未授权（EPERM/EACCES）原样归因，提示需系统设置授权后重启（能力清单 A.2 #6）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class FenceError extends Error {
  constructor(message, code = 'GIT_FENCE') { super(message); this.name = 'FenceError'; this.code = code; }
}

/** 读取工作区根清单（PI_HOS_ROOTS JSON [{id,path}]）。读取失败返回 []。 */
export function workspaceRoots(env = process.env) {
  const raw = env.PI_HOS_ROOTS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.path === 'string') : [];
  } catch { return []; }
}

/**
 * 解析仓库根：dir 相对 ctx.cwd 归一为绝对路径。
 * 返回 { root, roots, outsideRoot } —— outsideRoot 为 true 表示落在已知工作区根之外（仅提示，不阻断）。
 */
export function resolveRepoRoot(dir, cwd) {
  if (dir === undefined || dir === null || (typeof dir === 'string' && !dir.trim())) dir = '.';
  const root = path.resolve(cwd || process.cwd() || '/', dir);
  const roots = workspaceRoots();
  let outsideRoot = false;
  if (roots.length > 0) {
    outsideRoot = !roots.some((r) => isWithin(path.resolve(r.path), root));
  }
  return { root, roots, outsideRoot };
}

/** 前缀包含判断：child 是否等于或在 parent 之内。 */
export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 归一并校验 rel 在 root 内；越界抛 FenceError。返回绝对路径。 */
export function resolveWithin(root, rel) {
  if (rel === undefined || rel === null) throw new FenceError(`路径为空（root=${root}）`);
  const abs = path.resolve(root, String(rel));
  if (!isWithin(root, abs)) {
    throw new FenceError(`路径越出仓库根：${rel}（root=${root}）`, 'GIT_FENCE_ESCAPE');
  }
  return abs;
}

/**
 * 软链防护：realpath 后仍在 root 内才放行；root 本身不存在时跳过（新建场景）。
 * 返回 realpath 后的绝对路径。
 */
/**
 * 软链防护：realpath 后仍在 root 内才放行；目标不存在时按原路径返回（新建场景）。
 *
 * 【为什么 root 也必须 realpath（2026-10-20 单测 TC-H04 抓到的真实缺陷）】
 * 只对目标做 realpath、却拿原始 root 字符串比较，任何让两者形态不同的因素都会被误判成
 * "软链逃逸"：Windows 8.3 短名/大小写、macOS 的 /private/var、以及 root 自身是软链/junction。
 * 现场：普通文件被拒（软链指向仓库根之外：sub/f.txt → …Tempchroot-xxxxsub.txt）。
 */
export async function resolveWithinReal(root, rel) {
  const abs = resolveWithin(root, rel);
  try {
    const real = await fsp.realpath(abs);
    if (!isWithin(await canonicalRoot(root), real)) {
      throw new FenceError(`软链指向仓库根之外：${rel} → ${real}`, 'GIT_FENCE_SYMLINK');
    }
    return real;
  } catch (err) {
    if (err && err.code === 'ENOENT') return abs; // 目标尚不存在（写入新文件）
    throw err;
  }
}
/** root 的 canonical 形态（realpath 失败时退回原值，绝不改变放行/拒绝语义）。 */
async function canonicalRoot(root) {
  try {
    return await fsp.realpath(root);
  } catch {
    return root;
  }
}

/** 给模型的越界/授权提示文本（如实、可操作）。 */
export function fenceHint(root, roots, outsideRoot) {
  const parts = [];
  if (outsideRoot) {
    const known = roots.map((r) => `${r.id}=${r.path}`).join('；') || '（未提供 PI_HOS_ROOTS）';
    parts.push(`提示：目标目录 ${root} 不在已知工作区根内（${known}）。`);
    parts.push('git 操作不经过逐写审批（pi 信任模型无此机制）；请确认这是你要操作的目录。');
  }
  return parts.join('\n');
}

/** 把 OS 授权错误归因（EPERM/EACCES）为可读提示；其它错误原样抛出。 */
export function rethrowOsPermission(err, root) {
  if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
    throw new FenceError(
      `无权限访问 ${root}（${err.code}）：该目录可能需要在「系统设置 → 应用权限」授予后**重启应用**才生效。`,
      err.code,
    );
  }
  throw err;
}

/** 同步 stat 辅助（判定目录是否为 git 仓库：存在 .git）。 */
export function hasGitDir(root) {
  // .git 可能是目录（普通仓库）或文件（worktree/submodule 指针），两者都算 git 仓库
  try { return !!fs.statSync(path.join(root, '.git')); }
  catch { return false; }
}
