---
name: android-runtime-capabilities
description: Pi Desktop（OpenHarmony / ArkWeb + 进程内 Node）的平台能力边界：哪些工具可用、哪些被平台封死、以及在 `bash` 里必须遵守的约束。动手前先读，能避免把"平台没有"当成"代码写错"。
---

# Android 平台能力边界（Pi Desktop / `pi-desktop-ark`）

本技能随包分发，描述的是**这台设备上运行时真实的样子**。
证据口径：✅ 真机实测 ｜ 🔶 沿用（有据但本轮未复测）｜ ⬜ 未验证。

## 1. 先看这 5 条（最容易踩）

1. **`bash` 没有任何围栏。** 它就是你自己的工作进程里的一个常驻 `/system/bin/sh`，
   以应用 uid 运行，**不受** pi 的文件审批流约束。`No command in bash is fenced.`
   ⇒ 能用 `read` / `write` / `edit` / `ls` / `find` / `grep` 完成的事，**不要**用 `bash` 绕。
2. **`process.cwd()` 是 `/`。** 所有路径一律写**绝对路径**；相对路径没有意义。
3. **`node` 二进制能跑，但跑不了 JS。** `node -v` → `v24.13.0`（`/data/service/hnp/bin/node`），
   **`execve` 并没有被拒**；但一旦执行 JS（`node -e` / `node -p`，加 `--jitless` 也一样）就被
   seccomp 打死：`Signal 31 (core dumped)`、`rc=159`。⇒ 任何 JS 只能在**应用进程内**跑。
   `process.execPath` = `/system/bin/appspawn`，**永远不要**拿它去 spawn（`spawn … EACCES`）。
4. **`symlink` 在应用域被拒（`EPERM`），硬链接可用。** `ln -s a.txt sym.txt` → `Permission denied`；
   `ln a.txt hard.txt` → 成功、`nlink=2`。需要"链接"时优先真拷贝或硬链接。
5. **没有 `git`、没有 `rg`、没有 `fd`、没有 PTY。** 终端的 `terminal.pty` 能力会返回结构化
   `unsupported`——不是坏，是平台没有。`python3`（3.12.8）与 `node`（v24.13.0）**二进制存在**，
   但 `node` 跑不了 JS（见第 3 条）。

## 2. 工具清单（同名顶替，行为与内建一致）

| 工具 | 状态 | 实现与注意 |
|---|---|---|
| `read` / `write` / `edit` / `ls` | ✅ | pi 内建；沙箱 `hmfs` 语义正常：`chmod` 如实生效、原子写靠 `rename` |
| `bash` | ✅ | 常驻 `sh` + **随机哨兵行**判定结束（不依赖 `exit`/`close` 事件），默认超时 120 s，超时**保留已产出输出**。⚠️ 在它内部**再调 `/system/bin/sh -c …` 会失败**：`inaccessible or not found`、`rc=127`（应用域对 `/system/bin/*` 的 `stat`/`open` 被拒，mksh 的 access 预检因此先失败）⇒ **不要嵌套 `sh -c`**，命令直接写在 `bash` 里 |
| `grep` | ✅ | **纯 JS**（无 `rg`）：只认 `pattern` / `path` / `glob` / `literal` / `ignoreCase` |
| `find` | ✅ | **纯 JS**（无 `fd`）：`*` 匹配单段、`**` 跨段；上限 `MAX_FILES 2000` / `MAX_DEPTH 8` |
| `rm` / `mv` / `cp` 工具 | ❌ | 没有这些**工具**；需要时用 `bash`（注意第 1 条） |

`grep`/`find` 的通用约束：默认跳过 `node_modules`、`.git` 与**点开头**的目录；
不跟随符号链接目录；单文件读取上限 512 KB；输出超 256 KB 会**显式标注截断**。

## 3. 文件系统边界

