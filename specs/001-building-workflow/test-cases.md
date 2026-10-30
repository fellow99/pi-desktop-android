# 001-building-workflow — test-cases

> 验收测例。CI 类需求无 Playwright/后端 HTTP 面；测试面 = 静态校验 + 本地脚本回归 + GitHub Actions 远端运行证据。
> 证据落 `logs/<日期>-N/`（logs gitignored，本地留存）。判据纪律 C5：只认可读回的证据（命令输出/Release 资产），不以“日志里有那行”为准。

| # | 用例 | 步骤 | 期望（可观测） | 对应 spec# |
|---|---|---|---|---|
| TC1 | workflow 触发区分 | 推 commit 到 main / 打 v0.12.1 | 普通 push 只跑校验、无 Release；tag 跑发布并创建/更新 Release | 1 |
| TC2 | 载荷组装（Linux） | job 日志 `assemble-payload --apply` | 6 补丁标记全部命中；归档自检 PASS；收尾 pi-web pristine；exit 0 | 2 |
| TC3 | 引擎门禁 | provision-engine 步骤 | 归档 sha256 -c 通过；“引擎在位且校验通过（24.22.1）”；exit 0 | 3 |
| TC4 | 签名链路 | keytool 自检 + apksigner verify | keytool -list exit 0；apksigner 输出 verified，证书 CN=Pi Desktop,O=fellow99 | 4,10 |
| TC5 | 版本三一致 | `aapt2 dump badging` | versionName=0.12.1 versionCode=2 package=org.fellow99.pi.PiDesktopAndroid label='Pi Desktop' | 5 |
| TC6 | .so 白名单 | `unzip -l apk \| grep .so` | 集合 ⊆ {libnode,libc++_shared,libnode_bridge,libnode_host_client}；全部 lib/arm64-v8a/ | 6 |
| TC7 | 16KB 对齐 | `zipalign -c -P 16 -v 4` | Verification successful，无 OutOfAlignment | 6 |
| TC8 | 合规机械项 | `compliance-check.mjs --apk` | G1–G7、G10、G11 全 PASS；机械项 0 FAIL（G8/G9 MANUAL） | 7 |
| TC9 | Release 资产 | Release v0.12.1 页面 | 挂 `pi-desktop-android-0.12.1-arm64-v8a.apk` + `.sha256`；notes 含 pi-web v0.12.1 / node 24.22.1 / commit | 8 |
| TC10 | sha256 自洽 | 下载 apk 与 .sha256，`sha256sum -c` | OK | 8 |
| TC11 | 失败不发布 | （构造性审查）workflow 任一步非零 | job fail；softprops 步骤不可达；无 Release/资产更新 | 9 |
| TC12 | 密钥不入库/不回显 | `git grep` 仓库 + 检查 Actions 日志 | 无 jks/keystore/密码明文；日志无 secret 明文（GitHub 自动 mask + 不 cat） | 10 |
| TC13 | Windows 本地不回归 | Win 本地 `node --check assemble-payload.mjs` + dry-run | tar 仍解析 System32\tar.exe；dry-run 输出与改动前一致（无错误） | 11 |
| TC14 | gradle 默认值不回归 | 不带 -P 时配置解析 | versionName=0.1.0 versionCode=1（默认）；带 -P 时被覆盖 | T2.3 |
| TC15 | actionlint | `actionlint release.yml` | 0 error | T3.10 |

## 远端验证策略（重要）
- **校验路径（push 触发）**：先验证“引擎投放 + 载荷组装 + 合规”整条构建链。为避免在非 tag 路径处理签名，
  校验 job 也解码 secrets（同一 job），但不发布；或校验 job 仅跑到 assembleRelease（secrets 在该仓库对所有 workflow run 可用）。
  实现上以同一 build job + `if: startsWith(github.ref,'refs/tags/')` 门控发布步骤，构建步骤两条路径完全一致，最大化验证覆盖。
- **发布路径（tag）**：打 `v0.12.1`。如需重跑：`git tag -d v0.12.1 && git push origin :refs/tags/v0.12.1` 后重打；
  Release 为 tag 级，同名 tag 重推会更新资产（softprops 默认更新已有 release）。
- tag 与版本：v0.12.1 对应 versionName 0.12.1 / versionCode 2。
