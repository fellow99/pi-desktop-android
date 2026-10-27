/*
 * ⚠️ 模块格式：本文件是 **ESM**（`export default`），与 payload 根下的 CJS 装载链（bootstrap → require）不同。
 * 依据：pi 的扩展加载走 **jiti**（`@earendil-works/pi-coding-agent/dist/bundle/chunks/jiti-loader-*.js`，
 * 扩展名表含 .js/.mjs/.cjs/.ts），ESM 形态已在旧壳真机验证；改成 CJS 属于对**已验证资产**的
 * 未验证改写，因此与 `pi-desktop-hos/extensions/android-exec.js` **逐字一致**（工程规划 §8.3「原样搬」）。
 * V2 差异：宿主不再是 Electron 主进程；能用宿主桥的地方走库的宿主能力桥（ArkTS 侧 HostCapabilities.ets），
 * Phase 1 的桥**传输不可用**，相关能力会如实报「不可用/不可判定」，不静默降级。
 */
/**
 * android-exec.js — 壳专用扩展：以同名工具**顶替内建 `bash`**（Pi Desktop / Android）
 *
 * ## 为什么需要这个扩展
 *
 * 内建 `bash` 在Android上**永久挂住**：它用 `waitForChildProcess()` 等子进程的 `exit`/`close`
 * 事件判定结束，而本平台这些事件**永不送达**（子进程 1.5 s 内变僵尸后一直没有事件），
 * 且内建工具**没有默认超时** —— 见 `docs/Android环境能力清单-v0.11.1.md` #15 与
 * `docs/真机验证记录.md` 轮次 1 发现 11 / 轮次 2 发现 22。
 *
 * ## 本扩展怎么绕开它
 *
 * 用一个**常驻的非 PTY `/system/bin/sh`**（mksh R59）+ **随机哨兵行**：
 * 结束判定**只看 stdout 里有没有出现结束哨兵行**，完全不依赖任何进程事件。
 *
 * 每条命令下发这样一帧（`<tok>` 是每条命令新生成的随机 hex，**不写进命令体**）：
 *
 * ```
 * printf '\n__PI_BEGIN__ %s\n' '<tok>'
 * ( cd '<cwd>'
 * <command>
 * ) 2>&1
 * __pi_rc=$?
 * printf '\n__PI_END__ %s %s\n' '<tok>' "$__pi_rc"
 * ```
 *
 * 用**子 shell 括号组**（`( … )`）而不是花括号组，是刻意选择：
 * 命令里的顶层 `exit`/`exec` 只会结束子 shell，**不会杀死常驻 shell**
 * （参考工程的同型实现用花括号组，因此每条 `exit N` 都会打断它的常驻 shell，
 * 只能靠重启恢复；本实现的 `exit 3` 会如实返回 rc=3 且 shell 存活）。
 *
 * ## 与内建 `bash` 的行为差异（对模型透明，但必须知道）
 *
 * | 维度 | 内建 `bash` | 本扩展 |
 * |---|---|---|
 * | 结束判定 | 等 `exit`/`close` → 设备上永不返回 | stdout 哨兵行 → 正常返回 |
 * | 默认超时 | **无** | **120 s**（超时后重置常驻 shell，**并保留已产出的输出**） |
 * | stderr | 独立管道 | 合并进 stdout（帧内 `2>&1`），顺序可读 |
 * | 命令的 stdin | `ignore`（≈/dev/null） | **`</dev/null`**（同语义；也保证帧协议不被读 stdin 的命令吃掉） |
 * | 每条命令的 cwd | `cwd: <会话目录>`，不存在则**直接失败** | 帧内隐式 `cd '<会话目录>'`，`cd` 失败则**直接失败并报错**（同语义） |
 * | 跨命令状态 | 无（每次新建 shell） | 无（每条命令都在子 shell 内执行，`cd`/变量不跨命令保留） |
 * | PTY | 无 | 无 |
 * | 文件围栏 | **无** —— 子进程以应用 uid 运行，绕过 pi 的文件审批流 | **同样无**（信任模型未改变） |
 * | 重置语义 | 杀进程树（`killProcessTree`） | 杀**进程组**（`detached: true` + `kill(-pid)`）：被超时/中止的旧命令的子进程不会继续往旧管道写 |
 * | 僵尸 | 每条命令 1 个 | **常驻复用，显著更少**（9 条命令只 spawn 1 次） |
 * | 环境变量 | 每个会话注入 `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL` | **不注入**（常驻 shell 继承应用进程的环境；这些变量是内建工具的会话元数据，本扩展不提供） |
 *
 * ## 生命周期（遵守 pi 的扩展契约）
 *
 * **工厂内零长驻资源**：不 spawn、不建定时器。常驻 shell 在**首次工具调用**时惰性启动，
 * 并在 `session_shutdown` 里幂等释放（`resetShell()`）。
 *
 * ## 自包含约束
 *
 * 只 import `node:` 内建模块。**不** import 上游任何路径 —— 扩展与上游的耦合面越小，
 * 上游升级时越不会碎。shell 绝对路径与 `config/settings.json` 的 `shellPath` 保持一致。
 *
 * 本扩展运行在 pi 进程内，拥有与应用相同的操作系统权限；它不读凭据、不改会话状态。
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

/** 与 config/settings.json 的 `shellPath` 一致：设备上唯一保证存在的 POSIX shell（mksh R59）。 */
const SHELL_PATH = "/system/bin/sh";

