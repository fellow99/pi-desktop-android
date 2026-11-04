# 112-cli-integration — test-cases

> 依据：`spec.md` C1–C7、`plan.md` P0–P4。目标设备：真机 `cd3fac61`（Xiaomi MIX / Android 11 / arm64-v8a）优先；
> 模拟器仅在真机不可用时作为备选并注明翻译层差异。所有用例初始状态均为 **PENDING**。
>
> **凭据纪律**：DeepSeek API Key 仅在测试运行时临时注入，占位符统一写作 `<DEEPSEEK_API_KEY>`；
> 不得写入命令记录、logcat 证据、截图、报告、提交或本文件。任何 Authorization/key 字段落盘前必须脱敏。

## 测试环境与通用前置

- 设备：`adb devices` 仅选择目标真机 `cd3fac61`；记录 Android 版本、ABI、页面大小能力。
- 构建：`./gradlew :app:assembleDebug`；安装前记录旧 APK 版本与 `filesDir` 是否已有旧扩展残留。
- 二进制：`node scripts/provision-cli.mjs --from <cli-tarballs>` 后执行 `node scripts/verify-cli.mjs` 与 `--check`。
- 三个执行通道定义：
  - **TERM**：Pi Desktop 终端面板，交互式 PTY；
  - **PTY**：Agent 的 `ptyBash` 工具；
  - **EXEC**：Agent 的 `bash` 工具（`android-exec.js` 常驻 `/system/bin/sh`）。
- 版本基线：Node `v26.13.0`、npm `11.20.0`、Python `Python 3.14.10`、pip `26.2.2`、git `2.56.0`、uv `uv 0.13.6`、pnpm `12.16.1`。
- 网络用例单独标记 **NETWORK**；失败时记录 DNS/TLS/代理事实，不得把环境网络故障记成 CLI 缺陷。

---

## A. P0 Go/No-Go 探针（先于正式实现）

### TC-112-P0-001：legacy packaging 物理落盘
- **阶段**：P0 / Build & Install ｜ **通道**：APK + `run-as`
- **前置**：最小探针 APK 或正式 debug APK；`useLegacyPackaging=true`；jniLibs 含五个 CLI、壳脚本、git 传输件及现有引擎库。
- **步骤**：
  1. 安装并启动 App；
  2. 读取 `applicationInfo.nativeLibraryDir`；
  3. `run-as <pkg> ls -l <nativeLibraryDir>`；
  4. 检查 `libnode_cli.so`、`libpython_cli.so`、`libgit_cli.so`、`libgit_http_fetch.so`、`libgit_remote_curl.so`、`libuv_cli.so`、`libpnpm_cli.so`、五个命令壳、`libnode.so`、`libpty_node.so`、`libc++_shared.so`。
- **期望**：全部是物理 regular file；权限/SELinux 上下文允许读/执行所需动作；不是空壳或仅 APK mmap 占位。
- **失败处置**：No-Go；记录 AGP 版本、manifest merge、`extractNativeLibs` 实际值，暂停实现。
- **状态**：PENDING

### TC-112-P0-002：legacy packaging 下现有 Node/PTY dlopen 不回归
- **阶段**：P0 / Regression ｜ **通道**：TERM / boot-facts
- **步骤**：启动 App；读取 `pi-web.boot-facts.json`；打开终端面板；运行 `tty`；执行一次普通对话健康检查。
- **期望**：App 正常启动；Node 服务 ready；`boot-facts.pty.ready=true`；`libnode.so`/`libpty_node.so` 装载成功；终端能分配 `/dev/pts/N`；logcat 无 dlopen/namespace 致命错误。
- **失败处置**：No-Go；不得把 CLI 变更合入；按最小化原则定位 legacy packaging 与库装载关系。
- **状态**：PENDING

