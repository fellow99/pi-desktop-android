# 112-cli-integration — plan（技术实施计划）

> 依赖：`specs/112-cli-integration/spec.md`；方案权威：node-bridge-workspace `docs/aosp+node+python+git运行方案.md`（§2 约束 / §3 逐工具 / §4 公共基础设施 / §9 制品线）。
> 本工程无 `.specify`，沿用自身约定（`specs/<模块>/spec.md` + `plan.md` + `tasks.md` + `test-cases.md`）。

## 架构（数据流）

```
GitHub Release tarball ──(provision-cli.mjs, 锁 cli.lock.json, sha256/ELF 门禁)──┐
                                                                                  │ jniLibs/arm64-v8a/lib*_cli.so + 壳 lib*.so（不入库）
                                                                                  ▼
Gradle assembleDebug ├─ jniLibs(legacyPackaging=true, 物理落盘 nativeLibraryDir) ─┤
                     └─ assets/cli-tools/<tool>.tar.gz（noCompress gz，独立于 pi-web.tar.gz）
                                                                                  │
App 启动（PiDesktopRuntime 注入 nativeLibraryDir）                                ▼
  Kotlin: 解 assets/cli-tools/*.tar.gz → filesDir/node-bridge/cli-tools/<tool>（digest marker 幂等）
        + 建 $HOME/bin symlink 农场（Go/No-Go 探针；备选见 D4）                    │
  Node(package/pi-web-launch): PATH/NATIVE/TOOLS/PYTHON/GIT/SSL env 进程级注入 ────┤
                                                                                  ▼
            terminal-manager(/system/bin/sh -l)  ptyBash(env=process.env)  android-exec(继承父 env)
                                                                                  ▼
                  命令名 node/npm/npx/corepack/python/pip/git/uv/pnpm 经 PATH 命中
```

## 关键技术决策

### D1 获取与随包：GitHub Release tarball + provision 投放（对齐第二轮 Maven，二进制不入库）
- 新增 `cli.lock.json`（工程根，**入库**）：五仓 release tag/tarball URL/tarball sha256 + 每个 ELF 的
  sha256/size + `-bridge-tools/manifest.json` digest + exec 门禁期望值（PT_INTERP / DT_NEEDED 白名单）。
  Python 已核实 Release：`fellow99/aosp-python-cli@v3.14.10`，tarball `b4b90341…57571c` /
  24,288,587B；`libpython_cli.so` `1112574a…bb0d6` / 15,754,472B；tools manifest
  `95d3e330…4361`、`fileCount=1078`、`totalSha256=e82f1973…a60dc`。
- 新增 `scripts/provision-cli.mjs`（镜像 provision-engine.mjs）：
  - 输入：`--from <dir>`（已下载 tarball 目录，CI/本机）或 `--download`（按 lock URL 拉取，零仓内二进制）；
  - 解包后按 **AAR 内布局**投放：
    - jni：`*.so`（`lib*_cli.so` + 壳）→ `app/src/main/jniLibs/arm64-v8a/`（git 的两个传输件一并）；
    - assets 工具树：各 `<tool>-bridge-tools/` → 打成 `app/src/main/assets/cli-tools/<tool>.tar.gz`
      （确定性 ustar，复用 assemble-payload 的确定性写法）；
  - `--check`：校验 jniLibs 中 CLI ELF 的 sha/size/门禁 + assets/cli-tools 存在且 digest 一致。
- 新增 `scripts/verify-cli.mjs`：exec 型 ELF 门禁（见 spec C2），独立于 verify-runtime/verify-pty 的 dlopen profile；
  16KB 判据按 ELF 装载规则检查每个 PT_LOAD 的 `p_offset ≡ p_vaddr (mod 16KB)` 与 `p_align ≤ 16KB`，不能误判文件大小。
- 为什么 tools 树走独立 `assets/cli-tools/*.tar.gz` 而非并入 pi-web.tar.gz：
  pi-web 载荷已 27k 文件/首启解包 20–40s；CLI 树（npm 依赖、python stdlib 数万文件）并入会再放大首启时延与
  marker 失配面；独立资产 + 独立 digest marker，可单独演进，第二轮换 Maven 时只改获取侧。
