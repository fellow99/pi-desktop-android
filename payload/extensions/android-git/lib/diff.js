/**
 * diff.js — 用 bundle 内 jsdiff（createTwoFilesPatch）产 unified diff；含二进制检测。
 * isomorphic-git 无 diff 原语（设计 F2）：变动清单来自 statusMatrix，两侧字节来自 readBlob。
 */
import { loadGitRuntime } from './runtime.js';

/** 含 NUL 字节判二进制（前 8000 字节采样）。 */
export function isBinary(buf) {
  if (!buf) return false;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/** 生成两版本的 unified diff；二进制返回 differ 行。 */
export function twoFilePatch(oldLabel, newLabel, oldBuf, newBuf) {
  const { createTwoFilesPatch } = loadGitRuntime();
  if (isBinary(oldBuf) || isBinary(newBuf)) {
    return `Binary files ${oldLabel} and ${newLabel} differ`;
  }
  const oldText = oldBuf === null || oldBuf === undefined ? '' : Buffer.from(oldBuf).toString('utf8');
  const newText = newBuf === null || newBuf === undefined ? '' : Buffer.from(newBuf).toString('utf8');
  if (oldText === newText) return '';
  return createTwoFilesPatch(oldLabel, newLabel, oldText, newText, '', '', { context: 3 });
}

/** 只统计增删行数（stat 模式）。 */
export function patchStat(oldBuf, newBuf) {
  const oldText = oldBuf == null ? '' : Buffer.from(oldBuf).toString('utf8');
  const newText = newBuf == null ? '' : Buffer.from(newBuf).toString('utf8');
  const { createTwoFilesPatch } = loadGitRuntime();
  const patch = createTwoFilesPatch('a', 'b', oldText, newText, '', '', { context: 0 });
  let add = 0, del = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}
