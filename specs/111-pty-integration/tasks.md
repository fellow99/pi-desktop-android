# 111-pty-integration — tasks（依赖序任务清单）

> 依赖：spec.md、plan.md。每任务含文件路径与验收。P0→P2 依赖序。

## P0 依赖与随包（构建/门禁，无设备）

- [ ] T001 `gradle/libs.versions.toml`：nodeRuntime→26.13.0，新增 nodePty=26.13.0 + `node-pty` 坐标
- [ ] T002 `app/build.gradle.kts`：依赖区加 `runtimeOnly(libs.node.pty)`
- [ ] T003 `runtime.lock.json`（根）：active.node→26.13.0；补 libnode/libcxx/libpty sha；新增 pty Maven 坐标
- [ ] T004 `scripts/verify-pty.mjs`（新）：node-pty AAR 内 libpty_node.so SHA + ELF 门禁
  （ET_DYN · 无 PT_INTERP · AArch64 · DT_NEEDED libnode.so · 16KB 对齐）
- [ ] T005 `scripts/verify-runtime.mjs`：锁口径升级 26.13.0（新 sha）
- [ ] T006 `scripts/provision-engine.mjs`：零网兜底 sha→26.13.0
- [ ] T007 `scripts/provision-pty.mjs`：退役（或并入 verify-pty --check）
- [ ] T008 `scripts/crop-rules.mjs`：node-pty 规则保留裁 1.2.0-beta.15，注释指向 overlay
- [ ] T009 `scripts/assemble-payload.mjs`：裁剪+壳资产后、vendor 兼容前，overlay
  `vendor/node-pty`(1.1.0)→`stage/node_modules/node-pty` + 补 `build/Release/pty.node` 占位
- [ ] T010 `scripts/devtest.mjs`：G1 锁口径 26.13.0 + pty；新增 pty-ready/overlay 断言
- **验收 P0**：`./gradlew :app:assembleDebug` 过；`verify-runtime` + `verify-pty` 全绿；APK 内 3 个 .so。

## P1 运行期（进程内可测）

- [ ] T011 `payload/pi-web-launch.js`：node-pty **常驻加载器**（dlopen libpty_node.so + 种子 require cache）
  提升为启动恒执行 + boot-facts `pty.ready`；保留 selftest 深探针
- [ ] T012 `payload/pi-web-launch.js`：删除 Node 侧 `throwIfAborted` 垫片
- [ ] T013 `patches/v0.12.1/0001-….patch`：`terminal-capability.ts` 移除 `"android"` 名单 +
  `ptyEvidence()` 增补 `libpty_node.so` 在位/可装载实测门；supported 仅当真装载
- [ ] T014 `payload/extensions/android-pty/index.js`：保留 `/pty-test`；新增最简 PTY bash 工具
  （单次 spawn mksh -c、onExit 完成判据、120s 超时 + 进程组 kill、输出 64KiB 截断、workspace cwd 围栏）
- [ ] T015 `payload/config/settings.json`（可选）：注册试运行工具
- **验收 P1**：`GET /api/terminal` 返 supported:true（真机/模拟器探针）；`/pty-test` 回程 OK。

## P2 验证与取证（真机）

- [ ] T016 真机 MIX/M2105K81C 构建安装 `app-debug.apk`；首启、payload 解包、服务就绪
- [ ] T017 终端面板 E2E（T1a–T1e：`tty`=pts、回显/颜色、resize、Ctrl-C、exit 关闭与清理）
- [ ] T018 最简 PTY bash 工具：退出码、120s 超时、围栏、输出截断
- [ ] T019 核心回归：模型对话、看图分析、git/pnpm 自检在 26.13.0 复跑
- [ ] T020 回归四件套（`regression.mjs`）+ 合规（compliance-check G3 native lib）
- [ ] T021 回填 as-built：能力清单 §B.3 #16→✅、README 矩阵、docs/002 记录、specs/104 terminal.pty 说明
- **验收 P2**：T016–T021 证据落盘；能力清单回填。

## 非目标（第二轮）
- bash 工具深化（常驻 PTY shell、流式、进程组 kill 对齐、与 android-exec 治理合并）
- x86_64 模拟器 Next 引导（L-ENV）、机型矩阵扩容、Google Play 转入
