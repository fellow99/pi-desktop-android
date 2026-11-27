# AGENTS.md — pi-desktop-android（Pi Desktop · Android 版）

> 本文件是本工程（`pi-desktop-android`）的 AI Agent 工作规范与导航入口。
> 事实权威：`docs/000-工程规划.md`（v0.2，规划唯一权威）；行为权威：`specs/constitution.md`。本文档只做收敛与回引。

---

## 一、项目定位

**Pi Desktop · Android 版**（`pi-desktop-android`）—— **不带 Chromium/Electron** 的 Android 原生壳：
Kotlin 宿主用**系统 WebView** 加载本进程内 Node 跑起的 `pi-web` 服务（`aosp-node-bridge` + Maven Central
`node-runtime`，`dlopen` + `node::Start`，Node **26.13.0** small-ICU），**无 Termux、无子进程 Node**。
功能目标与 `pi-desktop-ark` 对齐，能力增量：前台服务（keep-alive）、进程内 pnpm 扩展、SAF 存储访问框架桥。
上游 `pi-web` 补丁 **6 条**（`patches/v0.19.0/`）。

- 显示名 / application ID：`Pi Desktop` / `top.fellow99.pi.PiDesktopAndroid`
- ABI：**`arm64-v8a` only**；minSdk / targetSdk / compileSdk = **24 / 36 / 36**
- 版本：`0.19.0` / `versionCode` `1900`（tag `v0.19.0` 触发 GitHub Actions 构建**签名 APK 并发布 Release**；**本轮本机安装被 MIUI「USB 安装」限制拦下，未完成真机复验**）
- 上游基线：`pi` **v1.6.1** + `pi-web` **v0.19.0**

> **引擎说明**：Maven `node-runtime:24.2.0` 为 `--with-intl=none`（无 Intl，Next 16 编译产物会解析失败）；
> 本工程通过 `scripts/provision-engine.mjs` 提供 **aosp-node-runtime v26.13.0（small-ICU）** 到 `app/src/main/jniLibs/`，
> SHA-256 锁在 `runtime.lock.json`；**引擎二进制刻意不入库**。

## 二、关键目录

| 路径 | 作用 |
|---|---|
| `app/src/main/` | Kotlin 宿主（`AndroidManifest.xml`：权限 / singleTask / 前台服务） |
| `app/src/main/assets/pi-web/` | 载荷落点（**gitignored**，组装脚本生成） |
| `app/build.gradle.kts` | applicationId / ABI / 签名（keystore 不入库） |
| `scripts/` | 载荷流水线（patch→build→crop→tar.gz）、`provision-engine.mjs`、验证 `verify-runtime.mjs` |
| `patches/v0.19.0/` | 上游 6 条幂等可逆补丁 |
| `specs/` | 规格文档集（`011/012/013` 公共 + `1XX` 基础） |
| `docs/` | 工程规划、安卓能力清单、真机验证记录、`evidence/` |
| `.github/workflows/` | 标签触发构建/发布（`build-release.yml`） |

**构建前提**：依赖 `../pi`、`../pi-web`（兄弟目录）；引擎由脚本提供（不入库）。

## 三、常用命令

```bash
./gradlew assembleDebug    # 本地构建（签名需 keystore，不入库）
# 载荷流水线见 scripts/；引擎提供：node scripts/provision-engine.mjs
```

> 具体命令与 SDK/签名环境参 see README 与 `docs/000-工程规划.md`。

## 三之二、CI 依赖安装口径与「依赖版本门禁」铁律

> 来源：0.18.0 轮 CI **run #26 失败**（`assemble-payload` 在 `rebuildPiWebInto` 处 FATAL）。

| 事实 | 说明 |
|---|---|
| CI 装 pi-web 依赖的方式 | **`pnpm install --dir ../pi-web --lockfile=false`**（见 `.github/workflows/build-release.yml`）—— 上游 pi-web **不带 pnpm lock**，所以是非冻结安装 |
| 后果 | `^` 范围包会合法浮动（例：`@alloc/quick-lru` `^5.2.0` → 实装 **5.3.0**，而 `package-lock.json` 记 **5.2.0**） |
| 本地装依赖的方式 | `npm ci`（与 `package-lock.json` 逐条一致） |

**铁律：任何"依赖版本门禁"只允许校验 `pi-web/package.json` 里「精确钉住」的直连依赖**
（spec 无 `^` / `~` / `*`，当前 **19 项**：`next@16.4.6`、`@earendil-works/*@1.6.1`、`node-pty`、`undici`、`semver`、`typebox` 等）。

- ❌ **禁止**拿 `package-lock.json` 逐条比对整棵安装树，也禁止比对 `node_modules/**` 全量 —— 在 CI 的 pnpm 路径上必然误报，把可用构建判成失败。
- ✅ 判据意义：精确钉住项在 `npm ci` 与 `pnpm --lockfile=false` 下**都**落到同一版本，正好等价于「装的是当前上游 tag 那套基线」—— 这才是门禁真正要保证的东西。
- 实现见 `scripts/assemble-payload.mjs` 的 `assertDependencyTreeMatchesLock()`；**改这条门禁前先读它的注释**，那里写了完整失败史。

## 四、规格文档（specs）

- 编号：`0XX` 公共模块（011 版本 / 012 构建工作流 / 013 品牌化）· `1XX` 基础模块·
  （101 运行时接入与启动编排 / 102 载荷流水线 / 103 渲染壳 / 104 宿主能力 / 105 鉴权 / 106 工具扩展 / 107 合规）。
  编号与 `pi-desktop-ark` 一一对标。
- 每个模块成对提供 `spec.md`（需求/验收）＋ `plan.md`；as-built 状态以 ✅/⬜/⚠️ 标注。
- 证据纪律：planned 与 as-built 逐条区分；`🔶 沿用` 不得当作本工程实测事实。
- 未归档真机报告的能力（`android-git`、`android-pnpm`）按「已实现未验证」对待。

## 五、CodeGraph 代码地图规范

> 本工程已建立 CodeGraph 语义索引，AI 探索**优先走 CodeGraph**。

- 索引位置：`.codegraph/`（不入库，已 `.gitignore`）。
- **自动更新**：git `post-commit` 钩子（`.git/modules/pi-desktop-android/hooks/post-commit`）在每次提交后自动 `codegraph sync`，非阻塞、不破坏提交。
- 常用命令：`codegraph status` / `codegraph context "<任务>"` / `codegraph query|callers|callees|impact <符号>` / `codegraph affected <文件>`。
- 改动大量源码后查不到符号，先 `codegraph sync` 再查。

## 六、提交纪律

- Conventional Commits（`feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`/`revert`）。
- **严禁** `git add -A` / `git add .`：只暂存本会话改动的文件。
- **派生产物绝不入库**：`app/src/main/assets/pi-web/`（载荷）、`build/`、`.gradle/`、`.kotlin/`、`*.apk`、`*.aab`。
- **密钥绝不入库**：`keystore.properties`、`pi-desktop-android.keystore`、`*.jks`、`*.keystore`、`local.properties`（样例 `.sample` 才入库）。
- 严禁提交密钥 / Token / 口令 / 引擎二进制。

## 七、安全红线

- 严禁 `as any` / `@ts-ignore` / `@ts-expect-error` 压制类型错误。
- 严禁空的 `catch(e) {}`。
- 修复 Bug 只做最小改动，禁止顺手重构；禁止臆测未读取的代码。
