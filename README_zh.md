[English](./README.md) | 中文

---

# Pi Desktop · 安卓版（`pi-desktop-android`）

> **定位：Android Edition（安卓版）**—— Pi Desktop 家族的 Android 成员。
> **不随包分发浏览器内核、不带 Electron/Chromium**：应用在**自己的进程内**托管 Node.js
> 运行时（aosp-node-bridge + 投放制 `libnode.so`），由该运行时在本机提供上游 **Pi Web** 服务，
> 再用**系统 WebView** 加载这个本地服务渲染界面。功能目标与
> [`pi-desktop-ark`](../pi-desktop-ark)（鸿蒙纯血版）对齐，并增加 Android 增量：
> 前台服务保活、进程内 pnpm 扩展、SAF 存储访问框架桥。

| 项 | 值 |
| --- | --- |
| 版别 | **Android Edition**（`pi-desktop-android`） |
| 应用显示名 / 应用 ID | **Pi Desktop** / `org.fellow99.pi.PiDesktopAndroid`（2026-10-24 定稿；显示名与 `pi-desktop` / `…Ark` 品牌口径一致，仅包名带 Android） |
| 版本 / versionCode | **`0.1.0` / `1`**（预发布；第 0 级真机验证已完成） |
| 上游基线 | `pi` **v1.2.0** + `pi-web` **v0.12.1**（`patches/v0.12.1/` 下 6 条幂等可反向补丁） |
| 后端 | `io.github.fellow99:node-bridge` **0.2.0**（JNI 直调宿主桥）+ **投放制** aosp-node-runtime 引擎 `libnode.so` **v24.22.1**（`--with-intl=small-icu`，见下方「引擎说明」），进程内 `dlopen` + `node::Start` |
| 前端 | 系统 WebView 加载 `http://127.0.0.1:<随机端口>/`（同源 HTTP + SSE；loopback 即安全上下文） |
| ABI | **仅 `arm64-v8a`**（引擎只出单 ABI） |
| minSdk / targetSdk / compileSdk | **24** / **36** / **36** |
| 当前状态 | **真机第 0 级已过**（Xiaomi M2105K81C / Android 11，A1–A8 全 ✅）；模拟器因 ARM 翻译层跑 Next.js require 图必崩，只能覆盖轻负载探针 |
| 规划文档 | [`docs/000-工程规划.md`](docs/000-工程规划.md)（v0.2，规划口径的权威文档） |

> **引擎说明**：Maven 上的 `io.github.fellow99:node-runtime:24.2.0` 以 `--with-intl=none`
> 构建（完全没有 `Intl`，会使 Next 16 编译产物中的 Unicode 属性转义在解析期直接失败）。
> 因此本工程用 `scripts/provision-engine.mjs` 把 **aosp-node-runtime v24.22.1（small-ICU）**
> 投放到 `app/src/main/jniLibs/`，SHA-256 由 `runtime.lock.json` 锁定；该二进制**刻意不入库**。

---

## 这是什么

