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
 *   · Android v1 只声明 `sandbox` 一个根（app-specific 外存真实路径，免权限）；
 *     文档/下载等共享目录走 SAF 授权桥（Phase 2，届时经宿主桥 `perm.*` 能力接入），
 *     本版**不声明**、不提示授权窗（避免误导）。
 *   · 权限状态：bridge 0.2.0 的 Node 侧 `host.js` 没有 perm 查询能力 ⇒ 如实显示
 *     「不适用/不可判定」，绝不猜。
 *
 * 提供能力：`/roots` 命令 —— 摊开每个根的解析结果、存在性与可读性。
 *
 * 刻意不做的事（与工程规划 §5.1 权限模型一致）：不在工厂里启动进程、socket、
 * watcher 或定时器。
 */

import { readdirSync, statSync } from "node:fs";

/** 宿主写入的根清单环境变量名（与 `payload/env.js`、Kotlin 侧同一字面量）。 */
const ROOTS_ENV = "PI_ANDROID_ROOTS";

/** 本版期望的根 id（Android v1 只有沙箱根；SAF 授权树随 Phase 2 扩展）。 */
const EXPECTED_IDS = ["sandbox"];

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

/** 权限状态（Android v1：沙箱根免权限；其余形态 Phase 2 经宿主桥接入）。 */
function permissionStatus(permType) {
  if (!permType) return "不适用（app-specific 目录，无 OS 权限门槛）";
  return "不可判定（SAF 授权桥随 Phase 2 接入；本版不声明共享存储根）";
}

function buildReport() {
  const { roots, error } = readRoots();
  const heading = "工作区主目录（Android v1 · 选择工作区目录）";

  if (error) {
    return lines(
      heading,
      `  ⚠ ${error}`,
      "",
      "  本版期望的主目录：沙箱（app-specific 外存 workspace 目录）。",
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
      `      授权：${permissionStatus(root.permType)}`,
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
    "    · 共享存储（文档/下载等）走 SAF 持久化授权桥，随 Phase 2 接入（本版不声明）。",
    "    · 不申请 MANAGE_EXTERNAL_STORAGE（合规红线，规划 §17 G7）。",
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