/** 帧标记。带下划线与大写，几乎不可能与命令输出撞车。 */
const BEGIN_MARK = "__PI_BEGIN__";
const END_MARK = "__PI_END__";

/** 默认超时（秒制参数的默认值）。内建 bash 没有默认超时，这是它挂死的另一半原因。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 超时后给「已经在跑的命令」的收尾窗口；期间哨兵到达仍按成功返回。 */
const DRAIN_TIMEOUT_MS = 2_000;
/** 与内建 bash 的上限一致。 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** 交给模型的输出上限；超过仍会读到哨兵，只是正文截断并显式标注。 */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** onUpdate 进度节流。 */
const PROGRESS_THROTTLE_MS = 500;

const bashSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, default 120)" },
  },
  required: ["command"],
};

// ---------------------------------------------------------------- 常驻 shell 状态

/**
 * 当前常驻 shell 的状态；`null` = 尚未启动或已被重置。
 *
 * **为什么每个 shell 一个状态对象**（代码评审 C1）：本平台唯一可用的死亡信号是 stdout 的 `end`，
 * 而被替换掉的旧 shell（超时 / 中止后被 kill）的 `end` 会在**任意稍后时刻**到达。若存活标记是
 * 模块级布尔值，旧 shell 的 `end` 会把**新** shell 标记成「已死」：在飞的命令被误报为
 * 「shell 意外退出」，下一次调用还会再 spawn 出一个 shell。因此每个 shell 一个状态对象，
 * 所有事件处理先做身份判断（`shell !== state` 直接丢弃）。
 *
 * @type {{ proc: import("node:child_process").ChildProcess, alive: boolean, buffer: string } | null}
 */
let shell = null;
/** 串行链：同一时刻只允许一条命令在常驻 shell 上执行。 */
let chain = Promise.resolve();

/** 摘掉一个（将要被丢弃的）shell 上的所有监听器，避免它的迟到输出影响任何后续状态。 */
function detachShell(state) {
  const { proc } = state;
  try {
    proc.stdin.destroy();
  } catch {
    /* 已关闭 */
  }
  for (const stream of [proc.stdout, proc.stderr, proc.stdin]) {
    try {
      stream?.removeAllListeners();
    } catch {
      /* 忽略 */
    }
  }
  try {
    proc.removeAllListeners("error");
  } catch {
    /* 忽略 */
  }
}

/**
 * 杀掉常驻 shell **及其进程组**。
 *
 * 为什么用进程组（代码评审 I2）：内建 `bash` 用 `killProcessTree`；只 `kill` 常驻 shell 本身的话，
 * 被超时重置的那条命令的子进程（例：`sleep 120; echo LATE` 里的 `sleep` 与子 shell）会继续活着，
 * 继续往**同一个 stdout 管道**写 —— 那些迟到内容会污染后续命令的结果。
 * `detached: true` 让 shell 成为进程组长，于是可以整组杀。
 */
function killShellProcess(state) {
  const { proc } = state;
  const pid = proc.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* 进程组已不存在或不支持 → 退化为单进程 kill */
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
}

