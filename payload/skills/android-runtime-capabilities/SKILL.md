---
name: android-runtime-capabilities
description: Pi Desktop（Android / 系统 WebView + 进程内 Node，aosp-node-bridge）的平台能力边界：哪些工具可用、哪些被平台封死、五个真实 CLI（node/python/git/uv/pnpm）的实际形态与已知限制，以及在 `bash` 里必须遵守的约束。动手前先读，能避免把"平台没有"当成"代码写错"。
---

# Android 平台能力边界（Pi Desktop / `pi-desktop-android`）

本技能随包分发，描述的是**这台设备上运行时真实的样子**（as-built）。
证据口径：✅ 真机实测（Xiaomi M2105K81C / Android 11 / arm64，见 `docs/002-真机验证记录.md`）｜
🔶 沿用（ark/bridge 有据，本机未复测）｜⬜ 未验证。
权威清单：工程内 `docs/安卓环境能力清单-0.12.1.md`。

## 1. 先看这 5 条（最容易踩）

1. **`bash` 没有逐写围栏。** 它是应用进程内的一个常驻 `/system/bin/sh`（mksh），以应用 uid
   运行，**不受** pi 的文件审批流约束；唯一门禁是 project trust（`defaultProjectTrust:"ask"`）。
   ⇒ 能用 `read` / `write` / `edit` / `ls` / `find` / `grep` 完成的事，**不要**用 `bash` 绕。
2. **工作目录用工作区根，别假设 POSIX 全盘可达。** 主线工作区在应用专属外存
   `Android/data/org.fellow99.pi.PiDesktopAndroid/files/workspace`（免权限真实路径）；
   工作区根由宿主注入的 `PI_ANDROID_ROOTS` 声明。
   其它目录树经 **SAF** 加入，返回的是 `content://` URI——**不是文件系统路径**，Node 的 fs
   不能直接打开，必须走 `android-saf` 桥。
3. **`process.execPath` 不是 Node。** 实测 basename 为 `app_process64`，**永远不要**拿它
   spawn node（补丁 0004 据此让会话导出等路径自动走进程内回退）。所有 JS 只在**应用进程内**
   的 Node（aosp-node-runtime v26.13.0，small-ICU）里跑。
4. **本地服务只绑 loopback、免密、端口随机。** `127.0.0.1:<随机端口>`，真实端口见
   `<filesDir>/node-bridge/payload/pi-web.ready.json`；**不要硬编码端口**。loopback 是安全
   上下文（`crypto.subtle` 可用）。
5. **PTY/终端面板已产品化（111）。** `terminal.pty` 按启动期 `globalThis.__piWebPty.ok`
   （dlopen `libpty_node.so` 成功）运行期裁决，成功即结构化 `supported:true` 走上游原路径；
   终端面板经 node-pty 1.1.0 + 随包原生件，Agent 侧另有 `ptyBash` 工具（已列入 defaultTools）。

## 2. 工具清单（同名顶替，行为与内建对齐）

预置 `settings.json` 的 `defaultTools = [read, write, edit, ls, find, grep, bash]`。

