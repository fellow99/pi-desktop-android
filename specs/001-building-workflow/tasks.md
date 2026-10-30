# 001-building-workflow — tasks

> 依赖序任务清单。状态：⬜ 待做 / 🚧 进行中 / ✅ 完成。
> 参考先例：oc-desktop-android/specs/001-building-workflow/tasks.md（as-built 全绿）。

## T1 spec/plan/test-cases
- [x] T1.1 spec.md / plan.md / tasks.md / test-cases.md 落 `specs/001-building-workflow/`（不进父工程）
- [ ] T1.2 specs/README.md 模块表、SPECS_CHECKLIST.md 增补 001 行（as-built 状态随实现回填）

## T2 引擎接入 Maven Central（对齐参考工程）
- [ ] T2.1 `gradle/libs.versions.toml`：nodeRuntime `24.2.0` → `24.22.1`
- [ ] T2.2 `app/build.gradle.kts`：增 `runtimeOnly(libs.node.runtime)`；更新引擎注释（24.2.0 废弃原因删改）
- [ ] T2.3 新增根目录 `runtime.lock.json`（镜像 aosp-node-runtime active：node/abi/bridge/libnodeSha256/libcxxSharedSha256/gates/upstream/syncedAt）
- [ ] T2.4 新增 `scripts/verify-runtime.mjs`（移植参考工程；AAR 定位 --aar/env→mavenLocal→Gradle 缓存；SHA-256=lock + ELF 六项门禁）
- [ ] T2.5 回滚 T2.3 段（上一版计划）的 app 版本 `-PversionName/-PversionCode` 属性化改动（对齐参考「不注入 tag」）
- [ ] T2.6 本机验证：`node scripts/verify-runtime.mjs` 找 AAR（本次无 24.22.1 AAR 缓存 ⇒ 预期提示先拉取或 --aar）；`provision-engine.mjs --check` 仍绿（双路径一致性）

## T3 构建脚本跨平台 / 参数化（承上一轮已做）
- [x] T3.1 `scripts/assemble-payload.mjs`：`assertArchiveReadable()` tar 解析跨平台（Win=System32 bsdtar，Linux/CI=`tar` from PATH）
- [x] T3.2 同脚本：main() 支持 `--pi-web <dir>`，默认值保持 `../pi-web`（已实现，本地 dry-run 全绿）
- [ ] T3.3 `node --check` 两脚本语法 + assemble `--dry-run` 回归

## T4 GitHub Actions workflow（对齐参考工程骨架）
- [ ] T4.1 新增 `.github/workflows/build-release.yml`：on push tags `v*` + workflow_dispatch；（不做 push/PR 校验 job）
- [ ] T4.2 环境：checkout → Node24+corepack → JDK17+gradle cache → （不手工装 SDK，hosted runner）
- [ ] T4.3 引擎：AAR 预取（curl --retry 3 → $RUNNER_TEMP → PDA_NODE_RUNTIME_AAR）+ `verify-runtime --aar`
- [ ] T4.4 载荷：clone pi-web@v0.12.1（sibling）→ pnpm install → `assemble-payload --apply --pi-web`
- [ ] T4.5 签名分支：secrets 齐 → release（keystore 解码+keytool 自检+keystore.properties umask077）；缺 → debug 兜底；半配 → error 退出
- [ ] T4.6 APK：`./gradlew :app:assemble${VARIANT} --stacktrace`
- [ ] T4.7 产物：重命名 `pi-desktop-android-${ref_name}.apk` + `.sha256`；upload-artifact@v4 始终上传
- [ ] T4.8 发布：softprops/action-gh-release@v2（if startsWith refs/tags/v），name=`Pi Desktop Android ${ref_name}`；`permissions: contents: write`；concurrency 防并发
- [ ] T4.9 actionlint / YAML 解析校验

## T5 本机等价验证（无真机面，对齐参考 test-cases 口径）
- [ ] T5.1 actionlint/YAML 静态
- [ ] T5.2 `node --check` + assemble dry-run 回归（tar 跨平台不破坏 Windows）
- [ ] T5.3 verify-runtime：--aar 指向本地下载 AAR（若拿到）或说明缓存缺失处置；provision-engine --check 绿
- [ ] T5.4 `./gradlew :app:assembleDebug`（本机后台）确认 Maven node-runtime 24.22.1 解析后 APK 正常（引擎进包）
- [ ] T5.5 workflow_dispatch 真跑彩排（push 到 main 经 action 手动触发；release 步 skipped）→ 记录 run id
- [ ] T5.6 正式 tag v0.12.1 触发 → Release + 签名 APK 验证（用户侧 push，或征得许可后代 push）
- [ ] T5.7 TEST_REPORT.md 归档 logs/

## T6 Code Review + Bugfix/Regression
- [ ] T6.1 requesting-code-review 派发（commit range）→ REVIEW_REPORT.md
- [ ] T6.2 receiving-code-review 逐条核验修复 → 复审（Critical=0）
- [ ] T6.3 spec/test-cases as-built 回填 ✅；README/CHECKLIST 回填
