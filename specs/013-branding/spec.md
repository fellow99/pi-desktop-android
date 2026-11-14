# 013 — 品牌化（branding）功能规格

> **Module:** branding ｜ **Status:** Implemented ｜ **Last Updated:** 2026-11-14（R2）
> **上游基线:** `pi` v1.2.0 / `pi-web` v0.12.1（品牌化实施轮次为 2026-10-30）
> **应用名 / 包名:** **Pi Desktop** / `top.fellow99.pi.PiDesktopAndroid`（R2 由 `org.fellow99.pi.PiDesktopAndroid` 变更，见 §R2）
> **需求编号:** `013-branding-r2` ｜ **日期:** 2026-11-14
> **物料唯一来源:** 父工程 `../assets/`（`logo.svg`、`logo.png`、`logo-1024-with-bg.png`）
> **规划依据:** [`../../docs/000-工程规划.md`](../../docs/000-工程规划.md) §头部表、G10、§16.3；[`../../docs/安卓环境能力清单-0.12.1.md`](../../docs/安卓环境能力清单-0.12.1.md) §H
> **同型参考:** `pi-desktop` 的 `013-branding`、`pi-desktop-hos` 的 `013-branding`（同一物料与判据口径）

## 1. 模块概述

### 1.1 目的

把 Android 版交付物中的上游品牌与占位图标清掉，统一为 **Pi Desktop**：

- 应用显示名、launcher / adaptive 图标、通知小图标；
- 载荷（pi-web 产物副本）中的用户可见 `Pi Web` 文案、页面 Logo、favicon / PWA 图标 / apple-touch-icon；
- 保持技术标识符（`pi-web`、`PI_WEB_*`、`pi_web_session`、`PiWeb`、路由）不变；包名按 §R2 单独变更。

### 1.2 解决的问题

- 应用图标曾使用占位图，与桌面版 / 鸿蒙版品牌不一致。
- pi-web 产物直接暴露上游 `Pi Web` 品牌与图标。
- 手工拷贝图标不可复现，缺物料时静默产出无品牌包。
- Android 的 WebView 与 PWA 图标位多（五密度、adaptive、favicon、192/512），容易漏。

### 1.3 范围

**包含**

- `scripts/generate-icons.mjs`：从父工程物料生成五密度 legacy / round / adaptive 图标与 adaptive 背景色。
- `scripts/brand-assets.mjs`：在载荷暂存副本内替换 `Pi Web` → `Pi Desktop`、页面 Logo、favicon / PWA 图标。
- `res/values/strings.xml` 应用名 **Pi Desktop**；`PI_WEB_APP_NAME=Pi Desktop`。
- 构建期硬失败与终检：物料缺失/尺寸不符/透明度不符 ⇒ 失败；替换后 0 处用户可见 `Pi Web`。
- 文档与能力清单回写。

**不包含**

- 修改上游 `pi` / `pi-web` 源码。
- 改包名 `top.fellow99.pi.PiDesktopAndroid`（品牌名与应用名一致，包名保留 Android 标识）——**R2 按产品决策变更**，见 §R2。
- 换掉 Pi Web UI 的交互设计 / i18n 文案（除品牌名本身）。
- 官网与发布说明物料（属 `pi-desktop-website`）。

## 2. 用户故事

- 作为用户，我在桌面图标、应用标题、浏览器标签、PWA 安装名上看到的是 **Pi Desktop**。
- 作为用户，我在登录页、空会话 hero、侧栏看到统一的 Logo，而不是上游图标。
- 作为维护者，我换父工程 `assets/` 的物料并重跑流水线，就能全链更新，不需要手工改多套图。
- 作为维护者，物料缺失或透明通道不符时构建立即失败，不会发出半品牌包。
- 作为审核者，我能用 `--check` 终检证明产物中用户可见 `Pi Web` 为 0。

## 3. 功能需求

### 3.1 应用名与图标

- **FR-013-001**（MUST）：`res/values/strings.xml` 的 `app_name` 必须为 `Pi Desktop`。
- **FR-013-002**（MUST）：`scripts/generate-icons.mjs` 必须从 `../assets/logo-1024-with-bg.png` 生成 legacy 方形/圆形图标，从 `../assets/logo.png` 生成 adaptive 前景；五密度齐全。
- **FR-013-003**（MUST）：应用级图标必须为 **1024×1024 且不透明**（alpha 全 255）；窗口/通知类小图标允许透明。
- **FR-013-004**（MUST）：adaptive 背景色必须取自满版图左上像素，且生成 `mipmap-anydpi-v26/ic_launcher{,_round}.xml`。
- **FR-013-005**（MUST）：物料缺失、尺寸不符、透明度不符 ⇒ 构建失败，不得静默降级。

### 3.2 载荷品牌化

