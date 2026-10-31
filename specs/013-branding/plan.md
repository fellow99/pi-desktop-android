# 013 — 品牌化（branding）技术方案（As-Built）

> **Module:** 013-branding ｜ **Status:** Implemented ｜ **Last Updated:** 2026-10-31
> **对应规格:** [`spec.md`](./spec.md)（FR-013-001 … FR-013-014）
> **实现落点:** `scripts/generate-icons.mjs`、`scripts/brand-assets.mjs`、`app/src/main/res/values/strings.xml`、
> `scripts/assemble-payload.mjs`、`payload/env.js`
> **证据:** [`../../docs/安卓环境能力清单-0.12.1.md`](../../docs/安卓环境能力清单-0.12.1.md) §H REV-1、
> [`../../docs/002-真机验证记录.md`](../../docs/002-真机验证记录.md)

## 1. 技术上下文

### 1.1 运行环境

- 构建：Node 24 + Python3 + Pillow；Android Gradle Plugin 8.10.1。
- 运行：Android 系统 WebView + 进程内 Node 24.22.1。
- 物料：父工程 `../assets/`（CI 用 sparse checkout 获取 `assets/`）。

### 1.2 依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Pillow | 系统包 | 图标缩放/裁圆/背景色采样 |
| `logo.svg` | 父工程物料 | 页面 Logo（矢量） |
| `logo.png` | 200×200、含透明 | 192/180/favicon 位图 |
| `logo-1024-with-bg.png` | 1024×1024、不透明 | 应用级图标 / PWA 512 |

## 2. 宪法合规检查

| 原则 | 合规 | 说明 |
|---|---|---|
| C1 一切经同源 HTTP | ✅ | 品牌化不改数据面 |
| C2 壳薄、契约硬 | ✅ | 只改资源与载荷副本 |
| C3 结论以库与真机为准 | ✅ | 图标尺寸/透明度由脚本硬校验 |
| C4 不改上游 | ✅ | 品牌化只在载荷暂存副本；上游零改动 |
| C5 失败可见 | ✅ | 物料缺失/尺寸不符/残留 `Pi Web` 均构建失败 |
| C9 敏感信息不入库 | ✅ | 脚本不接触凭据 |

## 3. 研究结论

- **D1 两段式品牌化**：
  1. `generate-icons.mjs` 在 **APK 资源层**生成 launcher / adaptive / 通知图标；
  2. `brand-assets.mjs` 在 **载荷暂存层**替换文案、Logo、favicon / PWA 图标。
  两段都在构建期执行，运行时不改任何东西。
- **D2 物料硬校验**：`logo.png` 必须真含透明像素；`logo-1024-with-bg.png` 必须 alpha 全 255；
  不满足直接失败，避免「看起来生成了但图标是错的」。
- **D3 文案替换只认带空格首字母大写**：`Pi Web` → `Pi Desktop`；技术标识符（`pi-web`、`PI_WEB_`、`pi_web_session`、`PiWeb`）计数前后不变。
- **D4 页面 Logo 用 SVG**：`apple-touch-icon.png` 的 `<img src>` 替换为 `/icons/logo.svg`；元数据 `rel="apple-touch-icon"` 与 `sw.js` 预缓存保持原样。
- **D5 终检独立命令**：`brand-assets.mjs --check` 可在 CI 只读运行，避免「生成时通过、产物被改坏」。

## 4. 数据模型

