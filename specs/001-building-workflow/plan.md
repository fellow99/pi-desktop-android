# 001-building-workflow — plan（GitHub Actions 构建流程技术方案）

> 技术方案与 as-built 说明。对应 spec.md 的验收表。

## 方案总览
单文件双触发器：`.github/workflows/release.yml`

```
push tags v*            → job build (release=true)  → softprops/action-gh-release
push(branch) / pull_request → job build (release=false)   （不发 Release，只验证可重复构建）
```

Runner：`ubuntu-24.04`（x86_64 宿主做载荷/APK 构建；引擎本身是 arm64 .so，仅投放不执行，与宿主架构无关）。

## Job 步骤设计（按序）
1. **checkout**：`actions/checkout@v4`，本仓库（submodule 自身即 git 仓库，CI 直接 clone 该 repo）。
2. **JDK 17**：`actions/setup-java@v4`（temurin, 17）。
3. **Node 24 + pnpm**：`actions/setup-node@v4`（node-version 24）后 `corepack enable`；配 pnpm 缓存目录（pnpm store 在 $HOME/.local/share/pnpm/store）。
4. **Android SDK**：`android-actions/setup-android@v3`；`sdkmanager "build-tools;36.0.0" "platforms;android-36"`（licenses 由 action 接受；platform 也由 AGP 自动下载，显式声明保证 zipalign/aapt2 在 PATH）。
5. **检出 pi-web@v0.12.1**：
   ```bash
   git clone --depth 1 --branch v0.12.1 https://github.com/agegr/pi-web.git ../pi-web
   ```
   放 runner 的 sibling 目录（与本地 `../pi-web` 布局一致，脚本默认值即可命中；仍显式传参不依赖默认）。
   `pnpm install --dir ../pi-web`（无 lock，非冻结安装）。
6. **引擎投放**（v24.22.1 small-icu，免编 Node）：
   ```bash
   RT=$RUNNER_TEMP/aosp-node-runtime
   mkdir -p $RT && cd $RT
   # 取 lock 里登记的 release 归档（URL/sha256 从仓库内 runtime.lock.json 的同源副本？——见“偏差与取舍 D1”）
   curl -sSL -o rt.tgz https://github.com/fellow99/aosp-node-runtime/releases/download/v24.22.1/node-v24.22.1-android-arm64-v8a.tar.gz
   echo "fcf61ffc…  rt.tgz" | sha256sum -c -
   tar xzf rt.tgz   # 解出 bin/arm64-v8a/{libnode.so,libc++_shared.so}
   ```
   本仓库没有 runtime.lock.json 副本（它在 aosp-node-runtime 仓）。CI 不克隆 runtime 全仓，直接用 release 归档，
   再借用 `scripts/provision-engine.mjs`：它要求 `--runtime-dir` 下有 `runtime.lock.json` 和
   `node-runtime/src/main/jniLibs/arm64-v8a/`。
   **取舍 D2（采用）**：CI 里拼出最小 runtime-dir 布局——
   `sparse checkout` aosp-node-runtime（depth 1，tag v24.22.1，只取 `runtime.lock.json`），
   把解包的两个 .so 放进 `node-runtime/src/main/jniLibs/arm64-v8a/`，再跑本仓
   `node scripts/provision-engine.mjs --runtime-dir $RT`（带 sha256+size 断言，失败 exit 2）。
   这样 CI 与本地**同一条投放命令、同一份 lock、同一门禁口径**（宪法 C3），不新写拷贝逻辑。
   ELF 八项门禁：归档来自已发布产物（发布时 provision.mjs 已验）；本仓 provision-engine 做 sha256/size 复核。
7. **解码签名材料**（仅 release job，secrets 缺失则降级未签名并在日志显著标注——但本仓库已部署 secrets，正常路径是签名）：
   ```bash
   echo -n "$ANDROID_KEYSTORE" | base64 -d > pi-desktop-android.keystore
   keytool -list -keystore pi-desktop-android.keystore -storepass "$KEYSTORE_PASSWORD" >/dev/null
   printf 'storeFile=pi-desktop-android.keystore\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
     "$KEYSTORE_PASSWORD" "$KEY_ALIAS" "$KEY_PASSWORD" > keystore.properties
   ```
   两个文件均 gitignored；日志只打 keytool 成功与否，不 cat 密码/keystore（C9）。
8. **组装载荷**：`node scripts/assemble-payload.mjs --apply --pi-web "$PWD/../pi-web"`。
   （需给脚本加 `--pi-web` 参数；当前 DEFAULT_PI_WEB 写死 sibling，CI 布局恰好也是 sibling，但显式参数更硬。——并入开发项，见 tasks T3。）
