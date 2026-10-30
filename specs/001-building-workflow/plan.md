# 001-building-workflow — plan（GitHub Actions 构建流程技术方案）

> 技术方案与 as-built 说明。对应 spec.md 的验收表。
> 参考先例：`oc-desktop-android/specs/001-building-workflow/plan.md`（已 CI 真跑发布全绿）。

## 方案总览
单文件 `build-release.yml` 双触发（对齐参考工程）：

```
push tags v*            → 构建 + verify-runtime 门禁 + 签名 + GitHub Release
workflow_dispatch       → 同样构建链但 Release 步按设计跳过（仅验证与 artifact 留存）
```

Runner：`ubuntu-latest`（参考工程同款；hosted runner 预装 Android SDK、license 已接受，缺组件由 AGP 自动补装）。
timeout-minutes: 60；`concurrency` 按 ref 分组防并发互踩（参考工程同款，R11 纪律）。

## Engine 接入（核心变更，对齐参考工程）
**为什么改 Maven Central**：参考工程已把引擎接入从「本地 aosp-node-runtime 目录 provision」改为
`io.github.fellow99:node-runtime:24.22.1` 从 Maven Central 直解（runtime.lock.json 注明 2026-10-27 发布，
2026-10-29 对 Central AAR 实测 verify-runtime 全绿）。本工程本地 jniLibs 引擎 sha=be1d16… 恰与 Central
发布版一致 ⇒ 同一构建，可安全切换，且消除 CI 依赖 curl GitHub release 归档 + sparse-checkout 的复杂链路。

- `app/build.gradle.kts`：依赖块增 `runtimeOnly(libs.node.runtime)`。删除原「为什么不用 Maven node-runtime:24.2.0」注释
  中的废弃原因（那是针对 24.2.0 intl=none 的旧版本）；保留 24.22.1 的出处说明。
- `gradle/libs.versions.toml`：`nodeRuntime = "24.22.1"`。
- 新增 `runtime.lock.json`（根目录）：镜像 aosp-node-runtime active 值，字段对齐参考工程：
  `{ active: { node, abi, bridge, maven, libnodeSha256, libcxxSharedSha256, gates }, upstream, syncedAt }`。
- 新增 `scripts/verify-runtime.mjs`：移植参考工程，改动仅为工程相关路径/校验常数从工程内 lock 读。
  逻辑：AAR 定位（`--aar` 参数 / `PDA_NODE_RUNTIME_AAR` 环境变量 → mavenLocal → Gradle 缓存）→
  zip 读 `jni/arm64-v8a/libnode.so` 与 `libc++_shared.so` → SHA-256 = lock → ELF 六项门禁
  （ET_DYN · 无 PT_INTERP · EM_AARCH64 · DT_SONAME=libnode.so · 导出 `_ZN4node5StartEiPPc` · PT_LOAD 16KB 对齐）。
- 保留 `provision-engine.mjs`：本地零网兜底（`--check` 验证 jniLibs 与 lock 一致），CI 不再调用。

## 载荷组装（pi-web）
与参考工程（其上游为 opencode）不同的原因：本工程载荷是 pi-web，需 pnpm 安装 + next build（补丁标记缺失时）。
CI 步骤：
1. `actions/checkout@v4` 检出本仓库。
2. `git clone --depth 1 --branch v0.12.1 https://github.com/agegr/pi-web.git ${{ github.workspace }}/../pi-web`。
3. `corepack enable` + `pnpm install --dir ../pi-web`（无 lock，非冻结）。
4. `node scripts/assemble-payload.mjs --apply --pi-web ../pi-web`（断言 describe=v0.12.1；补丁标记命中；归档自检；pristine 收尾）。
   - `--pi-web` 参数为本工程新增（让 CI 显式指向克隆路径，不依赖默认 sibling 约定之外的巧合）。

## 签名分支（对齐参考工程 R4/R6）
```
if 全部 secrets 非空（ANDROID_KEYSTORE/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD）:
    base64 -d > pi-desktop-android.keystore
    keytool -list 自检（值不可回读，这里是唯一可观测证据）
    写 keystore.properties（umask 077）
    VARIANT=release
else:
    VARIANT=debug（AGP debug keystore，可直接安装）
    部分配置 → ::error:: 显式报错（防静默半配）
```
材料只落 workspace；`keystore.properties`/`*.keystore` 保持 gitignore（C9）。
本仓库已部署 secrets ⇒ 正常路径为 release 签名包。