- `app/build.gradle.kts`：`androidResources.noCompress += "gz"`（已在）；jniLibs 沿用 gitignored 目录。

### D2 useLegacyPackaging：false → true（P0 真机 Go/No-Go 1）
- exec 件必须物理落盘 nativeLibraryDir（设计 C3），AGP 侧唯一干净开关是
  `packaging { jniLibs { useLegacyPackaging = true } }`（全局，影响 libnode/libpty）。
- **必须真机验证回归**：legacy=true 后（a）全部 CLI/引擎 `.so` 物理存在；（b）`process.dlopen(libpty_node.so)`
  与 libnode 桥装载仍正常（ensurePtyNative 走绝对路径存在分支，namespace 同目录族）；（c）boot-facts.pty.ready=true、终端与对话不回归。
- 若 dlopen 回归：不硬上。回退评估「split/按库无法分别设 legacy」→ 记录并与用户确认（可能需等消费侧 AAR 方案）。

### D3 首启 tools 物化：Kotlin 侧解包（早于 Node，env 一次到位）
- 在 `PiDesktopRuntime.runBoot` 注入 env **之前**，新增 `CliTools.materialize(context)`：
  从 `assets/cli-tools/<tool>.tar.gz` 解到 `filesDir/node-bridge/cli-tools/<tool>/`，
  以 tarball sha256 为 marker（与 PayloadArchive 同纪律：内容比对、原子落盘、损坏重建）。
- 选择 Kotlin 而非 Node 启动期物化：env（NODE_TOOLS_DIR/PYTHONHOME/…）要在 `rt.start(env)` 时一次性给准，
  Kotlin 侧先就位可避免「首启 env 指向空目录、需重启」竞态；tar 解包可复用新增的极简 tar 读取（无 gzip 原生 API，
  可用 java.util.zip.GZIPInputStream + ustar 解析；或放 Node 首启物化 + 首轮写 marker、env 指向稳定路径后
  由壳脚本惰性自检——**以 P0 探针后实现最简且无竞态者为准，二选一在 tasks 落定**）。

### D4 命令短名暴露：symlink 农场（P0 真机 Go/No-Go 2），备选用绝对入口
- 首选：建 `$HOME/bin/`，为每条命令建符号链接到 nativeLibraryDir 实体；PATH 前置该目录。
  - node/python/pip/git/uv/pnpm 链到各自 `lib<tool>[_cli].so`；npm/npx/corepack 链到同名壳 `libnpm.so` 等。
  - SELinux 对 symlink 只查**目标**标签（apk_data_file 域放行，设计 §4.3）；但本工程历史记录「应用域禁 symlink」，
    故必须先探针（filesDir 与 nativeLibraryDir 两处都试）。
- **备选（探针否决 symlink 时）**，按可行性排序：
  1. mksh `~/.mkshrc` 函数/别名（仅交互终端与 android-exec 常驻 mksh 生效；ptyBash 的 `sh -c` 非交互不读 rc ——
     需在 ptyBash 用 `sh -lc` 或显式 source，评估对 111 已验证路径的最小改动）；
  2. 引导层把「命令名 → 绝对 ELF 路径」映射下发给 ptyBash/android-exec（Node 侧包装），终端交互则依赖 .mkshrc；
  3. 都不成立则只暴露绝对路径 `lib*_cli.so`（体验降级，最后手段，需用户确认）。
- 探针在开发最前期产出结论；C5 命令暴露以探针结论为准，**不得伪造命令可用**（宪法 A6）。

### D5 环境变量契约（进程级注入，三通道全覆盖）
- 注入点：Kotlin `PiDesktopRuntime.runBoot` 的 `env`（D3 物化之后），Node 侧 `pi-web-launch.js` 早期再做
  PATH 合并与 `$HOME/bin` 农场（若 D4 由 Node 建）。terminal-manager/ptyBash/android-exec 均继承，无需逐通道改。
