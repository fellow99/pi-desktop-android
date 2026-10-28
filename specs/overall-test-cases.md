# overall-test-cases.md — 测试用例索引

> 测试判据的**目录**：每条用例指向可复核的证据（HTTP JSON / 截图 / run-as 读回文件）。
> 判据纪律（宪法 C5/C10）：以可读回证据为准，不以 logcat 为判据。

## T0 Phase 0 平台探针（已完成 ✅）

| 用例 | 判据 | 结果 | 证据 |
|---|---|---|---|
| T0-1 JIT/WASM（O1） | `GET /jit` → `wasm=ok` 且 `hotLoopMs<1000` | ✅ | `docs/evidence/jit.json` |
| T0-2 Intl 影响面（O2） | `GET /intl` → 逐项 ok/error 结构化 | ⚠️ 全缺+编译期抛错 | `docs/evidence/intl.json` |
| T0-3 WebView cleartext（O3a） | WebView 加载 `http://127.0.0.1:<port>/o3.html` 渲染成功 | ✅ | `docs/evidence/phase0-probe-o3-page.png` |
| T0-4 secure-context + crypto.subtle（O3b） | `o3-report.isSecureContext=true` 且 sha256(abc) 前缀 `ba7816bf` | ✅ | `docs/evidence/o3.json` |
| T0-5 localStorage（O3c） | `o3-report.localStorage=true` | ✅ | 同上 |
| T0-6 SSE EventSource（O3d） | `o3-report.sseEventSource=true`（服务端 `curl -N /sse` 对照） | ✅ | 同上 |
| T0-7 解包（O4） | 27,179 文件冷解 ≤60s；二次幂等 0ms；0 穿越 | ✅ 18.0s/0ms/0 | run-as `o4-report.json` |
| T0-8 spawn sh（O5） | `/spawn`：事件含 spawn→stdout→exit→close；哨兵行；嵌套 | ✅ | `docs/evidence/spawn.json` |
| T0-9 宿主桥往返 | `/basic` → `host.echo.ok=true`（Kotlin 回执可见） | ✅ | `docs/evidence/basic.json` |
| T0-10 worker/fs | worker 42；fs roundTrip | ✅ | 同上 |

## T1 Phase 1 端到端（⚠️ 模拟器翻译层阻塞：T1-2 后半/T1-5/6/7 未能在模拟器完成，真机交接命令见 docs/002 E2E 节）

| 用例 | 判据 | 结果 | 证据 |
|---|---|---|---|
| T1-1 APK 构建 | `gradlew :app:assembleDebug` exit 0；APK 含 libnode.so + assets 载荷 | ✅ | 构建 log + `unzip -l` |
| T1-2 首屏渲染 | 启动应用 → WebView 渲染 Pi Web UI 首屏；`/api/web-auth` 200 | ⚠️ 加载页+解包+编排+宿主桥 ✅；Next 引导 SEGV | `docs/002` E2E + evidence/shell-loading-page.png |
| T1-3 建工作区 | UI/API 建会话（cwd=PI_ANDROID_ROOTS sandbox 根内）成功 | ⬜ 随 T1-2 阻塞（sandbox 根已由宿主创建并注入） | — |
| T1-4 模型配置 | 配置 DeepSeek（模型 deepseek-flash）后 auth 落沙箱 `auth.json`（0600）；**仓库无 Key** | ⬜ 随 T1-2（deepseek-flash 已确认在模型注册表；仓库侧扫描 ✅ 0 命中） | 扫描记录（107） |
| T1-5 对话流式 | 发「介绍一下你自己」→ SSE 流式回复完整 | ⬜ 随 T1-2（SSE 数据面已由 T0-6 验证） | — |
| T1-6 看图分析 | 附图对话 → 模型给出图像内容分析 | ⬜ 随 T1-2 | — |
| T1-7 会话持久化 | 重启应用 → 会话列表仍在 | ⬜ 随 T1-2 | — |
| T1-8 敏感信息扫描 | 仓库 grep 无 Key 明文/凭证 | ✅ 实际 Key/generic sk-/凭证模式 全 0 命中 | 本次提交前扫描 |

## T2 Phase 2 宿主能力（✅ 模拟器实测 2026-10-29；SSE/真弹窗项见 docs/002 T2 表）