### TC-112-P0-003：symlink 农场可行性
- **阶段**：P0 / Platform Probe ｜ **通道**：TERM / PTY / EXEC
- **步骤**：
  1. 在 `$HOME/bin` 建 `node -> <nativeLibraryDir>/libnode_cli.so`（或探针 ELF）；
  2. 如策略允许，再在 `nativeLibraryDir` 相邻可写位置做对照；
  3. 分别经交互 shell、`ptyBash`、非交互 `sh -c` 执行 `$HOME/bin/node -v`；
  4. 记录 `symlink()` errno、SELinux audit、目标标签、`readlink -f`。
- **期望（首选）**：filesDir 下 symlink 创建成功，三通道都能经链接 exec 并输出 Node 版本。
- **备选判定**：若 symlink 被拒，必须明确 errno/avc，并转 D4 备选（`.mkshrc`/包装/绝对路径）重新设计；不得把绝对路径误报为短名可用。
- **状态**：PENDING

### TC-112-P0-004：jniLibs shell 壳脚本原样解包并可执行
- **阶段**：P0 / Platform Probe ｜ **通道**：TERM / EXEC
- **步骤**：检查安装后 `libnpm.so`、`libnpx.so`、`libcorepack.so`、`libpip.so`、`libpip3.so` 的文件头和权限；在正确 env 下执行 `libnpm.so -v`、`libpip.so --version`。
- **期望**：壳文件首行仍为 `#!/system/bin/sh`，未被 AGP 压缩/改写/当 ELF 拒绝；npm 与 pip 版本回程正常。
- **失败处置**：记录具体失败（未解包、无执行位、shebang 被改、exec format error）；决定壳脚本迁移动作并回写 plan D4/C3。
- **状态**：PENDING

### TC-112-P0-005：git HTTP 传输件发现与 TLS
- **阶段**：P0 / Network ｜ **通道**：TERM / EXEC
- **步骤**：配置 `GIT_TEMPLATE_DIR`、CA、必要时 `GIT_EXEC_PATH`；执行：
  - `git --version --build-options`；
  - `git ls-remote https://github.com/fellow99/aosp-python-cli.git v3.14.10`；
  - 另测一个 `https://` 公开只读仓库 HEAD。
- **期望**：版本为 git 2.56.0；HTTPS remote helper 能发现 `libgit_http_fetch.so`/`libgit_remote_curl.so`；TLS 校验成功并返回 ref；CA 文件可被读取。
- **失败处置**：区分传输件发现失败、CA 失败、网络/代理失败；若仅网络不可达，TLS 用本地 httpbin/可控 TLS 服务补测。
- **状态**：PENDING

### TC-112-P0-006：P0 探针报告与方案锁定
- **阶段**：P0 / Evidence
- **步骤**：归档 `logs/<date>-1/P0-PROBE-REPORT.md`、命令回显、logcat、APK 清单、boot-facts；逐项更新 spec/plan/tasks 的最终方案。
- **期望**：四个 Go/No-Go 均有 ✅/❌/备选结论；所有 ⬜ 待验证项被真实证据替换；无凭证明文。
- **状态**：PENDING

---

## B. 获取、锁、ELF 门禁与 APK 随包

### TC-112-B-001：五个 tarball 来源与 SHA 锁定
- **阶段**：P1 / Build
- **步骤**：运行 `provision-cli.mjs --download` 或从已校验缓存 `--from`；比对 lock 中 tarball URL、size、SHA-256。
- **期望**：五个包全部下载/读取成功且哈希一致；网络失败或哈希不符均非零退出；不会写入半成品 jniLibs/assets。
- **状态**：PENDING

### TC-112-B-002：exec ELF 门禁
- **阶段**：P1 / Security Gate
- **步骤**：运行 `verify-cli.mjs`，逐个解析 `libnode_cli.so`、`libpython_cli.so`、`libgit_cli.so`、两个 git 传输件、`libuv_cli.so`、`libpnpm_cli.so`。
- **期望**：均为 ELF64、Little Endian、`ET_DYN`、`e_machine=AArch64`、恰有 `PT_INTERP=/system/bin/linker64`；每个 `PT_LOAD` 满足 `p_offset ≡ p_vaddr (mod 16KB)` 且 `p_align ≤ 16KB`；`DT_NEEDED` 仅在系统库白名单；无 `RPATH/RUNPATH` 指向应用域；size/sha 与 lock 一致。
- **状态**：PENDING

