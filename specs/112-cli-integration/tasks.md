# 112-cli-integration — tasks（实施任务，依赖排序）

> 依赖：`spec.md` / `plan.md`。每任务标注所属阶段（P0–P4）与验收；as-built 状态在完成后回填
> （⬜ 未开始 / 🟦 进行 / ✅ 完成 / ⚠️ 受阻）。分支：`main`（逐阶段提交，Conventional Commits）。

## P0 真机探针（Go/No-Go）

- [x] T0.1 最小探针验证 legacy 物理落盘：`useLegacyPackaging=true` 后 `nativeLibraryDir/…/lib/arm64` 物理含全部 `lib*.so`（含壳）。✅ 见报告 P0-1（2026-11-04，Android17/API37 x86_64+arm64 翻译模拟器；真机小米 MIX Android 8/API26 因 MIUI 人工安装门未完成）。
- [x] T0.2 同设置下 dlopen 回归：按序 `c++_shared→node→pty_node` System.loadLibrary 全成功（引擎无 JNI_OnLoad，等价纯 dlopen；pty NEEDED node+c++ 链解析正常）。✅ 报告 P0-2，**否决项未触发**。
- [x] T0.3 symlink 农场探针：`android.system.Os.symlink` 在 filesDir 可用（git exec 农场 8 名 + `$HOME/bin` 短名），短名直链 PIE 执行回程。✅ 报告 P0-3。约束：幂等重建须无条件 `delete()`（悬空链接 `exists()=false`，否则 errno=17）。
- [x] T0.4 shell 壳探针：shebang 原样保留、可执行；`npm -v → 11.20.0`。✅ 报告 P0-4。**关键约束**：pip 壳写死 `dirname "$0"` 不读 env，短名 symlink 会 code=127 ⇒ pip/pip3 必须生成绝对路径**包装脚本**（`pip --version → 26.2.2` 验证）。
- [x] T0.5 git 远程探针：`GIT_EXEC_PATH` 指农场 + 8 链接，`git --version=2.56.0`；`git ls-remote https://github.com/fellow99/aosp-python-cli.git` TLS 成功（静态 curl+OpenSSL）。✅ 报告 P0-5。
- [x] T0.6 产出 `logs/2026-11-04-1/P0-PROBE-REPORT.md`、设备 logcat `P0-PROBE-REPORT-device.txt` 与离线 ELF 门禁 `P0-ELF-GATE.json`。结论 **GO（22/22）**，锁定：PYTHONHOME（非 PYTHONPATH）+`LD_LIBRARY_PATH`、pip 包装脚本、git exec 农场、aapt dot 保留、悬空链接幂等、AGP `.tar.gz→.tar` 条目口径。**遗留**：真机 cd3fac61 原生 arm64 内核回归并入 T4.x（MIUI 人工门解除后复跑 A 段）。

## P1 获取 / 门禁 / 随包

- [x] T1.1 建 `cli.lock.json`：五仓 tag/tarball URL/tarball sha256、各 ELF sha256+size、tools manifest digest、门禁期望。✅ 已入库（`toolArchives` tool 键控；`generatedAt` 易变，锁只校验语义字段）。
- [x] T1.2 `scripts/verify-cli.mjs`：exec 型 ELF 门禁（ET_DYN=PIE、AArch64、PT_INTERP=/system/bin/linker64、NEEDED 白名单、16KB LOAD 判据、sha/size）；壳脚本 shebang 白名单单列。✅
- [x] T1.3 `scripts/provision-cli.mjs`：`--from`/`--download`/`--check`；投放 jniLibs + 确定性 `assets/cli-tools/<tool>.tar`（gzip 内容、`.tar` 后缀规避 AGP 改名）。✅
- [x] T1.4 `.gitignore`：jniLibs 已忽略；新增忽略 `app/src/main/assets/cli-tools/` 派生产物。✅
- [x] T1.5 `app/build.gradle.kts`：切 `useLegacyPackaging=true` 并注释（exec 件物理落盘，dlopen 回归 T0.2 已证安全）。✅
- [x] T1.6 本机 provision → verify/`--check` 全绿。✅（提交 `1343841`）
- [x] T1.7 `assembleDebug` 过；APK 含 jni 齐件 + `assets/cli-tools/*.tar`；toybox tar 严格 ustar（目录条目 0755）修复见提交 `875e40c`。✅ 报告 `logs/2026-11-05/P1-BUILD-PACKAGE-REPORT.md`。

## P2 运行期引导 / 命令暴露

