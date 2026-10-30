#!/usr/bin/env node
/**
 * brand-assets.mjs — Web 载荷品牌化（对标 pi-desktop-hos 的 103-branding /
 * pi-desktop-ark assemble-payload 内联的 applyWebBranding）。
 *
 * ## 为什么需要它
 *
 * 应用图标（launcher / adaptive / 通知小图标）已由 `generate-icons.mjs` 从父工程物料生成，
 * 应用显示名在 `res/values/strings.xml` 定稿为 `Pi Desktop`、`PI_WEB_APP_NAME=Pi Desktop`
 * 已在 Kotlin 侧注入。但 **pi-web 构建产物本身仍带上游品牌**：
 *   · 预渲染 HTML / RSC / 客户端 chunk 里的用户可见文案 `Pi Web`；
 *   · `public/icons/` 的 favicon / PWA 图标（192/512）/ apple-touch-icon；
 *   · 页面 hero / 登录页 Logo（`<img src="/icons/apple-touch-icon.png">`）。
 * 上游 `../pi-web` 一个字节都不能改（零补丁纪律），所以只能在**载荷暂存副本**上换。
 *
 * ## 物料（唯一来源 = 父工程 `../assets`，缺失/不可解析 ⇒ 硬失败，绝不产出无品牌包）
 *
 * | 文件 | 硬校验 | 用途 |
 * |---|---|---|
 * | `logo.svg` | 含 `<svg` 与 `viewBox` | 页面 Logo（逐字节复制为 public/icons/logo.svg，矢量任意尺寸清晰） |
 * | `logo.png` | 200×200、真含透明像素 | 透明标记下采样：icon-192(192²) / apple-touch-icon(180²) / favicon 路由体(192²) |
 * | `logo-1024-with-bg.png` | 1024×1024、真不透明 | PWA 大图标 icon-512(512²)，带底更像应用图标（不放大 200²） |
 *
 * ## 为什么用 Python + Pillow（与 generate-icons.mjs 同口径）
 *
 * 不引入 Node 图像依赖；本机 Python 环境已有 Pillow。图标生成确定性：Lanczos 重采样 +
 * 固定尺寸，同物料重复执行字节稳定。
 *
 * ## 判据（硬失败）
 *
 * 替换后暂存树 `node_modules/` 之外 **0 处** 用户可见 `Pi Web`；index/login 预渲染文档
 * 必须含 `Pi Desktop`；技术标识符（`pi-web` / `@agegr/pi-web` / `PI_WEB_` / `pi_web_session` /
 * `PiWeb`）出现次数不得改变。任一不满足 ⇒ exit 1（构建失败优于发半品牌包）。
 *
 * CLI：
 *   node scripts/brand-assets.mjs <stageRoot>          # 对载荷暂存根执行品牌化
 *   node scripts/brand-assets.mjs --check <stageRoot>  # 只终检不改写（CI）
 *   物料目录可用 --assets <dir> 或 PI_ASSETS_DIR 覆盖（默认 ../assets）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = "[brand]";

/** 文案：pi-web 显示名 → 本工程显示名。只替换**带空格、首字母大写**的用户可见串。 */
const BRAND_FROM = "Pi Web";
const BRAND_TO = "Pi Desktop";

/**
 * 页面 Logo 的 `<img src>` 路径替换（三种编译形态，实测上游产物）：
 * RSC/JSON `"src"`、客户端 chunk `src:`、SSR HTML `src="`。
 * 不动 `rel="apple-touch-icon"` 的 `href` 元数据与 sw.js 预缓存（PNG 仍生成、仍被引用）。
 */
const LOGO_SRC_REPLACEMENTS = [
  ['"src":"/icons/apple-touch-icon.png"', '"src":"/icons/logo.svg"'],
  ['src:"/icons/apple-touch-icon.png"', 'src:"/icons/logo.svg"'],
  ['src="/icons/apple-touch-icon.png"', 'src="/icons/logo.svg"'],
];

