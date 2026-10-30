# 001-building-workflow — spec（GitHub Actions 的构建流程）

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md（§16.3 构建流水线、§17 合规清单 G1–G11）；宪法：specs/constitution.md（C3 结论以库与真机为准、C5 失败可见、C9 敏感信息不入库、C10 可证伪的验收）。
> 参考先例：`d:\opencode-workspace\oc-desktop-android\specs\001-building-workflow\`（同门工程的 as-built CI 方案，已真跑发布：run 40875919607 全绿）。
> 本模块只落本工程 `specs/`，**不**进父工程 pi-workspace。

## 需求
在 GitHub Actions 上建立**标签触发**的自动构建/发布流水线：推送 `v*` tag（首发 `v0.12.1`）→ Linux runner 上
`pi-web 上游检出 → pnpm 安装 → 补丁幂等应用与载荷组装 → assembleRelease → 合规核对 → GitHub Release 发布`。
`workflow_dispatch` 可手动触发（仅构建验证，不发布）。**不改 Git 分支策略。**

### 范围
- 新增 `.github/workflows/build-release.yml`（对齐参考工程：tag 触发 + workflow_dispatch；不做 push/PR 校验 job）。
- 引擎接入**从本地 provision 改为 Maven Central 直解**（对齐参考工程与该工程对 aosp-node-runtime 的引用方式）：
  - `app/build.gradle.kts` 增 `runtimeOnly(libs.node.runtime)` = `io.github.fellow99:node-runtime:24.22.1`；
  - `gradle/libs.versions.toml` 的 `nodeRuntime` 由 `24.2.0` 升 `24.22.1`（参考工程已实测 Central AAR 全绿；本工程本地 jniLibs 的 libnode.so sha=be1d16… 与 Central 版逐字节一致）；
  - 新增工程内 `runtime.lock.json` 镜像（同参考工程：active + sha256 + gates + 来源）；
  - 移植 `scripts/verify-runtime.mjs`（参考工程同款：校验 AAR 内 `jni/arm64-v8a/libnode.so` 的 SHA-256 = lock，并跑 ELF 六项门禁）；
  - 保留 `scripts/provision-engine.mjs` 作本地零网兜底路径（同一版引擎，`--check` 仍可用），CI **不再**走该路径。
- 跨平台化：`scripts/assemble-payload.mjs` 归档自检 tar 解析不再硬编码 `%SystemRoot%\System32\tar.exe`（Windows 仍落 bsdtar；Linux 用 PATH tar）。
- 不做：Play AAB/PAD、多 ABI（引擎矩阵只有 arm64-v8a）、PTY 原生件（规划暂缓）、push/PR 触发、**tag 注入 versionName/versionCode**（对齐参考工程：版本维持本工程静态口径，tag 只用于 Release/APK 命名）。

### 环境契约（CI 侧事实，均来自已锁定来源）
| 输入 | 来源 | 锁定/校验 |
|---|---|---|
| pi-web 源码 | `github.com/agegr/pi-web` tag **v0.12.1**（公开，匿名可读） | assemble 脚本断言 `git describe` 恰为 v0.12.1，不符 exit |
| node-bridge AAR | Maven Central `io.github.fellow99:node-bridge:0.2.0` | libs.versions.toml 锁定 |
| node-runtime AAR | **Maven Central** `io.github.fellow99:node-runtime:24.22.1`（small-icu，2026-10-27 发布） | `verify-runtime.mjs`：AAR 内 libnode.so SHA-256 = lock `be1d16…` + ELF 六项门禁 |
| 引擎事实源 | `aosp-node-runtime` 仓 runtime.lock.json（active=24.22.1） | 工程内镜像 `runtime.lock.json`，`verify-runtime` 消费 |
| pnpm | corepack（pi-web engines node>=22.19；CI 用 Node 24） | 无 pnpm-lock（上游无锁文件），按上游 package.json 安装 |
| 签名材料 | GitHub Secrets（已部署：ANDROID_KEYSTORE/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD） | C9：只经 secrets；缺失 → debug 签名兜底（可安装），不产出未签名包 |
| JDK / SDK | Temurin JDK 17；Android SDK 由 hosted runner 预装 + AGP 自动补装（build-tools 供 zipalign/aapt2） | G5 zipalign -P 16 |

### 版本口径
对齐参考工程：**不**把 tag 注入 `versionName`/`versionCode`。APK 内版本维持本工程静态默认（0.1.0 / 1）；
tag（如 `v0.12.1`）只用于 GitHub Release 名与 APK 命名（`pi-desktop-android-v0.12.1.apk`）。后续如需内嵌真实版本号，
单独作为后续需求处理（不扩大本需求范围）。

## 验收
| # | 判据 | 状态 |
|---|---|---|
| 1 | 推送 tag `v*` 触发 workflow 发布；`workflow_dispatch` 触发只构建、不创建 Release | ⬜ |
| 2 | runner 上 pi-web@v0.12.1 检出 + pnpm 安装后 `node scripts/assemble-payload.mjs --apply --pi-web <path>` 全绿：6 补丁标记命中、归档自检通过、收尾 pi-web pristine | ⬜ |
| 3 | 引擎经 Maven Central AAR：`verify-runtime.mjs` 对预取 AAR 全绿（libnode.so SHA-256=lock + ELF 六项门禁）；APK 内 .so 集合 = {libnode, libc++_shared, libnode_bridge, libnode_host_client} | ⬜ |
| 4 | 签名分支闭合：配置了 secrets → `assembleRelease` 签名包（apksigner verify 通过）；未配置 → `assembleDebug` debug 签名兜底；材料只落 workspace 不入库 | ⬜ |
| 5 | 包名 org.fellow99.pi.PiDesktopAndroid、应用名 Pi Desktop（G10 三一致，aapt2 badging 可读回） | ⬜ |
| 6 | 产物核对：`zipalign -c -P 16` 通过；`node scripts/compliance-check.mjs --apk` 机械项无 FAIL（G8/G9 MANUAL 不算） | ⬜ |
| 7 | GitHub Release `v0.12.1` 挂载 APK + `.sha256`，Release Notes 含 pi-web/引擎版本与构建提交 | ⬜ |
| 8 | 任一关键步骤失败（补丁冲突/verify-runtime 门禁/合规 FAIL）⇒ 整个 workflow 失败，不产出/不更新 Release；产物以 artifact 留存 | ⬜ |
| 9 | 敏感信息纪律：keystore/.jks/密码零入库；workflow 不回显 secret；`keystore.properties`/`*.keystore` 保持 gitignore | ⬜ |
| 10 | 跨平台改动不破坏 Windows 本地：assemble tar 解析在 Windows 仍选 System32\tar.exe，本地 dry-run 行为不变 | ⬜ |
| 11 | 引擎双路径一致性：本地 `provision-engine.mjs --check`（24.22.1）与 Maven AAR `verify-runtime` 指认同一 sha（be1d16…） | ⬜ |

## 实现锚点
- `.github/workflows/build-release.yml`（新增，唯一 CI 文件）
- `scripts/verify-runtime.mjs`（移植自参考工程；AAR 定位：优先 `--aar`/env，其次 Gradle 缓存、mavenLocal）
- `runtime.lock.json`（工程根镜像，active node=24.22.1 + sha256 + gates）
- `scripts/assemble-payload.mjs`（`assertArchiveReadable()` tar 解析跨平台化；`--pi-web` 参数）
- `app/build.gradle.kts`（增 `runtimeOnly(libs.node.runtime)`；引擎注释同步更新）
- `gradle/libs.versions.toml`（`nodeRuntime` = `24.22.1`）
- 保留不改：`scripts/provision-engine.mjs`（本地兜底）、`scripts/compliance-check.mjs`（已跨平台）、`patches/v0.12.1/`

## 非目标 / 风险
- pnpm 无锁文件 ⇒ 构建可重复性弱于锁定（沿用上游现状，CI 不引入自维护 lock，避免改上游 C4）。风险 R1。
- pi-web 安装/编译耗时（Next16 webpack build）是主要时长来源；pnpm store 缓存缓解；参考工程在 60min runner 内完成。
- GitHub Secrets 不可回读，端到端正确性由 workflow 内 keytool 自检 + apksigner/verify-runtime 证明（C5/C10）。
- 版本号内嵌（tag→versionName）不在本需求（对齐参考工程「不注入」口径），如需另行立项。
