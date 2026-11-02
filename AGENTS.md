# AGENTS.md — pi-desktop-android（Pi Desktop · Android 版）

> 本文件是本工程（`pi-desktop-android`）的 AI Agent 工作规范与导航入口。
> 事实权威：`docs/000-工程规划.md`（v0.2，规划唯一权威）；行为权威：`specs/constitution.md`。本文档只做收敛与回引。

---

## 一、项目定位

**Pi Desktop · Android 版**（`pi-desktop-android`）—— **不带 Chromium/Electron** 的 Android 原生壳：
Kotlin 宿主用**系统 WebView** 加载本进程内 Node 跑起的 `pi-web` 服务（`aosp-node-bridge` + Maven Central
`node-runtime`，`dlopen` + `node::Start`，Node **26.13.0** small-ICU），**无 Termux、无子进程 Node**。
功能目标与 `pi-desktop-ark` 对齐，能力增量：前台服务（keep-alive）、进程内 pnpm 扩展、SAF 存储访问框架桥。
上游 `pi-web` 补丁 **6 条**（`patches/v0.13.0/`）。

- 显示名 / application ID：`Pi Desktop` / `org.fellow99.pi.PiDesktopAndroid`
- ABI：**`arm64-v8a` only**；minSdk / targetSdk / compileSdk = **24 / 36 / 36**
- 版本：`0.13.0` / `versionCode` `1300`（tag `v0.13.0` 触发 GitHub Actions 构建**签名 APK 并发布 Release**）
- 上游基线：`pi` **v1.4.0** + `pi-web` **v0.13.0**

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
| `patches/v0.13.0/` | 上游 6 条幂等可逆补丁 |
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
