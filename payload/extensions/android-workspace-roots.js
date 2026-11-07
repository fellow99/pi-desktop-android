/*
 * android-workspace-roots.js — 壳专用扩展（Pi Desktop / Android）
 *
 * 模块格式：**ESM**（`export default`），由 pi 的扩展自动发现扫描拾取
 * （落点 `<PI_CODING_AGENT_DIR>/extensions/android-workspace-roots.js`，无需在
 * settings.json 里声明）。
 *
 * 对标 ark 的 `harmony-workspace-roots.js`（需求 203 的 Android 形态）：
 *   · 根清单来源 = 宿主注入的 `PI_ANDROID_ROOTS`（由 Kotlin 侧 `PiDesktopRuntime`
 *     按 `env.js` 契约装配）；本扩展只**消费**，不猜路径。
 *   · Android（需求 203 方案 A）声明**三个**根：沙箱（app-specific 外存 workspace，
 *     免权限）+ 文档/下载（共享存储 POSIX 路径，经 G7.1 特例 All-files/运行时授权）。
 *   · 授权状态：共享存储是否可用以**实际可读性（readdir）**为准——权限 API 有假阴性，
 *     真实可读才是「现在能不能用」的唯一事实。
 *
 * 提供能力：`/roots` 命令 —— 摊开每个根的解析结果、存在性与可读性。
 *
 * 刻意不做的事（与工程规划 §5.1 权限模型一致）：不在工厂里启动进程、socket、
 * watcher 或定时器。
 */

import { readdirSync, statSync } from "node:fs";

/** 宿主写入的根清单环境变量名（与 `payload/env.js`、Kotlin 侧同一字面量）。 */
const ROOTS_ENV = "PI_ANDROID_ROOTS";

/** 本版期望的根 id（需求 203 方案 A：三根）。 */
const EXPECTED_IDS = ["sandbox", "documents", "download"];

function lines(...parts) {
  return parts.filter((p) => p !== undefined && p !== null).join("\n");
}

/** @returns {{ roots: Array, error: string|null }} */
function readRoots() {
  const raw = process.env[ROOTS_ENV];
  if (!raw) {
    return { roots: [], error: `${ROOTS_ENV} 未设置：宿主（PiDesktopRuntime）未注入根清单` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { roots: [], error: `${ROOTS_ENV} 不是合法 JSON：${err && err.message}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { roots: [], error: `${ROOTS_ENV} 不是非空数组` };
  }
  return { roots: parsed, error: null };
}

/** 探测单个根：存在性 + 可读性（readdir 一次），不抛错。 */
function probeRoot(root) {
  const path = String(root && root.path ? root.path : "");
  if (!path) return { exists: false, readable: false, detail: "路径为空" };
  try {
    if (!statSync(path).isDirectory()) return { exists: true, readable: false, detail: "存在但不是目录" };
  } catch (err) {
    return { exists: false, readable: false, detail: `不可访问：${err && err.code}` };
  }
  try {
    readdirSync(path);
    return { exists: true, readable: true, detail: "可读" };
  } catch (err) {
    return { exists: true, readable: false, detail: `存在但不可读：${err && err.code}` };
  }
}

/** 权限/授权状态（Android 需求 203 方案 A）。 */
function permissionStatus(permType, probe) {
  if (!permType) return "不适用（app-specific 目录，无 OS 权限门槛）";
  if (probe && probe.readable) return "共享存储已可读（All-files / 运行时存储权限生效；以实际可读为准）";
  return "共享存储未授权（All-files/运行时存储权限；以实际可读为准）—— 未授权时选择器显示「请求权限 / 刷新」";
}

function buildReport() {
  const { roots, error } = readRoots();
  const heading = "工作区主目录（Android · 选择工作区目录 · 需求 203 方案 A）";

  if (error) {
    return lines(
      heading,
      `  ⚠ ${error}`,
      "",
      "  本版期望的主目录：沙箱 / 文档 / 下载。",
      "  选择器顶部缺 Tab 时先查这里。",
    );
  }

  const ids = roots.map((r) => r && r.id);
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const table = roots.map((root) => {
    const probe = probeRoot(root);
    return lines(
      `  · ${root.label || root.id}（id=${root.id}）`,
      `      路径：${root.path}`,
      `      状态：${probe.detail}`,
      `      授权：${permissionStatus(root.permType, probe)}`,
    );
  });

  return lines(
    heading,
    `  来源：环境变量 ${ROOTS_ENV}（宿主启动期注入）`,
    `  数量：${roots.length} / 期望 ${EXPECTED_IDS.length}`,
    missing.length ? `  ⚠ 缺少主目录：${missing.join(", ")}` : "  ✓ 主目录齐备",
    "",
    ...table,
    "",
    "  说明：",
    "    · 沙箱根 = app-specific 外存 workspace 目录（getExternalFilesDir 派生；免权限、真实 POSIX 路径）。",
    "    · 文档/下载根 = 共享存储 POSIX 路径（/storage/emulated/0/{Documents,Download}），授权经 G7.1 特例",
    "      （需求 203 方案 A：API30+ All-files 设置页 / API24-29 运行时权限）。",
    "    · 共享存储是否可用**以实际可读（readdir）为准**，不依赖权限 API 返回值（防假阴性）。",
  );
}

export default function androidWorkspaceRoots(pi) {
  pi.registerCommand("roots", {
    description: "显示工作区主目录（沙箱）的解析结果与可读性",
    handler: async (_args, ctx) => {
      const report = buildReport();
      if (ctx.hasUI) {
        ctx.ui.notify(report, "info");
      } else {
        console.log(report);
      }
    },
  });
}
