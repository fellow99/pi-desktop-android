# 001-building-workflow — spec（GitHub Actions 的构建流程）

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md（§16.3 构建流水线、§17 合规清单 G1–G11）；宪法：specs/constitution.md（C5 失败可见、C9 敏感信息不入库、C10 可证伪的验收）。
> 本模块只落本工程 `specs/`，**不**进父工程 pi-workspace。

## 需求
在 GitHub Actions 上建立**标签触发**的自动构建/发布流水线：推送 `v*` 标签（首发 `v0.12.1`）→ Linux runner 上完成
pi-web 上游克隆与 pnpm 安装 → 补丁幂等应用与载荷组装 → Node 引擎投放（八项 ELF 门禁）→ release 签名 APK →
产物核对（unzip/zipalign/合规脚本）→ 发布到该 tag 的 GitHub Release。推 commit / PR 只做**可重复性构建校验**（不出 Release）。

### 范围
- 新增 `.github/workflows/release.yml`（标签发布 + push/PR 校验单工作流两 job/触发器）。
- 为让现有**只在 Windows 验证过**的构建脚本在 Linux runner 可跑，做最小跨平台化改动：
  - `scripts/assemble-payload.mjs` 归档自检的 tar 解析器不再硬编码 `%SystemRoot%\System32\tar.exe`（改 PATH 解析，Windows 仍落 bsdtar）。
- `app/build.gradle.kts` 支持从命令行 `-PversionName/-PversionCode` 覆盖版本（默认值保持 1 / 0.1.0 不变，本地构建零影响）。
- 不做：Play AAB/PAD、多 ABI（引擎矩阵只有 arm64-v8a，规划 §12 锁定）、PTY 原生件（规划决策暂缓，G3 白名单不含 libpty_node.so）。

### 环境契约（CI 侧事实，均来自已锁定版本）
| 输入 | 来源 | 锁定/校验 |
|---|---|---|
| pi-web 源码 | `github.com/agegr/pi-web` tag **v0.12.1**（公开，匿名可读） | assemble 脚本断言 `git describe` 恰为 v0.12.1，不符 exit |
| Node 引擎 | `github.com/fellow99/aosp-node-runtime` tag **v24.22.1**（small-icu） | release 归档 sha256 `fcf61ffc…`；`tools/provision.mjs` 八项 ELF 门禁 + lock sha256 |
| node-bridge AAR | Maven Central `io.github.fellow99:node-bridge:0.2.0` | gradle 依赖锁（libs.versions.toml） |
| pnpm | corepack（pi-web engines node>=22.19；CI 用 Node 24） | 无 pnpm-lock（上游无锁文件），按上游 package.json 安装 |
| 签名材料 | GitHub Secrets（已部署：ANDROID_KEYSTORE/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD） | C9：只经 secrets，解码后 keytool -list 自检 |
| JDK / SDK | Temurin JDK 17；Android SDK API 36 + build-tools 36.0.0（gradle 自动装；build-tools 显式装给 zipalign/aapt2） | G5 zipalign -P 16 |

### 版本映射
tag `v0.12.1` ⇒ `versionName=0.12.1`；`versionCode` 由 patch 段之后的序号给出，本次 = **2**（0.1.0 默认占位为 1）。
workflow 从 tag 名推导：去掉 `v` 前缀得 versionName；versionCode 用显式 step 计算/传入（首发 2；后续按发布序列单调递增）。

## 验收
| # | 判据 | 状态 |
|---|---|---|
| 1 | 推送 tag `v0.12.1` 触发 release workflow；push/PR 仅触发校验 job，不创建 Release | ⬜ |
| 2 | runner 上 pi-web@v0.12.1 检出后 `node scripts/assemble-payload.mjs --apply --pi-web <path>` 全绿：6 补丁标记命中、归档自检通过、收尾 pi-web pristine | ⬜ |
| 3 | 引擎从 aosp-node-runtime v24.22.1 release 归档投放：归档 sha256 校验通过 + 八项 ELF 门禁全过；jniLibs 仅 libnode.so/libc++_shared.so | ⬜ |
| 4 | keystore 从 Secrets 解码，`keytool -list` 成功；`assembleRelease` 产出**已签名** APK（apksigner verify 通过） | ⬜ |
| 5 | APK versionName=0.12.1、versionCode=2、包名 org.fellow99.pi.PiDesktopAndroid、标签 Pi Desktop | ⬜ |
| 6 | 产物核对：unzip -l 的 .so 集合 ⊆ G3 白名单（libnode/libc++_shared/libnode_bridge/libnode_host_client）；`zipalign -c -P 16` 通过 | ⬜ |
| 7 | `node scripts/compliance-check.mjs --apk <apk>` 机械项无 FAIL（G8/G9 MANUAL 不算） | ⬜ |
| 8 | GitHub Release `v0.12.1` 挂载 APK（命名 `pi-desktop-android-0.12.1-arm64-v8a.apk`）+ 校验和附件（.sha256），Release Notes 含载荷/引擎版本与构建提交 | ⬜ |
| 9 | 任一关键步骤失败（补丁冲突/门禁/签名/核对/合规 FAIL）workflow 失败且**不产出/不更新** Release | ⬜ |
| 10 | 敏感信息纪律：仓库不含 keystore/密码明文；workflow 日志不回显 secret（set -x 不覆盖 secrets，keystore.properties 不 cat） | ⬜ |
| 11 | 跨平台改动不破坏 Windows 本地构建：assemble 脚本 tar 解析在 Windows 仍选 System32\\tar.exe，本地 dry-run 行为不变 | ⬜ |

## 实现锚点
- `.github/workflows/release.yml`（新增，唯一 CI 文件）
- `scripts/assemble-payload.mjs`（`assertArchiveReadable()` tar 解析跨平台化；约 1 处）
- `app/build.gradle.kts`（versionName/versionCode 读 gradle 属性，带默认值）
- 复用不改：`scripts/provision-engine.mjs`、aosp-node-runtime `tools/provision.mjs`、`scripts/compliance-check.mjs`、`patches/v0.12.1/`

## 非目标 / 风险
- pnpm 无锁文件 ⇒ 构建可重复性弱于锁定（沿用上游现状，CI 不引入自维护 lock，避免改上游 C4）。风险登记 R1。
- pi-web 安装/编译耗时（Next16 webpack build）是主要时长来源；用 pnpm store + gradle/actions 缓存缓解。
- GitHub Secrets 不可回读，端到端正确性只能由 workflow 内 keytool 自检 + 签名验证证明（C5/C10）。
