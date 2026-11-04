# 112-cli-integration — spec（引入 node / python / git / uv / pnpm 真实运行程序）

> 模块规格（需求/验收）。事实权威：node-bridge-workspace `docs/aosp+node+python+git运行方案.md`（2026-10-30 §9 已拍板）；宪法：`specs/constitution.md`。
> 需求编号：`112-cli-integration` ｜ 需求名称：引入 node、python、git 等运行程序
> Git 分支：**不改动**（工作于 `main`，逐阶段提交）
> 本模块仅入 `pi-desktop-android/specs/`，**不**加入父工程 `pi-workspace/specs`。

## 需求（WHAT）

`pi-desktop-android` 在此前 PTY 终端（111）之上，把五个**真实交叉编译二进制 CLI** 随 APK 预置并接入
Agent 运行环境，使终端面板与 Agent 的 `bash`/`ptyBash` 工具里能像 Linux/macOS/Windows 一样直接使用：

| 命令 | 来源仓 | Release 版本 | 提供 |
|---|---|---|---|
| `node`（含 `npm`/`npx`/`corepack`） | `aosp-node-cli` | `v26.13.0` | Node 26.13.0 PIE 可执行 + npm 11.20.0 / corepack 0.36 JS 树 |
| `python`（含 `pip`/`pip3`） | `aosp-python-cli` | `v3.14.10` | CPython 3.14.10（静态扩展）+ pip 26.2.2 + stdlib + CA |
| `git` | `aosp-git-cli` | `v2.56.0` | git 2.56.0（zlib/openssl/curl 全静态）+ http 传输件 + templates + CA |
| `uv` | `aosp-uv-cli` | `v0.13.6` | uv 0.13.6（Rust，rustls 自带根证书） |
| `pnpm` | `aosp-pnpm-cli` | `v12.16.1` | pnpm 12.16.1（Rust 独立二进制，**非** JS 版） |

同时按补充需求，**移除两套纯 JS 替代方案**：

- **isomorphic-git**（`payload/extensions/android-git/`，纯 JS git，单源自 `pi-desktop-hos/harmony-git`）；
- **进程内 JS 版 pnpm**（`payload/extensions/android-pnpm/`，vendored bundle，package.json 自述 pnpm 9.15.9；统称「pnpm v10 内进程 JS 方案」）。

移除后 git / pnpm 一律以真实二进制形态出现（Agent 通过 `bash`/终端直接敲 `git`、`pnpm`），不再提供
isomorphic-git 结构化工具集。

### 第二轮（**本期不落地，仅登记**）

下一轮五仓发布到 **Maven Central** 后，改为 Gradle `runtimeOnly("io.github.fellow99:<cli>:<ver>")`
直接消费 AAR。本期从 **GitHub Release tarball** 获取，经 provision 脚本投放（二进制不入库），并把
目录/命名对齐 AAR 内布局（`jni/arm64-v8a/lib*_cli.so` + `assets/<tool>-bridge-tools/`），使第二轮只改
依赖获取方式、不改运行期引导。

## 背景事实（已勘察，2026-11-04）

- 设备：已连真机 `cd3fac61`（Xiaomi MIX / lithium / Android 11 / arm64）；模拟器备选 `Medium_Phone_API_37.0`。
- 三个命令执行通道**全部继承 Node 进程环境**，故**进程级 `PATH` 注入一处即全覆盖**：
  - 终端面板：`pi-web/lib/terminal-manager.ts#shellEnvironment()` 复制 `process.env`，spawn `/system/bin/sh -l`；
  - `ptyBash`：`payload/extensions/android-pty/index.js` spawn 时显式 `env: process.env`；
  - Agent `bash`：`payload/extensions/android-exec.js` 常驻 `/system/bin/sh`，**不传 env**（继承父进程）。
