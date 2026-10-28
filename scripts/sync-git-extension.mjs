#!/usr/bin/env node
/**
 * sync-git-extension.mjs —— 把 pi-desktop-hos 的 harmony-git 扩展同步为本工程 payload（规划 §10 单源）。
 *
 * 单源原则：pi-desktop-hos/extensions/harmony-git/ 是唯一权威源码；本脚本复制到
 * pi-desktop-android/payload/extensions/android-git/，并在 index.js 头部插入标记
 * （// synced-from: pi-desktop-hos@<sha>），**禁止在本工程侧直接修改实现**。
 * 与 ark 同名脚本的差异只有：目标目录（android-git）与标记文案。
 *
 * 用法：node scripts/sync-git-extension.mjs [--check]
 *   --check  只比对差异不写文件（CI 用）；有差异时退出码 1。
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOS_EXT = path.resolve(ROOT, '..', 'pi-desktop-hos', 'extensions', 'harmony-git');
const AND_EXT = path.join(ROOT, 'payload', 'extensions', 'android-git');
const CHECK_ONLY = process.argv.includes('--check');

/** 递归收集文件相对路径。 */
function collect(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function hosHeadSha() {
  try {
    return execSync('git -C ' + JSON.stringify(path.resolve(HOS_EXT, '..', '..')) + ' log -1 --format=%h -- extensions/harmony-git', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function main() {
  if (!fs.existsSync(HOS_EXT)) {
    console.error(`源不存在：${HOS_EXT}`);
    process.exit(2);
  }
  const marker = `// synced-from: pi-desktop-hos@${hosHeadSha()}（单源：pi-desktop-hos/extensions/harmony-git；请勿在本工程侧直接修改）\n`;
  const files = collect(HOS_EXT);
  const diffs = [];

  for (const rel of files) {
    const src = fs.readFileSync(path.join(HOS_EXT, rel));
    const content = rel === 'index.js' ? Buffer.concat([Buffer.from(marker, 'utf8'), src]) : src;
    const dst = path.join(AND_EXT, rel);
    if (!fs.existsSync(dst) || sha(fs.readFileSync(dst)) !== sha(content)) {
      diffs.push(rel);
      if (!CHECK_ONLY) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, content);
      }
    }
  }
  // 目标侧多出（源已删除）的文件
  if (fs.existsSync(AND_EXT)) {
    for (const rel of collect(AND_EXT)) {
      if (!files.includes(rel)) {
        diffs.push(`${rel}（本工程侧多余，已删除）`);
        if (!CHECK_ONLY) fs.rmSync(path.join(AND_EXT, rel));
      }
    }
  }

  if (CHECK_ONLY) {
    if (diffs.length) {
      console.error(`未同步（${diffs.length} 个文件有差异）：\n  ${diffs.join('\n  ')}\n运行 node scripts/sync-git-extension.mjs`);
      process.exit(1);
    }
    console.log(`android-git 已与单源一致（${files.length} 文件）✔`);
    return;
  }
  console.log(`android-git 已同步：${files.length} 文件（源 sha=${hosHeadSha()}；差异 ${diffs.length} 处已写入）`);
  if (diffs.length) console.log('  ' + diffs.join('\n  '));
}

main();
