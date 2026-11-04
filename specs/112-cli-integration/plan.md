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

### D2 useLegacyPackaging：false → true —— ✅ P0 已实证安全（GO）
- exec 件必须物理落盘 nativeLibraryDir（设计 C3），AGP 侧唯一干净开关是
  `packaging { jniLibs { useLegacyPackaging = true } }`（全局，影响 libnode/libpty）。
- **P0 结论（2026-11-04，报告 logs/2026-11-04-1）**：legacy=true 后（a）全部 15 件 `.so`/壳物理存在且长度一致；
  （b）按序 `System.loadLibrary("c++_shared"→"node"→"pty_node")` 全成功（引擎无 JNI_OnLoad，等价纯 dlopen，
  libpty 的 NEEDED libnode/libc++ 链解析正常）——**否决项未触发**。APK 内 lib 仍 DEFLATED，安装期解压。
- 遗留：终端面板/boot-facts/PTY 的端到端不回归在 P2 正式接线后验；原生 arm64 真机（小米 MIX）在 P4 复跑。

### D3 首启 tools 物化：Kotlin 侧解包（早于 Node，env 一次到位）
- 在 `PiDesktopRuntime.runBoot` 注入 env **之前**，新增 `CliTools.materialize(context)`：
  从 `assets/cli-tools/<tool>.tar.gz` 解到 `filesDir/node-bridge/cli-tools/<tool>/`，
  以 tarball sha256 为 marker（与 PayloadArchive 同纪律：内容比对、原子落盘、损坏重建）。
- 选择 Kotlin 而非 Node 启动期物化：env（NODE_TOOLS_DIR/PYTHONHOME/…）要在 `rt.start(env)` 时一次性给准，
  Kotlin 侧先就位可避免「首启 env 指向空目录、需重启」竞态；tar 解包可复用新增的极简 tar 读取（无 gzip 原生 API，
  可用 java.util.zip.GZIPInputStream + ustar 解析；或放 Node 首启物化 + 首轮写 marker、env 指向稳定路径后
  由壳脚本惰性自检——**以 P0 探针后实现最简且无竞态者为准，二选一在 tasks 落定**）。
### D4 命令短名暴露 —— ✅ P0 已锁定：纯 PIE 用 symlink，壳类（pip）用包装脚本
- 已证 `android.system.Os.symlink` 在 App 私有 filesDir 可用（无 SELinux 拒绝），建两层：
  1. `$HOME/bin/`（PATH 前置）：`node`/`python`/`git-cli`/`uv`/`pnpm-bin` 直接 symlink 到 nativeLibraryDir 的纯 PIE 主件；
     `npm`/`npx`/`corepack` 可 symlink（壳读 `NODE_NATIVE_DIR` 兜底，已验 `npm=11.20.0`）。
  2. `filesDir/gitexec/`：严格按 `assets/git-bridge-tools/gitexec-manifest.json#farm` 建 8 链接（git* → libgit_cli/libgit_remote_curl），`GIT_EXEC_PATH` 指向它。
- **硬约束（P0 实测 code=127）**：`libpip.so` 壳写死 `exec "$(dirname "$0")/libpython_cli.so" -m pip "$@"`，**不读 env**；
  经 `$HOME/bin/pip` symlink 调用时 `$0` 落在链接目录 ⇒ 找不到主件。故 `pip`/`pip3`（以及任何 dirname 相对定位的壳）
  短名必须由 Kotlin **生成绝对路径包装脚本**并 `chmod 755`（已验 `pip 26.2.2`）。纯 PIE 主件无此问题。
- **幂等**：重装后 nativeLibraryDir 路径变化会使旧链接悬空，`File.exists()` 对 dangling link 返回 false；
  必须对每个短名/农场名**无条件 `delete()` 后重建**（`File.delete()` 删链接本身，不跟随目标），否则 `Os.symlink errno=17 EEXIST`。
- 备选（.mkshrc / Node 侧命令映射 / 仅绝对路径）经 P0 判定**不需要**，留作未来某机型 SELinux 收紧时的退路，不在本期实现。
- 纪律：C5 命令暴露以 P0 实证为准，**不得伪造命令可用**（宪法 A6）。

