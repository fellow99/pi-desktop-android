#!/usr/bin/env node
/**
 * assemble-payload.mjs —— pi-desktop-android 的载荷组装流水线（宿主机 Node 运行）。
 *
 * 与 pi-desktop-ark 的同名脚本同构（移植 + Android 化），流水线：
 *   ① 幂等应用 patches/v0.12.1/*.patch 到 ../pi-web 工作树（--reverse --check 命中即跳；冲突即 exit 2，绝不 --3way）
 *   ② 组装/刷新 PI_DIST（build/pi-dist：package.json + next.config.ts + public/ + node_modules/ + .next/）
 *   ③ 补丁标记断言（缺标记 ⇒ 用打了补丁的源码重编 `next build --webpack` 并镜像 .next；重编后仍缺 ⇒ exit 2）
 *   ④ 裁剪复制 PI_DIST → build/payload-stage/pi-web（crop-rules：nft.json / win32 原生 SWC / sharp / node-pty / *.node）
 *   ⑤ 追加壳资产 payload/{pi-web-launch.js,env.js,extensions,skills,config,jitless}
 *   ⑥ 确定性 ustar + gzip（mtime=0、条目排序）→ app/src/main/assets/pi-web/pi-web.tar.gz + pi-web.version（SHA-256）
 *   ⑦ 归档可读性自检（逐块走 tar；防「空名字头块」回归）
 *   ⑧ 收尾还原 pi-web 工作树 pristine（--keep-patches 可留）
 *
 * 用法：
 *   node scripts/assemble-payload.mjs            # 干跑：报告补丁/裁剪/体积，不写产物
 *   node scripts/assemble-payload.mjs --apply    # 产出 assets 载荷
 *
 * 纪律（同 ark）：补丁可往返（SHA-256 逐文件断言）· 收尾 pi-web 必须 pristine · 产物体积如实报告。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CROP_RULES, ruleMatchesFile, ruleMatchesDir, firstMatchingRule, assertKeepSound, describeRules } from '../scripts/crop-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_PI_WEB = path.resolve(PROJECT_ROOT, '..', 'pi-web');
const PI_WEB_PATCH_TAG = 'v0.12.1';
const DEFAULT_PATCH_DIR = path.join(PROJECT_ROOT, 'patches', PI_WEB_PATCH_TAG);
const DEFAULT_PI_DIST = path.join(PROJECT_ROOT, 'build', 'pi-dist');
const DEFAULT_STAGE = path.join(PROJECT_ROOT, 'build', 'payload-stage');
const ASSETS_PAYLOAD_DIR = path.join(PROJECT_ROOT, 'app', 'src', 'main', 'assets', 'pi-web');
const DEFAULT_TAR = path.join(ASSETS_PAYLOAD_DIR, 'pi-web.tar.gz');
const DEFAULT_VERSION = path.join(ASSETS_PAYLOAD_DIR, 'pi-web.version');
const APP_PAYLOAD_DIR = path.join(PROJECT_ROOT, 'payload');
const APP_PAYLOAD_ENTRIES = ['pi-web-launch.js', 'env.js', 'extensions', 'skills', 'config', 'jitless'];
const TAR_ROOT = 'pi-web';

/** 载荷里必须出现的补丁标记（编译产物是 webpack 产物；源码补丁必须重编才生效）。 */
const PI_WEB_PATCH_MARKERS = [
  { rel: '.next/server/app/api/terminal/route.js', marker: 'terminal.pty' },
  { rel: '.next/server/app/api/cwd/browse/route.js', marker: 'PI_ANDROID_ROOTS' },
  { rel: '.next/server/app/api/cwd/validate/route.js', marker: 'pi-android-sandbox-alias' },
  { rel: '.next/server/app/api/sessions/[id]/export/route.js', marker: 'pi-hos-export-runtime-guard' },
  { rel: '.next/server/app/api/cwd/browse/route.js', marker: 'pi-hos-picker-contract' },
  { rel: '.next/server/app/api/host/perm/route.js', marker: 'pi-hos-perm-manual' }
];

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return bytes + ' B';
}

