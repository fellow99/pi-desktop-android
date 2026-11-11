# 113-system-back — tasks（系统级返回按钮行为改造 · Android）

> 依赖有序任务清单。对应 specs/113-system-back/{spec,plan}.md。

## T1 设置（Setup）
- [ ] T1.1 确认 pi-web 工作树在 v0.15.0（tag f130910）且干净
- [ ] T1.2 建日志目录 `logs/20261111-1/` + `DEV_CHECKLIST.md`

## T2 补丁 + 宿主（Foundational）
- [ ] T2.1 改 pi-web 工作树 `components/AppShell.tsx`：加 `pi-back` 监听 effect（关设置页→收抽屉→no-op）
- [ ] T2.2 `git diff` 生成 `0008-system-back.patch` 落 `patches/v0.15.0/`，`git apply --check` 通过
- [ ] T2.3 还原 pi-web 工作树 pristine 并核验
- [ ] T2.4 改 `app/src/main/java/.../MainActivity.kt` 的 `onBackPressed()`（派发 `pi-back` / 未挂载兜底退出）

## T3 验证（User Story）
- [ ] T3.1 本地静态核对：补丁文件头、事件协议名 `pi-back` 三平台一致
- [ ] T3.2 `./gradlew :app:compileDebugKotlin` 编译通过（宿主改动无类型错误）

## T4 Code Review（Phase 3.5 门禁）
- [ ] T4.1 用 requesting-code-review 技能分派评审（Critical/Important/Minor）
- [ ] T4.2 用 receiving-code-review 技能核实并修复 Critical/Important
- [ ] T4.3 `REVIEW_REPORT.md` 回填 + `fix:` 提交

## T5 测试（Phase 4，真机 8f155833）
- [ ] T5.1 `assemble-payload` + `assembleDebug` 构建 APK
- [ ] T5.2 `adb install -r` 覆盖部署（不卸载）
- [ ] T5.3 逐条执行 test-cases.md（BACK=keyevent 4），记录 PASS/FAIL
- [ ] T5.4 `TEST_REPORT.md` 产出 + `test:` 提交

## T6 Bugfix / Regression（Phase 5/6）
- [ ] T6.1 修 FAIL 用例，逐一复测
- [ ] T6.2 回归抽查通过用例，最终 `TEST_REPORT.md` + 提交
