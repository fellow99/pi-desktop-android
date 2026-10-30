---
name: android-runtime-capabilities
description: Pi Desktop（Android / 系统 WebView + 进程内 Node，aosp-node-bridge）的平台能力边界：哪些工具可用、哪些被平台封死、Git/pnpm 扩展的实际形态，以及在 `bash` 里必须遵守的约束。动手前先读，能避免把"平台没有"当成"代码写错"。
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
   工作区根由宿主注入的 `PI_ANDROID_ROOTS` 声明（`PI_HOS_ROOTS` 是兼容别名，同值）。
   其它目录树经 **SAF** 加入，返回的是 `content://` URI——**不是文件系统路径**，Node 的 fs
   不能直接打开，必须走 `android-saf` 桥。
3. **`process.execPath` 不是 Node。** 实测 basename 为 `app_process64`，**永远不要**拿它
   spawn node（补丁 0004 据此让会话导出等路径自动走进程内回退）。所有 JS 只在**应用进程内**
   的 Node（aosp-node-runtime v24.22.1，small-ICU）里跑。
4. **本地服务只绑 loopback、免密、端口随机。** `127.0.0.1:<随机端口>`，真实端口见
   `<filesDir>/node-bridge/payload/pi-web.ready.json`；**不要硬编码端口**。loopback 是安全
   上下文（`crypto.subtle` 可用）。
5. **PTY/终端面板 v1 不提供。** `terminal.pty` 返回结构化 `unsupported`——不是坏，是产品决策
   暂缓（路线 A 原生件技术验证已 Go，但未产品化；`android-pty` 只是评估试验件）。

## 2. 工具清单（同名顶替，行为与内建对齐）

预置 `settings.json` 的 `defaultTools = [read, write, edit, ls, find, grep, bash]`。

| 工具 | 状态 | 实现与注意 |
|---|---|---|
| `read` / `write` / `edit` / `ls` | ✅ | pi 内建；纯 Node.js，沙箱内语义正常，原子写靠 `rename` |
| `bash` | ✅ 真机 | 常驻 `sh` + **随机哨兵行**判定结束（**不**依赖 `exit`/`close`，但 Android 上这两个事件其实正常送达）；默认超时 120 s，超时保留已产出输出；常驻复用显著减少僵尸。`sh -c "sh -c …"` 嵌套在探针上可用 |
| `grep` | ✅ 真机 | **纯 JS**（无 `rg` 二进制）：只认 `pattern`/`path`/`glob`/`literal`/`ignoreCase` |
| `find` | ✅ 真机 | **纯 JS**（无 `fd` 二进制）：`*` 匹配单段、`**` 跨段；`MAX_FILES 2000` / `MAX_DEPTH 8` |
| `git_*`（21 个）+ `git_credentials` | 🔧 已随包；本地链+网络浅克隆真机自检通过，会话语义面待验 | **`android-git` 扩展**：纯 JS isomorphic-git 1.44.2（vendor bundle 915 KB），**不依赖系统 git**。init/status/log/add/commit/checkout/branch/merge/rebase 之外的本地生命周期 + HTTP(S) clone/fetch/pull/push；凭据存 `pi-agent/.git-credentials`（0600）。**不支持**：`rebase`、`blame`、SSH 远端（`git@host:` 自动改 https）、SHA-256 仓库、worktree。仓库必须在声明根内（围栏） |
| pnpm 工具面（6 个） | 🔧 已随包；真机自检 7/7（本地包 add 等），网络 tarball 下载受当前设备网络限制 | **`android-pnpm` 扩展**：进程内 vendored pnpm 9.15.9（9 MB 单文件），**不 spawn node**。生命周期脚本**恒禁用**（`--ignore-scripts`，无法开启）；离线下写操作结构化拒绝、只读面保留；项目必须在声明根内。注意启动器已建 `<HOME>/tmp` 并冻结 `os.tmpdir()`（Android 无 /tmp） |
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

- 应用出网 ✅（INTERNET 权限；HTTPS 模型调用正常；git 外网浅克隆真机 9/9，约 2.5 s）。
- **刻意不设 `PI_OFFLINE`**（与鸿蒙 ark 的刻意差异——Android 有可用出网）；可在设置中显式离线。
  此时 pnpm 写操作结构化拒绝、只读面保留。
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
| `terminal.pty` | ❅ 结构化 `supported:false`（决策暂缓） |

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
| PTY / 终端面板产品化 | L3（决策暂缓） | `/dev/ptmx` 应用域可开（真机复测），但 devpts ptmxmode=000/ioctl slave 受限；node-pty 路线 A 原生件已交叉编译验证（3/3），产品化待 B3（exec 通道 + /api/terminal 联调 + 用户拍板） |
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
