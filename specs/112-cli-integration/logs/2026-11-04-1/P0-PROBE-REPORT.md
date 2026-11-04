# P0 Go/No-Go 五 CLI 探针报告（specs/112-cli-integration）

- 日期：2026-11-04
- 执行方式：首选真机受 MIUI 人工安装门阻塞，按用户指令先用模拟器；原生 arm64 真机回归保留到 P4。
- 实跑设备：Android Emulator `Medium_Phone_API_37.0`
  - Android **17 / API 37**；内核 `6.12.81-android16-6`
  - 宿主 ABI：`x86_64`；`ro.product.cpu.abilist=x86_64,arm64-v8a`
  - arm64 执行：系统翻译层 `libndk_translation.so`
  - 页大小：App `/proc/self/auxv` 读取 `AT_PAGESZ=4096`；系统支持上限 `ro.product.cpu.pagesize.max=16384`
- 未完成真机：小米 MIX（serial `cd3fac61`），Android **8.0.0 / API 26**，`arm64-v8a`，4KB 页；侧载报 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`。
- 一次性探针工程：`<scratch>/p0-probe/`（不入库）
  - AGP 8.10.1 / Gradle 8.12 / compileSdk 36 / minSdk 24 / targetSdk 26 / `ndk.abiFilters=arm64-v8a`
  - `packaging.jniLibs.useLegacyPackaging=true`
  - 15 个 jniLibs：Node 引擎 3 件 + 五个 CLI 主 ELF/传输 ELF/壳
  - 3 份工具树 assets：node 2028 tar 条目、git 47 tar 条目、python 1212 tar 条目（其中 Python 为 1078 个文件 + 134 个目录）
- 探针 APK：121,695,971B，SHA-256 `761a34dc17e32e290ff8340588a443b75fb6ad21a429ecb1f6cf0780d2151c75`
- 设备端结论：**22/22 PASS，0 FAIL**。原始日志见 [P0-PROBE-REPORT-device.txt](P0-PROBE-REPORT-device.txt)；离线 ELF 结果见 [P0-ELF-GATE.json](P0-ELF-GATE.json)。

---

## 1. 六项 P0 打包/运行风险裁决

| 用例 | 结论 | 证据 |
|---|---|---|
| P0-1 legacy packaging 物理落盘 | ✅ GO | 15 个预期文件均在 `nativeLibraryDir=/data/app/.../lib/arm64`，`File.canExecute()=true`。APK 内 `lib/*.so` 可保持 DEFLATED，安装期由系统物理解压。 |
| P0-2 现有 Node 引擎 dlopen 不回归 | ✅ GO | App 真实进程按 `c++_shared → node → pty_node` 顺序 `System.loadLibrary` 全部成功。离线解析显示引擎无 `JNI_OnLoad`，`libpty_node.so` 对 `libnode.so`/`libc++_shared.so` 的 DT_NEEDED 可解析。 |
| P0-3 assets 工具树物化 | ✅ GO | 三份工具树经 App 内 `/system/bin/tar` 解到 `filesDir/cli-tools`；最终物化 **2710 个文件**，本次耗时 1,797ms（前次运行 922ms/1,494ms，受翻译层和调度影响）。 |
| P0-4 dotfile 与 shell shebang 保留 | ✅ GO | `node-bridge-tools/npm/.npmrc` 存在；`libnpm.so` 首 16 字节保持 `#!/system/bin/sh`。AGP 会把 noCompress 的 `.tar.gz` 安装包条目改名为 `.tar`，App 按实际 `.tar` 条目读取。 |
| P0-5 短名 symlink + pip 包装脚本 | ✅ GO | `filesDir/home/bin` 建立 node/npm/npx/corepack/python/git/uv/pnpm 短名；gitexec 建立 8 个农场链接。pip/pip3 因上游壳硬编码 `dirname "$0"`，由 App 生成绝对路径包装脚本并置可执行位。 |
| P0-6 git manifest 农场完整性 | ✅ GO | 严格按 `gitexec-manifest.json#farm` 创建 `git`、`git-upload-pack`、`git-receive-pack`、`git-upload-archive`、`git-remote-http/https/ftp/ftps`，设备端 8/8 存在。 |

## 2. 五 CLI 真机/模拟器冒烟结果

全部在 App 进程 `ProcessBuilder` 下执行，环境变量由探针显式注入：

| CLI/能力 | 结果（设备日志原文摘要） |
|---|---|
| Node | `node --version → v26.13.0` |
| npm | `npm --version → 11.20.0` |
| npx | `npx --version → 11.20.0` |
| Corepack | `corepack --version → 0.36.0` |
| Python | `python --version → Python 3.14.10` |
| Python SSL/SQLite/zlib | `OpenSSL 3.5.9 29 Sep 2026 3.54.1`；同一命令同时 `import ssl,sqlite3,zlib` 成功，另测 SQLite 版本后缀 `3.54.1` |
| pip | `pip 26.2.2 from .../python-bridge-tools/lib/python3.14/site-packages/pip (python 3.14)` |
| uv | `uv 0.13.6 (aarch64-linux-android)` |
| pnpm | `pnpm --version → 12.16.1` |
| git | `git version 2.56.0` |
| git 本地仓库 | `init → add → commit → log --oneline` 全部 exit=0，日志可见提交 `556139c p0` |
| git HTTPS/TLS | `git ls-remote --heads https://github.com/fellow99/aosp-python-cli.git` exit=0，返回 `459b4f18... refs/heads/main` |

## 3. P0 锁定的产品实现约束

1. **`useLegacyPackaging` 必须开启**：exec 型 PIE 虽以 `.so` 投放，但需要安装器物理解压到可执行路径；P0 同时证明 Node 引擎三件在该布局下 dlopen 不回归。
2. **重装后必须无条件重建 symlink/包装脚本**：重装会改变 `nativeLibraryDir`，旧链接可能悬空；`File.exists()` 对 dangling symlink 返回 false，不能作为唯一删除判据。统一先 `File.delete()` 再 `Os.symlink`/写 wrapper。
3. **pip/pip3 不能复用上游壳的短名 symlink**：上游 `libpip.so` 固定执行 `"$(dirname "$0")/libpython_cli.so" -m pip`，不读环境变量；产品必须生成：
   ```sh
   #!/system/bin/sh
   exec "<nativeLibraryDir>/libpython_cli.so" -m pip "$@"
   ```
4. **Node shell 壳可经短名 symlink 使用**：`libnpm.so`/`libnpx.so`/`libcorepack.so` 支持 `NODE_NATIVE_DIR` 与 `NODE_TOOLS_DIR`；P0 已验证 npm/npx/corepack。
5. **Python 只设 `PYTHONHOME`，不设 `PYTHONPATH`**：`PYTHONHOME=<filesDir>/cli-tools/python-bridge-tools`，并设置 `SSL_CERT_FILE=<tools>/python-bridge-tools/cacert.pem`、`LD_LIBRARY_PATH=<nativeLibraryDir>`；P0 下无 prefix 警告。
6. **git 必须使用 exec-path 农场**：设置 `GIT_EXEC_PATH=<filesDir>/gitexec`、`GIT_TEMPLATE_DIR=<tools>/git-bridge-tools/templates`、`GIT_SSL_CAINFO=<tools>/git-bridge-tools/cacert.pem`。
7. **AAPT dotfile 约束**：npm 树包含 `.npmrc`、`.travis.yml`、`.release-please-manifest.json` 等；产品构建需清空默认 `ignoreAssetsPattern`，不能让 `.*` 规则静默丢文件。
8. **AGP assets 后缀行为**：对 noCompress 的 `.tar.gz`，AGP `compressDebugAssets` 产出条目可能剥离为 `.tar`。P1 可直接以 `.tar` 作为确定性 assets 包名，或在自定义打包任务中绕过该改名行为；消费端必须以实际 APK 条目为准。

## 4. 离线 ELF / 16KB 门禁

解析器：`<scratch>/elf_gate.py`（纯 Python ELF64 解析，无 `readelf` 依赖）。门禁结果：

- ELF 总数：10（5 个 shell 型 `.so` 不按 ELF 处理）
- 10/10：`e_type=ET_DYN(3)`、`e_machine=AArch64(183)`
- 10/10：所有 `PT_LOAD` 满足 `p_align=0x4000` 且 `(p_offset - p_vaddr) mod 0x4000 = 0`
- 7 个 exec 型 CLI ELF：均恰有 `PT_INTERP=/system/bin/linker64`
- 3 个引擎共享库：无 `PT_INTERP`、无 `JNI_OnLoad`，符合 dlopen 共享库形态
- CLI 主 ELF 的 DT_NEEDED 均仅引用系统白名单：`libc.so`、`libm.so`、`libdl.so`、`liblog.so`、`libz.so`；CLI 不直接依赖 `libc++_shared.so`
- 5 个 shell 型 `.so`（`libnpm.so`、`libnpx.so`、`libcorepack.so`、`libpip.so`、`libpip3.so`）首行均为 `#!/system/bin/sh`

关键哈希：

| 文件 | 大小（B） | SHA-256 |
|---|---:|---|
| `libnode_cli.so` | 62,155,912 | `eb51b439d2a8164bc2e4be233b9a363b6def736a000feb432ce72702ee28b86c` |
| `libpython_cli.so` | 15,754,472 | `1112574a9dceca5c2cf7878a08ebc1fc5eca4914e892c73a10b49d87f6ebb0d6` |
| `libgit_cli.so` | 3,993,328 | `171716839caf1f2c4767c28792b9abb4cf79a6d71cc4155aa1f53cbc81ae8bab` |
| `libgit_http_fetch.so` | 8,437,504 | `cf0fcc2aaecf134314284189434f5ee43186e1c96a5af546b4f60c04734f35d0` |
| `libgit_remote_curl.so` | 8,450,536 | `fc25b57e645b5ff04d307818583232657be13b9f0fa3e15d822917b5286afe27` |
| `libuv_cli.so` | 34,979,336 | `c6d9edfd1642e03fde1308b91ad4f57382a1925f38f0b83da0063b4ddaabcfb1` |
| `libpnpm_cli.so` | 47,317,088 | `e5378cfacefa35b117ee7a54ebf6160ebf0e8c0a96ace4d5673ffcc2913d98dd` |
| `libnode.so`（引擎） | 81,491,624 | `be1d16414a1e68983f27ac16e287395b71e4f4f5a79d78a78a741b583472397e` |
| `libpty_node.so`（引擎） | 90,816 | `b965c62d8ab066d8d5b290c34c924b597699aaaa94ea4dabb6eedad414077a93` |
| `libc++_shared.so`（引擎） | 1,253,544 | `cd61762848882a16c8244c964a6f396c0caa0b440588a210ce9cc4ab0e6d9f0c` |

> 注：本轮模拟器是 4KB 页上的 arm64 翻译环境，不能替代原生 arm64 16KB-only 设备签收；但离线 ELF 门禁已先证明所有交付件满足 16KB 对齐要求。

## 5. 已知边界与 P4 遗留

- 小米 MIX 的 MIUI 人工安装门仍阻塞；P4 获得屏幕授权后，必须在原生 arm64 Android 8 内核复跑本报告 P0-1…P0-6 与五 CLI 冒烟。
- 本轮验证 Python `ssl/sqlite3/zlib` 可用；`_bz2/_lzma/_zstd/_ctypes` 的裁剪边界沿用构建制品声明，未在本探针中作为通过项伪造实测。
- API 37 模拟器 `run-as <pkg>` 对 App 私有目录权限不足（shell 身份 `u:r:shell:s0`），设备证据以 App 自身 logcat 和进程内 `File/Process` 结果为准。
- 模拟器网络可解析并访问 GitHub HTTPS；ICMP ping 不通不代表 TCP/TLS 失败，git HTTPS 实测已通过。

## 6. Go/No-Go 结论

**GO**。P0 证明产品主轴可行：legacy 物理落盘、Node 引擎 dlopen、App 私有目录 symlink、shell/Python 包装、工具树物化、git exec-path 农场与静态 TLS 均在 App 真实上下文中通过。P1 可进入 `cli.lock.json`、`provision-cli.mjs`、`verify-cli.mjs` 与产品 Gradle 打包接线。