| 用例 | 判据 | 结果 | 证据 |
|---|---|---|---|
| T2-1 宿主能力自检 | `am start --ez selftest true` → selftest 报告 14/14 | ✅ | `pi-web.selftest.json`（run-as 读回） |
| T2-2 引擎引导事实/Intl | boot-facts：Intl 8 构造器+属性转义编译+exec 全 true；wasm validateOk | ✅ | `pi-web.boot-facts.json` |
| T2-3 形态事实合并 | engine-facts.json 含 platform/decision/payloadSha + bootFacts | ✅ | `engine-facts.json` |
| T2-4 前台服务+Doze | isForeground=true(dataSync)；deep-idle 进程/服务存活；SSE ⬜ | ✅ | dumpsys（docs/002 T2-5/6） |
| T2-5 崩溃哨兵 | crash-test → last-crash.txt 落盘 + 重启横幅 | ✅ | `crash/last-crash.txt` + evidence 截图 |
| T2-6 预览密钥轮换随包 | app.log「预览密钥已轮换」替代 WARN | ✅ | app.log 04:28:09.732 |
| T2-7 SAF dryRun 契约 | pickFolder/pickFiles dryRun 回 would-Intent | ✅ | selftest 报告 |
| T2-8 SAF 真弹窗 | 人工选择 → 持久化授权 + 结果文件 | ⬜ headless | —（人工路径） |
| T2-9 git204 / pnpm 套件 | Phase 3（对标 ark） | ⬜ | — |
| T2-10 机型验证矩阵扩容 | ≥2 真机 × 2 Android 版本（真机项，挂起） | ⬜ | 模拟器口径见 docs/002 |
| T2-11 裁剪回归守门 | `node scripts/devtest.mjs` 全绿（G1 引擎锁/G2 资产 sha/G3 规则自审/G4 Intl 残留/G5 端上事实） | ✅ G1–G4；G5 可选 | devtest 输出 |
| T2-12 载荷裁剪 | stage ≤ 31k 文件 / ≤ 320MiB（对标 ark 27k/375MB 档） | ✅ 30,413 / 307.4MiB（tar.gz 74.5MiB） | assemble --apply 日志 |

## T3 Phase 3（✅ 模拟器实测 2026-10-29；取证见 docs/002 Phase 3 节）

| 用例 | 判据 | 结果 | 证据 |
|---|---|---|---|
| T3-1 git 单源一致性 | sync --check：39 文件一致 + synced-from 标记 | ✅ | `scripts/sync-git-extension.mjs --check` |
| T3-2 git 宿主单测 | node --test tests/*.test.mjs = 25 pass/0 fail | ✅ | 本机 node:test |
| T3-3 git204-lite 设备链 | init→…→status 8 步全 OK（debug+release 双包） | ✅ | `pi-web.git-selftest.json` |
| T3-4 pnpm bundle 载入执行 | --version=9.15.9 / config get / add 进度真实推进 | ✅ | `pi-web.pnpm-selftest.json`（output 字段） |
| T3-5 pnpm 终止信号（R8-1） | CLI 完成路径在本环境不落地 ⇒ 120s 超时 | ❌→⬜ 真机 | 同上（timedOut 字段） |
| T3-6 回归四件套 | 包体/签名/首启/facts 入 baseline | ✅ | `build/regression.json` |
| T3-7 合规机械项 | G1–G7/G10/G11 PASS | ✅ | compliance-check 输出 |
| T3-8 侧载 release 签名 APK | apksigner + zipalign-P16 + 冒烟 | ✅ | app-release.apk 156.8MiB |
| T3-9 clone/远端 git 用例 | 依赖 pi-web 会话面 | ⬜ | — |

## T4 Phase 4 · PTY 路线 A（✅ 模拟器实测 2026-10-29；取证见 docs/002 Phase 4 两节）

| 用例 | 判据 | 结果 | 证据 |
|---|---|---|---|
| T4-1 O6 探针 | ptmx-open/devpts/slave/script/stty 五步结构化 | ✅ | `evidence/pty-selftest.json` |
| T4-2 交叉编译 | NDK r28c + headers@24.22.1 → pty.node（aarch64/Android24） | ✅ | `vendor/pty.node.lock.json` |
| T4-3 装载（debug） | 数据目录 require 成功（DT_NEEDED libnode.so 符号可达） | ✅ | `pi-web.ptynode-selftest.json` |
| T4-4 真 PTY 回程（debug） | node-pty.spawn sh → PTY_ROUNDTRIP_OK + id/tty（forkpty 全链 621ms） | ✅ | 同上 |
| T4-5 装载+回程（release） | 同 T4-3/4（528ms） | ✅ | `evidence/pty-route-a-release.logcat.txt` |
| T4-6 lock/provision/devtest 门禁 | sha256 `b965c62d…` 三处一致 | ✅ | devtest G6 |
| T4-7 terminal.pty 产品化 | android-exec pty 通道 + /api/terminal 联调 | ⬜ 随 pi-web（真机窗口）+ 用户拍板 | — |
| T4-8 ptmx-open 真机复测 | user 版 SELinux 口径 | ⬜ 真机 | — |