### TC-112-B-003：shell 壳脚本白名单
- **阶段**：P1 / Security Gate
- **步骤**：检查 npm/npx/corepack/pip/pip3 壳脚本内容、参数透传和路径解析。
- **期望**：首行为 `#!/system/bin/sh`；仅调用同目录受锁主二进制；无联网下载、无 `eval` 任意输入、无绝对构建机路径；参数 `"$@"` 正确透传。
- **状态**：PENDING

### TC-112-B-004：独立 tools assets 确定性打包
- **阶段**：P1 / Build
- **步骤**：运行 provision；检查 `app/src/main/assets/cli-tools/{node,python,git}.tar.gz`（如 uv/pnpm 无工具树则不强制生成空包）；重复运行两次。
- **期望**：tar.gz 存在且 noCompress 生效；manifest digest/lock 一致；内容不含 Windows 绝对路径；重复构建字节稳定或 manifest digest 稳定；不进入 `pi-web.tar.gz`。
- **状态**：PENDING

### TC-112-B-005：APK 内容与体积
- **阶段**：P1 / Build
- **步骤**：`./gradlew :app:assembleDebug`；用 `unzip -l`/aapt 检查 APK；记录构建前后 APK、ABI splits、native 与 assets 大小。
- **期望**：`lib/arm64-v8a/` 含全部受锁 CLI/壳/引擎件；`assets/cli-tools/*.tar.gz` 不被 deflate；无 x86/arm32；APK 增量与估算同量级并记录；构建无 jniLibs 校验错误。
- **状态**：PENDING

### TC-112-B-006：未投放/篡改负例
- **阶段**：P1 / Negative
- **步骤**：分别删除一个 ELF、截断一个壳脚本、修改一个 tools tar.gz 后运行 `--check`。
- **期望**：均非零退出且错误能指出具体文件/哈希/门禁；不回写伪成功状态。
- **状态**：PENDING

---

## C. tools 物化、环境变量与命令暴露

### TC-112-C-001：首启物化与幂等
- **阶段**：P2 / Integration
- **步骤**：清除 App 数据后首启；记录 tools 根目录、marker、耗时；正常退出再二启；删除一个文件后三启。
- **期望**：首启解出 node/python/git tools 到 `filesDir/node-bridge/cli-tools/<tool>/`；文件数和 digest 与 manifest 一致；二启跳过解压且耗时毫秒级；三启检测损坏并原子重建；进程无半解压目录可被 CLI 使用。
- **状态**：PENDING

### TC-112-C-002：三通道环境变量一致
- **阶段**：P2 / Integration ｜ **通道**：TERM / PTY / EXEC
- **步骤**：三通道分别执行 `env | sort` 或指定变量检查：`PATH`、`HOME`、`TMPDIR`、`NODE_NATIVE_DIR`、`NODE_TOOLS_DIR`、`PYTHONHOME`、`PYTHONPATH`、`SSL_CERT_FILE`、`GIT_CONFIG_GLOBAL`、`GIT_TEMPLATE_DIR`、`UV_CACHE_DIR`、`XDG_CACHE_HOME`、pnpm store。
- **期望**：三通道值一致且路径存在；`PATH=<nativeLibraryDir>:<$HOME/bin>:...`；缓存/配置目录都位于 App 可写域；没有构建机用户名或绝对路径泄漏。
- **状态**：PENDING

### TC-112-C-003：短名命令在三通道命中
- **阶段**：P2 / Functional ｜ **通道**：TERM / PTY / EXEC
- **步骤**：每个通道运行 `command -v node npm npx corepack python pip pip3 git uv pnpm`。
- **期望**：10 个短名全部解析到预期 symlink/包装；`command -v` 不返回 `/system/bin` 占位；不存在的命令不会被伪报。
- **状态**：PENDING

