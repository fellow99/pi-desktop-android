// android-pty — pi-agent 扩展（111-pty-integration：PTY 产品化）
//
// 原生件 libpty_node.so 由 node-pty AAR（io.github.fellow99:node-pty:26.13.0，node-pty@1.1.0）
// 随 APK 进 nativeLibraryDir；启动期 pi-web-launch.js 的「PTY 常驻加载器」dlopen 它并种子
// require.cache（<payload>/node_modules/node-pty/build/Release/pty.node）。因此这里
// `require("node-pty")`（从本扩展向上解析到 payload/node_modules/node-pty，1.1.0，与原生配对）
// 会命中已种子的原生件。失败结构化如实上报，绝不静默降级（宪法 A6）。
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

// node-pty 单例：首次 require 即命中启动期种子（原生已装载）。绝不缓存失败态——每次工具调用
// 都尝试装载，若原生缺失则 throw（execute 把它结构化上报给模型）。
// 装载路径：优先用启动期注入的绝对包路径 `PI_PTY_PKG_ABS`（=<payloadRoot>/node_modules/node-pty，
// 命中 ensurePtyNative 种子过的同一副本，node-pty 内部 require build/Release/pty.node 会命中
// dlopen 的 libpty_node.so）；未设置则回到按名解析 `node-pty`（终端面 payload 内消费场景）。
function loadPty() {
  const abs = process.env.PI_PTY_PKG_ABS;
  return abs ? req(abs) : req("node-pty");
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 简单截断到 UTF-8 字节上限（不切坏多字节字符）。 */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  for (let end = maxBytes; end > maxBytes - 4 && end > 0; end -= 1) {
    const sliced = buf.subarray(0, end).toString("utf8");
    if (!sliced.endsWith("\uFFFD")) return `${sliced}\n\n[PTY 输出已截断：共 ${buf.length} 字节，仅显示前 ${maxBytes}]`;
  }
  return `[输出不可截断（编码异常）]`;
}

/**
 * 单次 spawn 到真 PTY（V1 试运行，非常驻）：完成判据 = PTY `onExit` 事件（node-pty waitpid，拿真退出码，
 * 这是哨兵法拿不到的核心收益）。120s 超时 + 中止（signal）/杀进程组兑底。输出有界。
 */
function runPtyCommand(command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    let term = null;
    let out = "";
    let finished = false;
    let timer = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { if (term) term.kill("SIGKILL"); } catch { /* 已退 */ }
      resolve(result);
    };
    timer = setTimeout(() => finish({ ok: false, timedOut: true, text: out, exitCode: null }), timeoutMs);
    if (signal) {
      try { if (signal.aborted) finish({ ok: false, aborted: true, text: out, exitCode: null }); else signal.addEventListener("abort", () => finish({ ok: false, aborted: true, text: out, exitCode: null }), { once: true }); }
      catch { /* 忽略 signal 绑定失败 */ }
    }
    try {
      term = loadPty().spawn("/system/bin/sh", ["-c", command], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: cwd || process.cwd() || "/",
        env: process.env,
      });
    } catch (err) {
      finish({ ok: false, text: `node-pty spawn 失败：${(err && err.message) || err}`, exitCode: null });
      return;
    }
    term.onData((data) => {
      out += data;
      if (Buffer.byteLength(out, "utf8") > MAX_OUTPUT_BYTES * 2) {
        // 保留尾部，防无限刷屏累积
        out = out.slice(-MAX_OUTPUT_BYTES);
      }
    });
    term.onExit(({ exitCode }) => {
      finish({ ok: exitCode === 0, text: out, exitCode });
    });
  });
}

function ptyBashSchema() {
  // SDK registerTool 要求 **object 参数 schema**（`parameters` 必须是对象、而非数组；
  // 数组会在 `loader.js#registerTool` 抛 "must define an object parameter schema"，
  // 导致整个 android-pty 扩展加载失败——ptyBash 工具与 pty-test 命令双双缺席）。
  return {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)." },
    },
    required: ["command"],
  };
}