- [x] T2.1 实现 tools 物化：选定 **Kotlin `CliTools.kt`**（`materialize` + digest marker 幂等、损坏重建），assets/cli-tools → `filesDir/node-bridge/cli-tools/<tool>/`；并承担 symlink 农场 + `writeLoginProfile`。✅ `:app:compileDebugKotlin` 过（待提交）。
- [x] T2.2 `PiDesktopRuntime.runBoot`：物化后经 `CliTools.environment()` 进程级一次注入 env（PATH/HOME/TMPDIR/NODE_*/PYTHONHOME（不设 PYTHONPATH）/LD_LIBRARY_PATH/SSL_CERT_FILE/GIT_*/UV_CACHE_DIR/PNPM_HOME 等）。✅
- [x] T2.3 命令短名暴露（**P2 实测改判，见 plan D4b**）：symlink 农场在真域受 bionic 裸短名 realpath + execve 数据目录两约束，权威机制改为 **`$HOME/.profile` shell 函数（exec 绝对 ELF/壳）+ 三通道统一 login shell `sh -l`**；symlink/gitexec 农场保留作绝对路径后备。TERM 本就 `sh -l`；PTY `["-l","-c"]`、EXEC `spawn(SHELL_PATH,["-l"])`。✅
- [x] T2.4 `pi-web-launch.js`：探针**延迟到 Next 就绪后 `setImmediate` 异步跑**，boot-facts 写 `cli:{status:'deferred'}`，结果另落 `pi-web.cli-facts.json`；常驻 `sh -l` + 随机哨兵 + 只看 stdout；PATH 探测与 runOne 同构双标记帧；git 冒烟走独立短生命周期 shell（`runGitSmoke`）。✅ 模拟器 10/10、PATH 10/10、零超时、43s。
- [x] T2.5 模拟器（API37 翻译层，真机留 T4.x）：十命令 `--version` 全回程——node v26.13.0 / npm·npx 11.20.0 / corepack 0.36.0 / Python 3.14.10 / pip 26.2.2 / git 2.56.0 / uv 0.13.6 / pnpm 12.16.1。✅ 证据 `cli-facts-app-untrusted.json`。
- [⚠️] T2.6 git 工作流：init/config/add/hash-object/write-tree/log 正常、`ls-remote` TLS 成功；**`git commit` 在真域稳定 rc=139（SELinux 拒 `link(2)` + git 不回退 rename 而 NULL 解引用）**，配置层无 workaround。因果链/对照表/产品处置见 `logs/2026-11-05/git-commit-segfault/README.md`；原生 arm64 是否同样崩溃留 T4.x 裁决。
- [ ] T2.7 模拟器：`uv venv`（离线可判定）；`pnpm install` 纯 JS 小包验证 lifecycle 找 node；npm/pip 纯包安装按网络据实记录。⬜ 待跑（本轮聚焦探针/段错误裁决）。
- [ ] T2.8 验证无编译器边界被如实上报（promptGuidelines/能力标志），不静默降级。⬜ 随 T3.7 一并改。

## P3 移除纯 JS 替代（补充需求）

- [ ] T3.1 删 `payload/extensions/android-git/`（isomorphic-git）与 `scripts/sync-git-extension.mjs`。
- [ ] T3.2 删 `payload/extensions/android-pnpm/`（JS pnpm 9.15.9 bundle）。
- [ ] T3.3 `pi-web-launch.js`：删 `runGitSelftest`/`runPnpmSelftest` 及 main 调用与仅其使用的辅助；新增启动期清理旧物化残留 `extensions/{android-git,android-pnpm}`。
- [ ] T3.4 `env.js`：确认无其它消费者后移除 harmony-git `PI_HOS_ROOTS` 单源别名。
- [ ] T3.5 `compliance-check.mjs`：移除 pnpm.LICENSE/isomorphic-git 在位断言，改登记五 CLI 的 LICENSE/THIRD-PARTY-NOTICES 来源；确认门禁绿。
- [ ] T3.6 `.github/workflows/build-release.yml`：移除 sync-git 检查；构建前加 `provision-cli --download/--check`（CI 网络拉 Release）；保留构建机 pnpm12 装 pi-web 步骤。
- [ ] T3.7 `android-exec.js` promptGuidelines：更新为「PATH 含 node/npm/python/pip/git/uv/pnpm；无 gcc/make，原生扩展/sdist 不可编译」。
- [ ] T3.8 grep 全仓确认无残留引用（历史 docs/specs/evidence 保留不改；代码/脚本/CI 零残留）；重新 assemble + 组装载荷验证产物不含两扩展。

## P4 验收 / 取证 / 文档

- [ ] T4.1 按 `test-cases.md` 跑 CLI 功能用例（终端 + Agent bash + ptyBash 三通道）。
- [ ] T4.2 按 `test-cases.md` 跑 Agent 用例：DeepSeek（key 一次性注入，不入库）、模型 deepseek-flash、建工作区、对话「介绍一下你自己」、看图分析。
- [ ] T4.3 回归四件套：终端面板 111 用例、一次普通对话、载荷组装 pristine、合规门禁；确认未引入回归。
- [ ] T4.4 回填 `docs/安卓环境能力清单-*.md`（git/pnpm 真实二进制 ✅；新增 node/python/uv ✅；生态边界）、README×2（CLI 能力/体积/限制）。
- [ ] T4.5 真机证据归档 `logs/<date>-N/` + `docs/evidence/`（脱敏：无 API Key/Authorization/凭据）；更新 `specs/SPECS_CHECKLIST.md` 收录 112。
- [ ] T4.6 `./gradlew assembleDebug` + 全量 verify/合规门禁终检；提交序列收尾。

## 提交规划（Conventional Commits，禁止 --no-verify）
- `build: provision five real CLI binaries from GitHub releases (112)`（cli.lock/provision/verify/gitignore/gradle）
- `feat: wire real node/python/git/uv/pnpm CLIs into terminal and agent PATH (112)`（物化/env/boot-facts）
- `refactor!: remove isomorphic-git and in-process JS pnpm extensions (112)`（删除/CI/合规；若判定为破坏性加 `!`）
- `test: add CLI integration and DeepSeek agent test cases (112)`
- `docs: record real CLI capabilities and ecosystem limits (112)`