function spawnShell() {
  if (shell && shell.alive && shell.proc) return shell;
  const proc = spawn(SHELL_PATH, [], {
    stdio: ["pipe", "pipe", "pipe"],
    // 进程组长：让 `killShellProcess()` 能整组杀（与内建 `bash` 的 detached 形状一致）。
    detached: true,
  });
  const state = { proc, alive: true, buffer: "" };
  shell = state;
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    // 迟到分块（来自已被替换的 shell）必须丢弃，否则会串进当前命令的结果。
    if (shell !== state) return;
    state.buffer += chunk;
  });
  // 平台实测：唯一的存活/死亡信号（exit/close 永不触发）。
  proc.stdout.on("end", () => {
    if (shell !== state) return;
    state.alive = false;
  });
  // EPIPE 是**异步**的 'error' 事件，同步 try/catch 抓不到它 → 必须挂监听，否则会变成未处理流错误。
  proc.stdin.on("error", () => {
    if (shell !== state) return;
    state.alive = false;
  });
  // 帧内已 2>&1 合并；这里必须排空 stderr，避免管道反压把 shell 卡住。
  proc.stderr.on("data", () => {});
  proc.stderr.on("end", () => {});
  proc.on("error", () => {
    if (shell !== state) return;
    state.alive = false;
  });
  return state;
}

/** 幂等重置：杀掉常驻 shell（含其进程组）、摘掉监听器并丢弃引用，**不等任何事件**。 */
function resetShell() {
  const state = shell;
  shell = null;
  if (!state) return;
  state.alive = false;
  state.buffer = "";
  detachShell(state);
  killShellProcess(state);
}

// ---------------------------------------------------------------- 帧构造

/** POSIX 单引号转义：把内部的 `'` 变成 `'\''`。 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 构造一条命令的帧（**每条命令一个新 token**，token 不写进命令体）。
 *
 * ```
 * printf '\n__PI_BEGIN__ <tok>\n'
 * ( cd '<cwd>' || { printf 'cd failed: %s\n' '<cwd>' >&2; exit 1; }
 * <command>
 * ) </dev/null 2>&1
 * __pi_rc=$?
 * printf '\n__PI_END__ <tok> <rc>\n'
 * ```
 *
 * - **子 shell 括号组**（非花括号组）：命令里的顶层 `exit`/`exec` 只结束子 shell，不杀常驻 shell；
 * - `cd … || { …; exit 1; }`：cwd 不存在时**立刻失败并报错**，不再让命令悄悄跑在应用的默认 cwd 里
 *   （代码评审 M4；内建 `bash` 在 cwd 不存在时同样直接失败）；
 * - `</dev/null`：把命令的 stdin 从**帧管道**上摘下来。两个理由（代码评审 M5）：
 *   ① 与内建一致（内建 spawn 时 stdin 是 `ignore`）；② 否则读 stdin 的命令（`cat` / `read` /
 *   不带文件参数的 `grep`）会把帧剩下的部分读走 —— 既让结束哨兵永远不到（挂到超时），
 *   也把 token 泄露给被执行的命令，违反 FR-tool-005「哨兵不得泄露给被执行的命令」。
 *   （实测：`cat` 确实会把帧尾的 `__PI_END__ <tok> %s` 原文打到 stdout。）
 */
function buildFrame(command, token, cwd) {
  return [
    `printf '\\n${BEGIN_MARK} %s\\n' ${shQuote(token)}`,
    `( cd ${shQuote(cwd)} || { printf 'cd failed: %s\\n' ${shQuote(cwd)} >&2; exit 1; }`,
    command,
    ") </dev/null 2>&1",
    "__pi_rc=$?",
    `printf '\\n${END_MARK} %s %s\\n' ${shQuote(token)} "$__pi_rc"`,
    // 结尾空行：保证哨兵行自身以换行收尾，下一条命令的 BEGIN 一定落在新行行首。
    "",
  ].join("\n");
}

function resolveTimeoutMs(seconds) {
  if (seconds === undefined || seconds === null) return DEFAULT_TIMEOUT_MS;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const ms = Math.round(value * 1000);
  if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return ms;
}

// ---------------------------------------------------------------- 单条命令执行

/**
 * 在常驻 shell 上执行一条命令。
 *
 * 返回 `{ ok, exitCode, text, elapsedMs, timedOut?, died?, aborted? }`。
 * `exitCode === null` 表示**没能拿到退出码**（超时 / shell 死亡 / 中止）——
 * 绝不伪造 0。
 */