9. **构建 APK**：
   ```bash
   ./gradlew :app:assembleRelease --no-daemon --stacktrace \
     -PversionName=0.12.1 -PversionCode=2
   ```
10. **产物核对 + 合规**（验收 6/7）：
    ```bash
    APK=app/build/outputs/apk/release/app-release.apk
    unzip -l "$APK" | grep -E '\.so$'
    zipalign -c -P 16 -v 4 "$APK" | tail -3
    apksigner verify --print-certs "$APK"
    node scripts/compliance-check.mjs --apk "$APK"
    ```
    compliance-check 已对非 Windows 做 PATH 回退（aapt/zipalign）；`unzip` runner 自带。
11. **改名 + 校验和**：
    `pi-desktop-android-0.12.1-arm64-v8a.apk` + 同名 `.sha256`（`sha256sum` 生成，内容带文件名）。
12. **发布**（仅 tag）：`softprops/action-gh-release@v2`（内置 `GITHUB_TOKEN`，`permissions: contents: write`），
    挂载 apk + sha256；release notes 由 workflow 内 here-doc 生成（pi-web tag、引擎版本、commit SHA、合规结论摘要）。
    name=`Pi Desktop Android 0.12.1`，prerelease=false，tag 已存在直接更新该 Release。

## 代码改动点
- **`app/build.gradle.kts`**：defaultConfig 内
  ```kotlin
  versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
  versionName = (project.findProperty("versionName") as String?) ?: "0.1.0"
  ```
  默认值不变 ⇒ 本地 `assembleDebug/Release` 行为零变化。
- **`scripts/assemble-payload.mjs`**：
  - `assertArchiveReadable()`：tar 命令解析改为
    Windows 仍 `<SystemRoot>\System32\tar.exe`，其余平台直接 `'tar'`（GNU tar 支持 `-tzf`，输出同为条目列表）；
    注释更新为“bsdtar(Win)/GNU tar(Linux) 独立第三方实现”。
  - main() 增加 `--pi-web <dir>` 可选参数（默认值不变）。
  两处均为**最小、行为保持**改动。
- **不改**：provision-engine.mjs（已支持 --runtime-dir/env）、compliance-check.mjs（已跨平台）、gradle 配置、补丁。

## 偏差与取舍
- **D1 归档 sha256 来源**：archiveSha256 登记在 aosp-node-runtime/runtime.lock.json。CI 做 sparse checkout 取 lock 后，
  优先**从 lock 动态读 URL+sha256**（jq/Node 一行解析），避免把哈希在 workflow 里写死成第二事实源（C3）。
  若解析失败则 fail（不静默用硬编码）。
- **D2 同命令投放**：CI 拼最小 runtime-dir 复用 provision-engine.mjs，而不是 curl 出来直接 cp（后者会绕过本仓校验）。
- **D3 无 pnpm lock**：不冻结安装（上游现状）；缓存 pnpm store 只省时间不改解析。风险 R1。
- **D4 versionCode**：workflow 里首发写 2，并用注释说明“发布序列单调递增，手动维护”；不做自动 git 计数（tag 浅克隆计数不可靠）。
- **D5 签名缺失降级**：加 `if: secrets.ANDROID_KEYSTORE != ''` 不可在 run 级直接判 secret，改为在 step 内判
  `[ -n "$ANDROID_KEYSTORE" ]`，缺失则跳过解码（gradle 自动出未签名包）并 `::warning::`；apksigner 步骤随之条件化，
  compliance/Release notes 标注“unsigned”。已部署 secrets ⇒ 主路径签名。

## 风险登记
| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 无 pnpm-lock ⇒ 上游依赖漂移导致不可重复构建/偶发失败 | 日志固定 node/pnpm 版本；失败可见；后续推动上游或本仓锁定（本期不做，C4） |
| R2 | Next16 webpack build 在 Linux 与 Windows 产物差异（路径/裁剪规则） | 裁剪规则按 rel 匹配；payload 验收以补丁 marker + 归档可读 + 文件数为准；CI 全绿即证 |
| R3 | tag 名不符 v* 或 pi-web/引擎 tag 漂移 | on: push: tags: v*；脚本自身断言 pi-web describe=v0.12.1；引擎 lock 锁 24.22.1 |
| R4 | GITHUB_TOKEN 无写权限 Release 失败 | workflow 顶层 `permissions: contents: write` |
| R5 | secrets 配错（base64/密码）构建尾段才失败 | 解码后立即 keytool -list 早失败；失败不产出 Release |
