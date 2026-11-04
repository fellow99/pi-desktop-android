# 112-cli-integration — tasks（实施任务，依赖排序）

> 依赖：`spec.md` / `plan.md`。每任务标注所属阶段（P0–P4）与验收；as-built 状态在完成后回填
> （⬜ 未开始 / 🟦 进行 / ✅ 完成 / ⚠️ 受阻）。分支：`main`（逐阶段提交，Conventional Commits）。

## P0 真机探针（Go/No-Go）

- [ ] T0.1 用五个已下载 tarball + 现有引擎件，做**最小探针 APK/调试通道**，在真机 `cd3fac61`（Android 11）验证：
  `useLegacyPackaging=true` 后 `nativeLibraryDir` 物理含全部 `lib*.so`（`run-as ls`/代码上报）。验收：文件齐。
- [ ] T0.2 同设置下回归 dlopen：App 正常启动、终端面板可开、`boot-facts.pty.ready=true`、`libnode.so/libpty_node.so` 装载正常。验收：111 能力不回归（**否决项**）。
- [ ] T0.3 symlink 农场探针：filesDir 与（可能的）nativeLibraryDir 下建 `$HOME/bin/node → …/libnode_cli.so`，经 PTY 与非 PTY sh 各执行一次。验收：建链成功且 `node -v` 回程；失败则记录 errno，转 plan D4 备选。
- [ ] T0.4 shell 壳探针：`libnpm.so`/`libpip.so`（shebang 脚本）随 jniLibs 落盘后，在设好 `NODE_TOOLS_DIR/NODE_NATIVE_DIR` 下经 sh 执行。验收：`npm -v`/`pip --version` 回程（AGP 是否原样保留 shebang）。
- [ ] T0.5 git 远程探针：设 `GIT_TEMPLATE_DIR/SSL_CERT_FILE` 后 `git --version` 与 `git ls-remote https://github.com/…`。验收：版本回程；https TLS 成功（决定是否需 `GIT_EXEC_PATH`/传输件路径）。
- [ ] T0.6 产出 `logs/<date>-1/P0-PROBE-REPORT.md`：逐项 ✅/❌ + 证据（logcat/命令回显），据结论锁定 D2/D3/D4 最终方案。

## P1 获取 / 门禁 / 随包

- [ ] T1.1 建 `cli.lock.json`：五仓 tag/tarball URL/tarball sha256、各 ELF sha256+size、tools manifest digest、门禁期望（PT_INTERP、NEEDED 白名单、16KB）。Python 已核实：tarball 24,288,587B / `b4b90341…57571c`，ELF 15,754,472B / `1112574a…bb0d6`，manifest `95d3e330…4361`。
- [ ] T1.2 `scripts/verify-cli.mjs`：exec 型 ELF 门禁（ET_DYN=PIE、e_machine=AArch64、PT_INTERP=/system/bin/linker64、NEEDED 白名单、每个 PT_LOAD 满足 `p_offset ≡ p_vaddr mod 16KB` 且 `p_align ≤ 16KB`、sha/size 比对）；壳脚本单独白名单（shebang 校验，不做 ELF）。
- [ ] T1.3 `scripts/provision-cli.mjs`：`--from <dir>`/`--download`/`--check`；解包五 tarball → jniLibs 投放 `lib*_cli.so`+壳+git 传输件；把 `<tool>-bridge-tools/` 确定性打成 `assets/cli-tools/<tool>.tar.gz`。
- [ ] T1.4 `.gitignore` 复核：`jniLibs/`（已忽略）覆盖新增 CLI 件；新增忽略 `app/src/main/assets/cli-tools/`（派生产物）。
- [ ] T1.5 `app/build.gradle.kts`：依 T0.2 结论切 `useLegacyPackaging=true`（加注释：exec 件需落盘，dlopen 回归已由 T0.2 证实安全）。
- [ ] T1.6 本机 `node scripts/provision-cli.mjs --from <scratch>` → `verify-cli --check`/`provision-cli --check` 全绿。
- [ ] T1.7 `./gradlew assembleDebug` 构建过；`unzip -l` 校验 APK：jni 齐件 + `assets/cli-tools/{node,python,git}.tar.gz`；记录 APK 体积增量。

## P2 运行期引导 / 命令暴露

- [ ] T2.1 实现 tools 物化（按 T0 结论选定 Kotlin `CliTools.kt` 或 Node 首启）：assets/cli-tools → `filesDir/node-bridge/cli-tools/<tool>/`，tarball sha256 marker 幂等、损坏重建。
- [ ] T2.2 `PiDesktopRuntime.runBoot`：物化后注入 env：`PATH`（nativeLibraryDir + $HOME/bin 前置）、`NODE_NATIVE_DIR`、`NODE_TOOLS_DIR`、`PYTHONHOME/PYTHONPATH/SSL_CERT_FILE`、`GIT_CONFIG_GLOBAL/GIT_TEMPLATE_DIR/GIT_EXEC_PATH?/SSL_CERT_FILE`、`UV_CACHE_DIR/XDG_CACHE_HOME`、pnpm store 目录。
- [ ] T2.3 命令短名暴露（按 T0.3 结论）：首选 symlink 农场；否决则实现 D4 备选（.mkshrc + ptyBash sh -lc 最小改动 或 Node 包装），并在 boot-facts 记录机制。
- [ ] T2.4 `pi-web-launch.js`：合并 PATH/建链（若 Node 侧承担）；`writeBootFacts` 增 `cli` 块（present + `--version` 带超时探针，五件独立成败、结构化 reason）。
- [ ] T2.5 真机：终端面板依次 `node -v`/`npm -v`/`npx -v`/`corepack --version`、`python -V`/`pip --version`/`python -c "import ssl…"`、`git --version`、`uv --version`、`pnpm --version`。
- [ ] T2.6 真机 git 工作流：init/config/add/commit/log/branch + `git ls-remote https://…`（CA 生效）。
- [ ] T2.7 真机：`uv venv`（离线可判定）；`pnpm install` 一个纯 JS 小包（或本地包）验证 lifecycle 找得到 node；npm/pip 纯包安装按网络据实记录。
- [ ] T2.8 验证无编译器边界被如实上报（promptGuidelines/能力标志），不静默降级。

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