| 位置 | 可用性 |
|---|---|
| `$HOME` = `<filesDir>`（应用沙箱，`hmfs`） | ✅ 可读写；`chmod` 如实生效；凭据文件 `pi-agent/auth.json` 为 `0600` |
| `<filesDir>/workspace` | ✅ 默认工作区根（沙箱 Tab 的第一入口） |
| `<filesDir>/tmp` | ✅ `TMPDIR` |
| `/storage/Users/currentUser/Download` | ✅ 已授权可写（`READ_WRITE_DOWNLOAD_DIRECTORY` 由用户授予后实测可建可删） |
| `/storage/Users/currentUser/{Desktop,Documents}` | ⚠️ 未授权时写入 `EPERM`；需用户在 *设置 → 应用 → 允许访问* 授权并**重启应用** |
| `/storage`、`/storage/Users/currentUser`（父目录） | ⚠️ **不可列举**：`ls /storage` → `EACCES`、`ls /storage/Users/currentUser` → `EPERM`，只有已授权的子目录可见 |
| 沙箱外任意路径 | ⚠️ 读可能成功、写基本失败；不要把"能读"当成"能写" |

## 4. 网络与端口

- 应用出网 ✅（HTTPS 正常，模型调用走公网）。
- 本地服务**只**监听 `127.0.0.1`，**端口每次启动随机**。
  真实端口唯一权威来源：`<filesDir>/payload/pi-web.ready.json` 的 `port` 字段。
  **不要硬编码端口**（`40477` / `34697` / `15777` 都只是某一次的历史值）。
- 插件/包的**联网安装已关闭**（`PI_OFFLINE=1`，`settings.json` 的 `packages` 为空）。设备侧
  `npm`/`npx` 虽然存在但**不可用**（`npm -v` 立即 `Signal 31 (core dumped)`、`rc=159`，**不是**挂住变僵尸），`git` 不存在。

## 5. 日志与诊断（谁写谁读）

- `<filesDir>/payload/app.log`：本载荷自己的日志（UTF-8，**优先看这个**）。
- `<filesDir>/payload/node.log`：库的日志环，行格式 `<stream> <epochMs> <text>`；
  ArkWeb 的原生输出会被过滤掉一部分，**不要**把大段 `console.log` 当诊断手段。
- 崩溃：`<filesDir>/node-bridge/last-crash.json`。
- 沙箱**不能用 `hdc shell` 直接读**（部分路径可 `cat`，但不要依赖它）；
  观测点在**应用域**（同源 HTTP 端点，或壳层右下角 `debug` 图标弹出的「App调试」弹窗）。

## 6. 已知不可用（不要尝试"修"，那是平台约束）

| 能力 | 层 | 现象 |
|---|---|---|
| PTY / 终端面板 | L2（L1 已强化） | 无 `openandroid-arm64/pty.node`；**应用域复测 2026-10-18**：`/dev` 不可列举（`EACCES`）、`/dev/ptmx` `EACCES`、`/proc/mounts` 134 条里 `devpts` **0** 条、`/dev` 是 `devfs` |
| 应用域 `symlink` | L1 | `ln -s` → `Permission denied`；**硬链接不受影响**（`ln` 成功、`nlink=2`） |
| 子进程跑 Node / JIT | L1（seccomp） | `Signal 31 (core dumped)` |
| 开机自启 | L1 | 系统只有只读接口，无公开 setter |
| 2in1 真实后台态 | L1/L3 | 窗口被遮挡后 Ability 仍报 `FOREGROUND`，`isKeepAlive: false` |
| 插件联网安装 | L3（策略） | `PI_OFFLINE=1`，仅本地源 |

## 7. 干活时的默认姿势

1. 先 `ls` / `find` / `grep` 把地形摸清，再改文件——不要盲写。
2. 改文件优先 `edit`（精确替换），整篇重写才用 `write`。
3. 需要 shell 时，**一次调用里做完**（常驻 shell 是串行的，拆成多次只会更慢）。
4. 任何"平台看起来没做到"的现象，先查本技能第 6 节，再看 `<filesDir>/payload/app.log`。
5. 报告结论时**给出证据**（命令 + 原样输出），不要把推断写成实测。
