# pi-desktop-android — 规范文档（specs/）

> 本目录是 **pi-desktop-android** 的规范文档体系（specs-as-built 方法：planned 与 as-built 逐条区分）。
> 需求模块只落在本工程 `specs/`，**不**进父工程 `pi-workspace`。
> 事实权威：`../docs/000-工程规划.md`；行为权威：`constitution.md`。

## 文档索引

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | 本文件：项目与文档导读 |
| [SPECS_CHECKLIST.md](SPECS_CHECKLIST.md) | 各功能模块规范文档的完成状态清单 |
| [STRUCTURE.md](STRUCTURE.md) | 整个工程的目录文件结构（随 as-built 更新） |
| [TECH.md](TECH.md) | 整个项目的技术选型与锁定版本 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 整体架构、启动时序、责任分界、环境契约 |
| [constitution.md](constitution.md) | 宪法原则（C1–C10，不可协商） |
| [overall-spec.md](overall-spec.md) | 整体规格（需求→能力映射，验收口径） |
| [overall-plan.md](overall-plan.md) | 整体技术方案（分阶段落地路径） |
| [overall-data-model.md](overall-data-model.md) | 数据模型（沙箱落点、会话、凭据、配置） |
| [overall-test-cases.md](overall-test-cases.md) | 测试用例索引（探针/E2E/devtest 的判据目录） |

## 功能模块目录（`NNN-<模块>-<二级模块>/`）

| 目录 | 模块 | 对标 ark |
|---|---|---|
| `101-runtime-integration-launch-orchestration/` | 运行时接入与启动编排 | 101 |
| `102-payload-pipeline-assembly-crop/` | 载荷组装流水线（补丁/裁剪/打包） | 102 |
| `103-webview-shell-render-pages/` | 渲染壳（三态 UI/围栏/返回键） | 103 |
| `104-host-capabilities-kotlin-impl/` | 宿主能力（Kotlin 10 项） | 104 |
| `105-auth-loopback-no-password/` | 鉴权（loopback 免密路线 ①） | 105 |
| `106-tools-extensions-same-name-overrides/` | 同名顶替扩展四件 | 106 |
| `107-compliance-and-security/` | 合规与敏感信息纪律 | 107 |

> 每个模块目录含 `spec.md`（需求/验收）与 `plan.md`（技术方案），as-built 状态以 ✅/⬜/⚠️ 标注。

## 项目一句话

`pi-desktop-android` = **Pi Desktop 的 Android 形态**：Kotlin 壳 + 系统 WebView 渲染**本机进程内 Node 跑起的 pi-web**（`aosp-node-bridge` + `node-runtime` 双 AAR），无 Chromium 随包、无 Termux、无子进程 Node。对标 `pi-desktop-ark`，能力增量：git/pnpm（后期阶段）与前台服务。

## 相关文档（工程内）

- `docs/000-工程规划.md` —— 唯一权威规划（结论先写这里）
- `../docs/002-真机验证记录.md` —— Phase 0 探针与 E2E 验证证据
- `../docs/安卓环境能力清单-0.12.1.md` —— **as-built 能力清单**（对标 ark 001 的 33 项主表 + 待实现项分级）
- `docs/evidence/` —— 探针 JSON 与截图
- `patches/v0.12.1/` —— 上游补丁（纪律见 `docs/000-工程规划.md` §9）
