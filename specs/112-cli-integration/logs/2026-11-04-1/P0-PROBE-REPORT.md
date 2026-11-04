# P0 真机 Go/No-Go 探针报告（specs/112-cli-integration）

- 日期：2026-11-04
- 执行环境（首选真机受阻，回退模拟器——见 §6）：
  - **实跑设备**：Android Emulator `Medium_Phone_API_37.0`
    - Android **17 / API 37**；内核 `6.12.81-android16-6`
    - 宿主 ABI `x86_64`，`ro.product.cpu.abilist = x86_64,arm64-v8a`（系统内置 arm64 翻译层，arm64-v8a APK 可装可跑）
    - 内核页大小：`getconf PAGE_SIZE = 4096`；`ro.product.cpu.pagesize.max = 16384`
  - **目标真机**（未完成安装）：小米 MIX（`cd3fac61`），Android **8.0.0 / API 26**，`arm64-v8a`，4KB 页
- 探针工程（一次性，不入库）：`<scratch>/p0-probe/`
  - AGP 8.10.1 / Gradle 8.12 / compileSdk 36 / minSdk 24 / `ndk abiFilters = arm64-v8a`
  - 关键开关：`packaging.jniLibs.useLegacyPackaging = true`（即 `extractNativeLibs=true`）
  - 打入：现有引擎三件（`libnode.so` 81,491,624B / `libpty_node.so` 90,816B / `libc++_shared.so` 1,253,544B）
    + 五个真实 CLI 的全部主 ELF/壳 + node/python/git 工具树（assets/cli-tools/**，共 2710 文件随包）
- 制品版本：node 26.13.0（npm 11.20.0 / corepack）· python 3.14.10（pip 26.2.2 / OpenSSL 3.5.9）· git 2.56.0 · uv 0.13.6 · pnpm 12.16.1
- 结果：**22/22 PASS，0 FAIL**（App 真实进程上下文）

---

## 1. 五项风险裁决（对应 test-cases.md A 段 P0-1…P0-5）

| 风险 | 结论 | 真机证据 |
|---|---|---|
| **P0-1** legacy packaging 物理落盘 | ✅ GO | `useLegacyPackaging=true` 后全部 `.so`（含 358B/153B 壳）物理解压到 `nativeLibraryDir=/data/app/~~…/lib/arm64`；主 ELF 长度与投放一致（libnode.so=81491624B、libnode_cli.so=62155912B）。`File.canExecute()=true`（`setExecutable()` 对系统目录返回 false 但安装器已置可执行位，不影响 exec）。|
| **P0-2** 现有引擎 dlopen 不回归 | ✅ GO | 在 legacy 落盘布局下按依赖顺序 `System.loadLibrary("c++_shared"→"node"→"pty_node")` 全部成功（引擎无 `JNI_OnLoad`，等价纯 dlopen 依赖解析；`libpty_node.so` DT_NEEDED 含 `libnode.so`+`libc++_shared.so`，链解析正常）。|
| **P0-3** filesDir symlink 农场 | ✅ GO | `android.system.Os.symlink` 在 App 私有 `filesDir` 下可用，无 SELinux 拒绝：git exec-path 农场 8 个原名（git/git-upload-pack/git-receive-pack/git-upload-archive/git-remote-http/https/ftp/ftps）→ 3 物理件；`$HOME/bin` 短名一批，均成功。|
| **P0-4** shebang 壳原样落盘可执行 | ✅ GO（含一条硬约束，见 §3）| 壳首字节保持 `#!/system/bin/sh`，可执行位就绪；npm 壳经短名调用 `npm --version → 11.20.0`；pip 经**包装脚本**调用 `pip 26.2.2 … (python 3.14)`。|
| **P0-5** git http 传输件发现 + HTTPS/TLS | ✅ GO | `git --exec-path` 指向农场；`git ls-remote --heads https://github.com/fellow99/aosp-python-cli.git` 返回 `459b4f18… refs/heads/main`（静态链接 curl 8.23 + OpenSSL 3.5，经 `libgit_remote_curl.so` 走 TLS，系统 `git-remote-https` 农场解析成功）。|

## 2. 五 CLI 冒烟与裁剪边界（全 PASS）

- `node --version = v26.13.0`；`npm --version = 11.20.0`
- python：`PYOK 3.14.10 OpenSSL 3.5.9 (29 Sep 2026) 3.54.1(sqlite)` —— `ssl` / `sqlite3` / `zlib` / `hashlib` 可用，**PYTHONHOME 正确配置下无 prefix 警告**
- `uv --version = uv 0.13.6 (aarch64-linux-android)`（rustls 自带根证书）
- `pnpm --version = 12.16.1`（standalone 经 PATH 找到真实 node）
- `git --version = git version 2.56.0`
- 裁剪边界（**如实记录为能力边界**，非缺陷）：
  - `import _bz2` → `ModuleNotFoundError`（构建声明 `prunedModules=_bz2,_lzma,_zstd`）
  - `import ctypes` → 失败：static-first 构建**未内置 `_ctypes`**（离线符号表确证主 ELF 无 `PyInit__ctypes`；stdlib 树内零 `.so`、无 lib-dynload）
  - 符号表静态内置证据：主 ELF 含 `PyInit__ssl` / `PyInit__sqlite3` / `PyInit__hashlib`；无 `PyInit__ctypes`/`__bz2`/`__lzma`/`__zstd`
- 物化性能：assets 工具树 2710 文件 → filesDir，约 4.5s（幂等由 digest marker 控制，二启跳过）

## 3. P0 暴露并锁定的实现约束（直接回写 plan D2/D3/D4）

1. **Python 环境变量（D-ENV）**：必须设
   `PYTHONHOME=<tools>/python-bridge-tools`（其下为标准布局 `lib/python3.14`、`lib/python3.14/site-packages`），
   **不要设 PYTHONPATH**；并设 `SSL_CERT_FILE=<tools>/python-bridge-tools/cacert.pem`、`LD_LIBRARY_PATH=<nativeDir>`。
   仅设 PYTHONPATH 虽能 exit=0，但会打印 “Could not find platform independent libraries <prefix>” 且前缀错误。
2. **短名层不能对 pip 壳用 symlink（D4 关键）**：`libpip.so` 壳写死 `exec "$(dirname "$0")/libpython_cli.so" -m pip "$@"`，**不读任何环境变量**。
   经 `$HOME/bin/pip` 符号链接调用时 `$0` 解析到链接目录，报 `.../home/bin/libpython_cli.so: not found`（实测 code=127）。
   → pip/pip3 短名必须由 Kotlin **生成内容为绝对路径的包装脚本**（`exec "<nativeDir>/libpython_cli.so" -m pip "$@"`）并 `chmod 755`。
   - 对照：node 壳 `libnpm.so` 用 `${NODE_NATIVE_DIR:-$(dirname "$0")}`，有环境变量兜底，symlink 也能跑；但为统一性，壳类短名建议都走包装脚本。
   - 纯 PIE（node/uv/pnpm/git/python 主件）symlink 无此问题，可直接链。
3. **幂等重建必须能清“悬空符号链接”**：重装后 `nativeLibraryDir` 路径变化，旧 symlink 会 dangling；
   `File.exists()` 对 dangling link 返回 **false**，用它做删除判据会漏删导致 `Os.symlink errno=17 EEXIST`。
   → 物化/建链时对短名与农场名**无条件 `delete()` 后重建**（`File.delete()` 删的是链接本身，不跟随目标）。
4. **aapt dot 文件保留（D-PACK）**：npm 树含 `.npmrc`/`.travis.yml`/`.release-please-manifest.json` 等 dot 文件，
   必须覆写 `androidResources.ignoreAssetsPattern` 去掉默认 `.*` token，否则被静默丢弃（实测安装包内保留成功）。
5. **打包压缩**：`useLegacyPackaging=true` 下 APK 内 `lib/*.so` 仍为 DEFLATED，安装期物理解压；
   `.tar.gz`/`pem`/`py`/`js`/`json` 走 `noCompress`（gz 已压缩；文本 noCompress 便于 fd 直读与逐文件物化）。
6. git exec-path 农场严格按 `assets/git-bridge-tools/gitexec-manifest.json#farm` 建 8 链接，`GIT_EXEC_PATH=<filesDir>/gitexec`，
   另需 `GIT_SSL_CAINFO=<tools>/git-bridge-tools/cacert.pem`、`GIT_TEMPLATE_DIR=<tools>/git-bridge-tools/templates`。

## 4. 16KB 页对齐离线门禁（全 PASS）

判据：每个 `PT_LOAD` 满足 `p_offset ≡ p_vaddr (mod 0x4000)` 且 `p_align ≤ 0x4000`。

| ELF | 结果 | 备注 |
|---|---|---|
| libnode_cli.so / libgit_cli.so / libgit_http_fetch.so / libgit_remote_curl.so / libuv_cli.so / libpnpm_cli.so / libpython_cli.so | PASS | 全部 `p_align=0x4000`、各段 delta=0 |
| 现有引擎 libnode.so（回归基准） | PASS | 同样 0x4000 对齐 |

设备当前为 4KB 页（`PAGE_SIZE=4096`），但内核声明支持上限 16KB（`cpu.pagesize.max=16384`）；交付 ELF 已满足 16KB 约束，未来 16KB-only 镜像/真机不需要重编。

## 5. 结论（Go/No-Go）

**GO**：五项风险全部通过，方案主轴成立——`useLegacyPackaging=true` 物理落盘 + 引擎 dlopen 不回归 + filesDir symlink 农场 + 壳/PYTHONHOME 按 §3 约束处理 + git 静态 TLS 可用。P1 可按 plan 进入 `cli.lock.json` / `verify-cli.mjs` / `provision-cli.mjs` 与打包接线。

## 6. 真机受阻说明（硬件/人工门，按规范显式记录）

- 目标真机小米 MIX（Android 8）侧载返回 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`——MIUI 需在手机屏幕人工确认“USB 安装/继续安装”，当前无人值守无法点击（设备 `adb_install=1` 但仍弹系统确认）。
- 回退到 Android 17 API 37 官方 x86_64（含 arm64 翻译）模拟器完成全部 App 上下文实测；**P1 完成后具备真机条件时，须在小米 MIX 上复跑 A 段 P0 用例做原生 arm64 内核回归**（翻译层与原生内核在 exec/mmap/SELinux 路径上仍可能有差异），本项保留为待办，不以模拟器结果替代真机签收。
- 本机 arm64 系统镜像 AVD（`python_arm64_api35`）无法在 x86_64 宿主 QEMU2 直接启动（`Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host`），故选用带 arm64 翻译的 x86_64 镜像。

## 7. 复现方式

1. 探针源在 `<scratch>/p0-probe/`（AGP 8.10.1，`useLegacyPackaging=true`）；制品取自 `<scratch>/cli-pkgs/x-*`。
2. `./gradlew :app:assembleDebug` → 安装启动后自动物化并裁决，报告写设备 `files/P0-PROBE-REPORT.txt`，logcat tag=`P0PROBE`。
3. 本次设备 logcat 存档：`P0-PROBE-REPORT-device.txt`（同目录）。