[Pi](https://pi.dev) 是最小、可扩展的 agent harness；[Pi Web](../pi-web) 是它的本地 Web 界面
（Next.js 应用，**一个 Node 进程同时提供 SPA 与 `/api/*`**，agent 在该进程内创建）。
本工程把这一套封装进 Android 原生应用壳：

- 系统 WebView（不自带 Chromium）100% 原样渲染上游 UI，不 fork 前端；
- Node 运行时在**应用自身进程**内提供 pi-web，二者只经 loopback 通信；
- Kotlin 壳补齐本地 Node 服务在 Android 上做不到的事：目录/文件选择（SAF）、运行时权限、
  通知、保活前台服务、外链跳转。

> **非官方声明**：本工程非 Pi / Pi Web 团队构建，与上游作者无隶属关系，未获其背书。
> `Pi` 与 `Pi Web` 均为 MIT 许可的上游开源项目，本工程仅是其桌面形态在 Android 上的第三方移植。

## 已交付模块

需求按 `specs/1NN-<name>/` 组织（编号与 ark 同构）：

| 模块 | 规格目录 | 交付物 |
|---|---|---|
| `101-runtime-integration` | [`specs/101-runtime-integration-launch-orchestration/`](specs/101-runtime-integration-launch-orchestration/) | Maven 桥接线、归档投放、启动/探活/marker 状态机 |
| `102-payload-pipeline` | [`specs/102-payload-pipeline-assembly-crop/`](specs/102-payload-pipeline-assembly-crop/) | 补丁 → 构建 → 裁剪 → tar.gz 载荷流水线（归档 74.5 MiB） |
| `103-webview-shell` | [`specs/103-webview-shell-render-pages/`](specs/103-webview-shell-render-pages/) | WebView 配置、boot/错误页、导航围栏、清历史、Chrome 94 垫片 |
| `104-host-capabilities` | [`specs/104-host-capabilities-kotlin-impl/`](specs/104-host-capabilities-kotlin-impl/) | Kotlin 宿主桥：facts、权限、SAF 选择器、通知、外链、保活、结构化 `terminal.pty=unsupported` |
| `105-auth` | [`specs/105-auth-loopback-no-password/`](specs/105-auth-loopback-no-password/) | 只绑 loopback + 免密（WebView 与 Node 同进程，没有 Electron 式 loopback 隔离） |
| `106-tools-extensions` | [`specs/106-tools-extensions-same-name-overrides/`](specs/106-tools-extensions-same-name-overrides/) | 同名顶替扩展（`bash` / `find` / `grep`） |
| `107-compliance` | [`specs/107-compliance-and-security/`](specs/107-compliance-and-security/) | 上架合规清单 G1–G11（清单最小权限、16 KB 对齐、诊断面仅 debug、AI 标识、隐私草稿） |

相对 ark 的两项能力增量登记在 `docs/000-工程规划.md` §10/§11：**`android-git`**
（纯 JS isomorphic-git，从 `pi-desktop-hos` 单源同步）与 **`android-pnpm`**
（进程内 vendored pnpm 9.15.9）。两者均已装进载荷，但**尚无入库的真机端到端报告**，
按「已实现未验证」对待。

## 目录结构

```
pi-desktop-android/
├── app/
│   ├── build.gradle.kts                     # applicationId / 仅 arm64-v8a / 签名（keystore 不入库）
│   └── src/main/
│       ├── AndroidManifest.xml              # 4 个权限；singleTask；dataSync 前台服务
│       ├── assets/
│       │   ├── pi-web/pi-web.tar[.gz]       # 载荷归档（构建产物，不入库）
│       │   └── webview/polyfill-webview.js  # Chrome 94（旧系统 WebView）ES2022/dvh 垫片
│       ├── java/org/fellow99/pi/PiDesktopAndroid/
│       │   ├── MainActivity.kt              # WebView 壳：围栏、文件选择、console 转发、调试开关
│       │   ├── PiApplication.kt
│       │   ├── runtime/                     # PiDesktopRuntime、PayloadArchive、EngineFacts
│       │   ├── host/HostCapabilities.kt     # 宿主能力桥（10 个能力）
│       │   ├── service/PiForegroundService.kt
│       │   └── payload/PayloadArchive.kt
│       ├── jniLibs/arm64-v8a/               # libnode.so + libc++_shared.so（投放制，gitignore）
│       └── res/                             # 应用名 = "Pi Desktop"、启动图标
├── payload/                                 # 组装时叠加到 pi-web 之上的壳覆盖层
│   ├── pi-web-launch.js                     # 进程内 Next 启动、就绪 marker、jitless 兼容层、物化
│   ├── env.js                               # 环境契约（PI_* 变量）
│   ├── extensions/
│   │   ├── android-exec.js                  # 顶替内建 bash：常驻 mksh + 随机哨兵行
│   │   ├── android-search.js                # 顶替 find/grep：纯 JS 遍历，零 rg/fd、零子进程
│   │   ├── android-runtime.js · android-workspace-roots.js
│   │   ├── android-saf.js                   # SAF 桥（content://、持久化授权）
│   │   ├── android-git/                     # 21 个 git_* 工具 + git_credentials（isomorphic-git 1.44.2）
│   │   ├── android-pnpm/                    # vendored pnpm 9.15.9，进程内执行，恒 --ignore-scripts
│   │   └── android-pty/                     # 仅评估用 node-pty 试验件（未产品化，见「能力边界」）
│   ├── skills/android-runtime-capabilities/
│   ├── config/{settings.json,mcp.json}
│   └── jitless/                             # 纯 JS 兼容层，仅当 WebAssembly 不存在时启用
├── patches/v0.12.1/                         # 6 条幂等 pi-web 补丁（0001–0006）
├── scripts/                                 # assemble-payload · crop-rules · provision-engine/pty · devtest · sync
├── docs/                                    # 000 规划 · 能力清单 · 真机记录 · 隐私草稿
├── specs/                                   # 1NN 模块规格
├── keystore.properties.sample               # release 签名模板（keystore.properties 已 gitignore）
└── build.gradle.kts · settings.gradle.kts · gradle/
```

## 构建

前置条件：宿主机 Node.js（跑载荷流水线）、Android SDK + JDK 17、以及 `arm64-v8a`
真机或镜像（x86_64 模拟器镜像只能在 ARM 翻译层下跑引擎，Next.js 服务起不来——见「已知限制」）。

```bash
# 0) 引擎：把 libnode.so 投放到 app/src/main/jniLibs（sha256 锁门禁；不在 git 中）
node scripts/provision-engine.mjs --check      # 校验已投放的引擎
node scripts/provision-engine.mjs             # 按锁定的 aosp-node-runtime 构建投放

# 1) 宿主机组装载荷（先干跑，再应用）
node scripts/assemble-payload.mjs              # 报告补丁/裁剪/体积
node scripts/assemble-payload.mjs --apply      # -> app/src/main/assets/pi-web/pi-web.tar.gz + .version

# 2) 构建 APK
./gradlew :app:assembleDebug                   # 或 :app:assembleRelease
# release 签名：复制 keystore.properties.sample 为 keystore.properties 并填写；
# 缺该文件时 release 产出未签名包。debug 用调试密钥自动签名。
```

产物：`app/build/outputs/apk/debug/app-debug.apk`（约 181 MB：引擎 81.5 MB + 载荷 74.5 MiB）。

## 安装与运行

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n org.fellow99.pi.PiDesktopAndroid/.MainActivity
```

- 首启解包载荷（模拟器上 85 MB / 2.7 万文件实测约 **18 秒**；SHA-256 marker 使之后每次启动
  0 ms 跳过解包）并启动进程内服务；boot 页显示进度，HTTP 探活成功后 WebView 切到服务页面。
- 服务只绑 `127.0.0.1` 的**随机端口**（验证中固定端口曾造成 EADDRINUSE 硬故障），**免密**；
  loopback 是安全上下文（`crypto.subtle` 可用），`network_security_config` 只对 loopback 放行明文。

真机/模拟器验证现状（见 [`docs/002-真机验证记录.md`](docs/002-真机验证记录.md)）：

- **真机** Xiaomi M2105K81C（Android 11，arm64）：A1–A8（冷启、解包、运行时启动、宿主桥、
  模型/SSE 对话、看图、布局、文件上传）全部 ✅；并修复了该设备出厂 WebView（**Chrome 94**）
  的兼容三连：ES2022 + 动态视口单位垫片、`<input type=file>` 接线、布局充满。
- **x86_64 模拟器**（berberis ARM 翻译层）：轻负载探针全过（JIT/WASM、Intl、SSE 数据面、
  spawn 语义、宿主桥、18 秒解包）；但 Next.js require 图在翻译层下、JIT/jitless/各内存配置
  都确定性 SIGSEGV —— 属宿主环境限制，不是应用缺陷。因此模拟器只覆盖探针与诊断面。

## 能力边界（已知限制）

| 能力 | 状态 | 说明 |
|---|---|---|
| 主界面（Pi Web）、流式 SSE 对话、模型/Provider 设置 | ✅ 真机 | 本地同源服务；API Key 只存应用内部存储 |
| 文件读 / 写 / 编辑 / 列举 | ✅ | 应用进程内纯 Node.js |
| 命令执行（`bash` 工具） | ✅ 真机 | 由 `android-exec.js` 同名顶替：一个常驻非 PTY `/system/bin/sh`（mksh）+ 随机哨兵行；只凭 stdout 哨兵判定完成，从不等待 `exit`/`close` 事件 |
| 文件查找 / 内容搜索（`find` / `grep`） | ✅ 真机 | 由 `android-search.js` 同名顶替：纯 JS 遍历，零 `fd`/`rg`、零子进程；单文件 512 KiB 上限 |
| Git 操作 | 🔧 已实现，待真机验证 | `android-git` 以纯 JS isomorphic-git 1.44.2 提供 21 个 `git_*` 工具 + `git_credentials`，不依赖系统 git 二进制。范围外：`rebase`、`blame`、SSH 远端、SHA-256 仓库 |
| 包管理（pnpm） | 🔧 已实现，待真机验证 | `android-pnpm` 在**进程内**运行 vendored pnpm 9.15.9；生命周期脚本恒禁用（`--ignore-scripts`），离线下写操作结构化拒绝，项目必须落在声明的工作区根内 |
| 终端面板 / PTY | ❌ v1 不做（决策暂缓） | 补丁 0001 + 宿主桥把 `terminal.pty` 暴露为结构化 unsupported。`payload/extensions/android-pty/` 是**仅评估用**试验件（`/pty-test`），其原生件尚未投放到 jniLibs，自检会结构化失败，不影响产品 |
| Code-mode（QuickJS 沙箱） | ⬜ 未验证 | Android **默认开 JIT**（没有鸿蒙式 W^X ACL 门），探针上 WebAssembly validate 成功，因此 code-mode 预期可用，只是尚未端到端验证。`jitless/` 是仅当 `WebAssembly` 缺失时安装的兜底层 |
| MCP stdio 服务器 | ⚠️ 仅通道 | 鸿蒙上「子进程 exit 事件不送达」的阻塞在 Android 不存在（`exit`/`close` 正常送达），但尚未接真实 MCP 服务器；随包 `mcp.json` 为空 |
| 工作区 / 用户文件 | ✅ 应用专属外存（免权限）+ SAF | 主线工作区在 `Android/data/<包>/files/workspace`；其它目录树经存储访问框架（SAF）加入（`content://` URI + 持久化授权），它不是 POSIX 路径，经 `android-saf` 桥暴露 |
| 通知 | 🔧 桥已实现 | `notify.show` 走通知渠道；Android 13+ 运行时申请 `POST_NOTIFICATIONS`，拒绝时结构化回报 |
| 后台保活 | ✅ 已实现（启停真机验证） | `runtime.keepAlive` 驱动 `dataSync` 型前台服务 + 常驻通知 |
| 外链 | ✅ | 仅主 frame 非本地导航经 `ACTION_VIEW` 交系统浏览器；`window.open` 被截留承载，子 frame 放行 |
| 自动更新 / 托盘 | ❌ / ➖ | v1 无更新器（首发侧载/国内渠道 APK，Google Play 后置）；托盘仅桌面版有 |
| codemode classifier WASM、图片处理 | ✅/🔧 | 默认引擎 JIT+WASM 可用；图片缩放在 jitless 兜底层沿用 ark 同款纯 JS photon 垫片策略 |

详见 [`payload/skills/android-runtime-capabilities/SKILL.md`](payload/skills/android-runtime-capabilities/SKILL.md)
（给模型看的能力摘要）与权威 as-built 清单
[`docs/安卓环境能力清单-0.12.1.md`](docs/安卓环境能力清单-0.12.1.md)。

## 对上游 pi-web 的补丁

6 条幂等、可反向的补丁（载荷组装时自动应用，收尾把 pi-web 工作树还原为 pristine）：

| 补丁 | 用途 |
|---|---|
| `0001-terminal-capability-unsupported` | 把缺失的 PTY 呈现为结构化能力标志，而不是原生模块加载异常 |
| `0002-cwd-sandbox-root-from-android-roots` | 从 `PI_ANDROID_ROOTS` 解析工作目录 / 浏览根 |
| `0003-cwd-adb-path-alias-normalize` | 把 adb/主机风格路径别名归一为沙箱相对路径 |
| `0004-session-export-runtime-identity-guard` | 运行时身份为 `app_process`、无法 spawn Node 时，会话导出走进程内回退 |
| `0005-directory-picker-contract` | 工作区根 Tab + 由宿主 roots 供数的目录选择器契约（前端零路径硬编码） |
| `0006-directory-picker-permission-flow` | 把 `EACCES`/`EPERM` 与 `ENOENT` 分开 → HTTP 403 + `canRequest`；`POST /api/host/perm` 拉起系统授权窗 |

## 隐私与合规

- 应用**不收集账号、无广告追踪/统计/崩溃 SDK、不做服务端中转**：你的 API Key（内部存储，
  `0600`）、会话、文件只在调用你自己配置的模型服务商时离开设备。渠道审核材料草稿：
  [`docs/隐私政策与AI标识-G8G9.md`](docs/隐私政策与AI标识-G8G9.md)。
- UI 底部常驻「内容由 AI 生成」标识。
- 清单只申请 4 类权限（`INTERNET`、`ACCESS_NETWORK_STATE`、`POST_NOTIFICATIONS`、
  `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`）；WebView 远程调试**仅 debug 构建**开启。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/000-工程规划.md`](docs/000-工程规划.md) | 工程规划、决策、能力矩阵、分期（规划口径权威，v0.2） |
| [`docs/安卓环境能力清单-0.12.1.md`](docs/安卓环境能力清单-0.12.1.md) | **as-built 权威能力清单**：对标 ark，附证据与根因分层 |
| [`docs/002-真机验证记录.md`](docs/002-真机验证记录.md) | Phase 0 探针记录、模拟器翻译层结论、真机 A1–A8 证据 |
| [`docs/隐私政策与AI标识-G8G9.md`](docs/隐私政策与AI标识-G8G9.md) | 上架用隐私政策与 AI 标识材料草稿 |
| [`specs/`](specs/) | 模块规格（`101`–`107`）、架构、宪法、总体测试用例 |

## 许可

MIT（见 [`LICENSE`](LICENSE)）。上游 `Pi` / `Pi Web` 为 MIT 许可；vendored 组件保留各自许可证
（如 `payload/extensions/android-pnpm/vendor/pnpm.LICENSE`）。