- exec 型 CLI 与现有 dlopen 库是**两种 ELF 形态**：
  - exec 件：`ET_DYN`(PIE) + **`PT_INTERP=/system/bin/linker64`（必需）** + 16KB 兼容
    （LOAD 段判据：`p_offset ≡ p_vaddr (mod 16KB)`，且 `p_align ≤ 16KB`；不是要求文件大小零填到 16KB）；
  - 五个包的主 CLI/传输件 `DT_NEEDED` 实测**仅系统库**（python 为 libm/libdl/liblog/libz/libc；
    node/git/uv/pnpm 已勘察为系统库集合），**不依赖 `libc++_shared.so`**，因此**不需要为 CLI 注入
    `LD_LIBRARY_PATH`**（引擎的 libnode/libpty 维持现制）。
- 包形态（已解包核实）：
  - node：`libnode_cli.so`(62,155,912B) + shell 壳 `libnpm.so`/`libnpx.so`/`libcorepack.so`
    （壳读 `NODE_TOOLS_DIR`、`NODE_NATIVE_DIR`）+ `node-bridge-tools/{npm,corepack,manifest.json}`；
  - python：tarball 24,288,587B（1,086 文件）；`libpython_cli.so`(15,754,472B，
    sha `1112574a9dceca5c2cf7878a08ebc1fc5eca4914e892c73a10b49d87f6ebb0d6`) + 壳
    `libpip.so`/`libpip3.so`（各 153B，`exec dirname/$0/libpython_cli.so -m pip "$@"`）
    + 外层 `stdlib-assets/`（1,078 文件 / 18,445,260B，内容 `lib/python3.14/**` + `cacert.pem`）
    + `python-cli-release.aar`(12,578,963B，1,223 entries；AAR 内名为
    `assets/python-bridge-tools/`，比外层多 `manifest.json`：132,322B，
    sha `95d3e3305585949974d2788c54ffb3a66b9074ef79477aae3c8c4ff524244361`；
    manifest `fileCount=1078`、`totalSha256=e82f1973c8caa04904acf0a434d0df53b8bca6c83c2bc2d94bc95e41b56a60dc`)；
  - git：`libgit_cli.so`(3,993,328B) + **传输件** `libgit_http_fetch.so`(8,437,504B) /
    `libgit_remote_curl.so`(8,450,536B) + `git-bridge-tools/{templates,cacert.pem,gitexec-manifest.json}`
    （标准 git 子命令经主二进制 argv[0] 分发，**无 146 个 hardlink**——hardlink 清单仅源构建期 inventory）；
  - uv：单文件 `libuv_cli.so`(strip 34,979,336B，sha `c6d9edfd…bcfb1`)，rustls 自带根证书；
  - pnpm：单文件 `libpnpm_cli.so`(47,317,088B，sha `e5378cfa…d98dd`)，运行期需 `node` 在 PATH。
- 包校验（tarball SHA-256，与各 Release `.sha256` 一致）：
  - git `001aae771e11ad50d2298bd3c55f5ce072f08cd2d0abd012cd964745ade0e349`（80,651,789B）
  - node `60d7d89919f93bcb279411ad872ca4babbe023a080a3de4e21c50057d682803f`（46,531,153B）
  - uv `d3bfc4d30b3e950c23aab33d7ba5bded21b7a4fe5d99a73f68a8cedf2cb85b52`（16,146,767B）
  - pnpm `cbd6f3481362afec5626b6f43e3a11c0eafc2bc0ac3454193eb7d407dbf085b6`（22,719,556B）
  - python `b4b90341bfad6bf2e423842fe7bafb49b27d5f0b9585c3581d36b6567757571c`（24,288,587B；
    正确来源为 `fellow99/aosp-python-cli` Release `v3.14.10`，资产
    `python-cli-v3.14.10-android-arm64-v8a.tar.gz`）

### 平台硬约束（设计依据 §2，决定形态）

- **C1**：targetSdk 36 下应用可写数据目录（filesDir）**不可 exec/dlopen**（`neverallow execute:app_data_file`）
  ⇒ CLI 二进制只能进 APK 的 `nativeLibraryDir`，且必须以 `lib*.so` 命名。