| 工具 | 状态 | 实现与注意 |
|---|---|---|
| `read` / `write` / `edit` / `ls` | ✅ | pi 内建；纯 Node.js，沙箱内语义正常，原子写靠 `rename` |
| `bash` | ✅ 真机 | 常驻 `sh` + **随机哨兵行**判定结束（**不**依赖 `exit`/`close`，但 Android 上这两个事件其实正常送达）；默认超时 120 s，超时保留已产出输出；常驻复用显著减少僵尸。`sh -c "sh -c …"` 嵌套在探针上可用 |
| `grep` | ✅ 真机 | **纯 JS**（无 `rg` 二进制）：只认 `pattern`/`path`/`glob`/`literal`/`ignoreCase` |
| `find` | ✅ 真机 | **纯 JS**（无 `fd` 二进制）：`*` 匹配单段、`**` 跨段；`MAX_FILES 2000` / `MAX_DEPTH 8` |
| `git`（真实 CLI 2.56.0） | 🔧 已随包（112） | 交叉编译 arm64 ELF，经 login shell `sh -l` 的 `.profile` 函数在 PATH 暴露；`--version`/init/add/hash-object/write-tree/log 正常，HTTPS `ls-remote`/clone/fetch 走静态 curl+OpenSSL（TLS 已验）。**已知限制**：真域 SELinux 拒 app 数据目录 `link(2)`，当前构建 `git commit` 落 ref 时 rc=139 段错误（详见 112 证据）；不支持 SSH 远端、SHA-256 仓库、worktree。无 21 个 `git_*` 结构化工具，统一在 `bash`/终端敲 `git` |
| `pnpm`（真实 CLI 12.16.1） | 🔧 已随包（112） | Rust 独立二进制，经 `.profile` 函数在 PATH 暴露。**lifecycle 调用约定（G2）**：pnpm 以非 login `sh -c` 跑 package.json 脚本，`.profile` 函数不可见，脚本里裸 `node` 会撞 bionic realpath rc=255；须把脚本解释器写成绝对 `libnode_cli.so`（preinstall/`pnpm run`/store 实测全 rc=0，store 在 PNPM_HOME 可写域）。顶层 `pnpm --version`/`pnpm run` 走常驻 `sh -l` 正常 |
| `uv`（真实 CLI 0.13.6） | 🔧 部分可用（112，G3） | `uv --version`/`uv cache dir`（`$HOME/.cache/uv` 可写域）/rustls 根证书正常；**`uv venv` 与需探测解释器的 `uv pip` 不可用**——uv 以 isolated（`python -I`，environment=0）inspect 解释器、忽略 PYTHONHOME，交叉编译 Python 找不到外置 stdlib（No module named 'encodings'），非配置可解。Python 隔离需求改用主解释器 + `pip install --target/--user` 或预置 wheel |
| `rm` / `mv` / `cp` 工具 | ❌ | 没有这些**工具**；需要时用 `bash`（注意第 1 条） |
| `codemode`（QuickJS 沙箱） | ⬜ 未验证 | Android **默认开 JIT**（无鸿蒙式 W^X ACL 门），探针上 `WebAssembly.validate` 成功，理论可用但未端到端验证 |
| `powershell` | ❌ | Windows 专用 |

`grep`/`find` 通用约束：默认跳过 `node_modules`、`.git` 与点开头目录；不跟随符号链接目录；
单文件读取上限 512 KB；输出超 256 KB 显式标注截断；零子进程。

## 3. 文件系统边界

| 位置 | 可用性 |
|---|---|
| `$HOME` = `<filesDir>`（`…/files/node-bridge` 为载荷根；应用内部存储） | ✅ 可读写；`pi-agent/auth.json` 凭据文件 `0600` |
| `Android/data/<包>/files/workspace`（应用专属外存） | ✅ 默认工作区根，**免运行时权限**真实路径 |
| `<HOME>/tmp` | ✅ 启动器创建并冻结为 `os.tmpdir()`（Android 系统无 `/tmp`） |
| SAF 授权树（`content://…`） | ⚠️ 经 `android-saf` 桥访问（系统选择器 + `takePersistableUriPermission` 持久授权）；**不是 POSIX 路径**；真弹窗人工点选路径仍待验（dryRun 已过；图片选择的同源机制已真机验证） |
| 任意其它外部存储路径 | ⚠️ 主线不依赖；以 SAF/媒体集合为准，不要假设全盘可读 |

首启载荷解包到 `<filesDir>/node-bridge/payload/`（SHA-256 marker 幂等：冷解包约 18 s，
之后 0 ms 跳过；先 `.tmp` 后 rename，带路径穿越校验）。

## 4. 网络

- 应用出网 ✅（INTERNET 权限；HTTPS 模型调用正常；真实 git 的 HTTPS `ls-remote`/clone/fetch 经静态 curl+OpenSSL，TLS 已验）。
- **刻意不设 `PI_OFFLINE`**（与鸿蒙 ark 的刻意差异——Android 有可用出网）；可在设置中显式离线。
  此时 npm/pip/pnpm/uv 的 registry 访问不可用，仅离线子命令可跑。
- 本地服务只监听 `127.0.0.1` 随机端口（见第 1 节第 4 条）；局域网路线（0.0.0.0）已移植但 v1 不启用。
- MCP：`config/mcp.json` 随包为空（`mcpServers:{}`）。stdio 通道的子进程事件在 Android
  正常送达（不像鸿蒙），但**尚未接真实 MCP 服务器**；HTTP/SSE 类随 fetch 链路可用。

## 5. 宿主能力桥（Kotlin `HostCapabilities`，JNI 直调）

Node 侧可 `host.invoke(name, args)`，均返回结构化 JSON：