/**
 * 技术标识符（FR-brand-005）：替换前后出现次数必须逐项不变。
 * 带空格的 `Pi Web` 不可能包含这些连字符/下划线/驼峰标识，这里是防未来改坏的回归断言。
 */
const TECH_IDENTIFIERS = ["pi-web", "@agegr/pi-web", "pi_web_session", "PI_WEB_", "PiWeb"];

/** 单文本文件上限（防御：不把巨型 sourcemap 读进内存；.map 本就跳过）。 */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

const PY = process.platform === "win32" ? "python" : "python3";

function fail(message) {
  console.error(`\n${LOG} ✖ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { check: false, assetsDir: null, stageRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--assets") args.assetsDir = argv[++i];
    else if (!a.startsWith("--")) args.stageRoot = resolve(a);
  }
  if (!args.assetsDir) args.assetsDir = process.env.PI_ASSETS_DIR || resolve(PROJECT_ROOT, "..", "assets");
  return args;
}

// ---------------------------------------------------------------- 物料校验

function pngInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 26 || buf.subarray(1, 4).toString("latin1") !== "PNG") return null;
  return {
    bytes: buf.length,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25], // 0 灰度 2 RGB 3 调色 4 灰度+alpha 6 RGBA
  };
}

/** 用 Pillow 读真实最小 alpha（0–255）；不依赖文件扩展名。 */
function minAlphaPy(file) {
  const code = [
    "import sys",
    "from PIL import Image",
    `im = Image.open(${JSON.stringify(file)}).convert('RGBA')`,
    "a = im.getchannel('A')",
    "print(min(a.getdata()))",
  ].join(";");
  return Number(execFileSync(PY, ["-c", code], { encoding: "utf8" }).trim());
}

/** 确保 Pillow 可用（与 generate-icons.mjs 同一依赖口径）。 */
function ensurePillow() {
  try {
    execFileSync(PY, ["-c", "import PIL"], { stdio: "ignore" });
  } catch {
    fail("未找到 Python/Pillow（Web 图标生成必需）。安装：pip install Pillow（generate-icons.mjs 同依赖）。");
  }
}

function loadMaterial(assetsDir) {
  if (!existsSync(assetsDir)) {
    fail(`物料目录不存在：${assetsDir}\n  品牌化依赖父工程 assets/（logo.svg / logo.png / logo-1024-with-bg.png）。\n  可用 --assets <dir> 或 PI_ASSETS_DIR 指定。`);
  }
  const svgSrc = join(assetsDir, "logo.svg");
  const markSrc = join(assetsDir, "logo.png");
  const masterSrc = join(assetsDir, "logo-1024-with-bg.png");
  for (const [label, file] of [
    ["矢量 logo.svg", svgSrc],
    ["透明标记 logo.png", markSrc],
    ["不透明母版 logo-1024-with-bg.png", masterSrc],
  ]) {
    if (!existsSync(file)) fail(`物料缺失：${label} → ${file}`);
  }

  const svgText = readFileSync(svgSrc, "utf8");
  if (!/<svg[\s>]/i.test(svgText) || !/viewBox\s*=/.test(svgText)) {
    fail(`矢量物料不像合法 SVG（需要 <svg …> 与 viewBox）：${svgSrc}`);
  }
  const mark = pngInfo(markSrc);
  const master = pngInfo(masterSrc);
  if (!mark) fail(`物料不是 PNG：${markSrc}`);
  if (!master) fail(`物料不是 PNG：${masterSrc}`);
  if (!(mark.colorType === 4 || mark.colorType === 6)) {
    fail(`logo.png 必须带 alpha 通道（colorType 4/6）：${markSrc}（实际 ${mark.colorType}）`);
  }
  if (mark.width < 200 || mark.height < 200) {
    fail(`透明标记尺寸不足（至少 200×200，供 192/180 下采样）：${markSrc}（实际 ${mark.width}×${mark.height}）`);
  }
  if (master.width !== 1024 || master.height !== 1024) {
    fail(`不透明母版必须是 1024×1024：${masterSrc}（实际 ${master.width}×${master.height}）`);
  }
  const markMinAlpha = minAlphaPy(markSrc);
  if (markMinAlpha === 255) {
    fail(`透明标记不含任何透明像素（minAlpha=255）：${markSrc}\n  favicon/小图标依赖透明底，请提供带透明背景的 logo.png。`);
  }
  const masterMinAlpha = minAlphaPy(masterSrc);
  if (masterMinAlpha !== 255) {
    fail(`不透明母版含透明像素（minAlpha=${masterMinAlpha}）：${masterSrc}\n  PWA 512² 图标要求不透明；请使用 logo-1024-with-bg.png。`);
  }
  console.log(`${LOG} 物料：${assetsDir}`);
  console.log(`${LOG}   svg（viewBox 已校验）｜透明标记 ${mark.width}×${mark.height}（minAlpha=${markMinAlpha}）｜不透明母版 1024²（minAlpha=255）`);
  return { assetsDir, svgSrc, markSrc, masterSrc };
}

// ---------------------------------------------------------------- 位图生成（Pillow）

/**
 * 用 Pillow 重采样落盘 PNG。
 * @param {string} src 源图
 * @param {string} dst 目标
 * @param {{width:number,height:number,alpha:boolean}} opt alpha=false 输出 RGB（无 alpha 通道）
 */
function scaleTo(src, dst, { width, height, alpha }) {
  mkdirSync(dirname(dst), { recursive: true });
  // 载荷暂存为硬链接：Pillow 直接保存到同名路径会截断共享 inode、穿透污染
  // build/pi-dist 源。保存前先断开本目录项（源目录的链接仍指向旧 inode）。
  if (existsSync(dst)) unlinkSync(dst);
  const code = [
    "import sys",
    "from PIL import Image",
    `im = Image.open(${JSON.stringify(src)})`,
    `im = im.convert(${alpha ? "'RGBA'" : "'RGB'"})`,
    `im = im.resize((${width}, ${height}), Image.LANCZOS)`,
    `im.save(${JSON.stringify(dst)}, format='PNG')`,
  ].join(";");
  try {
    execFileSync(PY, ["-c", code], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fail(`Pillow 生成失败：${dst}\n  源：${src}（${width}×${height}，${alpha ? "RGBA" : "RGB"}）\n  ${String(error.stderr ?? error.message).trim()}`);
  }
  const info = pngInfo(dst);
  if (!info) fail(`生成结果不是 PNG：${dst}`);
  if (info.width !== width || info.height !== height) fail(`生成尺寸不符：${dst} → ${info.width}×${info.height}（期望 ${width}×${height}）`);
  if (!alpha && info.colorType !== 2) {
    fail(`不透明图标必须是 RGB PNG（colorType=2）：${dst}（实际 ${info.colorType}，调色板+tRNS 也不接受）`);
  }
}

// ---------------------------------------------------------------- 文本替换

/** 二进制判定：前 8 KiB 有 NUL 即跳过；整文件须可按 UTF-8 解码。 */
function isProbablyText(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  for (const byte of head) if (byte === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * 品牌文案 + Logo `<img src>` 路径替换（整个暂存根，跳过 node_modules 与 .map）。
 * 同时统计技术标识符替换前后次数（必须逐项不变）。
 */
function replaceBrandInTree(stageRoot) {
  const stats = {
    scanned: 0, changed: 0, skippedLarge: 0, skippedBinary: 0,
    brand: 0, logoPath: 0, techBefore: 0, techAfter: 0,
  };
  for (const file of walkFiles(stageRoot)) {
    const rel = relative(stageRoot, file).replaceAll("\\", "/");
    // 第三方代码：技术面，按 FR-brand-005 保留（其中可能含 "Pi Web" 字样也不动）
    if (rel.split("/").includes("node_modules")) continue;
    if (file.endsWith(".map")) continue;

    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size === 0) continue;
    if (size > MAX_TEXT_BYTES) {
      stats.skippedLarge += 1;
      continue;
    }
    const buf = readFileSync(file);
    if (!isProbablyText(buf)) {
      stats.skippedBinary += 1;
      continue;
    }
    stats.scanned += 1;
    const text = buf.toString("utf8");
    for (const id of TECH_IDENTIFIERS) stats.techBefore += countOccurrences(text, id);

    let next = text;
    let brandHits = 0;
    let logoHits = 0;
    if (next.includes(BRAND_FROM)) {
      brandHits = countOccurrences(next, BRAND_FROM);
      next = next.split(BRAND_FROM).join(BRAND_TO);
    }
    for (const [from, to] of LOGO_SRC_REPLACEMENTS) {
      if (!next.includes(from)) continue;
      logoHits += countOccurrences(next, from);
      next = next.split(from).join(to);
    }

    for (const id of TECH_IDENTIFIERS) stats.techAfter += countOccurrences(next, id);
    if (brandHits === 0 && logoHits === 0) continue;
    // 载荷暂存走**硬链接**（copyCropped 的 link()）：直接 writeFileSync 会截断共享
    // inode，把品牌化穿透污染回 build/pi-dist 源。先写临时文件再 rename 替换本目录项，
    // rename 在同卷是原子的，且只换暂存这一个名字，源目录仍指向旧 inode ⇒ 断开链接。
    const tmp = `${file}.brand-tmp`;
    writeFileSync(tmp, next, "utf8");
    try {
      renameSync(tmp, file);
    } catch (err) {
      unlinkSync(tmp);
      throw err;
    }
    stats.brand += brandHits;
    stats.logoPath += logoHits;
    stats.changed += 1;
  }
  return stats;
}

/** 终检：node_modules 之外不得残留用户可见 `Pi Web`。 */
function findBrandLeftovers(stageRoot) {
  const hits = [];
  for (const file of walkFiles(stageRoot)) {
    const rel = relative(stageRoot, file).replaceAll("\\", "/");
    if (rel.split("/").includes("node_modules")) continue;
    if (file.endsWith(".map")) continue;
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_TEXT_BYTES) continue;
    if (!isProbablyText(buf)) continue;
    const count = countOccurrences(buf.toString("utf8"), BRAND_FROM);
    if (count > 0) hits.push(`${rel}（${count} 处）`);
  }
  return hits;
}

// ---------------------------------------------------------------- 主流程

function writeWebIcons(stageRoot, material) {
  const publicIcons = join(stageRoot, "public", "icons");
  if (!existsSync(publicIcons)) {
    fail(`载荷暂存缺 public/icons：${publicIcons}\n  pi-dist 引导应已复制 public/；上游产物结构变化请核对 assemble-payload。`);
  }
  // ① 页面 Logo（矢量）—— 与物料逐字节一致，不经光栅化；先断开硬链接再复制
  const logoDst = join(publicIcons, "logo.svg");
  if (existsSync(logoDst)) unlinkSync(logoDst);
  copyFileSync(material.svgSrc, logoDst);
  // ② 透明标记下采样（只缩小不放大）
  scaleTo(material.markSrc, join(publicIcons, "icon-192.png"), { width: 192, height: 192, alpha: true });
  scaleTo(material.markSrc, join(publicIcons, "apple-touch-icon.png"), { width: 180, height: 180, alpha: true });
  // ③ PWA 大图标：不透明母版下采样到 512²
  scaleTo(material.masterSrc, join(publicIcons, "icon-512.png"), { width: 512, height: 512, alpha: false });
  // ④ favicon：Next 把 app/favicon.ico 编译为路由体（内容实为 512² PNG 字节，扩展名保留 .ico）。
  //    写 192² 透明 PNG 字节（与 hos 同形；上游源 favicon 本就是 PNG）。
  const faviconBody = join(stageRoot, ".next", "server", "app", "favicon.ico.body");
  if (!existsSync(faviconBody)) {
    fail(`未找到 favicon 路由体：${faviconBody}\n  pi-web 构建产物结构可能已变（favicon 路径）；请更新 brand-assets.mjs，不得静默沿用上游图标。`);
  }
  scaleTo(material.markSrc, faviconBody, { width: 192, height: 192, alpha: true });
  console.log(`${LOG} web 图标：logo.svg（逐字节）｜icon-192 192² alpha｜apple-touch 180² alpha｜icon-512 512² 不透明｜favicon 路由体 192² alpha`);
}

/** index/login 预渲染文档断言（hos FR-brand 同判据）。 */
function assertPrerenderedHtml(stageRoot) {
  for (const rel of [".next/server/app/index.html", ".next/server/app/login.html"]) {
    const file = join(stageRoot, rel);
    if (!existsSync(file)) {
      // login.html 在某些上游版本可能不预渲染；只对存在的文档做断言，index 必须在
      if (rel.endsWith("index.html")) fail(`品牌化断言失败：缺少预渲染文档 ${rel}（上游产物结构已变）`);
      continue;
    }
    const html = readFileSync(file, "utf8");
    const remaining = countOccurrences(html, BRAND_FROM);
    if (remaining > 0) fail(`品牌化断言失败：${rel} 仍含 ${remaining} 处「${BRAND_FROM}」（替换规则需更新）`);
    if (!html.includes(BRAND_TO)) fail(`品牌化断言失败：${rel} 未出现「${BRAND_TO}」`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stageRoot) fail("用法：node scripts/brand-assets.mjs [--check] [--assets <dir>] <stageRoot>");
  const stageRoot = args.stageRoot;
  if (!existsSync(stageRoot)) fail(`载荷暂存根不存在：${stageRoot}`);
  ensurePillow();

  if (args.check) {
    // CI 终检：只看残留（图标在位/尺寸由 generate-icons 的 G10 与本脚本生成日志保证；
    // 这里聚焦「不出半品牌包」的文本判据）。
    const leftovers = findBrandLeftovers(stageRoot);
    if (leftovers.length > 0) {
      fail(`品牌化终检失败：node_modules 之外仍有 ${leftovers.length} 个文件含「${BRAND_FROM}」\n  ${leftovers.slice(0, 20).join("\n  ")}`);
    }
    console.log(`${LOG} ✔ --check 通过：暂存树（排除 node_modules）「${BRAND_FROM}」= 0 处`);
    return;
  }

  const material = loadMaterial(args.assetsDir);
  writeWebIcons(stageRoot, material);

  const stats = replaceBrandInTree(stageRoot);
  console.log(`${LOG} web 文案替换：扫描 ${stats.scanned} 文本，改写 ${stats.changed} 个文件（文案 ${stats.brand} 处、Logo 路径 ${stats.logoPath} 处；跳过二进制 ${stats.skippedBinary}、超大 ${stats.skippedLarge}）`);
  if (stats.brand === 0) console.warn(`${LOG} ⚠ 本次未改写任何「${BRAND_FROM}」（重复运行或上游已自行改名）`);
  if (stats.techBefore !== stats.techAfter) {
    fail(`品牌化断言失败：技术标识符计数被改变（${stats.techBefore} → ${stats.techAfter}）——替换误伤，请检查规则。`);
  }

  assertPrerenderedHtml(stageRoot);
  const leftovers = findBrandLeftovers(stageRoot);
  if (leftovers.length > 0) {
    fail(`品牌化终检失败：node_modules 之外仍有 ${leftovers.length} 个文件含「${BRAND_FROM}」\n  ${leftovers.slice(0, 20).join("\n  ")}`);
  }
  console.log(`${LOG} ✔ 断言通过：index/login 无「${BRAND_FROM}」且含「${BRAND_TO}」；技术标识符计数未变（${stats.techAfter}）；全树终检 0 处残留`);
}

main();
