#!/usr/bin/env node
/**
 * generate-icons.mjs — G10：把品牌 logo 物化为 Android 应用图标（幂等可重建）。
 *
 * 输入（仓库外共享资产，三端同一品牌源）：
 *   ../assets/logo-1024-with-bg.png  1024×1024 带底色满版图 → legacy 方形/圆形
 *   ../assets/logo.png               200×200 透明底标志     → adaptive 前景
 *
 * 产出：
 *   res/mipmap-<density>/ic_launcher.png       legacy 方形（48dp 基准 × 密度）
 *   res/mipmap-<density>/ic_launcher_round.png legacy 圆形（同图裁圆）
 *   res/mipmap-<density>/ic_launcher_foreground.png adaptive 前景（108dp 画布，
 *                                                  内容居中收进 72/108 安全区）
 *   res/values/ic_launcher_colors.xml          adaptive 背景色（取满版图左上像素）
 *   res/mipmap-anydpi-v26/ic_launcher{,_round}.xml  adaptive 引用（API26+）
 *
 * 依赖：Python + Pillow（不引入 Node 图像库）。
 * 用法：node scripts/generate-icons.mjs          生成
 *       node scripts/generate-icons.mjs --check  仅校验产出在位/尺寸/底色（CI）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "..", "assets");
const res = join(root, "app", "src", "main", "res");
const check = process.argv.includes("--check");
const PY = process.platform === "win32" ? "python" : "python3";

const SRC_FULL = join(assets, "logo-1024-with-bg.png").replace(/\\/g, "/");
const SRC_MARK = join(assets, "logo.png").replace(/\\/g, "/");

// legacy 图标边长（px）= 48dp × 密度倍率
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
// adaptive 前景画布 108dp × 密度倍率：mdpi108 … xxxhdpi432
const FG = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const COLORS_PATH = join(res, "values", "ic_launcher_colors.xml");
const ANYDPI_DIR = join(res, "mipmap-anydpi-v26");

const pyPath = (p) => p.replace(/\\/g, "\\\\");

function py(script) {
  return execFileSync(PY, ["-c", script], { encoding: "utf8" }).trim();
}

// ── 位图：legacy 方形/圆形 + adaptive 前景（一次 Python 调用完成）─────────────
function rasterize() {
  const legacy = Object.entries(LEGACY).map(([d, s]) => ({
    size: s,
    square: join(res, `mipmap-${d}`, "ic_launcher.png"),
    round: join(res, `mipmap-${d}`, "ic_launcher_round.png"),
  }));
  const fg = Object.entries(FG).map(([d, s]) => ({
    size: s, path: join(res, `mipmap-${d}`, "ic_launcher_foreground.png"),
  }));
  const payload = { full: SRC_FULL, mark: SRC_MARK, fg, legacy };
  const code = `
import sys, os, json
from PIL import Image, ImageDraw
j=json.loads(sys.stdin.read())
full=Image.open(j["full"]).convert("RGBA")
mark=Image.open(j["mark"]).convert("RGBA")
def dirmk(p): os.makedirs(os.path.dirname(p),exist_ok=True)
for it in j["legacy"]:
    s=it["size"]
    dirmk(it["square"]); full.resize((s,s),Image.LANCZOS).save(it["square"],"PNG")
    base=full.resize((s,s),Image.LANCZOS)
    mask=Image.new("L",(s,s),0); ImageDraw.Draw(mask).ellipse((0,0,s-1,s-1),fill=255)
    out=Image.new("RGBA",(s,s),(0,0,0,0)); out.paste(base,(0,0),mask)
    dirmk(it["round"]); out.save(it["round"],"PNG")
# adaptive 前景：108dp 画布，标志居中收进 72/108 安全区
for it in j["fg"]:
    C=it["size"]; inner=int(round(C*72/108))
    canvas=Image.new("RGBA",(C,C),(0,0,0,0))
    m=mark.resize((inner,inner),Image.LANCZOS)
    canvas.paste(m,((C-inner)//2,(C-inner)//2),m)
    dirmk(it["path"]); canvas.save(it["path"],"PNG")
print("ok")`;
  execFileSync(PY, ["-c", code], { input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  return legacy;
}

function backgroundHex() {
  return py(`from PIL import Image
im=Image.open(r'''${pyPath(SRC_FULL)}''').convert("RGBA")
print("%02x%02x%02x"%im.getpixel((2,2))[:3])`);
}

function writeXml(bgHex) {
  mkdirSync(dirname(COLORS_PATH), { recursive: true });
  mkdirSync(ANYDPI_DIR, { recursive: true });
  writeFileSync(COLORS_PATH,
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!-- G10 自动生成：adaptive 图标品牌底色（取 logo-1024-with-bg.png 左上像素）。勿手改。 -->\n` +
    `<resources>\n    <color name="ic_launcher_background">#${bgHex}</color>\n</resources>\n`);
  const adaptive =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!-- G10 自动生成：adaptive icon（API26+）。勿手改；scripts/generate-icons.mjs 产出。 -->\n` +
    `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n` +
    `    <background android:drawable="@color/ic_launcher_background" />\n` +
    `    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n` +
    `</adaptive-icon>\n`;
  writeFileSync(join(ANYDPI_DIR, "ic_launcher.xml"), adaptive);
  writeFileSync(join(ANYDPI_DIR, "ic_launcher_round.xml"), adaptive);
}

function sha(p) { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12); }

// ── --check：在位 + 尺寸 + 底色一致 ──────────────────────────────────────────
function doCheck() {
  const expect = [];
  for (const [d, s] of Object.entries(LEGACY)) expect.push([join(res, `mipmap-${d}`, "ic_launcher.png"), s], [join(res, `mipmap-${d}`, "ic_launcher_round.png"), s]);
  for (const [d, s] of Object.entries(FG)) expect.push([join(res, `mipmap-${d}`, "ic_launcher_foreground.png"), s]);
  expect.push([COLORS_PATH, null], [join(ANYDPI_DIR, "ic_launcher.xml"), null], [join(ANYDPI_DIR, "ic_launcher_round.xml"), null]);
  const missing = expect.filter(([p]) => !existsSync(p)).map(([p]) => p);
  if (missing.length) { console.error("[icons] 缺失产出：\n - " + missing.join("\n - ")); process.exit(1); }
  const bad = [];
  for (const [p, want] of expect) {
    if (!want) continue;
    const got = Number(py(`from PIL import Image;print(Image.open(r'''${pyPath(p)}''').size[0])`));
    if (got !== want) bad.push(`${p}: ${got}≠${want}`);
  }
  if (bad.length) { console.error("[icons] 尺寸不符：\n - " + bad.join("\n - ")); process.exit(1); }
  console.log(`[icons] --check ✅ ${Object.keys(LEGACY).length} 密度方形/圆 + adaptive 前景 + XML 全在位；底色 #${backgroundHex()}；样例 sha ${sha(expect[0][0])}`);
}

if (check) { doCheck(); }
else {
  if (!existsSync(SRC_FULL) || !existsSync(SRC_MARK)) throw new Error(`缺源图：${SRC_FULL} / ${SRC_MARK}`);
  rmSync(join(res, "mipmap-anydpi-v26"), { recursive: true, force: true });
  rasterize();
  writeXml(backgroundHex());
  console.log("[icons] 生成完成：");
  console.log("  legacy 方形/圆形：5 密度（48→192px）");
  console.log("  adaptive 前景：5 密度（108dp×倍率）+ anydpi-v26 XML ×2，底色 #" + backgroundHex());
  console.log("  → AndroidManifest <application android:icon=\"@mipmap/ic_launcher\" android:roundIcon=\"@mipmap/ic_launcher_round\">");
}