- **C2**：禁止运行期下载可执行代码（Play 红线 + 本工作区纪律）⇒ 全部随 APK 预置。
- **C3（关键 Go/No-Go）**：现工程 `useLegacyPackaging=false`（libnode/libpty 从 APK mmap，
  nativeLibraryDir 可能为空壳）；**exec 件必须物理落盘** ⇒ 需切 `useLegacyPackaging=true` 并真机核验
  现有 dlopen 库（libnode/libpty）在该设置下仍正常（dlopen 绝对路径 / namespace 解析）。
- **C4**：shell 壳脚本（`libnpm.so` 等，内容为 `#!/system/bin/sh`）需与二进制同处可执行目录；AGP 对
  jniLibs 中的非 ELF「.so」是否原样解包/通过校验，需真机核验。
- 命令短名（`git`/`node`/…）经 **`$HOME/bin` symlink 农场**指向 nativeLibraryDir 实体（设计 §4.3）；
  但 111 时期 `pi-web-launch.js#listFilesDeep` 有「平台禁止 symlink（应用域 EACCES）」的历史记录——
  **symlink 农场可行性必须真机探针定分晓**，不可行则启用 plan 中的备选（不静默降级）。
- **生态边界（必须如实上报，非缺陷）**：设备无 gcc/make/toolchain ——
  npm 装带原生扩展的包无法 `node-gyp`；pip 装 sdist 无法本地编译；可行域 = 纯 JS / 纯 Python 包 + 预置原生件。

## 能力面与验收

### C1 获取与锁（GitHub Release → 本机投放，二进制不入库）
| 项 | 行为 | 验收 |
|---|---|---|
| provision 脚本 | 新增 `scripts/provision-cli.mjs`：下载/读取五个 Release tarball，校验 tarball SHA-256，按 AAR 布局投放 jniLibs + tools 资产 | `--check` 全绿；SHA 不符 exit 非 0 |
| 单一事实源 | 新增 `cli.lock.json`（工程根，入库）：五仓 release URL / tarball sha256 / 每个 ELF 的 sha256+size / tools manifest digest | 与 runtime.lock.json 同纪律；锁内无任何凭证明文 |
| jniLibs 投放 | `libnode_cli.so`+3 壳、`libpython_cli.so`+2 壳、`libgit_cli.so`+2 传输件、`libuv_cli.so`、`libpnpm_cli.so` → `app/src/main/jniLibs/arm64-v8a/`（gitignored） | `ls` 齐件；`verify-cli.mjs` ELF 门禁过 |
| tools 资产 | npm/corepack、python stdlib+CA、git templates+CA 投放至 gitignored 暂存位，打包进 APK（不进 pi-web.tar.gz） | 见 C3 |

### C2 exec 型 ELF 门禁（区别于 dlopen 库，新增 gate profile）
| 项 | 判据 | 验收 |
|---|---|---|
| 形态 | 每个 `lib*_cli.so`：`ET_DYN`(PIE)、`e_machine=AArch64`、16KB 兼容 LOAD 映射（`p_offset ≡ p_vaddr mod 16KB`） | `verify-cli.mjs` 全过 |
| 解释器 | **`PT_INTERP` 恰 1 且 = `/system/bin/linker64`**（与 dlopen 库「无 PT_INTERP」相反） | 门禁断言 |
| 依赖白名单 | `DT_NEEDED` 仅系统库白名单：`libc.so`/`libm.so`/`libdl.so`/`liblog.so`/`libz.so`；**白名单外 = 失败** | 门禁断言（当前五件无 `libc++_shared.so`/应用内私库） |
| 命名 | `lib<tool>_cli.so`；**严禁与 `libnode.so` 同名**；壳脚本 `lib*.so` 白名单单列 | 无 soname 冲突 |
| SHA | ELF 自身 sha256+size 与 `cli.lock.json` 一致 | 门禁断言 |