- **FR-013-006**（MUST）：`scripts/brand-assets.mjs` 必须在载荷**暂存副本**内把用户可见 `Pi Web` 替换为 `Pi Desktop`；上游源码零改动。
- **FR-013-007**（MUST NOT）：替换不得触及技术标识符：`pi-web`、`@agegr/pi-web`、`PI_WEB_`、`pi_web_session`、`PiWeb`、API 路由；替换前后计数必须逐项不变。
- **FR-013-008**（MUST）：页面 Logo 必须指向 `public/icons/logo.svg`（父工程 `logo.svg` 逐字节复制）。
- **FR-013-009**（MUST）：`favicon`、`icon-192`、`icon-512`、`apple-touch-icon` 必须由父工程物料生成，并回读校验尺寸/颜色类型。
- **FR-013-010**（MUST）：`PI_WEB_APP_NAME` 必须为 `Pi Desktop`；`PI_WEB_SKIP_VERSION_CHECK=1` 必须置位（Android 无自有更新检查，避免上游误报）。

### 3.3 判据与回归

- **FR-013-011**（MUST）：品牌化后暂存树（`node_modules/` 之外）用户可见 `Pi Web` 必须为 **0 处**；`index` / `login` 预渲染文档必须含 `Pi Desktop`。
- **FR-013-012**（MUST）：`brand-assets.mjs --check` 必须可在 CI 单独运行，只终检不改写，失败退出非 0。
- **FR-013-013**（MUST NOT）：不得回归既有能力：启动到首屏、会话可建、真实对话、`bash`/`find`/`grep`、文件上传。
- **FR-013-014**（MUST）：品牌化不得改变 `versionName` / `versionCode` / 包名。**R2 例外**：013-branding-r2 已按产品决策变更包名（见 §R2）；`versionName` / `versionCode` 均不变。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 物料 | 父工程 `assets/` | `logo.svg`、`logo.png`（200²、含透明）、`logo-1024-with-bg.png`（1024²、不透明） |
| 应用图标 | `res/mipmap-*` | 五密度、legacy/round/adaptive foreground、背景色 |
| Web 图标 | 载荷 `public/icons/` | `logo.svg`、`icon-192`、`icon-512`、`apple-touch-icon`、favicon body |
| 文案 | 用户可见品牌 | `Pi Web` → `Pi Desktop`，技术标识符不变 |

## 5. 验收场景

### 场景：应用名与图标

- Given 执行 `node scripts/generate-icons.mjs`
- When 检查 `res/mipmap-*` 与 `strings.xml`
- Then 五密度图标齐全、尺寸/透明度符合规则、`app_name=Pi Desktop`

### 场景：载荷终检

- Given 已组装载荷暂存树
- When 执行 `node scripts/brand-assets.mjs --check <stageRoot>`
- Then 用户可见 `Pi Web` 为 0、`Pi Desktop` 存在、技术标识符计数不变，退出码 0

### 场景：物料缺失

- Given 临时移走 `../assets/logo.png`
- When 执行 `generate-icons.mjs` 或 `brand-assets.mjs`
- Then 构建失败并给出明确指引，不产出无品牌包

### 场景：能力不回归

- Given 品牌化后的 APK 安装到真机
- When 启动并完成一次对话
- Then 首屏、SSE、工具调用正常，页面 Logo 为 `logo.svg`

## 6. 非功能需求

- **确定性**：同一物料重复生成字节稳定（Lanczos 重采样、固定尺寸）。
- **性能**：图标生成与文案替换在构建期完成，不增加运行时开销。
- **安全**：不改签名材料；品牌化脚本不读取凭据。
- **可维护**：物料路径可用 `--assets` / `PI_ASSETS_DIR` 覆盖。

## 7. 假设与约束

- 父工程 `assets/` 在 CI 中通过 sparse checkout 获取；本地缺失时可用 `PI_ASSETS_DIR` 指向镜像。
- Python + Pillow 可用（CI 安装 `python3-pil`）。
- 品牌名统一为 `Pi Desktop`；包名保留 `PiDesktopAndroid` 以区分渠道（R2 起为 `top.fellow99.pi.PiDesktopAndroid`）。

## R2 — 包名变更（013-branding-r2）

> **需求编号:** `013-branding-r2` ｜ **需求名称:** 包名修改 ｜ **Git 分支:** 不改动

包名 / applicationId / namespace 由 `org.fellow99.pi.PiDesktopAndroid` 改为 **`top.fellow99.pi.PiDesktopAndroid`**：

- 源码包目录 `app/src/main/java/org/fellow99/pi/PiDesktopAndroid/` 迁移至 `app/src/main/java/top/fellow99/pi/PiDesktopAndroid/`。
- `app/build.gradle.kts` 的 `namespace` 与 `applicationId` 同步更新。
- 8 个 `.kt` 的 `package` 声明与内部 `import`（含 `R` 资源引用）同步更新；`org.fellow99.nodebridge.*` 外部依赖包名保持不变。
- 版本号（`versionName` / `versionCode`）不变。
- 编译构建验证通过后回写本规格。

---

## 8. 依赖

- 父工程：`../../specs/013-branding/`（跨工程品牌规范）、`assets/`。
- 模块：`012-building-workflow`（组装期调用）、`102-payload-pipeline-assembly-crop`（载荷暂存树）。
- 同型实现：`pi-desktop` `013-branding`、`pi-desktop-hos` `013-branding`。
