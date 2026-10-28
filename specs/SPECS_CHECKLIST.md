# SPECS_CHECKLIST.md — 规范文档完成清单

> 每个功能模块的规范文档完成情况。状态：✅ 完成 · 🚧 进行中 · ⬜ 未开始（对应阶段未到）。

## 根文档

| 文档 | 状态 | 说明 |
|---|---|---|
| README.md | ✅ | 文档索引与导读 |
| SPECS_CHECKLIST.md | ✅ | 本文件 |
| STRUCTURE.md | ✅ | 脚本生成 + 关键文件抽查一致（2026-10-28） |
| TECH.md | ✅ | 技术选型与锁定版本 |
| ARCHITECTURE.md | ✅ | 架构/时序/分界/环境契约 |
| constitution.md | ✅ | C1–C10 |
| overall-spec.md | ✅ | 整体规格（S1–S5 判据含 as-built；E2E 项标注环境阻塞） |
| overall-plan.md | ✅ | 整体技术方案（含 R11/R12 风险登记） |
| overall-data-model.md | ✅ | 数据模型（沙箱落点/归档契约） |
| overall-test-cases.md | ✅ | 测试用例索引（T0 全绿；T1 部分被模拟器翻译层缺陷阻塞，真机交接命令已备） |

## 功能模块

| 模块目录 | spec.md | plan.md | 对应实现 | as-built 摘要 |
|---|---|---|---|---|
| `101-runtime-integration-launch-orchestration/` | ✅ | ✅ | `runtime/PiDesktopRuntime.kt` + `payload/PayloadArchive.kt` | ✅ 启动链路 E2E 见 overall-test-cases |
| `102-payload-pipeline-assembly-crop/` | ✅ | ✅ | `scripts/assemble-payload.mjs` + `crop-rules.mjs` + `patches/v0.12.1/` | ✅ 解包 27,179 文件 18.0s/幂等（Phase 0 O4） |
| `103-webview-shell-render-pages/` | ✅ | ✅ | `MainActivity.kt` | ✅ O3 数据面全绿（含 SSE） |
| `104-host-capabilities-kotlin-impl/` | ✅ | ✅ | `host/HostCapabilities.kt` | ✅ 10 能力注册；SAF/授权桩=unsupported（Phase 2） |
| `105-auth-loopback-no-password/` | ✅ | ✅ | `payload/env.js`（路线 ①） | ✅ 免密链路随 E2E 验证 |
| `106-tools-extensions-same-name-overrides/` | ✅ | ✅ | `payload/extensions/android-*.js` | ✅ 装载随 E2E 验证（/roots、工具面） |
| `107-compliance-and-security/` | ✅ | ✅ | Manifest/`network_security_config`/敏感信息扫描 | ✅ G1–G11 口径对照 |

## 里程碑对照（规划 §15）

| 阶段 | 状态 | 出口证据 |
|---|---|---|
| Phase 0 消费方探针 | ✅ | `docs/002-真机验证记录.md`（O1/O2/O3/O4/O5/O7）；**2026-10-29 增 O6 PTY 探针 ✅**（Phase 4 节） |
| Phase 1 端到端链路 | ⚠️ | 载荷组装+壳+启动链路（解包/编排/宿主桥）✅；WebView 渲染被模拟器 berberis 翻译层 SIGSEGV 阻塞（docs/002 E2E 节，真机交接命令已备）；§F 第 1 级收尾 6/6 ✅（裁剪 76.5MiB/轮换随包/engine-facts/devtest/崩溃哨兵/L-ENV 报告） |
| Phase 2 宿主能力补齐 | 🔶 4/5 | SAF 真接入+授权流+前台服务+§8 矩阵回填 ✅（selftest 14/14）；机型验证矩阵 ⏸ 真机项（docs/002 Phase 1/2 收尾节） |
| Phase 3 git/pnpm + 合规发布 | 🔶 4/5+1🔶 | android-git 单源+宿主单测 25/0+设备 8/8 ✅；回归四件套 ✅；合规机械项全过 ✅；侧载签名 APK ✅；android-pnpm 代码落地、R8-1 终止信号本环境不成立 ⏸ 真机复核（docs/002 Phase 3 节） |
| Phase 4 加固演进 | 🔶 进行中 | O6 PTY 探针 ✅ + 路线 A pty.node 交叉编译+真 PTY 回程双包 3/3 ✅（docs/002 Phase 4 两节）；`:node` 独立进程/引擎升级/Google Play ⬜ |