function walkTree(rootDir) {
  const out = [];
  const stack = [{ abs: rootDir, rel: '' }];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch (err) {
      out.push({ rel: cur.rel, abs: cur.abs, size: 0, error: err.code || String(err.message) });
      continue;
    }
    for (const e of entries) {
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const abs = path.join(cur.abs, e.name);
      if (e.isDirectory()) stack.push({ abs, rel });
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* 竞态：按 0 计入 */ }
        out.push({ rel, abs, size });
      }
    }
  }
  return out;
}

function totalBytes(files) {
  return files.reduce((acc, f) => acc + (f.size || 0), 0);
}

class AssembleError extends Error {}

function runGit(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: !res.error && res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(), error: res.error };
}

function sha256Sync(absPath) {
  try {
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

function patchAffectedFiles(patchPath) {
  const text = fs.readFileSync(patchPath, 'utf8');
  const seen = new Set();
  for (const line of text.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') seen.add(m[1].replace(/\r$/, ''));
  }
  return [...seen];
}

function missingPatchMarkers(distDir) {
  const missing = [];
  for (const { rel, marker } of PI_WEB_PATCH_MARKERS) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(distDir, rel), 'utf8');
    } catch { text = ''; }
    if (!text.includes(marker)) missing.push(`${rel}（缺「${marker}」）`);
  }
  return missing;
}

/** 整栈已应用判定：按**逆序**逐条反向检查（栈式补丁不能按正序逐条查——后条会改前条的上下文）。 */
function allPatchesApplied(opts, dir, names) {
  for (const name of [...names].reverse()) {
    if (!runGit(['apply', '--reverse', '--check', '--whitespace=nowarn', path.join(dir, name)], opts.piWeb).ok) {
      return false;
    }
  }
  return true;
}