| 能力 | 状态/行为 |
|---|---|
| `runtime.facts` | ✅ pkg/sdk/model/abi/pid/bridgeVersion（node-bridge 0.2.0）；另有落盘 `engine-facts.json` |
| `perm.check` / `perm.request` / `perm.openAppInfo` | ✅ 四态判定；POST_NOTIFICATIONS 运行时申请（Android 13+）；SAF 为 interactive-only；可深链应用设置页 |
| `fs.pickFolder` / `fs.pickFiles` | ✅ SAF 系统选择器（OPEN_DOCUMENT_TREE / OPEN_DOCUMENT，多文件、MIME 白名单）；契约=立即受理 + 结果落 `<HOME>/saf-results/`（JNI 桥同步返回限制），扩展侧轮询 |
| `notify.show` | ✅ 走通知渠道；未授权 POST_NOTIFICATIONS 时结构化报错并指路 `perm.request` |
| `runtime.keepAlive` | ✅ **Android 独有增量**：启停 `dataSync` 型前台服务 + 常驻通知；真机验 isForeground、Doze deep-idle 存活、loopback SSE 36s+ 不断 |
| `shell.openExternal` | ✅ 仅 http(s)，`ACTION_VIEW` 交系统浏览器（其余 scheme 拒绝） |
| `log.hilog` | ✅ 追加到 app.log（Android 侧为 logcat 命名沿用） |
| `terminal.pty` | ✅ 运行期裁决 | `globalThis.__piWebPty.ok`（dlopen libpty_node.so 成功）为真即 `supported:true` 走上游原路径；node-pty 1.1.0，Agent 侧另有 `ptyBash` 工具 |

## 6. WebView 事实（渲染面）

- 界面由**系统 WebView** 渲染（不自带内核）；真机出厂内核可能很旧（验证机锁 **Chrome 94**，
  全设备唯一实现）。壳层在页面脚本前注入 `polyfill-webview.js`（只在 API 缺失时补）：
  `findLast`/`findLastIndex`、`AbortSignal.throwIfAborted`、`AbortSignal.timeout`、
  `structuredClone`、`100dvh` 布局修正等。升级 WebView 后这些垫片自动成为空操作。
- `<input type=file>` 已接线：`onShowFileChooser` → 系统选择器 → `onActivityResult`
  回传（图片上传真机验证；无需存储权限）。
- 导航围栏：主 frame 非本地导航交系统浏览器；`window.open` 截留回本 Web 承载；子 frame 放行；
  历史在首次进入服务页后清除（返回键不回 boot 页）。
- 远程调试（chrome://inspect）**仅 debug 构建**开启；页面 console/未捕获异常转发 logcat
  （tag `pi-web-console`）。
- 底部常驻「内容由 AI 生成，仅供参考」标识。

## 7. 已知不可用 / 不做（不要尝试"修"，那是平台或决策约束）

| 能力 | 层 | 说明 |
|---|---|---|
| PTY / 终端面板 | ✅ 已产品化（111） | node-pty 1.1.0 + 随包 `libpty_node.so`（路线 A 原生件，exec 位走 nativeLibraryDir）；`terminal.pty` 按 `__piWebPty.ok` 运行期裁决，`ptyBash` 已在 defaultTools；111 已真机 E2E 通过 |
| x86_64 模拟器跑 Next 服务 | L-ENV | berberis ARM 翻译层下 Next require 图确定性 SIGSEGV（JIT/jitless/各内存配置同签名）；模拟器只覆盖轻负载探针与诊断，**取证以 arm64 真机为准** |
| 开机自启 / `SYSTEM_ALERT_WINDOW` / `MANAGE_EXTERNAL_STORAGE` / `REQUEST_INSTALL_PACKAGES` / `QUERY_ALL_PACKAGES` | L3 合规红线 | 明确不申请 |
| 托盘 / 桌面窗口状态记忆 | ➖ | 桌面版概念，Android 不适用（Activity 生命周期由系统管理） |
| 应用内自动更新 | L3 | v1 侧载/国内渠道 APK；Google Play（AAB/PAD）后置 |

## 8. 干活时的默认姿势

1. 先 `ls` / `find` / `grep` 摸清地形，再改文件——不要盲写。
2. 改文件优先 `edit`（精确替换），整篇重写才用 `write`。
3. 需要 shell 时一次调用里做完（常驻 shell 串行；命令以应用 uid 执行、无逐写围栏）。
4. 碰到「平台看起来没做到」：先查本技能 §5/§7，再看 app.log / logcat（`pi-web-console`）
   与 `<filesDir>/node-bridge/payload/engine-facts.json`、`pi-web.boot-facts.json`。
5. 涉及外部目录先确认它在 `PI_ANDROID_ROOTS` 内；SAF 树用 `content://` + `android-saf` 桥，
   不要拼 POSIX 路径。
6. 报告结论给出证据（命令 + 原样输出 / 自检 JSON 文件名），不要把推断写成实测。