export default function register(pi) {
  pi.registerTool({
    name: "ptyBash",
    label: "ptyBash",
    description:
      "Execute a shell command in a real PTY (pseudoterminal) and return the merged output with the "
      + "exit code from the PTY's exit event. Default timeout 120 seconds; output truncated at 256KB.",
    promptSnippet: "Execute shell commands in a real PTY (trial; V1 most-simplest)",
    promptGuidelines: [
      "This is the V1 trial of a PTY-backed shell tool (real teletype semantics, true exit codes).",
      "Shell is mksh at /system/bin/sh; run in a fresh PTY per call (no persistent shell state).",
      "Use `exit N`/command exit code to judge success; non-zero is an error result.",
    ],
    parameters: ptyBashSchema(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = typeof params?.command === "string" ? params.command : "";
      if (!command.trim()) throw new Error("command is required");
      const timeoutMs = (typeof params?.timeout === "number" && params.timeout > 0)
        ? Math.min(params.timeout, DEFAULT_TIMEOUT_MS * 2)
        : DEFAULT_TIMEOUT_MS;
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd() || "/";

      let result, loadErr = null;
      try {
        result = await runPtyCommand(command, cwd, timeoutMs, signal);
      } catch (err) {
        loadErr = (err && err.message) || String(err);
      }
      if (loadErr) {
        return {
          content: [{ type: "text", text: `PTY bash 不可用：${loadErr}\n（nativeLibraryDir 缺 libpty_node.so 或装载失败；boot-facts pty.ready 与 /api/terminal supported 应反映之）` }],
          details: { failure: "pty-unavailable" },
          isError: true,
        };
      }
      let text = result.text;
      const truncated = Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES;
      if (!truncated && result.exitCode !== null && result.exitCode !== 0 && !/exit code/.test(text)) {
        text = `${text}\n(exit code ${result.exitCode})`;
      }
      return {
        content: [{ type: "text", text: truncateUtf8(text, MAX_OUTPUT_BYTES) }],
        details: {
          exitCode: result.exitCode,
          timedOut: !!result.timedOut,
          aborted: !!result.aborted,
          truncated,
        },
        ...(result.ok && result.exitCode === 0 && !result.timedOut && !result.aborted ? {} : { isError: true }),
      };
    },
  });

  pi.registerCommand("pty-test", {
    description: "装载 node-pty（payload node_modules，命中启动期种子）并在真 PTY 里跑一次 sh 回显",
    handler: async (_args, ctx) => {
      let report;
      try {
        const pty = loadPty();
        const term = pty.spawn("/system/bin/sh", ["-c", "echo PTY_ROUNDTRIP_OK; id; tty"], {
          name: "xterm-color",
          cwd: ctx?.cwd || process.cwd(),
          env: process.env,
        });
        report = await new Promise((resolve) => {
          let out = "";
          const timer = setTimeout(() => { try { term.kill(); } catch { /* 已退 */ } resolve(`${out}\n[10s 超时]`); }, 10_000);
          term.onData((data) => {
            out += data;
            if (out.includes("PTY_ROUNDTRIP_OK")) {
              clearTimeout(timer);
              setTimeout(() => { try { term.kill(); } catch { /* 已退 */ } resolve(out); }, 400);
            }
          });
        });
        report = (report.includes("PTY_ROUNDTRIP_OK") ? "✓ PTY 回程成功" : "⚠ 未捕获回显") + "\n---- pty 输出 ----\n" + report.slice(0, 600);
      } catch (err) {
        report = "✗ node-pty 装载/执行失败：" + ((err && err.message) || err);
      }
      if (ctx?.hasUI) ctx.ui.notify(report, report.startsWith("✓") ? "info" : "warning");
      else console.log(report);
    },
  });
}