- 变量集（值见 spec C5）：`PATH`、`HOME`、`TMPDIR`（已有，保留）、`NODE_NATIVE_DIR`、`NODE_TOOLS_DIR`、
  `PYTHONHOME`、`PYTHONPATH`、`SSL_CERT_FILE`（python/git 各自 cacert；取 python 一份供 git 亦可，分别设置更稳）、
  `GIT_CONFIG_GLOBAL`、`GIT_TEMPLATE_DIR`、`GIT_EXEC_PATH`（按 gitexec-manifest 实测）、
  `UV_CACHE_DIR`/`XDG_CACHE_HOME`（指 filesDir）、pnpm store（可写 filesDir）。
- git 传输件发现：`libgit_http_fetch.so`/`libgit_remote_curl.so` 与主件同目录（nativeLibraryDir），
  git 经 exec-path/同目录约定发现子命令与 remote-helper；P0 用 `git ls-remote https://…` 实证，必要时补 `GIT_EXEC_PATH`。

### D6 boot-facts 与能力面
- `pi-web-launch.js#writeBootFacts` 增 `cli` 块：对五件做「present（文件在）+ version（`--version` 回程，带超时）」探针；
  结果并入 boot-facts；任一失败结构化 `ready:false/reason`，不阻断主服务（与 pty 同纪律）。
- 探针复用 `/system/bin/sh` spawn（android-exec 已证通道）或直接 child_process 绝对路径；严格超时、输出有界。

### D7 移除纯 JS 替代（补充需求，与 D1–D6 同一提交序列）
- 删 `payload/extensions/android-git/`（isomorphic-git）与 `scripts/sync-git-extension.mjs`；
  删 `payload/extensions/android-pnpm/`（JS bundle 9.15.9）。
- `pi-web-launch.js`：删 `runGitSelftest`/`runPnpmSelftest` 及 main 中调用、其报告写盘函数（仅被二者用的 withTimeout 等评估保留/删）。
- 启动期清理旧物化残留 `$PI_CODING_AGENT_DIR/extensions/{android-git,android-pnpm}`（真实 fs，非 symlink）。
- `env.js`：移除仅服务 harmony-git 的 `PI_HOS_ROOTS` 单源别名（确认无其它消费者后）。
- `scripts/compliance-check.mjs`：删 pnpm.LICENSE/isomorphic-git bundle 在位断言，改登记五个 CLI 的
  LICENSE/THIRD-PARTY-NOTICES 随包来源（LICENSE 文件在解包目录，随 provision 校验登记）。
- `scripts/crop-rules.mjs`：`pnpm-virtual-store` 规则服务于**载荷裁剪**（构建机装 pi-web 依赖产物），与设备 pnpm CLI 无关 → **保留**，仅复核注释不误导。
- CI `.github/workflows/build-release.yml`：移除 `sync-git-extension --check`（若有）；构建前增加
  `provision-cli.mjs --check`（或 CI 下载投放步骤）；区分构建机 pnpm12（装 pi-web，保留）。
- `android-exec.js` promptGuidelines：更新 PATH 可用命令与「无编译器」边界。

### D8 敏感信息纪律（测试用 API Key）
- DeepSeek API Key 仅在真机测试时经交互/一次性 `am`/local 注入，**绝不写入 specs/docs/log 仓库文件**；
- test-cases 用占位符 `<DEEPSEEK_API_KEY>`；测试证据里对 Key/Authorization 头脱敏；不提交抓包含明文。

## 文件变更清单