### C3 随包与物理落盘（C3/C4 Go-No-Go）
| 项 | 行为 | 验收（真机） |
|---|---|---|
| legacy packaging | `packaging.jniLibs.useLegacyPackaging=true`（exec 件必须落盘） | 装机后 `nativeLibraryDir` **物理存在**全部 `lib*.so` |
| 回归 dlopen | 同设置下 libnode/libpty 仍可装载 | 终端面板可用、`boot-facts.pty.ready=true`、对话正常 |
| tools 资产 | CLI 的 `-bridge-tools/` 经独立 `app/src/main/assets/cli-tools/<tool>.tar.gz`（noCompress gz）随包，**不**并入 27k 文件的 pi-web.tar.gz | `unzip -l apk` 见 assets/cli-tools/*.gz |
| 壳脚本解包 | `libnpm.so`/`libpip.so` 等 sh 壳原样落盘可经 shebang 执行 | 真机 `npm -v`/`pip --version` 回程 |
| APK 体积 | 增量约 150–170MB（node 62 + python 16 + git 21 + uv 35 + pnpm 47，含未压缩对齐） | 记录实测增量；动态特性分发留 M4，不在本期 |

### C4 首启 tools 资产幂等物化
| 项 | 行为 | 验收 |
|---|---|---|
| 独立物化器 | Kotlin 侧（或 Node 启动早期，见 plan 决策）按 manifest digest 把 assets/cli-tools 解到 filesDir 固定根（如 `node-bridge/cli-tools/<tool>/`），digest marker 幂等 | 首启后目录齐、二次启动毫秒跳过；marker 损坏可重建 |
| 目录变量 | 物化根经环境变量暴露：`NODE_TOOLS_DIR=<root>/node`、python stdlib 根、git template/exec 根 | env 实测指向存在目录 |

### C5 环境引导层与命令暴露（核心）
| 项 | 行为 | 验收（真机） |
|---|---|---|
| PATH | Node 启动早期（任何 spawn/终端之前）设 `PATH=<nativeLibraryDir>:<HOME>/bin:<原 PATH 或 /system/bin>`；`HOME`/`TMPDIR` 指 filesDir | 终端与 bash 工具内 `echo $PATH` 含两段 |
| symlink 农场 | `$HOME/bin/{node,npm,npx,corepack,python,pip,pip3,git,uv,pnpm}` → 对应 nativeLibraryDir 实体（P0 探针确认可建） | 建链成功且经链 exec 回程 |
| node 系 env | `NODE_NATIVE_DIR=<nativeLibraryDir>`、`NODE_TOOLS_DIR=<root>/node`（壳脚本依赖） | `node -v`=v26.13.0、`npm -v`=11.20.0、`npx -v`、`corepack --version` |
| python 系 env | `PYTHONHOME=<root>/python`、`PYTHONPATH=<root>/python/lib/python3.14`、`SSL_CERT_FILE=<root>/python/cacert.pem` | `python -V`、`pip --version`、`python -c "import ssl;print(ssl.OPENSSL_VERSION)"` |
| git 系 env | `GIT_CONFIG_GLOBAL=$HOME/.gitconfig`、`GIT_TEMPLATE_DIR=<root>/git/templates`、http 传输件可发现（`GIT_EXEC_PATH` 或同目录约定，按 gitexec-manifest）、`SSL_CERT_FILE=<root>/git/cacert.pem` | `git --version`=2.56.0；本地 init/add/commit/log；`git ls-remote https://…` TLS 成功 |
| uv | 单文件 + 自带根证书；`UV_*` 缓存/数据目录落 filesDir（可写） | `uv --version`、`uv venv`（离线/网络据实记录） |
| pnpm | `pnpm` 在 PATH 且能找到同 PATH 的 `node`（lifecycle scripts） | `pnpm --version`=12.16.1；最小 `pnpm install`（纯 JS 包） |
| boot-facts | 启动事实新增 `cli:{node,python,git,uv,pnpm:{present,version,probeOk}}`；任一缺失/失败**结构化标记 unsupported，绝不伪报可用**（宪法 A6） | boot-facts 落盘，五件真值 |

### C6 Agent 上下文一致（与桌面端用法一致）
| 项 | 行为 | 验收（真机） |
|---|---|---|
| bash 工具 | `android-exec.js` 常驻 shell 继承注入后的 PATH；更新 promptGuidelines（删除「no bash/curl/git/node on PATH」，改为可用清单与无编译器边界） | Agent `bash` 中 `git --version`/`node -v`/`python -V`/`pnpm -v`/`uv --version` 全部回程 |
| ptyBash | `env: process.env` 已透传，无需改逻辑，回归验证 | ptyBash 跑 `git --version` 回程 |
| 终端面板 | 交互敲五命令 + 一次真实 git 工作流 | 见 test-cases 终端用例 |

### C7 移除纯 JS 替代（补充需求）
| 项 | 行为 | 验收 |
|---|---|---|
| 删 isomorphic-git 扩展 | 删 `payload/extensions/android-git/`；删 `scripts/sync-git-extension.mjs`；清 CI（build-release.yml）中 sync/相关步骤；删 launch 的 `runGitSelftest`（git204-lite）与其报告；清 env.js 的 harmony-git 单源别名（如仅它使用） | 组装产物无 android-git；`sync --check` 步骤移除；引用面全清（grep 无残留，历史文档/spec 除外） |
| 删 JS pnpm 扩展 | 删 `payload/extensions/android-pnpm/`；删 launch 的 `runPnpmSelftest`（O8）与其报告；清 TMPDIR 注释中仅服务该 bundle 的表述（TMPDIR 本身保留——CLI 也需要） | 组装产物无 android-pnpm；pnpm 改走 C5 二进制 |
| 旧物化残留 | 启动期清理 filesDir `pi-agent/extensions/{android-git,android-pnpm}`（旧版物化残留，避免扩展被加载） | 升级首启后两目录消失、不再注册其工具 |
| 合规/裁剪脚本 | 更新 `compliance-check.mjs`（移除 pnpm.LICENSE/isomorphic-git bundle 在位断言，改为登记五 CLI 的 LICENSE/THIRD-PARTY-NOTICES 来源）；`crop-rules.mjs` 中 pnpm 载荷裁剪规则按实情保留/调整（区分构建机 pnpm 与设备 CLI） | 合规门禁绿；不引用已删文件 |
| 文档/能力清单 | 回填能力清单：git/pnpm 从「纯 JS 替代 / 已实现未验证」改为「真实二进制 ✅」；node/python/uv 新增 ✅；登记无编译器生态边界 | 能力清单与 README 更新（历史 spec 不改写） |

## 平台边界（A6 如实）
- x86/x86_64/arm32 **不支持**（五仓仅 arm64-v8a，工程本就 arm64-only）。
- 无编译器：node-gyp / sdist 编译 / make / gcc 不可用——能力标志与 promptGuidelines 必须写明，不静默降级。
- `npm i -g` 装出的 CLI 落 filesDir，受 C1 不可直接 exec 且无 `/usr/bin/env`；经 `npx` 或 `node <path>` 调用（设计 §3.1 已知限制，登记入文档）。
- ssh 远程 git（`git@…`）需 openssh/dropbear，**本期不含**；https 远程在本期验收。
- symlink 农场若被真机探针否决：启用 plan 备选并据探针结论调整 C5，不得伪造命令可用。

## 非目标（本期不做）
- 不改 Maven 依赖获取（第二轮）；不做 Play Dynamic Feature 体积分发；不引入 bash/openssh；
  不 fork/修改五个 CLI 上游；不改 pi-web 终端前端；不为 isomorphic-git 保留兼容垫片。