### TC-112-C-004：boot-facts CLI 结构化探针
- **阶段**：P2 / Integration
- **步骤**：读取 `pi-web.boot-facts.json`；模拟单个 CLI 超时/失败（可通过测试构建或坏路径夹具）。
- **期望**：`cli.node/python/git/uv/pnpm` 各自含 `present`、`version`、`probeOk`、失败 `reason`；单个失败不拖垮 Node 服务；版本来自真实 `--version` 而非硬编码。
- **状态**：PENDING

---

## D. 五个 CLI 功能用例（三通道）

### TC-112-D-001：Node 版本与基础执行
- **通道**：TERM / PTY / EXEC
- **步骤**：`node -v`；`node -p "process.platform + '-' + process.arch"`；`node -e "console.log('ok')"`；检查 `process.execPath`。
- **期望**：版本 `v26.13.0`；`android-arm64`；输出 `ok`；`execPath` 指向安装后的真实 CLI。
- **状态**：PENDING

### TC-112-D-002：npm / npx / corepack
- **通道**：TERM / EXEC
- **步骤**：`npm -v`；`npx -v`；`corepack --version`；在临时工作区运行 `npm init -y`；安装一个纯 JS 小包（离线包优先，否则标记 NETWORK）；运行其 package bin/script。
- **期望**：npm 为 11.20.0；corepack 可执行；npm/npx lifecycle 能找到同 PATH 的 node；全局原生编译不在此用例声称可用。
- **状态**：PENDING

### TC-112-D-003：Python 版本、stdlib 与 SSL
- **通道**：TERM / PTY / EXEC
- **步骤**：
  - `python -V`；`python -c "import sys,platform; print(sys.executable, platform.machine())"`；
  - `python -c "import ssl,sqlite3,json,zlib; print(ssl.OPENSSL_VERSION)"`；
  - 用 stdlib 启一个临时 HTTP client/server（本机 loopback）；
  - 测试 `bz2/lzma/zstd` 若构建元数据声明裁剪，则验证其失败边界与文档一致。
- **期望**：Python 3.14.10；stdlib 路径来自物化 tools；ssl/sqlite/json/zlib 可用；SSL CA 文件存在；被裁剪扩展有清晰 ImportError，不伪报。
- **状态**：PENDING

### TC-112-D-004：pip / pip3
- **通道**：TERM / EXEC
- **步骤**：`pip --version`；`pip3 --version`；`pip list`；在独立 target 目录安装一个纯 Python wheel（离线 wheel 优先，否则 NETWORK）；`python -m pip check`。
- **期望**：pip 26.2.2，绑定 Python 3.14；两个壳行为一致；纯 Python 包可导入；不依赖系统 Python；sdist 编译需求被明确标为不支持。
- **状态**：PENDING

### TC-112-D-005：git 本地工作流
- **通道**：TERM / PTY / EXEC
- **步骤**：在 `$HOME` 下建临时仓库：`git init`、配置本地 user、创建文件、`git add`、`git commit`、`git log`、`git branch test`、`git status`、`git diff`。
- **期望**：三通道均可完成；提交作者/模板配置生效；无 146 hardlink 依赖；退出码与输出符合桌面 git；仓库文件未越界到工作区外。
- **状态**：PENDING

### TC-112-D-006：git HTTPS 远端只读工作流
- **阶段**：NETWORK ｜ **通道**：TERM / EXEC
- **步骤**：`git ls-remote` 公开仓库；浅克隆一个小公开仓库到临时目录；`git fetch --depth=1`；查看 commit SHA。
- **期望**：TLS 证书校验成功；remote-helper 与传输件自动发现；代理环境若存在应透明继承；不关闭 SSL verify；失败能区分认证、网络和证书。
- **状态**：PENDING