function execOnce(command, cwd, timeoutMs, signal, onProgress) {
  return new Promise((resolve) => {
    // 常驻 shell 惰性启动；若已被重置（或从未启动）则新起一个。
    const state = shell && shell.alive && shell.proc ? shell : spawnShell();
    const proc = state.proc;
    const token = randomBytes(8).toString("hex");
    const startedAt = Date.now();

    let settled = false;
    let timer = null;
    let drainTimer = null;
    let poll = null;
    let lastProgressAt = 0;
    let timedOut = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (poll) clearInterval(poll);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, elapsedMs: Date.now() - startedAt });
    };

    /**
     * 本条命令输出**正文**的起点：跳过帧的 `__PI_BEGIN__ <tok>` 哨兵行。
     *
     * 两条路径都要用它 —— 正常结束走 `scan()`，超时/中止走 `partialText()`；
     * 真机实测（轮次 3b）曾出现超时路径把 `__PI_BEGIN__ <tok>` 原样回给模型。
     */
    const bodyStart = () => {
      const beginMarker = `\n${BEGIN_MARK} ${token}\n`;
      const beginAt = state.buffer.lastIndexOf(beginMarker);
      return beginAt < 0 ? 0 : beginAt + beginMarker.length;
    };

    /** 取本条命令到目前为止的输出正文（**必须在 resetShell() 之前调用**）。 */
    const partialText = () => state.buffer.slice(bodyStart()).replace(/\n$/, "");

    /** 在缓冲里找**本条命令**的结束哨兵；找到就结算。 */
    const scan = () => {
      // 哨兵必须落在**行首**（帧本身就以换行前缀输出），且该行必须已经**完整**（有行尾换行）：
      // 否则 stdout 分块会把 `… __PI_END__ <tok> 4` 当成 rc=4 提前结算（代码评审 I3）。
      const markerAt = state.buffer.indexOf(`\n${END_MARK} ${token} `);
      if (markerAt < 0) return false;
      const lineStart = markerAt + 1;
      const lineEnd = state.buffer.indexOf("\n", lineStart);
      if (lineEnd < 0) return false;
      const rcText = state.buffer.slice(lineStart + `${END_MARK} ${token} `.length, lineEnd).trim();
      // 必须同时匹配 token 与紧随其后的十进制退出码，否则视为未结束（绝不伪造 rc）。
      if (!/^\d{1,9}$/.test(rcText)) return false;
      const bodyFrom = bodyStart();
      finish({
        ok: true,
        exitCode: Number(rcText),
        text: state.buffer.slice(bodyFrom, markerAt).replace(/\n$/, ""),
      });
      return true;
    };

    const beginDrain = () => {
      timedOut = true;
      drainTimer = setTimeout(() => {
        // 收尾窗口内仍没等到哨兵：重置常驻 shell（否则下一条命令会与本条串流）。
        // 先取出已产出的文本，再重置 —— resetShell() 会清空缓冲（代码评审 I1）。
        const text = partialText();
        resetShell();
        finish({ ok: false, exitCode: null, text, timedOut: true });
      }, DRAIN_TIMEOUT_MS);
      drainTimer.unref?.();
    };

    const onAbort = () => {
      // 无法只中断一条命令（共享 shell）→ 只能重置整个常驻 shell（连同它的进程组）。
      const text = partialText();
      resetShell();
      finish({ ok: false, exitCode: null, text, aborted: true });
    };

    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        finish({ ok: false, exitCode: null, text: "", aborted: true });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    state.buffer = ""; // 帧内清零：隔离本条命令的输出
    try {
      proc.stdin.write(buildFrame(command, token, cwd));
    } catch (error) {
      // 同步写失败（管道已坏）：标记死亡，下一次调用会重启。
      state.alive = false;
      finish({ ok: false, exitCode: null, text: "", died: true, error: String(error?.message ?? error) });
      return;
    }

    timer = setTimeout(beginDrain, timeoutMs);
    timer.unref?.();

    poll = setInterval(() => {
      if (settled) return;
      if (scan()) return;
      if (!state.alive && !timedOut) {
        // shell 死了（例如外部 SIGKILL）：本条命令拿不到退出码，如实报告（保留已产出的文本）。
        finish({ ok: false, exitCode: null, text: partialText(), died: true });
        return;
      }
      if (onProgress && state.buffer.length > 0 && Date.now() - lastProgressAt > PROGRESS_THROTTLE_MS) {
        lastProgressAt = Date.now();
        try {
          onProgress(Buffer.byteLength(state.buffer, "utf8"));
        } catch {
          /* 进度回报失败绝不影响命令 */
        }
      }
    }, 20);
    // 定时器不拖住进程退出（plan D5）。
    poll.unref?.();
  });
}