| 实体 | 字段 / 文件 | 规则 |
|---|---|---|
| 应用图标 | `res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher*.png` | 48/72/96/144/192 px 基准；adaptive 前景 108–432 px |
| adaptive | `res/mipmap-anydpi-v26/ic_launcher{,_round}.xml` | 引用前景 + 背景色 |
| 背景色 | `res/values/ic_launcher_colors.xml` | 取满版图左上像素 |
| Web 图标 | `public/icons/logo.svg`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`、`favicon.ico.body` | 尺寸/颜色类型硬校验 |
| 文案 | `Pi Web` → `Pi Desktop` | 仅用户可见；技术标识符不变 |

## 5. 接口契约

### 5.1 提供的接口

- `node scripts/generate-icons.mjs [--check]`：生成/校验 APK 图标；失败非 0。
- `node scripts/brand-assets.mjs <stageRoot>`：就地品牌化载荷暂存树。
- `node scripts/brand-assets.mjs --check <stageRoot>`：只终检，不改写。
- 环境变量 `PI_ASSETS_DIR` / `--assets <dir>`：覆盖物料目录。

### 5.2 消费的接口

- 父工程 `../assets/` 三个物料文件。
- `scripts/assemble-payload.mjs` 的载荷暂存根（品牌化输入）。
- `payload/env.js` 注入 `PI_WEB_APP_NAME` / `PI_WEB_SKIP_VERSION_CHECK`。

## 6. 实现策略

### 6.1 图标生成

1. 读 `logo-1024-with-bg.png`，校验 1024²、alpha 全 255。
2. 用 Pillow 生成五密度 legacy 方形（48–192 px）与圆形（同尺寸裁圆）。
3. 读 `logo.png`，校验 200²、含透明像素；生成 108–432 px adaptive 前景（内容收进 72/108 安全区）。
4. 采样满版图左上像素写 `ic_launcher_colors.xml`；生成 `mipmap-anydpi-v26` XML。

### 6.2 载荷品牌化

1. 递归遍历暂存树（排除 `node_modules/`），只处理文本与图标文件。
2. 文本：把带空格的 `Pi Web` 替换为 `Pi Desktop`；统计技术标识符出现次数。
3. 图标：复制 `logo.svg` 到 `public/icons/logo.svg`；用 Pillow 生成 192/180/512 与 favicon body。
4. 页面 Logo：替换三种编译形态的 `src` 引用为 `/icons/logo.svg`。
5. 终检：`Pi Web` 为 0、`Pi Desktop` > 0、技术标识符计数不变；失败 exit 1。

### 6.3 错误处理

- 物料缺失/尺寸不符/透明度不符：打印修法并 exit 1。
- Python/Pillow 缺失：提示安装 `python3-pil`。
- 终检失败：列出残留文件与计数，构建失败。

### 6.4 性能

- 图标生成是一次性构建开销（秒级）；载荷文案替换为线性遍历，不增加运行时成本。

## 7. 测试考量

- 正向：生成后检查五密度图标、adaptive XML、`strings.xml`。
- 负向：移走物料 / 伪造透明通道 / 注入 `Pi Web` 残留，确认构建失败。
- 回归：安装 APK，检查首屏、Logo、对话、工具、文件上传。
- 终检：`brand-assets.mjs --check` 在 CI 与本地结果一致。

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `scripts/generate-icons.mjs` | APK 图标生成/校验 |
| `scripts/brand-assets.mjs` | 载荷文案/Logo/图标品牌化 |
| `app/src/main/res/values/strings.xml` | 应用名 `Pi Desktop` |
| `app/src/main/res/mipmap-*` | 五密度图标 |
| `app/src/main/res/mipmap-anydpi-v26/*.xml` | adaptive 图标 |
| `app/src/main/res/values/ic_launcher_colors.xml` | adaptive 背景色 |
| `scripts/assemble-payload.mjs` | 调用品牌化并组装载荷 |
| `payload/env.js` | `PI_WEB_APP_NAME` / `PI_WEB_SKIP_VERSION_CHECK` |

## 9. 与规格交叉引用

| FR | 落点 |
|---|---|
| FR-013-001 | `res/values/strings.xml` |
| FR-013-002/003/004/005 | `scripts/generate-icons.mjs` |
| FR-013-006/007/008/009/010 | `scripts/brand-assets.mjs` + `payload/env.js` |
| FR-013-011/012 | `brand-assets.mjs --check` + 组装期调用 |
| FR-013-013/014 | 真机回归 + `app/build.gradle.kts` 不变 |