/** 幂等应用补丁（纪律：整栈已应用 ⇒ 跳过；否则必须 pristine 逐条正向应用+往返校验；冲突即停）。 */
function applyPiWebPatches(opts) {
  const dir = opts.patchDir;
  if (!fs.existsSync(dir)) throw new AssembleError(`补丁目录不存在：${dir}`);
  const patches = fs.readdirSync(dir).filter((n) => n.endsWith('.patch')).sort();
  if (patches.length === 0) throw new AssembleError(`补丁目录为空：${dir}`);

  const head = runGit(['rev-parse', 'HEAD'], opts.piWeb);
  if (!head.ok) throw new AssembleError(`pi-web 不是可用的 git 工作树：${opts.piWeb}`);
  const describe = runGit(['describe', '--tags', '--exact-match', 'HEAD'], opts.piWeb);
  if (!describe.ok || describe.out !== PI_WEB_PATCH_TAG) {
    throw new AssembleError(
      `pi-web HEAD 不在被 patch 的上游 tag 上：期望 ${PI_WEB_PATCH_TAG}，实测 ${describe.ok ? describe.out : `(无 tag) ${head.out.slice(0, 12)}`}`,
    );
  }

  // 幂等路径：整栈已在位（上一轮未还原/重复运行）⇒ 直接跳过
  if (allPatchesApplied(opts, dir, patches)) {
    for (const name of patches) console.log(`上游补丁    : ${name} → 已应用，跳过（幂等，整栈反向检查）`);
    return { applied: [], skipped: patches };
  }

  const dirty = runGit(['status', '--porcelain'], opts.piWeb);
  if (dirty.out.length > 0) {
    // 自愈：pi-web 子模块在本流水线里只承载「补丁应用态」（钉死 tag、无用户改动）。
    // 非完整栈的脏态 = 上一轮被中断的残留 ⇒ 自动还原 pristine 再重放（并明确告知）。
    console.log('pi-web 工作树为中断残留 ⇒ 自动还原 pristine 后重放补丁');
    runGit(['checkout', '--', '.'], opts.piWeb);
    runGit(['clean', '-fd', 'app', 'lib', 'components'], opts.piWeb);
    const after = runGit(['status', '--porcelain'], opts.piWeb);
    if (after.out.length > 0) {
      throw new AssembleError(`pi-web 还原后仍非 pristine（存在非流水线改动，人工核查）：\n${after.out}`);
    }
  }

  const applied = [];
  for (const name of patches) {
    const patchPath = path.join(dir, name);
    const check = runGit(['apply', '--check', '--whitespace=nowarn', patchPath], opts.piWeb);
    if (!check.ok) {
      throw new AssembleError(`补丁与当前 pi-web 工作树冲突，中止（不得 --3way）：${name}\n  ${check.out}`);
    }
    const files = patchAffectedFiles(patchPath);
    const before = files.map((rel) => [rel, sha256Sync(path.join(opts.piWeb, rel))]);
    if (!runGit(['apply', '--whitespace=nowarn', patchPath], opts.piWeb).ok) {
      throw new AssembleError(`补丁应用失败：${name}`);
    }
    if (!runGit(['apply', '--reverse', '--whitespace=nowarn', patchPath], opts.piWeb).ok) {
      throw new AssembleError(`补丁反向应用失败（可往返性被破坏）：${name}`);
    }
    for (const [rel, sha] of before) {
      const now = sha256Sync(path.join(opts.piWeb, rel));
      if (now !== sha) throw new AssembleError(`补丁往返校验失败：${rel} 未还原（${sha} → ${now}）：${name}`);
    }
    if (!runGit(['apply', '--whitespace=nowarn', patchPath], opts.piWeb).ok) {
      throw new AssembleError(`补丁正式应用失败：${name}`);
    }
    console.log(`上游补丁    : ${name} → pi-web@${PI_WEB_PATCH_TAG}（往返校验通过：${files.length} 文件）`);
    applied.push(name);
  }
  return { applied, skipped: [] };
}

function revertPiWebPatches(opts, names) {
  const failed = [];
  for (const name of [...names].reverse()) {
    const r = runGit(['apply', '--reverse', '--whitespace=nowarn', path.join(opts.patchDir, name)], opts.piWeb);
    if (!r.ok) failed.push(`${name}: ${r.out}`);
  }
  return failed;
}

/**
 * PI_DIST 引导：只放「产品面文件」（package.json / next.config.ts / public / .next）。
 * node_modules **不复制**：Windows 上整树复制数万文件极慢（实测 10min+ 不可行），
 * 载荷暂存改走硬链接（linkPayloadTree，同卷零数据拷贝），直接从 pi-web/node_modules 取。
 */
async function ensurePiDist(opts) {
  const dist = opts.piDist;
  const src = opts.piWeb;
  if (!fs.existsSync(path.join(dist, 'package.json'))) {
    console.log(`PI_DIST     : 引导 ${dist}`);
    fs.mkdirSync(dist, { recursive: true });
    for (const name of ['package.json', 'next.config.ts', 'public']) {
      const from = path.join(src, name);
      if (!fs.existsSync(from)) continue;
      await fsp.cp(from, path.join(dist, name), { recursive: true, force: true });
    }
  }
}

/**
 * 硬链接一棵树（同卷 link()，失败回落 copyFile）。用于载荷暂存：
 * 暂存文件只读（tar 输入），从不就地修改，硬链接安全。
 */
async function linkInto(fromFile, toFile) {
  try {
    await fsp.unlink(toFile).catch(() => {});
    await fsp.link(fromFile, toFile);
  } catch {
    await fsp.copyFile(fromFile, toFile);
  }
}

