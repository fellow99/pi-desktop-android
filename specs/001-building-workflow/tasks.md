# 001-building-workflow — tasks

> 依赖序任务清单。状态：⬜ 待做 / 🚧 进行中 / ✅ 完成。

## T1 spec/plan/test-cases
- [ ] T1.1 spec.md / plan.md / tasks.md / test-cases.md 落 `specs/001-building-workflow/`（不进父工程）
- [ ] T1.2 specs/README.md 模块表、SPECS_CHECKLIST.md 增补 001 行（as-built 状态随实现回填）

## T2 工程脚本跨平台 / 参数化（最小改动）
- [ ] T2.1 `scripts/assemble-payload.mjs`：`assertArchiveReadable()` tar 解析跨平台（Win=System32 bsdtar，Linux/CI=`tar` from PATH）
- [ ] T2.2 同脚本：main() 支持 `--pi-web <dir>`，默认值保持 `../pi-web`
- [ ] T2.3 `app/build.gradle.kts`：`-PversionName/-PversionCode` 覆盖，默认 0.1.0/1 不变
- [ ] T2.4 Windows 本地回归：assemble `--dry-run` 与脚本 `node --check`；确认未触碰无关未提交改动

## T3 GitHub Actions workflow
- [ ] T3.1 新增 `.github/workflows/release.yml`：on push tags `v*` + push(branches)+pull_request 两触发；单 build job（输入 release 标志）
- [ ] T3.2 checkout / JDK17 / Node24+corepack pnpm / setup-android+build-tools;36.0.0+platforms;android-36 / 缓存（pnpm store、~/.gradle）
- [ ] T3.3 clone pi-web@v0.12.1 到 sibling + pnpm install
- [ ] T3.4 引擎：sparse/depth1 取 aosp-node-runtime@v24.22.1 的 runtime.lock.json；从 lock 解析 release 归档 URL+archiveSha256；下载+sha256 -c；解包到最小 runtime-dir；跑 `node scripts/provision-engine.mjs --runtime-dir $RT`
- [ ] T3.5 keystore 解码 + keytool 自检（secrets；缺失 warning 降级 unsigned，apksigner 条件化）
- [ ] T3.6 `assemble-payload --apply --pi-web` → `assembleRelease -PversionName/-PversionCode`（tag 推导；versionCode 首发 2，注释说明手动单调递增）
- [ ] T3.7 核对：unzip .so 白名单、zipalign -P 16、apksigner verify、compliance-check（机械项零 FAIL）
- [ ] T3.8 产物改名 `pi-desktop-android-<vn>-arm64-v8a.apk` + `.sha256`
- [ ] T3.9 release job：softprops/action-gh-release@v2 挂载 apk+sha256，notes 含版本矩阵+commit；`permissions: contents: write`；非 tag 不发布
- [ ] T3.10 `actionlint` 静态校验 workflow

## T4 Code Review（requesting-code-review + receiving-code-review）
- [ ] T4.1 以 T2/T3 commit range 派发 reviewer（Critical/Important/Minor 分类）→ REVIEW_REPORT.md
- [ ] T4.2 按 receiving 纪律逐条核验、修复 Critical/Important → 必要时复审

## T5 Testing（无真机面：静态 + 本地干跑 + workflow 远端触发）
- [ ] T5.1 YAML 静态校验（actionlint）、shell 语法（bash -n 生成片段）
- [ ] T5.2 本地：node --check 两脚本；assemble dry-run；gradle 属性格式检查（-P 传参 help 级/本地 assembleDebug 不回归视耗时决定）
- [ ] T5.3 推送 commit（push 触发器）观察校验 job：Linux 上载荷组装/引擎投放/合规全绿（用 debug 或 release-unsigned 路径验证构建链；签名在 tag 路径验证）
- [ ] T5.4 打 tag v0.12.1 触发发布 → 验证 Release 出现签名 APK + sha256，验收 1–11 逐条勾稽
- [ ] T5.5 TEST_REPORT.md 归档 logs/（logs 不入库，只本地留存证据）

## T6 Bugfix / Regression
- [ ] T6.1 T5 失败项分级修复
- [ ] T6.2 回归：重跑失败 job / 必要时删 tag 重打（远端 Release 可重复更新）
- [ ] T6.3 spec/test-cases as-built 状态回填 ✅；README/CHECKLIST 回填
