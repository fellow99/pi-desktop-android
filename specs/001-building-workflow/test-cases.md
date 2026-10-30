# 001-building-workflow — test-cases

> 验收测例。对齐参考工程 oc-desktop-android test-cases 口径：本机可执行 = 静态校验 + 等价命令；真实 tag 端到端 = 用户侧。
> CI 类需求无 Playwright/后端 HTTP 面。判据纪律 C5：只认可读回的证据（命令输出/Release 资产）。

| # | 用例 | 对应 spec# | 结果 |
|---|---|---|---|
| TC1 | YAML 可解析 + Actions 语义 | 1 | ✅ actionlint 0 error；YAML/CSRFToken 解析成功 |
| TC2 | 触发面 | 1 | ✅ push.tags=v* + workflow_dispatch；无 push/PR |
| TC3 | 载荷组装 | 2 | ✅ Linux runner 真跑全绿（next build/patch/crop/tar/brand） |
| TC4 | 引擎门禁 | 3 | ✅ 彩排 verify-runtime 全绿（Central AAR） |
| TC5 | 引擎双路径一致 | 11 | ✅ 同一 sha be1d16… |
| TC6 | 签名分支逻辑 | 4 | ✅ review 核 + 实跑（v0.12.1 release、dispatch debug） |
| TC7 | 签名材料零入库 | 9 | ✅ git check-ignore + ls-files 清 |
| TC8 | APK 构建 | 5 | ✅ 本地 + CI 双证实 |
| TC9 | .so 白名单 / 对齐 / 合规 | 6 | ✅ 4 .so；Verification successful；合规 0 FAIL |
| TC10 | 版本三一致 | 5 | ✅ 包名/标签正确（version 0.1.0 静态，对齐参考） |
| TC11 | Release 资产 | 7 | ✅ v0.12.1 已发布（签名 APK + sha256） |
| TC12 | sha256 自洽 | 7 | ✅ MATCH |
| TC13 | 失败不发布 / artifact 留存 | 8 | ✅ 9 轮调试 8 失败均无 Release；artifact 可查 |
| TC14 | dispatch 不发布 | 1/8 | ✅ 彩排 run 41092950615 Release 步 skipped |
| TC15 | Windows 本地不回归 | 10 | ✅ 本地 dry-run 30501 文件全绿 |
| TC16 | gradle 引擎依赖生效 | 3 | ✅ node-runtime:24.22.1 在 releaseRuntimeClasspath |

## 环境记录
- 本机：Windows 10 / Git Bash；Node v24；JDK 17；AGP 8.10.1 + Gradle 8.12。
- Maven Central 实证：`curl repo1.maven.org/.../node-runtime/maven-metadata.xml` → 24.22.1（2026-10-27 发布）；
  参考工程 runtime.lock.json 注明 2026-10-29 Central AAR verify-runtime 全绿。
- 本机 jniLibs libnode.so sha=be1d16…（= 参考工程 lock.libnodeSha256）⇒ Central 发布与本地投放逐字节一致。

## 远端验证策略
- 彩排：workflow_dispatch（手动）跑 debug 兜底路径，验证构建链与 artifact，Release 步按设计跳过。
- 正式：push tag `v0.12.1`（用户侧，需仓库推送权限）→ Release 挂签名 APK。
- 重跑：同 tag 重推时 softprops 默认更新既有 Release。
