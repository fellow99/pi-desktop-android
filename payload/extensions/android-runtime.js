/*
 * ⚠️ 模块格式：本文件是 **ESM**（`export default`），与 payload 根下的 CJS 装载链（bootstrap → require）不同。
 * 依据：pi 的扩展加载走 **jiti**（扩展名表含 .js/.mjs/.cjs/.ts），ESM 形态已在旧壳真机验证；
 * 因此与 `pi-desktop-hos/extensions/android-runtime.js` **逐字一致**（工程规划 §8.3「原样搬」）。
 * V2 差异（F1 本轮修正）：报告里原来写「Electron 主进程内（无子进程）」——V2 里 Node 由库在
 * **应用自己的进程**内托管（`dlopen` + `node::Start`，仍然没有子进程），故文案改为 V2 事实。
 */
/**
 * android-runtime.js — 壳专用扩展（Pi Desktop / Android）
 *
 * 本扩展是**根级单文件扩展**，由 pi 的扩展自动发现扫描拾取（落点
 * `<userData>/pi-agent/extensions/android-runtime.js`），无需在 settings.json 里声明。
 * 骨架刻意保持最小：它同时充当「PL1 插件机制是否生效」的自检探针 —— 导入即注册，
 * 不依赖任何原生模块或子进程（工程规划 §5.4）。
 *
 * 提供的能力：
 *   ① `/android-info` 命令 —— 打印本构建的运行时事实与能力边界，便于用户与模型自查。
 *   ② `session_start` 钩子 —— 校验 shell 绝对路径存在；缺失时只记一条清晰警告，
 *      **绝不抛错**（保活/环境类失败不应连带影响会话启动）。
 *
 * 刻意不做的事（与工程规划 §5.1 的权限模型一致）：不在工厂里启动进程、socket、watcher
 * 或定时器 —— pi 有不启会话就加载扩展的调用路径（`pi --help` 等），在工厂里起长驻资源
 * 会在那些路径上泄漏。
 *
 * 注意：本扩展运行在 pi 进程内，拥有与应用相同的操作系统权限。它只读环境变量，
 * 不读凭据、不改会话状态。
 */

import { existsSync } from "node:fs";

/** 设备上唯一保证存在的 POSIX shell（mksh R59）。与 config/settings.json 的 shellPath 一致。 */
const HARMONY_SHELL = "/system/bin/sh";

/** pi 内建工具的可用性（依据设备实测与 PI_OFFLINE=1 的下载禁令）。 */
const TOOL_FACTS = [
  { name: "read / write / edit", ok: true, why: "纯 Node.js" },
  { name: "ls", ok: true, why: "纯 Node.js（fs.readdir）" },
  {
    name: "bash",
    ok: true,
    why: `由 harmony-exec.js 顶替内建实现：spawn ${HARMONY_SHELL}（mksh R59）常驻 + 随机哨兵行协议。`
      + " 命令以应用身份运行、无 PTY；默认 120 s 超时；stderr 合并；每条命令在子 shell 内执行"
      + "（`cd`/变量不跨调用保留）；**命令不受文件围栏保护**。",
  },
  {
    name: "find / grep",
    ok: true,
    why: "由 harmony-search.js 顶替内建实现：纯 JS 遍历，不再需要 fd / ripgrep（设备上不存在且 PI_OFFLINE=1 禁止下载）。"
      + " 跳过点目录与 node_modules/.git（不解析 .gitignore），并显式报告各类上限。",
  },
  { name: "powershell", ok: false, why: "Windows 专用工具" },
  { name: "codemode", ok: null, why: "需 worker_threads + QuickJS wasm —— 未实测" },
];

function lines(...rows) {
  return rows.filter(Boolean).join("\n");
}

/**
 * 组装运行时事实报告。
 *
 * 只用 `process.env` 与 `ctx` —— pi 的 `ExtensionContext` 不暴露 agentDir，而 agent
 * 目录正是由本壳通过 `PI_CODING_AGENT_DIR` 注入的，从环境变量读是权威来源。
 */
function buildReport(ctx) {
  const env = process.env;
  const shellOk = existsSync(HARMONY_SHELL);

  const toolTable = TOOL_FACTS.map((tool) => {
    const mark = tool.ok === true ? "可用" : tool.ok === false ? "不可用" : "未实测";
    return `  · ${tool.name}：${mark} —— ${tool.why}`;
  }).join("\n");

  return lines(
    "Pi Desktop（Android）运行时事实",
    "",
    "环境",
    `  · 平台标记：process.platform = ${process.platform}`,
    `  · Node：${process.versions.node} ｜ 应用进程内（库 dlopen 托管，无子进程）`,
    `  · PI_CODING_AGENT_DIR = ${env.PI_CODING_AGENT_DIR ?? "(未设置，回退 ~/.pi/agent)"}`,
    `  · HOME = ${env.HOME ?? "(未设置)"}`,
    `  · TMPDIR = ${env.TMPDIR ?? "(未设置)"}`,
    `  · PI_OFFLINE = ${env.PI_OFFLINE ?? "(未设置)"}（=1 时禁止包自动安装与 fd/rg 下载）`,
    `  · shellPath 目标 ${HARMONY_SHELL}：${shellOk ? "存在" : "不存在（bash 工具会失败）"}`,
    `  · 会话工作目录：${ctx.cwd}`,
    `  · project trust：${ctx.isProjectTrusted() ? "已信任（.pi/ 资源会加载）" : "未信任（.pi/ 资源不加载）"}`,
    "",
    "内建工具可用性",
    toolTable,
    "",
    "替代做法",
    "  · 搜索用 find / grep 工具（壳扩展的纯 JS 实现），不要依赖 fd/rg —— 它们不存在。",
    "    find 的 pattern 用 `**` 递归（如 `**/*.json`）；grep 默认按正则，`literal` 关掉正则。",
    "  · 需要跑命令时用 bash 工具（壳扩展的常驻 shell）：有 120 s 默认超时、stderr 合并、",
    "    每条命令在子 shell 内执行（cd/变量不跨调用保留），顶层 exit 不会打断后续调用。",
    "  · 子进程跑 Node 脚本不可用：node -v 会打印版本，但 node -e / node x.js 无任何输出且进程变僵尸，",
    "    终止原因取不到（exit 事件不来、signalCode 恒 null）。参考工程记为 Signal 31 SIGSYS（seccomp 拦 JIT），",
    "    在本机属**未经证实**；无论原因，需要 JS 运行时的东西都必须在 agent 进程内跑。",
    "",
    "详见技能 android-runtime-capabilities 与 docs/工程规划.md §9.3 / §11。",
  );
}

export default function harmonyRuntime(pi) {
  pi.registerCommand("android-info", {
    description: "显示本 Android 构建的运行时事实与工具可用性",
    handler: async (args, ctx) => {
      const report = buildReport(ctx);
      // 命令结果的主要通道是 UI；没有 UI 的模式（json/print）下退化为控制台。
      if (ctx.hasUI) {
        ctx.ui.notify(report, "info");
      } else {
        console.log(report);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // 只校验、只警告：shell 缺失会让 bash 工具失败，但不应阻断会话启动。
    if (!existsSync(HARMONY_SHELL)) {
      const message = lines(
        `[pi-desktop] 警告：未找到 ${HARMONY_SHELL}，bash 工具将不可用。`,
        "  本扩展与 config/settings.json 的 shellPath 都指向该绝对路径；",
        "  若设备 shell 位置不同，请同步修改两者。",
      );
      console.error(message);
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    }
    return undefined;
  });
}