| 文件 | 改 | 内容 |
|---|---|---|
| `cli.lock.json`（根） | A | 五仓 release/tarball/elf sha+size/tools digest/门禁期望 |
| `scripts/provision-cli.mjs` | A | 下载/校验/投放 jniLibs + assets/cli-tools；`--check` |
| `scripts/verify-cli.mjs` | A | exec ELF 门禁（ET_DYN/PT_INTERP/NEEDED 白名单/16KB/sha） |
| `app/build.gradle.kts` | M | `useLegacyPackaging=true`（P0 回归后）；注释说明 |
| `app/src/main/jniLibs/arm64-v8a/lib*_cli.so`+壳 | A(gitignored) | provision 投放，不入库 |
| `app/src/main/assets/cli-tools/{node,python,git}.tar.gz` | A(gitignored) | provision 生成，不入库 |
| `app/.../payload/CliTools.kt`（新）或 Node 物化 | A | assets/cli-tools → filesDir digest 幂等物化（D3 二选一） |
| `app/.../runtime/PiDesktopRuntime.kt` | M | 调物化；注入 CLI env（PATH/NATIVE/TOOLS/PYTHON/GIT/SSL/UV） |
| `payload/pi-web-launch.js` | M | PATH 合并 + symlink 农场（D4）+ boot-facts.cli；删 git/pnpm selftest；清旧扩展残留 |
| `payload/env.js` | M | 删 harmony-git 单源别名（确认后） |
| `payload/extensions/android-exec.js` | M | 更新 promptGuidelines（PATH 命令清单/无编译器边界） |
| `payload/extensions/android-git/**` | R | 整目录删除（isomorphic-git） |
| `payload/extensions/android-pnpm/**` | R | 整目录删除（JS pnpm） |
| `scripts/sync-git-extension.mjs` | R | 删除 |
| `scripts/compliance-check.mjs` | M | 许可证在位断言改为五 CLI 来源登记 |
| `.github/workflows/build-release.yml` | M | 移除 sync-git 检查；加 provision-cli/verify-cli |
| `docs/安卓环境能力清单-*.md` / README×2 | M | git/pnpm 翻 ✅ 真实二进制；新增 node/python/uv；生态边界 |
| `runtime.lock.json` | — | 不动（引擎锁独立）；cli 另立 cli.lock.json |

## 分阶段（里程碑）

- **P0 探针（Go/No-Go，先于一切改动落代码）**：用最小测试 APK/现有包在真机验证
  ① legacyPackaging=true 物理落盘 + dlopen 不回归；② filesDir/nativeLibraryDir symlink 可建且经链 exec；
  ③ 壳脚本 shebang 在 nativeLibraryDir 可执行；④ git http 传输件发现 + TLS。产出探针报告 → 定 D2/D3/D4 走向。
- **P1 获取/门禁/随包**：cli.lock + provision-cli + verify-cli + jniLibs/assets 投放 → assembleDebug 过 + 门禁绿。
- **P2 运行期引导**：D3 物化 + D5 env + D4 命令暴露 + D6 boot-facts；真机 `--version` 五命令 + git 本地/https 工作流。
- **P3 移除纯 JS**：D7 删除/清理/CI/合规；回归四件套（终端、对话、载荷组装、合规）。
- **P4 验收/取证**：test-cases 全量（CLI 功能 + DeepSeek 对话/看图）；回填能力清单；真机证据归档。

## 风险与兜底
| 风险 | 等级 | 兜底 |
|---|---|---|
| legacyPackaging=true 致 libnode/libpty dlopen 回归 | 高 | P0 先验；不过则暂停并与用户确认，不带病推进 |
| 应用域禁止 symlink | 中高 | P0 探针；D4 备选 .mkshrc/包装/绝对路径 |
| AGP 拒识/不原样解包 sh 壳「.so」 | 中 | P0 验；必要时壳放 node/python 各自 tools 树但需可执行位（受 C1 限制）→ 以实测定 |
| git 远程子命令/CA 发现失败 | 中 | 实证 GIT_EXEC_PATH/SSL_CERT_FILE；https 不过先保本地，远程如实标 ⬜ |
| APK 体积 ~150–170MB | 中 | 记录；动态分发留 M4 |
| python stdlib 数万文件拖慢物化 | 中 | 独立 tar + digest 幂等；实测首启时延，必要时延后到首次使用 |
| 移除 JS 扩展影响旧会话/旧物化 | 低 | 启动清残留 + 版本化 agentDir |
