/*
 * android-saf.js — 壳专用扩展（Pi Desktop / Android，Phase 2 SAF 桥）
 *
 * 模块格式：ESM（`export default`），由 pi 的扩展自动发现扫描拾取（落点
 * `<PI_CODING_AGENT_DIR>/extensions/android-saf.js`）。
 *
 * 背景（能力清单 §F 第 2 级 #1）：bridge 0.2.0 的 `host.register` 只支持**同步**返回，
 * 而 SAF 系统选择器/权限弹窗天然是异步的用户交互 ⇒ Kotlin 侧契约 = 「立即受理 +
 * 结果落文件」：
 *   · `host.invoke('fs.pickFolder')` 立即返回
 *     `{ok:true, async:true, requestId, resultPath:"<HOME>/saf-results/<id>.json"}`；
 *   · 用户完成/取消后 Kotlin 原子写结果 JSON；
 *   · 本扩展封装「invoke + 轮询 resultPath」为两个命令：
 *       `/saf-pick-folder [标签]` —— 选目录（ACTION_OPEN_DOCUMENT_TREE）；
 *       `/saf-pick-files  [mimeType,…]` —— 选文件（ACTION_OPEN_DOCUMENT，默认多选）。
 *
 * 为什么不仿造 POSIX 路径：SAF 返回 `content://` URI，不是文件系统路径 —— Node 的 fs
 * 读不了它（宪法 A6 不隐藏平台真相）。本扩展只如实汇报 URI/树 id/显示名与持久化状态；
 * 内容读取须走 ContentResolver（后续如需落沙箱再做 inbox 拷贝，另行立项）。
 *
 * 刻意不做的事：不在工厂里启动进程/socket/watcher/定时器（规划 §5.1）；
 * 轮询只在命令 handler 执行期间存在。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/** bridge 的 Node 侧客户端（与 pi-web-launch.js 同一份 require 目标）。 */
function loadHost() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(home, "payload", "host.js"),
    "host.js",
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      // jiti 的 CJS interop：createRequire 从目标文件位置解析（拿对模块实例）
      return createRequire(candidate)(candidate);
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 用户在系统选择器前停留的时间不可控：给足 5 分钟

/** invoke + 轮询结果文件；返回最终结果对象或 {timeout:true}。 */
async function pickAndAwait(host, capability, args) {
  const accepted = await host.invoke(capability, args ?? {});
  if (!accepted || accepted.ok !== true || accepted.async !== true) {
    // dryRun / no-activity / 其它同步结果：原样返回
    return { accepted, final: accepted ?? null };
  }
  const home = process.env.HOME || "";
  const rel = String(accepted.resultPath || "").replace("<HOME>/", "");
  const resultPath = rel ? join(home, rel) : "";
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (resultPath && existsSync(resultPath)) {
      try {
        return { accepted, final: JSON.parse(readFileSync(resultPath, "utf8")) };
      } catch (err) {
        // 半截文件（原子写不会出现，但防御）：下一轮再读
        if (!String(err?.message || "").includes("Unexpected end")) throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { accepted, final: { timeout: true, detail: `轮询超时（${POLL_TIMEOUT_MS}ms）：用户未完成选择` } };
}

function formatResult(capability, { accepted, final }) {
  if (final === null || final === undefined) {
    return `${capability} 无结果：${JSON.stringify(accepted)}`;
  }
  if (final.timeout) {
    return `⚠ ${capability}：${final.detail}`;
  }
  if (final.ok !== true) {
    return `⚠ ${capability} 未完成：${final.error ?? "unknown"}（${final.detail ?? "-"}）`;
  }
  const lines = [`✓ ${capability} 完成：`];
  if (final.uri) {
    lines.push(`  URI：${final.uri}`);
    if (final.treeDocumentId) lines.push(`  树 id：${final.treeDocumentId}`);
    if (final.displayName) lines.push(`  显示名：${final.displayName}`);
  }
  if (Array.isArray(final.uris)) {
    lines.push(`  文件数：${final.count ?? final.uris.length}`);
    for (const uri of final.uris.slice(0, 10)) lines.push(`    · ${uri}`);
    if (final.uris.length > 10) lines.push(`    …（共 ${final.uris.length} 个）`);
  }
  if (final.note) lines.push(`  说明：${final.note}`);
  return lines.join("\n");
}

async function runPick(pi, ctx, capability, args) {
  const host = loadHost();
  if (!host || typeof host.invoke !== "function") {
    const msg = "⚠ 未找到 bridge 的 host.js（HOME 未设置或载荷不完整）——SAF 桥不可用";
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    else console.error(msg);
    return;
  }
  try {
    const outcome = await pickAndAwait(host, capability, args);
    const report = formatResult(capability, outcome);
    if (ctx.hasUI) ctx.ui.notify(report, outcome.final && outcome.final.ok === true ? "info" : "warning");
    else console.log(report);
  } catch (err) {
    const msg = `⚠ ${capability} 抛错：${(err && err.message) || err}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
  }
}

export default function androidSaf(pi) {
  pi.registerCommand("saf-pick-folder", {
    description: "SAF 选择一个目录（系统选择器；结果含 content:// URI 与持久化授权）",
    handler: async (args, ctx) => {
      await runPick(pi, ctx, "fs.pickFolder", {});
    },
  });
  pi.registerCommand("saf-pick-files", {
    description: "SAF 选择文件（默认多选；参数可给 MIME 白名单，如 `text/plain,image/png`）",
    handler: async (args, ctx) => {
      const mimeTypes = String(args ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await runPick(pi, ctx, "fs.pickFiles", mimeTypes.length > 0 ? { mimeTypes } : {});
    },
  });
}
