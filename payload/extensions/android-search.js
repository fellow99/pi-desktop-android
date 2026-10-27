/*
 * ⚠️ 模块格式：本文件是 **ESM**（`export default`），与 payload 根下的 CJS 装载链（bootstrap → require）不同。
 * 依据：pi 的扩展加载走 **jiti**（扩展名表含 .js/.mjs/.cjs/.ts），ESM 形态已在旧壳真机验证；
 * 因此与 `pi-desktop-hos/extensions/android-search.js` **逐字一致**（工程规划 §8.3「原样搬」）。
 * V2 无差异：纯 JS 目录遍历，不依赖任何 Electron/宿主桥。
 */
/**
 * android-search.js — 壳专用扩展：以同名工具**顶替内建 `grep` 与 `find`**（Pi Desktop / Android）
 *
 * ## 为什么需要这个扩展
 *
 * 内建 `grep` 需要外部二进制 **`rg`**（ripgrep）、内建 `find` 需要 **`fd`**。这两个二进制
 * 设备上**不存在**，而本构建 `PI_OFFLINE=1` 又**禁止下载**，因此两个工具在真机上必然失败
 * （`fd is not available and could not be downloaded`）。见
 * `docs/Android环境能力清单-v0.11.1.md` #18 / #19。
 *
 * 原本的替代路径（用 `bash("grep -rn …")`）也因内建 `bash` 会挂住（#15）而**一起不可达**，
 * 于是「按内容搜索」与「按名递归找文件」在本构建上**实质不可用**。
 *
 * ## 本扩展怎么补
 *
 * **纯 JavaScript 目录遍历**：零子进程、零外部二进制、零联网。只用 `node:fs` / `node:path`。
 * 迭代式 BFS（不用递归，避免深目录爆栈），并且**每一处上限都在输出里写明**。
 *
 * ## 与内建工具的关系
 *
 * - **同名顶替**：注册名同样是 `grep` / `find`，参数与内建兼容，因此对模型与 pi-web 都透明。
 * - **差异（必须知道）**：内建靠 `rg`/`fd`，会**真正解析 `.gitignore`** 且**默认包含隐藏项**（两者都传
 *   `--hidden`）；本实现只做「跳过点开头目录 + `node_modules`/`.git`」的**近似**忽略规则
 *   （设备上没有 git，且不引入 gitignore 解析器的复杂度）。这不影响绝大多数搜索，但**排除规则更宽**。
 * - 单文件读取上限 512 KiB，超限文件**跳过并计数**（内建由 rg/fd 处理二进制与超大文件）。
 * - **glob 语法**：`*`/`?` 单段、`**` 跨段、`{a,b}` 枚举、`[0-9]`/`[!a-z]` 字符类；`find` 用
 *   **智能大小写**（模式全小写时忽略大小写 —— 与 fd 默认一致），`grep` 的 `glob` 大小写敏感（与 rg 默认一致）。
 * - **输出路径基准是会话 cwd**（`displayPath`），因此打印出来的路径可以直接喂给 `read`/`write`/`bash`；
 *   内建 `grep` 在 `path` 为目录时改成相对**搜索路径**、`find` 相对**搜索根** —— 这是有意保留的差异。
 * - 汇总里的 `N files read`（grep）是**真的读了 N 个文件**、`N files scanned`（find）是**遍历到 N 个文件**。
 * - **所有上限触顶都会写明**：结果数 `limit`、文件数、单文件字节、深度、单行字符数（后者为 `grep` 的截断提示）。
 *
 * ## 自包含约束
 *
 * 只 import `node:` 内建模块；**不** import 上游任何路径。工厂内**零长驻资源**
 * （不建 watcher、不建定时器、不 spawn）—— 搜索是纯同步 IO，无需生命周期钩子。
 *
 * 本扩展运行在 pi 进程内，拥有与应用相同的操作系统权限；它只读文件，从不写。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------- 上限与忽略规则

/** 遍历时跳过的目录名（**显式指定的根目录永远遍历**，即使它叫 `.pi`）。 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

/** 最大访问文件数（两个工具共用）。 */
const MAX_FILES = 2000;
/** 单文件最大读取字节；超过就跳过并计数，避免把大文件读进内存。 */
const MAX_FILE_BYTES = 512 * 1024;
/** 递归深度上限，计的是**返回路径相对搜索根的段数**（`a/b/c.txt` = 3 段）。 */
const MAX_DEPTH = 8;
/** 单行最大字符数；超出截断并加 `…`。 */
const MAX_LINE_CHARS = 300;

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;

const grepSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: { type: "string", description: "Directory or file to search (default: current directory)" },
    glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
    literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
    context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
    limit: { type: "number", description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})` },
  },
  required: ["pattern"],
};

const findSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})` },
  },
  required: ["pattern"],
};

// ---------------------------------------------------------------- glob → 正则

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把 glob 片段翻译成正则源。
 *
 * - `*` / `?` 只在**单个路径段内**生效（不跨 `/`）；
 * - `**` 跨段（`**\/` 前缀可匹配零层或多层目录）。
 */
/** 找到与 `segment[openIndex]`（必须是 `{`）配对的 `}`；没有配对则返回 -1。 */
function findClosingBrace(segment, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < segment.length; i += 1) {
    if (segment[i] === "{") depth += 1;
    else if (segment[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按**顶层**逗号切分花括号内容（嵌套层级里的逗号不切）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * 把 `[...]` 字符类交给正则（`[0-9]` 这类要按**类**而不是字面量处理）。
 * 同时把 fnmatch 的取反写法 `[!abc]` 转成正则的 `[^abc]`。返回 `null` 表示不是合法字符类 → 按字面量。
 */
function charClassToRegExpSource(segment, openIndex) {
  const close = segment.indexOf("]", openIndex + 1);
  if (close < 0) return null;
  const body = segment.slice(openIndex + 1, close);
  if (!body) return null;
  const negated = body.startsWith("!");
  const inner = (negated ? body.slice(1) : body).replace(/\\/g, "\\\\");
  if (!inner) return null;
  return { source: `[${negated ? "^" : ""}${inner}]`, end: close };
}

/**
 * 把 glob 片段翻译成正则源。
 *
 * - `*` / `?` 只在**单个路径段内**生效（不跨 `/`）；
 * - `**` 跨段（`**\/` 前缀可匹配零层或多层目录）；
 * - `{a,b}` 花括号枚举 → 交替 `(?:a|b)`（与 fd 的 glob 一致）；
 * - `[abc]` / `[0-9]` / `[!a-z]` 字符类 → 原样交给正则；
 * - 其它字符按字面量转义。
 */
function globSegmentToRegExpSource(segment) {
  let source = "";
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      const close = findClosingBrace(segment, i);
      if (close > i) {
        const alternatives = splitTopLevel(segment.slice(i + 1, close));
        if (alternatives.length > 1 && alternatives.every((alt) => alt.length > 0)) {
          source += `(?:${alternatives.map((alt) => globSegmentToRegExpSource(alt)).join("|")})`;
          i = close;
          continue;
        }
      }
    }
    if (char === "[") {
      const klass = charClassToRegExpSource(segment, i);
      if (klass) {
        source += klass.source;
        i = klass.end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return source;
}

/**
 * 编译 glob 模式。
 *
 * 返回 `{ match(target): boolean }`，其中 `target` 是**用 `/` 分隔的相对路径**。
 *
 * - 模式含 `/` → 与整条相对路径匹配（`**` 跨段）；
 * - 模式不含 `/` → 与**任意深度的 basename** 匹配（因此 `find("*.ts")` 能像内建一样工作）。
 * - `ignoreCase`：`find` 用**智能大小写**（模式全小写时忽略大小写），与内建 fd 的默认一致；
 *   `grep` 的 `glob` 保持大小写敏感。
 */
function compileGlob(pattern, { ignoreCase = false } = {}) {
  const raw = String(pattern ?? "").trim();
  if (!raw) return null;
  // 不含 `/` 的模式按「任意深度匹配 basename」处理（`find("*.ts")` 才能像内建一样工作）：
  // 补一个隐含的 `**/` 前缀，之后只走一条代码路径。
  const effective = raw.includes("/") ? raw : `**/${raw}`;
  const segments = effective.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  let source = "^";
  segments.forEach((segment, index) => {
    if (segment === "**") {
      // 末段 `**` 匹配任意内容；否则 `**/` 允许零层或多层目录。
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += globSegmentToRegExpSource(segment);
    if (index < segments.length - 1) source += "/";
  });
  source += "$";

  let compiled;
  try {
    compiled = new RegExp(source, ignoreCase ? "i" : "");
  } catch {
    return null;
  }
  return { match: (target) => compiled.test(target) };
}

// ---------------------------------------------------------------- 目录遍历

/**
 * 迭代式 BFS 遍历，产出候选**文件**。
 *
 * - 目录名以 `.` 开头 或 属于 `SKIP_DIR_NAMES` → 跳过（**但根目录例外**）；
 * - 不跟随符号链接目录（避免环）；符号链接文件按普通文件处理；
 * - `stat`/`readdir` 抛错 → 跳过该条目并计数，绝不整体失败。
 */
function walkFiles(rootAbs, { maxFiles = MAX_FILES } = {}) {
  const files = [];
  const stats = { dirsScanned: 0, filesSeen: 0, entriesSkipped: 0, maxDepthReached: false, fileCapReached: false };

  const queue = [{ abs: rootAbs, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();

    let entries;
    try {
      entries = readdirSync(current.abs, { withFileTypes: true });
    } catch {
      stats.entriesSkipped += 1;
      continue;
    }
    stats.dirsScanned += 1;

    for (const entry of entries) {
      const childAbs = join(current.abs, entry.name);
      const childRel = current.rel ? `${current.rel}/${entry.name}` : entry.name;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(childAbs);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          stats.entriesSkipped += 1;
          continue;
        }
        // 不跟随符号链接目录：可能构成环，也可能指到应用域之外。
        if (isDir) continue;
      }

      if (isDir) {
        // 跳过点开头目录与 node_modules/.git；根目录不在此判断内（永远遍历）。
        if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
        // `MAX_DEPTH` 计的是**返回路径相对搜索根的段数**上限（`a/b/c.txt` = 3 段）：
        // 一个文件的段数 = 目录层数 + 1，因此目录最多下探到 `MAX_DEPTH - 1` 层，
        // 这样「已达深度上限 N」的提示与实际返回的最深路径一致。
        if (current.depth + 1 > MAX_DEPTH - 1) {
          stats.maxDepthReached = true;
          continue;
        }
        queue.push({ abs: childAbs, rel: childRel, depth: current.depth + 1 });
        continue;
      }

      if (!isFile) continue;
      stats.filesSeen += 1;
      if (stats.filesSeen > maxFiles) {
        stats.fileCapReached = true;
        return { files, stats };
      }
      files.push({ abs: childAbs, rel: childRel });
    }
  }

  return { files, stats };
}

function toPosix(pathValue) {
  return sep === "/" ? pathValue : pathValue.split(sep).join("/");
}

/** 展示路径：能相对 cwd 表达就相对（更短、更可读），否则用绝对路径。 */
function displayPath(cwd, abs) {
  const rel = toPosix(relative(cwd, abs));
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel === "" ? "." : rel;
  return toPosix(abs);
}

function clampLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}…`;
}

function summarize(stats, extra = []) {
  const notes = [...extra];
  if (stats.fileCapReached) notes.push(`已达文件数上限 ${MAX_FILES}，遍历提前结束`);
  if (stats.maxDepthReached) notes.push(`已达深度上限 ${MAX_DEPTH}`);
  if (stats.entriesSkipped > 0) notes.push(`跳过 ${stats.entriesSkipped} 个不可读条目`);
  return notes;
}

// ---------------------------------------------------------------- grep

function buildGrepMatcher(pattern, { literal, ignoreCase }) {
  const source = literal ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    throw new Error(`Invalid search pattern: ${String(error?.message ?? error)}`);
  }
}

function collectMatchesForFile(absPath, matcher, limit) {
  let text;
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return { skipped: "too-large", matches: [] };
    text = readFileSync(absPath, "utf8");
  } catch {
    return { skipped: "unreadable", matches: [] };
  }
  const lines = text.split(/\r?\n/);
  const matches = [];
  // `limited`：本文件里还有第 limit+1 个命中 → 说明结果被截断（要让调用方**说出来**，不得静默）。
  let limited = false;
  for (let i = 0; i < lines.length; i += 1) {
    matcher.lastIndex = 0;
    if (!matcher.test(lines[i])) continue;
    if (matches.length >= limit) {
      limited = true;
      break;
    }
    matches.push({ lineNumber: i + 1, line: lines[i], lines });
  }
  return { matches, limited };
}

async function runGrep(params, cwd) {
  const pattern = typeof params?.pattern === "string" ? params.pattern : "";
  if (!pattern) throw new Error("pattern is required");
  const matcher = buildGrepMatcher(pattern, {
    literal: params?.literal === true,
    ignoreCase: params?.ignoreCase === true,
  });
  const rawLimit = Number(params?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_GREP_LIMIT;
  const context = Number.isFinite(Number(params?.context)) && Number(params.context) > 0
    ? Math.floor(Number(params.context))
    : 0;
  // glob 过滤：写错了要让模型看见，**不得**静默退化成「不过滤」（原实现会静默丢弃非法 glob）。
  let globFilter = null;
  if (params?.glob) {
    globFilter = compileGlob(params.glob);
    if (!globFilter) throw new Error(`Invalid glob pattern: ${params.glob}`);
  }

  const targetArg = typeof params?.path === "string" && params.path.trim() ? params.path.trim() : ".";
  const targetAbs = resolve(cwd, targetArg);

  let targetIsDir = false;
  try {
    targetIsDir = statSync(targetAbs).isDirectory();
  } catch {
    throw new Error(`Path not found: ${targetArg}`);
  }

  // 单个文件：直接搜它（与内建的 `path` 语义一致）
  if (!targetIsDir) {
    const result = collectMatchesForFile(targetAbs, matcher, limit);
    if (result.skipped === "too-large") return { text: `[文件超过 ${MAX_FILE_BYTES} 字节，已跳过]`, details: {} };
    if (result.skipped) throw new Error(`Cannot read file: ${targetArg}`);
    const matches = result.matches.map((match) => ({ ...match, abs: targetAbs }));
    const singleStats = { dirsScanned: 0, filesSeen: 1, filesRead: 1, entriesSkipped: 0 };
    const singleNotes = result.limited ? [`已达匹配上限 limit=${limit}，可能还有更多结果`] : [];
    return formatGrepOutput(matches, context, limit, singleStats, cwd, singleNotes);
  }

  const { files, stats } = walkFiles(targetAbs);
  const candidates = globFilter ? files.filter((file) => globFilter.match(file.rel)) : files;

  const allMatches = [];
  let truncatedFiles = 0;
  let limitReached = false;
  let filesRead = 0;
  const skipNotes = [];

  for (const file of candidates) {
    if (allMatches.length >= limit) {
      limitReached = true;
      break;
    }
    const remaining = limit - allMatches.length;
    const result = collectMatchesForFile(file.abs, matcher, remaining);
    if (result.skipped === "too-large") {
      truncatedFiles += 1;
      continue;
    }
    if (result.skipped) {
      stats.entriesSkipped += 1;
      continue;
    }
    filesRead += 1;
    // 本文件把剩余配额吃满（且它还有更多命中）→ 上限触达必须可见（FR-tool-016）。
    if (result.limited) limitReached = true;
    for (const match of result.matches) allMatches.push({ ...match, abs: file.abs });
  }
  stats.filesRead = filesRead;

  if (truncatedFiles > 0) skipNotes.push(`跳过 ${truncatedFiles} 个超过 ${MAX_FILE_BYTES} 字节的文件`);
  if (limitReached) skipNotes.push(`已达匹配上限 limit=${limit}，可能还有更多结果`);
  if (globFilter) skipNotes.push(`已按 glob "${params.glob}" 过滤文件`);

  return formatGrepOutput(allMatches, context, limit, stats, cwd, skipNotes);
}

function formatGrepOutput(matches, context, limit, stats, cwd, extraNotes) {
  const out = [];
  let longLinesTruncated = 0;
  if (matches.length === 0) {
    out.push("No matches found.");
  } else {
    // 行号 → 是否为命中；把 context 行也纳入，并按 grep 的约定区分分隔符。
    const linesByFile = new Map();
    for (const match of matches) {
      if (!linesByFile.has(match.abs)) linesByFile.set(match.abs, new Map());
      const map = linesByFile.get(match.abs);
      for (let offset = -context; offset <= context; offset += 1) {
        const lineIndex = match.lineNumber - 1 + offset;
        if (lineIndex < 0 || lineIndex >= match.lines.length) continue;
        const existing = map.get(lineIndex + 1);
        const isMatch = offset === 0;
        map.set(lineIndex + 1, existing === undefined ? isMatch : existing || isMatch);
      }
    }

    for (const [abs, map] of linesByFile) {
      const shown = displayPath(cwd, abs);
      const lineNumbers = [...map.keys()].sort((a, b) => a - b);
      const source = matches.find((match) => match.abs === abs)?.lines ?? [];
      let previous = null;
      for (const lineNumber of lineNumbers) {
        if (previous !== null && lineNumber > previous + 1) out.push("--");
        const separator = map.get(lineNumber) ? ":" : "-";
        const raw = source[lineNumber - 1] ?? "";
        if (raw.length > MAX_LINE_CHARS) longLinesTruncated += 1;
        out.push(`${shown}${separator}${lineNumber}${separator} ${clampLine(raw)}`);
        previous = lineNumber;
      }
    }
  }

  const notes = summarize(stats, extraNotes);
  // 单行上限触顶也必须可见（FR-tool-016 把「单行最大字符数」列为必须说明的上限之一）。
  if (longLinesTruncated > 0) notes.push(`${longLinesTruncated} 行超过 ${MAX_LINE_CHARS} 字符已截断`);
  notes.push(`${stats.filesRead ?? stats.filesSeen} files read`);
  out.push("", `(${notes.join("; ")})`);
  return { text: out.join("\n"), details: { matches: matches.length, limit } };
}

// ---------------------------------------------------------------- find

function runFind(params, cwd) {
  const pattern = typeof params?.pattern === "string" ? params.pattern.trim() : "";
  if (!pattern) throw new Error("pattern is required");
  // 智能大小写（与内建 fd 的默认一致）：模式全小写 → 忽略大小写；含大写 → 大小写敏感。
  const glob = compileGlob(pattern, { ignoreCase: !/[A-Z]/.test(pattern) });
  if (!glob) throw new Error(`Invalid glob pattern: ${pattern}`);
  const rawLimit = Number(params?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_FIND_LIMIT;

  const targetArg = typeof params?.path === "string" && params.path.trim() ? params.path.trim() : ".";
  const targetAbs = resolve(cwd, targetArg);
  let targetStat;
  try {
    targetStat = statSync(targetAbs);
  } catch {
    throw new Error(`Path not found: ${targetArg}`);
  }
  if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${targetArg}`);

  const { files, stats } = walkFiles(targetAbs);
  const matched = [];
  let limitReached = false;
  for (const file of files) {
    if (matched.length >= limit) {
      limitReached = true;
      break;
    }
    if (glob.match(file.rel)) matched.push(file);
  }

  const out = [];
  if (matched.length === 0) out.push("No files found.");
  else out.push(...matched.map((file) => file.rel));

  const notes = summarize(stats, limitReached ? [`已达结果上限 limit=${limit}，可能还有更多文件`] : []);
  notes.push(`${stats.filesSeen} files scanned`);
  out.push("", `(${notes.join("; ")})`);
  return { text: out.join("\n"), details: { matches: matched.length, limit } };
}

// ---------------------------------------------------------------- 扩展入口

export default function harmonySearch(pi) {
  // 注意：**工厂内零长驻资源**（无 watcher、无定时器、无 spawn）。搜索是纯同步 IO。
  pi.registerTool({
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern. Returns matching lines with file paths and line numbers. "
      + "Pure-JavaScript implementation for this Android build (no ripgrep binary needed). "
      + `Skips dot-directories, node_modules and .git; files larger than ${MAX_FILE_BYTES / 1024}KB are skipped; `
      + `depth capped at ${MAX_DEPTH}; every cap is reported in the output.`,
    promptSnippet: "Search file contents for patterns (pure JS, no ripgrep on this build)",
    promptGuidelines: [
      "This is the working content search on this device — the built-in version needs `rg`, which is absent.",
      "It does NOT parse .gitignore; it skips dot-directories, node_modules and .git instead.",
    ],
    parameters: grepSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd() || "/";
      const result = await runGrep(params, cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. "
      + "Pure-JavaScript implementation for this Android build (no fd binary needed). "
      + `Supports *, ?, **, {a,b} and [0-9] classes; an all-lowercase pattern matches case-insensitively. `
      + `Skips dot-directories, node_modules and .git; depth capped at ${MAX_DEPTH}; every cap is reported in the output.`,
    promptSnippet: "Find files by glob pattern (pure JS, no fd on this build)",
    promptGuidelines: [
      "This is the working filename search on this device — the built-in version needs `fd`, which is absent.",
      "Use `**` for recursive patterns, e.g. `**/*.json`; a pattern without `/` matches basenames at any depth.",
      "`{a,b}` alternation and `[0-9]` classes work; an all-lowercase pattern is matched case-insensitively.",
    ],
    parameters: findSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd() || "/";
      const result = runFind(params, cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