### TC-112-D-007：uv 版本、缓存目录与 venv
- **通道**：TERM / EXEC
- **步骤**：`uv --version`；`uv cache dir`；在临时目录 `uv venv`；检查 venv 中 python 入口；离线解析一个本地纯 Python 包（NETWORK 的 `uv pip install` 单独记录）。
- **期望**：uv 0.13.6；缓存/数据目录位于 App 可写域；venv 创建成功且指向包内 Python 3.14；rustls 根证书可用；不因缺少 `/usr/bin/env` 直接失败。
- **状态**：PENDING

### TC-112-D-008：pnpm 版本与纯 JS lifecycle
- **通道**：TERM / PTY / EXEC
- **步骤**：`pnpm --version`；准备最小 `package.json` 与 `preinstall/postinstall` 脚本；用本地 tarball/offline store 安装纯 JS 包；运行 `pnpm exec`/`pnpm run`。
- **期望**：pnpm 12.16.1；Rust CLI 自身不依赖旧 JS bundle；lifecycle 能从 PATH 找到 node 26.13.0；store 在 App 可写域；旧 android-pnpm 扩展不存在且未被加载。
- **状态**：PENDING

### TC-112-D-009：无编译器生态边界
- **阶段**：Boundary / Negative ｜ **通道**：EXEC
- **步骤**：查询 `command -v gcc g++ make cc clang node-gyp`；尝试一个需要原生编译的 npm 包和一个需要编译的 Python sdist（可离线夹具）；读取 Agent promptGuidelines。
- **期望**：系统无编译器被真实呈现；失败原因指向缺少 toolchain，而不是 CLI 损坏；指引明确可行域为纯 JS/纯 Python/wheel/预置原生件；不得承诺 node-gyp/sdist 可用。
- **状态**：PENDING

---

## E. 移除 isomorphic-git 与 JS pnpm 的回归

### TC-112-E-001：源码与载荷无旧扩展
- **阶段**：P3 / Regression
- **步骤**：检查源码树和组装后的 `pi-web` payload：不存在 `extensions/android-git`、`extensions/android-pnpm`；搜索旧入口注册、manifest 引用、selftest 名称。
- **期望**：代码、载荷、manifest、source map 引用均清除；历史 spec/docs 可保留但当前运行产物不包含旧扩展。
- **状态**：PENDING

### TC-112-E-002：旧版升级残留清理
- **阶段**：P3 / Upgrade
- **步骤**：预置 filesDir `pi-agent/extensions/android-git` 与 `android-pnpm` 假目录；安装新 APK 首启。
- **期望**：启动后两目录被删除；工具注册列表无 isomorphic-git/JS pnpm；真实 git/pnpm 仍可用；用户其它 extensions 不被误删。
- **状态**：PENDING

### TC-112-E-003：CI、合规与载荷构建
- **阶段**：P3 / Build
- **步骤**：运行与 CI 等价的 provision/verify、payload assembly、`compliance-check.mjs`、`./gradlew assembleDebug`；检查 workflow 不再调用 `sync-git-extension`。
- **期望**：所有门禁通过；构建机 pnpm12（用于构建 pi-web）与设备 pnpm CLI 被明确区分；许可证/NOTICES 有来源；不要求提交二进制或派生产物。
- **状态**：PENDING

### TC-112-E-004：Agent 工具提示语更新
- **阶段**：P3 / Functional
- **步骤**：让 Agent 查询当前 shell 能使用哪些开发命令；读取 `android-exec.js` 注入的 promptGuidelines。
- **期望**：提示 PATH 中存在 node/npm/npx/corepack、python/pip、git、uv、pnpm；不再声称无 git/node；准确声明无 gcc/make/toolchain 与 SSH 客户端边界。
- **状态**：PENDING

---

## F. Agent + DeepSeek 真机端到端

### TC-112-F-001：运行时注入 DeepSeek 凭据
- **阶段**：P4 / Security
- **步骤**：通过 App 内设置或测试时一次性机制注入 `<DEEPSEEK_API_KEY>`；选择模型 `deepseek-flash`；重启服务后检查配置文件权限。
- **期望**：Key 仅存在于运行时私有存储（建议 0600）；specs/docs/logs/截图/git diff 均无明文；测试结束可清除。
- **状态**：PENDING