/** 串行化：绝不让两条命令交错写同一个 stdin。 */
function enqueue(task) {
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------- 输出整形

function describeFailure(result) {
  if (result.timedOut) return "[命令超时，常驻 shell 已重置（下一条命令会自动重启它）]";
  if (result.aborted) return "[命令被中止，常驻 shell 已重置]";
  if (result.died) {
    return "[常驻 shell 意外退出，本条命令的退出码未知（未伪造为 0）。下一条命令会自动重启 shell；"
      + "注意 shell 状态（变量、cd）不会跨重启保留。]";
  }
  return "[命令未正常结束：未取得退出码]";
}

/**
 * 按 UTF-8 **字节**上限截断，且**不把多字节字符切成 `U+FFFD`**（代码评审 M3）：
 * 若切点落在字符中间就往前回退（UTF-8 单字符最长 4 字节，故最多退 3 次）。
 */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length };
  for (let end = maxBytes; end > maxBytes - 4 && end > 0; end -= 1) {
    const sliced = buf.subarray(0, end).toString("utf8");
    if (!sliced.endsWith("\uFFFD")) return { text: sliced, truncated: true, bytes: buf.length };
  }
  return { text: "", truncated: true, bytes: buf.length };
}

/** 把执行结果整形成给模型看的文本（附带「是否被截断」）。 */
function buildText(result) {
  const parts = [];
  if (result.ok) {
    if (result.text) parts.push(result.text);
    if (result.exitCode !== 0) parts.push(`(exit code ${result.exitCode})`);
  } else {
    if (result.text) parts.push(result.text);
    parts.push(describeFailure(result));
  }
  const text = parts.join("\n");
  const { text: clipped, truncated, bytes } = truncateUtf8(text, MAX_OUTPUT_BYTES);
  if (!truncated) return { text, truncated: false };
  return {
    text: `${clipped}\n\n[输出已截断：共 ${bytes} 字节，仅显示前 ${MAX_OUTPUT_BYTES} 字节]`,
    truncated: true,
  };
}

// ---------------------------------------------------------------- 扩展入口

export default function harmonyExec(pi) {
  // 注意：**工厂内不起任何长驻资源**。pi 有不启会话就加载扩展的调用路径，
  // 在工厂里 spawn 会在那些路径上泄漏。常驻 shell 在首次工具调用时惰性启动。
  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute a shell command in the working directory. Returns stdout and stderr merged, "
      + "with the exit code. On this Android build this is the resident-shell implementation "
      + "(the built-in spawn-based one never returns). Default timeout 120 seconds; output is "
      + "truncated at 256KB.",
    promptSnippet: "Execute shell commands (ls, grep, find, toybox, etc.)",
    promptGuidelines: [
      "On this device the shell is mksh R59 at /system/bin/sh; there is no bash/curl/git/node on PATH.",
      "Each command runs in a subshell: `cd` and shell variables do NOT persist between calls.",
      "A non-zero exit code is reported as `(exit code N)`; use `toybox <name>` for applets without a symlink.",
    ],
    parameters: bashSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = typeof params?.command === "string" ? params.command : "";
      if (!command.trim()) throw new Error("command is required");
      const timeoutMs = resolveTimeoutMs(params?.timeout);
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd() || "/";

      const result = await enqueue(() =>
        execOnce(command, cwd, timeoutMs, signal, (bytes) => {
          if (typeof onUpdate !== "function") return;
          onUpdate({
            content: [{ type: "text", text: `… 常驻 shell 已输出 ${bytes} 字节（命令仍在执行）` }],
            details: undefined,
          });
        }),
      );

      const { text, truncated } = buildText(result);
      return {
        content: [{ type: "text", text }],
        details: {
          exitCode: result.exitCode,
          elapsedMs: result.elapsedMs,
          truncated,
          ...(result.ok ? {} : { failure: result.timedOut ? "timeout" : result.aborted ? "aborted" : result.died ? "shell-died" : "unknown" }),
        },
        // 与内建一致：非零退出码对模型是错误结果（正文里仍然给出完整输出）。
        ...(result.ok && result.exitCode === 0 ? {} : { isError: true }),
      };
    },
  });

  pi.on("session_shutdown", async () => {
    // 幂等释放：杀掉常驻 shell。工厂里没起资源，这里也就没有别的要清。
    resetShell();
    return undefined;
  });
}