### D5 环境变量契约（进程级注入，三通道全覆盖）
- 注入点：Kotlin `PiDesktopRuntime.runBoot` 的 `env`（D3 物化之后），Node 侧 `pi-web-launch.js` 早期再做
  PATH 合并与 `$HOME/bin` 农场（若 D4 由 Node 建）。terminal-manager/ptyBash/android-exec 均继承，无需逐通道改。
- 变量集（P0 校准，值见 spec C5）：`PATH`（`$HOME/bin` 前置）、`HOME`、`TMPDIR`（已有，保留）、
  `NODE_NATIVE_DIR=<nativeDir>`、`NODE_TOOLS_DIR=<tools>/node-bridge-tools`、
  **`PYTHONHOME=<tools>/python-bridge-tools`（其下标准布局 lib/python3.14 + site-packages），不设 PYTHONPATH**、
  `LD_LIBRARY_PATH=<nativeDir>`、`SSL_CERT_FILE=<tools>/python-bridge-tools/cacert.pem`、
  `GIT_SSL_CAINFO=<tools>/git-bridge-tools/cacert.pem`、`GIT_TEMPLATE_DIR=<tools>/git-bridge-tools/templates`、
  **`GIT_EXEC_PATH=<filesDir>/gitexec`（已验必需，农场 8 链接）**、
  `GIT_CONFIG_GLOBAL`（指 filesDir）、`UV_CACHE_DIR`/`XDG_CACHE_HOME`（指 filesDir；uv 用 rustls 自带根证书，不依赖 SSL_CERT_FILE）、pnpm store（可写 filesDir）。
- P0 实测：仅设 PYTHONPATH 会令 python 报 “Could not find platform independent libraries <prefix>”（虽 exit 0）；
  设 PYTHONHOME 后 `ssl/sqlite3/zlib/hashlib` 干净可用（OpenSSL 3.5.9 / sqlite 3.54.1）。git 传输件经 GIT_EXEC_PATH 农场解析，`ls-remote` TLS 成功。

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

- **P0 探针（Go/No-Go）—— ✅ 已完成（2026-11-04），结论 GO（22/22）**：模拟器（Android17/API37 x86_64+arm64 翻译）实测
  ① legacyPackaging=true 物理落盘 + 引擎 dlopen 不回归；② filesDir symlink 可建且经链 exec（纯 PIE）；
  ③ 壳 shebang 原样可执行（pip 短名须包装脚本）；④ git exec-path 农场 + HTTPS/TLS 成功。报告 `logs/2026-11-04-1/`。
  遗留：真机 cd3fac61（MIUI 人工安装门）原生 arm64 内核回归并入 P4。
- **P1 获取/门禁/随包**：cli.lock + provision-cli + verify-cli + jniLibs/assets 投放 → assembleDebug 过 + 门禁绿。
- **P2 运行期引导**：D3 物化 + D5 env + D4 命令暴露 + D6 boot-facts；真机 `--version` 五命令 + git 本地/https 工作流。
- **P3 移除纯 JS**：D7 删除/清理/CI/合规；回归四件套（终端、对话、载荷组装、合规）。
- **P4 验收/取证**：test-cases 全量（CLI 功能 + DeepSeek 对话/看图）；回填能力清单；真机证据归档。

## 风险与兜底
| 风险 | 等级 | 兜底 |
|---|---|---|
| ~~legacyPackaging=true 致 libnode/libpty dlopen 回归~~ | ~~高~~ | ✅ P0 已证不回归（c++→node→pty 顺序装载成功） |
| ~~应用域禁止 symlink~~ | ~~中高~~ | ✅ P0 已证 filesDir 可 symlink；pip 壳改用绝对路径包装脚本；备选保留 |
| ~~AGP 不原样解包 sh 壳 `.so`~~ | ~~中~~ | ✅ P0 已证 shebang 保留、可执行；须覆写 ignoreAssetsPattern 保 dot 文件 |
| ~~git 远程子命令/CA 发现失败~~ | ~~中~~ | ✅ P0 已证 GIT_EXEC_PATH 农场 + GIT_SSL_CAINFO，ls-remote TLS 成功 |
| APK 体积 ~150–170MB（探针 debug APK 已达 ~140MB） | 中 | 记录；动态分发留后续 |
| ~~python stdlib 数万文件拖慢物化~~ | ~~中~~ | ✅ 实测 2710 文件约 4.5s；digest marker 幂等，二启跳过 |
| 移除 JS 扩展影响旧会话/旧物化 | 低 | 启动清残留 + 版本化 agentDir |
