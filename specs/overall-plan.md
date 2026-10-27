# overall-plan.md — 整体技术方案

> 分阶段落地方案（对应规划 §15）。本文件记录「怎么做与为什么这么做」；结论以 `docs/000-工程规划.md` 为准。

## 阶段 0：消费方探针（已完成 ✅）

**目的**：用最小代价验证规划里所有 ⬜ 的平台判断，避免在错误假设上盖楼。

做法：独立探针 Activity（`probe/`）+ 探针载荷（`assets/probe/probe-entry.js`），桥内建 selfcheck 思路扩展：
- 每类判断一个独立 HTTP 端点（`/basic /jit /intl /spawn`），`withTimeout` 硬超时，异步 spawn + 定时 kill；
- WebView 数据面用页面内自测回传（`/o3.html` → POST `/o3-report`）；
- 解包基准（O4）用真实 85MB 载荷三连测（冷/清理后再解/幂等）。

**结论**：O1/O3/O4/O5/O7 ✅，O2 ⚠️（Intl 全缺），O6 暂缓。过程教训（端口互抢、诊断端点互阻、取证端口避开常用值）已进宪法与 specs。
**清理**：探针代码整体删除（提交 `ccb8923`），结论文档保留。

## 阶段 1：端到端产品链路（当前 ✅ 见 overall-spec S4）

1. **载荷流水线**（`scripts/assemble-payload.mjs`）：
   补丁（幂等/可往返/整栈逆序判定）→ PI_DIST 引导（产品面文件；node_modules 不复制）→ 标记断言
   （缺则 `next build --webpack` 重编并镜像 .next）→ 裁剪暂存（硬链接，零数据拷贝——Windows 整树复制实测不可行）
   → 壳资产 → 确定性 ustar+gzip（mtime=0，与 Kotlin 解包器一一对应）→ 归档自检 → assets + 版本文件 → pi-web 还原 pristine。
2. **Kotlin 壳**：`PiDesktopRuntime`（编排 + StateFlow 三态）+ `MainActivity`（加载/WebView/错误三态 + 围栏 + 返回键 + 重启语义）+ `HostCapabilities`（10 能力）+ `PayloadArchive`（ustar/gzip 解包，SHA-256 幂等，路径穿越校验）。
3. **Node 侧移植**：`pi-web-launch.js`（ark 移植，宿主桥区块按 bridge 0.2.0 适配）+ `env.js`（`PI_ANDROID_ROOTS` 契约、不设 `PI_OFFLINE`）+ 四件同名顶替扩展 + jitless 兼容层 + config + skills。

## 阶段 2（后续）：宿主能力补齐

SAF 选择器真接入（`fs.pickFolder/pickFiles`）、`perm.request/openAppInfo` 授权流、通知权限请求流、前台服务（可选）、§8 能力矩阵逐项打勾。

## 阶段 3（后续）：git / pnpm 能力 + 合规发布

`android-git`（isomorphic-git 单源同步自 pi-desktop-hos，23 工具面 + git204 套件）；`android-pnpm`（vendored bundle 进程内）；体积/首启回归四件套；G1–G11 合规核销；侧载/国内渠道签名 APK。

## 阶段 4（可选）：加固与演进

`:node` 独立进程形态、PTY 重启评估（先跑 O6 探针）、机型验证矩阵扩容、Node 24.22.1 升级、Play 渠道转入（AAB/PAD）。

## 风险登记（与规划 §14 对照的增量）

| # | 风险 | 本期实证 | 处置 |
|---|---|---|---|
| R11 | 共享 pi-web 工作树被并行流水线争用（兄弟工程同机同源） | 本期实测：两个 assemble 并发导致工作树状态互踩 | 约定：assemble 前检查无并发实例；必要时串行协调（specs/102 登记） |
| R12 | Windows 构建面性能（Defender + 海量小文件） | 整树复制 10min+ 不可行 | 硬链接暂存（零数据拷贝）|