## 步骤序列（对齐参考工程十一步）
1. checkout 本仓库（fetch-depth: 0 保 abbrev 长度——本工程无基线守卫脚本依赖，但保守保留与参考一致）
2. Node 24（corepack）+ pnpm
3. JDK 17 + Gradle 缓存
4. 引擎 AAR 预取：`curl -fsSL --retry 3 -o $RUNNER_TEMP/node-runtime-24.22.1.aar https://repo1.maven.org/maven2/io/github/fellow99/node-runtime/24.22.1/node-runtime-24.22.1.aar` → `PDA_NODE_RUNTIME_AAR` env
5. `verify-runtime.mjs --aar`（门禁：AAR 内 libnode.so SHA-256=lock + ELF 六项；红则整流程失败）
6. 检出 pi-web@v0.12.1 + pnpm install
7. 签名注秘（VARIANT=release/debug 分支）
8. `assemble-payload --apply --pi-web`
9. `./gradlew :app:assemble${VARIANT} --stacktrace`
10. 收集产物：`dist/pi-desktop-android-${ref_name}.apk` + `.sha256`；`actions/upload-artifact@v4` 始终上传
11. GitHub Release（`if: startsWith(github.ref, 'refs/tags/v')`）：softprops/action-gh-release@v2，
    name=`Pi Desktop Android ${ref_name}`，files=`dist/*`；`permissions: contents: write`

## 代码改动点（最小）
- 新增 `.github/workflows/build-release.yml`
- 新增 `scripts/verify-runtime.mjs`（移植）
- 新增 `runtime.lock.json`（根目录镜像）
- `app/build.gradle.kts`：`runtimeOnly(libs.node.runtime)` + 注释更新
- `gradle/libs.versions.toml`：`nodeRuntime = "24.22.1"`
- `scripts/assemble-payload.mjs`：tar 跨平台 + `--pi-web`（已实现）
- 回滚：撤销 `app/build.gradle.kts` 的 `-PversionName/-PversionCode` 属性化（对齐参考「不改构建脚本/不注入 tag」）

## 偏差与取舍
- **D1**：本工程载荷（pi-web）需 pnpm install + next build（参考工程 opencode 用 bun + 已有 bundle），
  这是本工程特性，workflow 相应多两步（pnpm 安装 + assemble）。不偏移参考的结构骨架。
- **D2**：verify-runtime 的 AAR 定位优先 `--aar`/env（CI 预取），mavenLocal/Gradle 缓存仅本机。
- **D3**：不做 push/PR 触发（参考工程边界）。验证手段 = workflow_dispatch 真跑彩排 + 本机等价命令。
- **D4**：版本不注入 tag（参考工程口径）。Release/APK 命名带 tag，APK 内 static 版本。
- **D5**：gradle 不手工装 SDK 组件（hosted runner 预装 + AGP 自动补装），zipalign/aapt2 从 `$ANDROID_HOME/build-tools` 解析（compliance-check 已做 PATH 回退）。

## 风险登记
| ID | 风险 | 缓解 |
|---|---|---|
| R1 | pnpm 无 lock ⇒ 上游依赖漂移 | 固定 node/pnpm 版本；失败可见；本期不造锁（C4） |
| R2 | Next16 webpack build 在 Linux 与 Windows 产物差异 | 裁剪规则按 rel 匹配；验收以补丁 marker + 归档可读 + 文件数为准 |
| R3 | Maven Central 可达性（本机 repo1 偶发超时） | `curl --retry 3`；mirror 兜底（dependencyResolutionManagement 已配阿里云镜像） |
| R4 | GITHUB_TOKEN 无写权限 Release 失败 | workflow 顶层 `permissions: contents: write` |
| R5 | secrets 半配置 | 注秘步显式 `::error::` + exit 1 |
| R6 | release 归档 sha 与 Central AAR 混淆 | verify-runtime 只认工程内 lock（单一事实源），CI 预取 AAR 路径显式 |
