# 011 — 版本更新：0.12.1（version）技术方案（As-Built）

> **Module:** 011-version-0.12.1 ｜ **Status:** Implemented ｜ **Last Updated:** 2026-10-31
> **对应规格:** [`spec.md`](./spec.md)（FR-011-001 … FR-011-015）
> **规划依据:** [`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) 头部版本表、§12、§15 Phase 3、§16.3
> **证据:** `.github/workflows/build-release.yml`、`runtime.lock.json`、`docs/002-真机验证记录.md`、Release `v0.12.1`

## 1. 技术上下文

### 1.1 运行环境

- 宿主：Kotlin + Android Gradle Plugin 8.10.1、Gradle 8.12、JDK 17。
- 运行时：`aosp-node-bridge` 0.2.0 + `node-runtime` 24.22.1（small-ICU，arm64-v8a）。
- 载荷：`pi-web` v0.12.1 生产构建 + `pi` v1.2.0 依赖 + 6 条补丁。
- CI：GitHub Actions `ubuntu-latest`，Node 24、pnpm 12.16.1、JDK 17、Python3 + Pillow。

### 1.2 关键依赖与版本

| 依赖 | 版本 | 用途 |
|---|---|---|
| `PI_WEB_TAG` | `v0.12.1` | 检出上游 pi-web |
| `node-runtime` AAR | `24.22.1` | 进程内 Node 引擎（libnode.so） |
| `node-bridge` AAR | `0.2.0` | JNI 桥 + 引导 JS |
| `versionName` / `versionCode` | `0.1.0` / `1` | Android 应用版本 |
| 发布 tag | `v0.12.1` | GitHub Release 标识 |

## 2. 宪法合规检查

| 原则 | 合规 | 说明 |
|---|---|---|
| C1 一切经同源 HTTP | ✅ | 版本收敛不引入新数据通道 |
| C2 壳薄、契约硬 | ✅ | 版本号/包名只在构建配置与文档，不进业务代码 |
| C3 结论以库与真机为准 | ✅ | 引擎事实引用 `runtime.lock.json` 与 `verify-runtime` |
| C4 不改上游 | ✅ | 只允许 `patches/v0.12.1/` 六条幂等补丁 |
| C5 失败可见 | ✅ | 门禁失败即构建失败；Release 缺失即未发布 |
| C9 敏感信息不入库 | ✅ | keystore / 口令 / API Key 不入库 |

## 3. 研究结论

- **D1 版本号分离**：Android 的 `versionName` 是产品版本（`0.1.0`），上游 `pi-web` 是载荷版本（`0.12.1`）。
  workflow 注释明确「不把 tag 注入 versionName/versionCode」，避免 tag 变成构建号。
- **D2 运行时单一事实源**：`runtime.lock.json` 记录 Node / bridge / AAR / SHA-256 / ELF 门禁；
  `gradle/libs.versions.toml` 只引用同版本，升级必须两处同改。
- **D3 补丁目录按被 patch 的 tag 建**：`patches/v0.12.1/` 六条，与 ark 同构；版本目录不跨 tag 复用。
- **D4 Release 产物**：签名 APK（secrets 齐全时）或 debug APK 兜底；附 `.sha256`；Release 说明含上游 tag 与 run id。

## 4. 数据模型

| 实体 | 字段 | 来源 |
|---|---|---|
| `runtime.lock.json` | `active.node`、`active.bridge`、`libnodeSha256`、`libcxxSharedSha256`、`gates[]` | 仓库根 |
| Gradle 版本表 | `nodeBridge`、`nodeRuntime`、`compileSdk`、`minSdk`、`targetSdk` | `gradle/libs.versions.toml` |
| 应用版本 | `versionName`、`versionCode`、`applicationId` | `app/build.gradle.kts` |
| Workflow env | `PI_WEB_TAG`、`PDA_NODE_RUNTIME_VER` | `.github/workflows/build-release.yml` |

## 5. 接口契约

### 5.1 提供的接口

- `.github/workflows/build-release.yml`：tag `v*` 触发 → 载荷组装 → 引擎门禁 → APK → Release。
- `scripts/verify-runtime.mjs --aar <path>`：退出码 0/非 0 表示引擎门禁通过/失败。

### 5.2 消费的接口

- Maven Central：`io.github.fellow99:node-runtime:24.22.1`、`io.github.fellow99:node-bridge:0.2.0`。
- GitHub：`agegr/pi-web` tag `v0.12.1`、`earendil-works/pi` v1.2.0（经 pi-web 依赖锁定）。
- 父工程 `assets/`：品牌物料（sparse checkout）。

## 6. 实现策略

### 6.1 版本收敛步骤

1. 核对上游 tag / SHA 与 `pi-web` package.json 版本。
2. 更新 workflow 的 `PI_WEB_TAG` 与 `PDA_NODE_RUNTIME_VER`。
3. 更新 `runtime.lock.json` 与 `gradle/libs.versions.toml`（如引擎升级）。
4. 生成/复核 `patches/v0.12.1/` 六条补丁。
5. 跑 `assemble-payload.mjs`、`brand-assets.mjs`、`verify-runtime.mjs`、Gradle 构建。
6. 打 tag `v0.12.1`，由 workflow 发布 Release。
7. 回写 README / 规划 / 能力清单。

### 6.2 错误处理

- 上游 tag 不存在或 SHA 不符：workflow 失败（fail-visible）。
- 引擎 SHA/ELF 门禁失败：停止构建，不产出 APK。
- 签名 secrets 部分配置：`::error::` 显式失败；全缺省时 debug 兜底并标注。

### 6.3 性能

- 载荷组装与 Next 构建是主要耗时（workflow timeout 90 min）。
- 引擎 AAR 预取一次，verify-runtime 只读校验，不重复下载。

## 7. 测试考量

- 引擎门禁：正向（正确 AAR）+ 负向（篡改 SHA / 非 ELF）。
- 版本一致性：grep workflow / runtime.lock / gradle 三处。
- 发布演练：`workflow_dispatch` 只构建不发布；tag 推送才发布。
- 真机：安装 → 启动 → `/facts` → 一次对话（见 `docs/002-真机验证记录.md`）。

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `.github/workflows/build-release.yml` | tag 触发构建与 Release |
| `runtime.lock.json` | 运行时单一事实源 |
| `gradle/libs.versions.toml` | AAR 版本引用 |
| `app/build.gradle.kts` | 应用版本 / 签名 / ABI |
| `scripts/verify-runtime.mjs` | 引擎 SHA + ELF 门禁 |
| `patches/v0.12.1/*.patch` | 六条幂等补丁 |
| `docs/000-工程规划.md` | 规划与版本决策 |
| `docs/002-真机验证记录.md` | 真机证据 |

## 9. 与规格交叉引用

| FR | 落点 |
|---|---|
| FR-011-001 | workflow `PI_WEB_TAG` |
| FR-011-002/003 | `runtime.lock.json` + `libs.versions.toml` |
| FR-011-004 | `verify-runtime.mjs` |
| FR-011-005/006/007 | `app/build.gradle.kts` + workflow 注释 |
| FR-011-008 | workflow Release job |
| FR-011-009/010 | `patches/v0.12.1/` + 组装脚本 |
| FR-011-011/012 | `assemble-payload.mjs` / `brand-assets.mjs` |
| FR-011-013/014/015 | README / docs / Release 记录 |