/** 裁剪复制 PI_DIST → stage/<TAR_ROOT>（crop-rules 命中的不复制；规则目录不再下钻）。 */
async function copyCropped(fromDir, toDir, label, matchPrefix) {
  const problems = assertKeepSound();
  if (problems.length > 0) {
    for (const p of problems) console.log(`裁剪规则警告: ${p}`);
  }
  await fsp.mkdir(toDir, { recursive: true });
  const counts = new Map();
  let copiedFiles = 0;
  let copiedBytes = 0;
  let croppedFiles = 0;
  let lastReport = Date.now();

  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rawRel = rel ? `${rel}/${e.name}` : e.name;
      const childRel = matchPrefix ? matchPrefix + '/' + rawRel : rawRel;
      const childAbs = path.join(dir, e.name);
      if (e.isDirectory()) {
        let skipDir = false;
        for (const rule of CROP_RULES) {
          if (ruleMatchesDir(childRel, rule)) { skipDir = true; counts.set(rule.id, (counts.get(rule.id) || 0) + 1); break; }
        }
        if (skipDir) continue;
        const destRel = matchPrefix ? rawRel : childRel;
        await fsp.mkdir(path.join(toDir, destRel), { recursive: true });
        await walk(childAbs, rawRel);
      } else if (e.isFile()) {
        const rule = firstMatchingRule(childRel);
        if (rule) {
          croppedFiles += 1;
          counts.set(rule.id, (counts.get(rule.id) || 0) + 1);
          continue;
        }
        const destRelFile = matchPrefix ? rawRel : childRel;
        await fsp.mkdir(path.dirname(path.join(toDir, destRelFile)), { recursive: true });
        await linkInto(childAbs, path.join(toDir, destRelFile));
        copiedFiles += 1;
        if (Date.now() - lastReport > 10000) {
          lastReport = Date.now();
          console.log(`  [${label}] 已暂存 ${copiedFiles} 文件（裁掉 ${croppedFiles}）…`);
        }
      }
    }
  }

  await walk(fromDir, '');
  return { copiedFiles, croppedFiles, counts };
}
/** 用打了补丁的源码重编 pi-web，并把 .next 镜像进 PI_DIST（先清空再镜像）。 */
async function rebuildPiWebInto(opts) {
  const nextBin = path.join(opts.piWeb, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextBin)) throw new AssembleError(`找不到 next 入口：${nextBin}`);
  console.log(`载荷刷新    : PI_DIST 缺少补丁标记 ⇒ 用打了补丁的源码重新编译`);
  console.log(`              缺：${missingPatchMarkers(opts.piDist).join('｜')}`);
  console.log(`              node = ${process.execPath}；next build --webpack（cwd=${opts.piWeb}）`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [nextBin, 'build', '--webpack'], {
    cwd: opts.piWeb,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const tail = output.trim().split('\n').slice(-12).map((l) => `              │ ${l}`).join('\n');
  if (res.error || res.status !== 0) {
    throw new AssembleError(`next build 失败（status=${res.status ?? 'n/a'}）：\n${tail}`);
  }
  console.log(`              next build 完成：${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.log(tail);

  const srcNext = path.join(opts.piWeb, '.next');
  const dstNext = path.join(opts.piDist, '.next');
  fs.rmSync(dstNext, { recursive: true, force: true });
  const skip = (p) => {
    const base = path.basename(p);
    if (base === 'cache' || base === 'dev') return true;
    return base.endsWith('.nft.json');
  };
  await fsp.mkdir(dstNext, { recursive: true });
  await fsp.cp(srcNext, dstNext, { recursive: true, force: true, filter: (p) => !skip(p) });
  const copied = walkTree(dstNext).filter((f) => f.error === undefined);
  console.log(`              已镜像 .next → ${dstNext}（${copied.length} 文件 / ${human(totalBytes(copied))}）`);
  const stillMissing = missingPatchMarkers(opts.piDist);
  if (stillMissing.length > 0) {
    throw new AssembleError(`重新编译后载荷里仍找不到补丁标记：${stillMissing.join('｜')} —— 补丁没进编译产物，不能打包`);
  }
  console.log(`载荷断言    : ${PI_WEB_PATCH_MARKERS.length} 条补丁标记全部命中 ✔`);
}

// ── tar.gz（确定性 ustar 写入器；与 Kotlin 侧 PayloadArchive 解析器一一对应）────
function splitUstarName(name) {
  const bytes = (t) => Buffer.byteLength(t, 'utf8');
  const isDir = name.endsWith('/');
  const core = isDir ? name.slice(0, -1) : name;
  if (bytes(name) <= 100) return { headerName: name, prefix: '' };
  const slash = core.lastIndexOf('/');
  if (slash > 0) {
    const prefix = core.slice(0, slash);
    const base = core.slice(slash + 1);
    const headerName = isDir ? `${base}/` : base;
    if (bytes(headerName) <= 100 && bytes(prefix) <= 155) return { headerName, prefix };
  }
  return null;
}

function ustarHeader(name, size, typeflag) {
  const buf = Buffer.alloc(512, 0);
  const write = (text, offset, length) => {
    Buffer.from(text, 'utf8').copy(buf, offset, 0, length);
  };
  const plan = splitUstarName(name);
  if (plan === null) throw new AssembleError(`ustar 头容纳不下该条目名（需要 GNU 'L' 长名条目）：${name}`);
  write(plan.headerName, 0, 100);
  write('0000644\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  write('00000000000\0', 136, 12);
  write('        ', 148, 8);
  buf[156] = typeflag.charCodeAt(0);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  if (plan.prefix.length > 0) write(plan.prefix, 345, 155);
  let sum = 0;
  for (const byte of buf) sum += byte;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

function padTo512(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

function truncateUtf8Bytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > maxBytes) break;
    out += char;
  }
  return out;
}

async function writeTarGz(rootDir, outPath) {
  const files = walkTree(rootDir).filter((f) => f.error === undefined).sort((a, b) => a.rel.localeCompare(b.rel));
  const dirs = new Set();
  for (const file of files) {
    const segments = file.rel.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
  }
  const dirList = [...dirs].sort();

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const gz = createGzip({ level: 9 });
  const out = fs.createWriteStream(outPath);
  gz.pipe(out);
  let gzipError = null;
  gz.on('error', (err) => { gzipError = err; });
  const write = (chunk) => new Promise((resolve, reject) => {
    if (gzipError !== null) { reject(gzipError); return; }
    if (gz.write(chunk)) resolve();
    else gz.once('drain', resolve);
  });

  for (const dir of dirList) {
    const dirName = 'pi-web/' + `${dir}/`;
    const needsLong = splitUstarName(dirName) === null;
    if (needsLong) {
      const longName = Buffer.from('pi-web/' + dirName, 'utf8');
      await write(ustarHeader('././@LongLink', longName.length + 1, 'L'));
      await write(Buffer.concat([longName, Buffer.from([0])]));
      await write(Buffer.alloc(padTo512(longName.length + 1)));
    }
    await write(ustarHeader(needsLong ? truncateUtf8Bytes(dirName, 100) : dirName, 0, '5'));
  }
  for (const file of files) {
    const rel = file.rel;
    const needsLong = splitUstarName(rel) === null;
    if (needsLong) {
      const longName = Buffer.from('pi-web/' + rel, 'utf8');
      await write(ustarHeader('././@LongLink', longName.length + 1, 'L'));
      await write(Buffer.concat([longName, Buffer.from([0])]));
      await write(Buffer.alloc(padTo512(longName.length + 1)));
    }
    const entryName = 'pi-web/' + rel;
    await write(ustarHeader(needsLong ? truncateUtf8Bytes(entryName, 100) : entryName, file.size, '0'));
    if (file.size > 0) {
      await new Promise((resolve, reject) => {
        const source = fs.createReadStream(file.abs);
        source.on('error', reject);
        source.on('end', resolve);
        source.pipe(gz, { end: false });
      });
    }
    const padding = padTo512(file.size);
    if (padding > 0) await write(Buffer.alloc(padding));
  }
  await write(Buffer.alloc(1024));
  await new Promise((resolve, reject) => { gz.end((err) => (err ? reject(err) : resolve())); });
  await new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject); });
  return files;
}

async function assertArchiveReadable(tarPath) {
  // 归档可读性自检：用系统 bsdtar（Windows 10+ 自带 tar.exe）做**权威**逐条读取。
  // （此前自研流式检查存在对齐误报；bsdtar 是独立第三方实现，仲裁力更强。）
  const tarExe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  const res = spawnSync(tarExe, ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : String(res.stderr || '').slice(-300);
    throw new AssembleError(`归档自检失败（bsdtar 无法完整读取）：${detail}`);
  }
  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  const counters = {
    files: lines.filter((l) => !l.endsWith('/')).length,
    dirs: lines.filter((l) => l.endsWith('/')).length,
    longNames: -1,
  };
  return counters;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const opts = {
    piWeb: DEFAULT_PI_WEB,
    patchDir: DEFAULT_PATCH_DIR,
    piDist: DEFAULT_PI_DIST,
    stage: DEFAULT_STAGE,
    keepPatches: argv.includes('--keep-patches'),
  };

  console.log(`pi-desktop-android 载荷组装（${apply ? 'APPLY' : 'DRY-RUN'}）`);
  console.log(`上游        : ${opts.piWeb} @ ${PI_WEB_PATCH_TAG}`);
  console.log(`补丁目录    : ${opts.patchDir}`);
  console.log(`PI_DIST     : ${opts.piDist}`);
  console.log(`裁剪规则    :\n${describeRules().split('\n').map((l) => '  ' + l).join('\n')}`);

  const patchResult = applyPiWebPatches(opts);
  try {
    await ensurePiDist(opts);
    if (missingPatchMarkers(opts.piDist).length > 0) {
      await rebuildPiWebInto(opts);
    } else {
      console.log(`载荷断言    : 补丁标记全部在位（跳过重编）✔`);
    }

    // ④ 裁剪复制
    const stageRoot = path.join(opts.stage, TAR_ROOT);
    fs.rmSync(opts.stage, { recursive: true, force: true });
    await fsp.mkdir(stageRoot, { recursive: true });
    console.log(`裁剪暂存    : ${opts.piDist} + pi-web/node_modules → ${stageRoot}（硬链接，零数据拷贝）`);
    const cropDist = await copyCropped(opts.piDist, stageRoot, 'dist');
    const cropNm = await copyCropped(path.join(opts.piWeb, 'node_modules'), path.join(stageRoot, 'node_modules'), 'node_modules', 'node_modules');
    const crop = {
      copiedFiles: cropDist.copiedFiles + cropNm.copiedFiles,
      croppedFiles: cropDist.croppedFiles + cropNm.croppedFiles,
      counts: new Map([...cropDist.counts, ...cropNm.counts].map(([k, v]) => [k, (cropDist.counts.get(k) || 0) + (cropNm.counts.get(k) || 0)])),
    };
    console.log(`  暂存 ${crop.copiedFiles} 文件；裁掉 ${crop.croppedFiles} 文件（规则命中：${[...crop.counts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}）`);

    // ⑤ 壳资产
    for (const entry of APP_PAYLOAD_ENTRIES) {
      const from = path.join(APP_PAYLOAD_DIR, entry);
      if (!fs.existsSync(from)) throw new AssembleError(`壳资产缺失：${from}`);
      await fsp.cp(from, path.join(stageRoot, entry), { recursive: true, force: true });
    }
    console.log(`壳资产      : ${APP_PAYLOAD_ENTRIES.join(', ')} → stage`);

    // ⑤a 运行期配置 next.config.js（真机根因，2026-10-29）：载荷内不含 @next/swc-* 原生
    // 绑定，Next 运行期若加载上游 next.config.ts 会 dlopen SWC 而原生崩溃（FORTIFY
    // pthread_mutex）。CONFIG_FILES 中 .js 优先于 .ts ⇒ 放等价 CJS 配置绕开运行期 SWC。
    // 源在 payload/next.config.runtime.js（上游工作区不落地，避免污染 next build）。
    const runtimeConfigSrc = path.join(APP_PAYLOAD_DIR, 'next.config.runtime.js');
    if (!fs.existsSync(runtimeConfigSrc)) {
      throw new AssembleError(`壳资产缺失：${runtimeConfigSrc}（运行期 next.config.js 的 CJS 源）`);
    }
    await fsp.copyFile(runtimeConfigSrc, path.join(stageRoot, 'next.config.js'));
    console.log('运行期配置   : next.config.runtime.js → stage/next.config.js（绕开运行期 SWC）');

    // ⑤'' 上游 bin 资产（能力清单 §F P1-2「预览密钥轮换」）：pi-web-launch 在
    // <payloadRoot>/bin/rotate-preview-secrets.js 找它；v0.12.1 上游有此文件，
    // 早期产物未随包 ⇒ 启动日志 WARN 跳过（不轮换 = 发布包里固化着可跳闸门的密钥）。
    // 该文件不受任何补丁触碰，打补丁态/ pristine 态内容一致。
    const rotateSource = path.join(opts.piWeb, 'bin', 'rotate-preview-secrets.js');
    if (!fs.existsSync(rotateSource)) {
      throw new AssembleError(`上游缺 bin/rotate-preview-secrets.js：${rotateSource}（v0.12.1 应有；上游结构变化需人工核对 pi-web-launch 的调用契约）`);
    }
    await fsp.mkdir(path.join(stageRoot, 'bin'), { recursive: true });
    await fsp.copyFile(rotateSource, path.join(stageRoot, 'bin', 'rotate-preview-secrets.js'));
    console.log('上游 bin     : bin/rotate-preview-secrets.js → stage（预览密钥轮换随包 ✔）');

    // ⑤''' Web 侧品牌化（对标 hos 103 / ark applyWebBranding）：用户可见文案 Pi Web → Pi Desktop、
    // 页面 Logo 换父工程 assets/logo.svg、favicon/PWA 图标按物料重生成；终检 0 残留。
    // 必须在全部树操作（裁剪/壳资产/bin）之后、vendor 兼容变换与打包之前；脚本自行硬失败。
    {
      const brandScript = path.join(PROJECT_ROOT, 'scripts', 'brand-assets.mjs');
      const r = spawnSync(process.execPath, [brandScript, stageRoot], { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new AssembleError(`Web 品牌化失败（exit ${r.status ?? r.error?.message}）：${brandScript}`);
      }
    }

    // ⑤' vendor 兼容变换（O2 处置，宪法 C6 如实登记）
    //    引擎 24.2.0 = --with-intl=none：/\p{ID_Start}/ 等 Unicode 属性转义在模块**编译期**抛
    //    SyntaxError ⇒ Next 进程内启动必炸（Phase 1 E2E 实测）。对 compiled 产物做 ASCII 等价
    //    字符类替换（标识符匹配场景功能等价）；替换后断言零残留，否则 exit 2。
    const skipVendorCompat = process.argv.includes('--no-vendor-compat');
    if (skipVendorCompat) console.log('vendor 兼容  : --no-vendor-compat ⇒ 跳过（small-icu 引擎原生支持属性转义）');
    const vendorCompat = [
      { rel: 'node_modules/next/dist/compiled/@edge-runtime/primitives/url.js.text.js' },
      { rel: 'node_modules/next/dist/compiled/edge-runtime/index.js' },
      { rel: 'node_modules/next/dist/compiled/terser/bundle.min.js' },
      { rel: 'node_modules/next/dist/compiled/zod-validation-error/index.js' },
    ];
    const compatTokens = [
      { from: "\\\\p{ID_Start}", to: "A-Za-z" },
      { from: "\\p{ID_Start}", to: "A-Za-z" },
      { from: "\\\\p{ID_Continue}", to: "A-Za-z0-9" },
      { from: "\\p{ID_Continue}", to: "A-Za-z0-9" },
    ];
    let compatApplied = 0;
    for (const { rel } of vendorCompat) {
      if (skipVendorCompat) { compatApplied += 1; continue; }
      const p = path.join(stageRoot, rel);
      if (!fs.existsSync(p)) continue;
      const before = fs.readFileSync(p, 'utf8');
      if (!before.includes('\p{ID_Start}')) { compatApplied += 1; continue; }
      let after = before;
      for (const { from, to } of compatTokens) after = after.split(from).join(to);
      if (after.includes('\p{ID_Start}') || after.includes('\p{ID_Continue}')) {
        throw new AssembleError(`vendor 兼容变换后仍有属性转义残留：${rel}`);
      }
      fs.writeFileSync(p, after);
      compatApplied += 1;
    }
    if (compatApplied !== vendorCompat.length) {
      throw new AssembleError(`vendor 兼容变换覆盖不全：${compatApplied}/${vendorCompat.length}（上游产物结构变化？）`);
    }
    console.log('vendor 兼容  : ' + (skipVendorCompat ? '跳过（--no-vendor-compat）' : 'Intl 属性转义 → ASCII 等价字符类（' + compatApplied + ' 文件，O2 处置）✔'));

    const staged = walkTree(stageRoot).filter((f) => f.error === undefined);
    console.log(`stage 合计  : ${staged.length} 文件 / ${human(totalBytes(staged))}`);

    if (!apply) {
      console.log('\nDRY-RUN 结束（--apply 产出资产）');
      return;
    }

    // ⑥ 打包 + 版本
    const files = await writeTarGz(stageRoot, DEFAULT_TAR);
    const tarSize = fs.statSync(DEFAULT_TAR).size;
    const sha = await sha256File(DEFAULT_TAR);
    fs.writeFileSync(DEFAULT_VERSION, sha + '\n', 'utf8');
    console.log(`归档        : ${DEFAULT_TAR}（${files.length} 条目 / ${human(tarSize)}）`);
    console.log(`版本        : ${DEFAULT_VERSION} = ${sha}`);

    // ⑦ 可读性自检
    const readable = await assertArchiveReadable(DEFAULT_TAR);
    console.log(`归档自检    : files=${readable.files} dirs=${readable.dirs} longNames=${readable.longNames} ✔`);
  } finally {
    // ⑧ 收尾还原 pristine（除非 --keep-patches）
    if (!opts.keepPatches) {
      const failed = revertPiWebPatches(opts, patchResult.applied);
      if (failed.length > 0) {
        console.error(`⚠ 还原失败（请手工 git -C ${opts.piWeb} checkout）：\n  ${failed.join('\n  ')}`);
        process.exitCode = 2;
      } else if (patchResult.applied.length > 0) {
        console.log(`收尾还原    : pi-web 已恢复 pristine（${patchResult.applied.length} 条补丁已反向）`);
      }
      const residual = runGit(['status', '--porcelain'], opts.piWeb);
      if (residual.out.length > 0) {
        console.error(`⚠ pi-web 仍非 pristine：\n${residual.out}`);
        process.exitCode = 2;
      }
    } else {
      console.log('收尾        : --keep-patches ⇒ 保留补丁应用态');
    }
  }
}

main().catch((err) => {
  console.error(`FATAL：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
