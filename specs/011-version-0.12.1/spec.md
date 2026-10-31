# 011 — 版本更新：0.12.1（version）功能规格

> **Module:** version ｜ **Status:** Implemented ｜ **Last Updated:** 2026-10-31
> **上游基线:** `pi` v1.2.0（`06a466935536f8c9bcacb2d5efc0fc021be1bdff`）· `pi-web` v0.12.1（`f83b1a502f8e434555a7153fe08e1c135dd65ca9`）
> **本工程版本:** `versionName` **0.1.0** / `versionCode` **1**（首发预发布；与上游版本号分离）
> **发布 tag:** `v0.12.1`（GitHub Release）
> **规划依据:** [`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) 头部版本表、§12 引擎矩阵、§15 Phase 3、§16.3 构建配方
> **同型参考:** `pi-desktop` / `pi-desktop-hos` 的 `011-version-0.12.1`（同一上游基线；本规格只记 Android 差异）

## 1. 模块概述

### 1.1 目的

把 Android 版的**上游载荷、运行时引擎与发布出口**收敛到 `v0.12.1` 基线，并明确一个容易混淆的事实：

- **上游版本** = `pi-web` v0.12.1（载荷内容）与 `pi` v1.2.0（agent）；
- **本工程应用版本** = `0.1.0` / `versionCode` 1（Android 首发预发布，尚未与上游版本号同步）；
- **发布 tag** = `v0.12.1`（用于 Release 命名与产物归档，**不注入** `versionName` / `versionCode`）。

本模块回答：升级到该基线时，哪些文件必须钉住、哪些门禁必须通过、发布产物必须包含什么、哪些旧结论必须保留。

### 1.2 解决的问题

- 上游 `pi-web` / `pi` 随手升级会让载荷与补丁、运行时引擎、文档三者脱钩。
- Android 的 `versionCode` 与上游 tag 语义不同，若把 tag 注入构建号会造成版本号回退或渠道冲突。
- 运行时引擎来自 Maven Central AAR，必须与 `runtime.lock.json` 的 SHA-256 / ELF 门禁一致。
- 六条上游补丁必须按 `v0.12.1` 目录归档，且可逆、幂等。

### 1.3 范围

**包含**

- 上游基线钉住：`PI_WEB_TAG: v0.12.1`、`pi` v1.2.0、`runtime.lock.json` 的 Node 24.22.1 / bridge 0.2.0。
- 应用版本与发布 tag 的**分离口径**：`app/build.gradle.kts` 的 `0.1.0` / 1 不变；tag 只用于 Release。
- 补丁目录 `patches/v0.12.1/`（6 条）与载荷组装、裁剪、品牌化的版本一致性。
- 引擎门禁：`scripts/verify-runtime.mjs` 对 AAR 做 SHA-256 + ELF 六项校验。
- CI：`.github/workflows/build-release.yml` 的 tag 触发、签名 APK、GitHub Release。
- 文档同步：README / `docs/000-工程规划.md` / `docs/安卓环境能力清单-0.12.1.md`。

**不包含**

- 修改上游 `pi` / `pi-web` 源码；只允许 `patches/v0.12.1/` 的幂等补丁。
- 把 `versionName` 提升到 `0.12.1`（需单独的产品版本决策）。
- Google Play 上架、自动更新、静默安装。
- 父工程 `pi-workspace` 的指针与发布说明（父工程单独提交）。

## 2. 用户故事

- 作为发布者，我能用同一个 tag 复现出与上次一致的签名 APK，并能从 Release 附件追溯到上游 tag。
- 作为维护者，我能从 `runtime.lock.json` 与 workflow env 一眼看出当前锁定的 Node / bridge / pi-web 版本。
- 作为审核者，我能验证「应用版本 0.1.0」与「上游 0.12.1」是两个独立概念，不会误判为版本回退。
- 作为开发者，我在升级上游时知道必须先改规划、再改版本表、再跑门禁。

## 3. 功能需求

### 3.1 上游与运行时钉住

- **FR-011-001**（MUST）：`.github/workflows/build-release.yml` 的 `PI_WEB_TAG` 必须为 `v0.12.1`，且检出上游时使用该 tag。
- **FR-011-002**（MUST）：`runtime.lock.json` 的 `active.node` 必须为 `24.22.1`、`active.bridge` 必须为 `0.2.0`，并记录 `libnodeSha256` / `libcxxSharedSha256`。
- **FR-011-003**（MUST）：`gradle/libs.versions.toml` 的 `nodeRuntime` 必须与 `runtime.lock.json` 一致；升级必须同时改两处。
- **FR-011-004**（MUST）：`scripts/verify-runtime.mjs` 必须对预取 AAR 执行 SHA-256 与 ELF 六项门禁（`ET_DYN` / 无 `PT_INTERP` / aarch64 / soname / `node::Start` 导出 / 16KB 对齐），失败即构建失败。

### 3.2 版本号与发布 tag

- **FR-011-005**（MUST）：`app/build.gradle.kts` 的 `versionName` 必须为 `0.1.0`、`versionCode` 必须为 `1`；本次基线收敛**不得**改动二者。
- **FR-011-006**（MUST）：`versionCode` 必须单调递增；后续任何发布不得回退或复用已发布值。
- **FR-011-007**（MUST）：发布 tag 必须为 `v0.12.1`，且只用于 GitHub Release 与 APK 命名；**MUST NOT** 注入 `versionName` / `versionCode`。
- **FR-011-008**（MUST）：Release 附件必须包含签名（或 debug 兜底）APK 与其 `.sha256` 文件；签名材料不得入库。

### 3.3 载荷与补丁

- **FR-011-009**（MUST）：`patches/v0.12.1/` 必须包含 6 条按该基线生成的幂等补丁（与 ark 同构）。
- **FR-011-010**（MUST）：补丁应用必须遵循「反向检查 → 正向检查 → 应用 → 反向 → SHA-256 还原断言」；冲突即终止，禁止 `--3way`。
- **FR-011-011**（MUST）：载荷组装必须使用 `scripts/assemble-payload.mjs` + `scripts/crop-rules.mjs`，并产出可复现的 `pi-web.tar.gz`。
- **FR-011-012**（MUST）：载荷品牌化必须由 `scripts/brand-assets.mjs` 在暂存副本上执行；不得改上游源码。

### 3.4 文档与证据

- **FR-011-013**（MUST）：README、`docs/000-工程规划.md`、`docs/安卓环境能力清单-0.12.1.md` 的上游基线必须一致为 `pi` v1.2.0 + `pi-web` v0.12.1。
- **FR-011-014**（MUST）：历史版本结论（`docs/002-真机验证记录.md` 的轮次、旧版能力数值）必须保留，不得回改。
- **FR-011-015**（MUST）：发布记录必须给出 workflow run id 与 Release URL，作为「已发布」的可证伪证据。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 上游基线 | 载荷与 agent 的来源 | `pi` tag / SHA、`pi-web` tag / SHA |
| 运行时锁 | 引擎单一事实源 | Node 版本、bridge 版本、AAR 坐标、SHA-256、ABI |
| 应用版本 | Android 包版本 | `versionName`、`versionCode` |
| 发布 tag | Release 标识 | `v0.12.1`、附件、run id |
| 补丁集 | 对 pi-web 的可逆修改 | 目录、条数、幂等性、SHA-256 还原 |

## 5. 验收场景

### 场景：基线一致性

- Given 工作树在 `main` 分支且上游目录干净
- When 检查 workflow env、`runtime.lock.json`、`libs.versions.toml`
- Then `PI_WEB_TAG=v0.12.1`、Node `24.22.1`、bridge `0.2.0` 三处一致

### 场景：引擎门禁

- Given 已从 Maven Central 预取 `node-runtime-24.22.1.aar`
- When 运行 `node scripts/verify-runtime.mjs --aar <aar>`
- Then SHA-256 与 `runtime.lock.json` 相等，ELF 六项全部通过，退出码 0

### 场景：发布

- Given 推送 tag `v0.12.1`
- When `.github/workflows/build-release.yml` 完成
- Then GitHub Release 含 APK + `.sha256`，应用内 `versionName` 仍为 `0.1.0`

### 场景：版本号不回退

- Given 上一发布 `versionCode=1`
- When 准备下一次发布
- Then 新 `versionCode` 必须大于 1；tag 不得替代 `versionCode`

## 6. 非功能需求

- **可复现**：同一 tag + 同一 `runtime.lock.json` 产出等价 APK（签名材料除外）。
- **可追溯**：Release 说明包含上游 tag、Node 版本、补丁数、workflow run id。
- **安全**：签名材料、keystore 口令、API Key 不入库；日志不回显。
- **体积**：libnode.so 压缩进 APK，`noCompress += "gz"` 保持载荷可 fd 直读。

## 7. 假设与约束

- 上游 `pi v1.2.0` / `pi-web v0.12.1` 的 tag 与 SHA 与桌面版一致。
- Maven Central 的 `node-runtime:24.22.1` 可用；离线时用 `scripts/provision-engine.mjs` 兜底。
- Android 应用版本 `0.1.0` 是首发预发布，不随上游 `0.12.1` 改名。

## 8. 依赖

- 上游：`pi` v1.2.0、`pi-web` v0.12.1。
- 运行时：`io.github.fellow99:node-bridge:0.2.0`、`io.github.fellow99:node-runtime:24.22.1`。
- 模块：`012-building-workflow`（构建/发布）、`102-payload-pipeline-assembly-crop`（载荷）、`107-compliance-and-security`（签名与合规）。
- 父工程：`../../specs/011-version-0.12.1/`（跨工程版本口径）。