### TC-112-F-002：创建工作区
- **阶段**：P4 / E2E
- **步骤**：在 App UI 新建命名工作区；用 Agent/终端确认工作区路径；在其中创建 README。
- **期望**：工作区创建成功，路径位于允许的 App 工作区根；重启后仍可见；文件操作不越界。
- **状态**：PENDING

### TC-112-F-003：普通对话「介绍一下你自己」
- **阶段**：P4 / E2E / NETWORK
- **步骤**：使用 `deepseek-flash` 发送「介绍一下你自己」；观察流式响应与错误状态。
- **期望**：HTTP/流式正常，返回连贯中文自我介绍；无鉴权错误；logcat 不打印 Key；失败时记录请求 ID（脱敏）。
- **状态**：PENDING

### TC-112-F-004：Agent 调用真实 CLI
- **阶段**：P4 / E2E
- **步骤**：要求 Agent 在工作区中运行 `node -v && python -V && git --version && uv --version && pnpm --version`，并总结输出；再要求初始化 git 仓库并提交 README。
- **期望**：Agent 通过 `bash`/`ptyBash` 使用真实二进制，不调用 isomorphic-git 工具；命令输出版本正确；git commit 成功；工具调用日志无凭据泄漏。
- **状态**：PENDING

### TC-112-F-005：看图分析
- **阶段**：P4 / E2E / NETWORK
- **步骤**：选择一张本地非敏感测试图片（例如生成的几何图形/文字图），让模型描述图片内容。
- **期望**：图片上传/多模态请求成功，描述与图中主体一致；临时图片缓存可追踪且不含隐私图片；请求记录脱敏。
- **状态**：PENDING

### TC-112-F-006：终端面板与 Agent 并行回归
- **阶段**：P4 / Regression
- **步骤**：终端面板运行一个短时 foreground 命令时，同时让 Agent 跑 `ptyBash`/`bash`；执行 Ctrl-C、窗口重开和服务重启。
- **期望**：PTY、Agent bash、Node 服务互不串进程；PATH 一致；Ctrl-C 只杀目标进程组；重启后 CLI tools 不需重新解包。
- **状态**：PENDING

---

## G. 终检与证据归档

### TC-112-G-001：全量门禁
- **步骤**：运行 `node scripts/provision-cli.mjs --check`、`node scripts/verify-cli.mjs`、载荷回归、合规检查、`./gradlew :app:assembleDebug`。
- **期望**：全部退出码 0；警告均有解释；无二进制、keystore、`.env`、凭据进入 git。
- **状态**：PENDING

### TC-112-G-002：仓库卫生
- **步骤**：`git status --short`；核对 staged 文件；搜索临时下载、scratch 路径、API Key、绝对用户名路径。
- **期望**：只暂存本会话相关文件；jniLibs CLI、assets/cli-tools、APK/build 目录均未入库；提交遵循 Conventional Commits。
- **状态**：PENDING

### TC-112-G-003：证据与文档回填
- **步骤**：归档真机命令输出、logcat、截图、boot-facts、APK 清单、网络用例结果；更新能力清单/README；历史不明项保留 ⬜ 或改标实测 ✅/❌。
- **期望**：证据能回溯到设备 `cd3fac61` 和版本号；所有 SHA/版本/路径与 lock 一致；无 API Key/Authorization；未实现能力不被标成可用。
- **状态**：PENDING

---

## 建议执行序

1. **P0**：TC-112-P0-001 → P0-006；任一 No-Go 先更新方案并暂停确认。
2. **P1**：TC-112-B-001 → B-006，先保证锁、门禁、APK 随包正确。
3. **P2**：TC-112-C-001 → D-009，验证物化、三通道和五 CLI 功能/边界。
4. **P3**：TC-112-E-001 → E-004，移除旧 JS 替代并做升级/CI 回归。
5. **P4**：TC-112-F-001 → G-003，完成 DeepSeek Agent E2E、终检、证据归档。
