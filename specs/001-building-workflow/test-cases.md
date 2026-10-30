# 001-building-workflow — test-cases

> 验收测例。对齐参考工程 oc-desktop-android test-cases 口径：本机可执行 = 静态校验 + 等价命令；真实 tag 端到端 = 用户侧。
> CI 类需求无 Playwright/后端 HTTP 面。判据纪律 C5：只认可读回的证据（命令输出/Release 资产）。

| # | 用例 | 对应 spec# | 步骤 | 期望（可观测） |
|---|---|---|---|---|
| TC1 | YAML 可解析 + Actions 语义 | 1 | node yaml / actionlint 跑 `build-release.yml` | 解析成功；actionlint 0 error（或等价结构断言） |
| TC2 | 触发面 | 1 | 解析 `on` 段 | 含 `push.tags == ['v*']` 与 `workflow_dispatch`；无 push/PR 分支触发 |
| TC3 | 载荷组装（Linux 等价） | 2 | 本地 assemble dry-run + workflow 内 `--apply --pi-web` 步骤文本 | dry-run 全绿；6 补丁标记命中；归档自检 PASS；pristine 收尾 |
| TC4 | 引擎门禁 | 3 | `verify-runtime.mjs --aar <central.aar>` | AAR 内 libnode.so SHA-256=lock（be1d16…）、libc++=cd6176…；ELF 六项全 PASS；exit 0 |
| TC5 | 引擎双路径一致 | 11 | `provision-engine.mjs --check` + verify-runtime | 两者指认同一 libnode.so sha（be1d16…） |
| TC6 | 签名分支逻辑 | 4 | 审查注秘 step | 全 secrets → release + keytool 自检 + keystore.properties(umask077)；无 → debug 兜底；半配 → error |
| TC7 | 签名材料零入库 | 9 | `git check-ignore keystore.properties *.keystore` + `git ls-files` | 全部 ignored；追踪集无敏感文件 |
| TC8 | APK 构建（本机等价） | 5 | `./gradlew :app:assembleDebug --stacktrace` | BUILD SUCCESSFUL；`app/build/outputs/apk/debug/app-debug.apk` 产出 |
| TC9 | .so 白名单 / 对齐 / 合规 | 6 | unzip -l \| grep .so；zipalign -c -P 16；compliance-check --apk | .so ⊆ {libnode,libc++_shared,libnode_bridge,libnode_host_client}；zipalign OK；机械项 0 FAIL |
| TC10 | 版本三一致 | 5 | aapt2 dump badging | package=org.fellow99.pi.PiDesktopAndroid；label='Pi Desktop' |
| TC11 | Release 资产 | 7 | （用户侧）push v0.12.1 | Release `v0.12.1` 挂 `pi-desktop-android-v0.12.1.apk` + `.sha256`；notes 含 pi-web/引擎/commit |
| TC12 | sha256 自洽 | 7 | 下载 apk 与 .sha256，sha256sum -c | OK |
| TC13 | 失败不发布 / artifact 留存 | 8 | 审查 step 划分 + upload-artifact | 关键步失败 → job fail、Release 步不可达；`dist/` 始终上传 artifact |
| TC14 | dispatch 不发布 | 1/8 | workflow_dispatch 真跑彩排 | 构建链全绿；Release 步 skipped；artifact 存在 |
| TC15 | Windows 本地不回归 | 10 | Win 本地 `node --check` + assemble dry-run | tar 仍选 System32\tar.exe；dry-run 无错误 |
| TC16 | gradle 引擎依赖生效 | 3 | 查 `./gradlew :app:dependencies --configuration releaseRuntimeClasspath` | 含 `io.github.fellow99:node-runtime:24.22.1`（runtime） |

## 环境记录
- 本机：Windows 10 / Git Bash；Node v24；JDK 17；AGP 8.10.1 + Gradle 8.12。
- Maven Central 实证：`curl repo1.maven.org/.../node-runtime/maven-metadata.xml` → 24.22.1（2026-10-27 发布）；
  参考工程 runtime.lock.json 注明 2026-10-29 Central AAR verify-runtime 全绿。
- 本机 jniLibs libnode.so sha=be1d16…（= 参考工程 lock.libnodeSha256）⇒ Central 发布与本地投放逐字节一致。

## 远端验证策略
- 彩排：workflow_dispatch（手动）跑 debug 兜底路径，验证构建链与 artifact，Release 步按设计跳过。
- 正式：push tag `v0.12.1`（用户侧，需仓库推送权限）→ Release 挂签名 APK。
- 重跑：同 tag 重推时 softprops 默认更新既有 Release。
