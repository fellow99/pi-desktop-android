# TECH.md — 技术选型

> 整个项目的技术决策与版本锁定。唯一权威是 `docs/000-工程规划.md`；本文件是技术面速查。
> 版本升级必须先改规划 §12，再改这里与 `gradle/libs.versions.toml`。

## 形态一句话

Kotlin/Android 宿主（Activity + 系统 WebView）+ **库提供的进程内 Node**（Maven 双 AAR：dlopen + node::Start）+ 端上 pi-web 服务端（同源 HTTP + SSE）。**无 Chromium 随包、无 Termux、无子进程 Node**。形态逐层对标 `pi-desktop-ark`（HarmonyOS Edition）。

## 锁定版本

| 项 | 值 | 说明 |
|---|---|---|
| AGP / Gradle / Kotlin | 8.10.1 / 8.12（wrapper）/ 2.2.20 | bridge 侧 AGP 9.2.1 需 Gradle 9，本机工具链锁 8.x（升级时同步升） |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 | 与库矩阵一致（`runtime.lock.json#matrix`） |
| ABI | 仅 `arm64-v8a` | `libnode.so` 只出 arm64 |
| node-bridge | `io.github.fellow99:node-bridge:0.2.0`（implementation） | Kotlin API（StateFlow）+ JNI 引导件 + NAPI addon + 内建 JS 载荷 |
| node-runtime | `io.github.fellow99:node-runtime:24.2.0`（runtimeOnly） | `libnode.so` 84,128,040 B，`--with-intl=none`，八项 ELF 门禁（含 16KB 对齐）已过 |
| 上游基线 | `pi` v1.2.0 / `pi-web` v0.12.1 | 子模块固定 tag，补丁按 tag 建目录 |
| Next | 16.3.8（webpack 构建，`next build --webpack`） | 进程内启动：`next/dist/server/lib/start-server.js` |
| 构建机 Node | ≥22.19（本机 v24.7.0） | 仅宿主机组装用；设备上是 24.2.0 引擎 |

## 关键技术决策

| # | 决策 | 依据 |
|---|---|---|
| 1 | 载荷 = 归档 + Kotlin 首启解包（SHA-256 幂等 marker） | Android assets 非文件系统路径（bridge §4.8 #1）；规划 §7.1 |
| 2 | 解包执行者在 Kotlin | AssetManager 只有 Java/Kotlin 侧高效可读；bridge 0.2.0 无 archiveAsset ⇒ app 自实现 `PayloadArchive`（接口形状按规划，库升级可替换） |
| 3 | WebView 数据面：cleartext 仅放行 loopback + DOM Storage 必开 | `network_security_config.xml`；Phase 0 O3 全绿（含 `isSecureContext=true`、SSE、crypto.subtle） |
| 4 | 鉴权：loopback 免密（路线 ①） | 上游对 loopback 放行逻辑已核（ark §6.1）；密码回退留作路线 ② |
| 5 | 就绪判定 = marker 真实端口 + `/api/web-auth` 200 | 不监听 stdout "Ready"；硬约束 ⑰⑱ |
| 6 | spawn 语义：常驻 shell + 哨兵行，不依赖 exit/close 时序 | `/system/bin/sh` 三事件实测齐全（Phase 0 O5）；规划 §2.3 #6 |
| 7 | 裁剪在打包期对副本做（硬链接暂存） | 删 win32 SWC 会触发联网补装（ark 实测）；Windows 整树复制不可行 ⇒ 硬链接零拷贝 |
| 8 | 补丁流水线幂等 + 整栈逆序判定 | 栈式补丁的上下文互叠（Phase 1 实测教训：正序逐条 reverse-check 会误判） |
| 9 | 构建仓库顺序：官方前置、阿里云兜底 | aliyun public 对 `node-runtime:24.2.0` 滞后 404（2026-10-27 实测） |
| 10 | 零 AndroidX 依赖（v1 壳） | 经典 View 体系足够；减少构建面（后续引入 Compose/AndroidX 需过 specs） |

## 平台缺口与降级（速查）

| 缺口 | v1 处置 |
|---|---|
| 进程内 Node 崩溃不可重启 | 失败态 UX +「重启应用」（`MainActivity.restartApp`） |
| `Intl` 缺失（`--with-intl=none`） | ⚠️ 实测构造器全缺、Unicode 属性转义编译期抛错；载荷冒烟为准（`docs/002` O2） |
| PTY 暂缓 | 补丁 0001 结构化 unsupported + 宿主 `terminal.pty` 能力同口径 |
| 共享存储无 POSIX 路径 | app-specific 外存真实路径主线；SAF 桥 Phase 2 |
| WebView 明文 loopback | networkSecurityConfig 精准放行 127.0.0.1/localhost |
