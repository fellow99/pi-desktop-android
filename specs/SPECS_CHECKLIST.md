# SPECS_CHECKLIST.md — 规范文档完成清单

> 每个功能模块的规范文档完成情况。状态：✅ 完成 · 🚧 进行中 · ⬜ 未开始（对应阶段未到）。

## 根文档

| 文档 | 状态 | 说明 |
|---|---|---|
| README.md | ✅ | 文档索引与导读 |
| SPECS_CHECKLIST.md | ✅ | 本文件 |
| STRUCTURE.md | ⬜ | 随 as-built 生成（E2E 后核对目录） |
| TECH.md | ✅ | 技术选型与锁定版本 |
| ARCHITECTURE.md | ✅ | 架构/时序/分界/环境契约 |
| constitution.md | ✅ | C1–C10 |
| overall-spec.md | 🚧 | 整体规格（E2E 后回填 as-built 列） |
| overall-plan.md | 🚧 | 整体技术方案（分阶段） |
| overall-data-model.md | 🚧 | 数据模型 |
| overall-test-cases.md | 🚧 | 测试用例索引（Phase 0 已有判据，E2E 后补全） |

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
| Phase 0 消费方探针 | ✅ | `docs/002-真机验证记录.md`（O1/O2/O3/O4/O5/O7） |
| Phase 1 端到端链路 | 🚧 | 载荷组装 + 壳已完成；E2E（装机会话/流式/持久化）进行中 |
| Phase 2 宿主能力补齐 | ⬜ | SAF 桥/perm 流（本期仅桩） |
| Phase 3 git/pnpm + 合规发布 | ⬜ | — |
| Phase 4 加固演进 | ⬜ | — |
