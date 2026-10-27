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

## T2 后续阶段（⬜ 规划占位）

- T2-x SAF 选择器/授权流（Phase 2，补丁 0005/0006 契约）
- T2-x git204 / pnpm 套件（Phase 3，对标 ark）
- T2-x 机型验证矩阵扩容（Phase 3+）
