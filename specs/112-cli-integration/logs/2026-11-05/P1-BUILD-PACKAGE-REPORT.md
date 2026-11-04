# P1 构建与打包验证报告（五个真实 CLI 接线 · 阶段 P1）

- 日期：2026-11-05
- 分支：`main`
- 裁决环境：模拟器 `emulator-5554`（Android 17 / API 37 / x86_64 + `libndk_translation`，App 页大小 4096）
- 构建命令：`ANDROID_HOME=<SDK> ./gradlew :app:assembleDebug --no-daemon` → **BUILD SUCCESSFUL in 1m 46s**
- 产物：`app/build/outputs/apk/debug/app-debug.apk`
- APK 大小：484,889,613 B（462.43 MiB）
- APK sha256：`e57fd751ce6149e264f5f78a75c82ed75f0c4f13bd65dc258bb7c64d97c0b3be`
- 结论：**P1 打包门禁全部通过（GO 进入 P2）**。本报告所有数据为构建机与模拟器实测，无占位/外推。

---

## 1. Gradle / 打包契约改动（最小改动）

| 项 | 改动 | 理由 |
|---|---|---|
| `packaging.jniLibs.useLegacyPackaging` | `false → true` | 引擎 + 五个 CLI 的 exec 型 `.so` 必须安装期物理解压到 `nativeLibraryDir`，才能 `dlopen`/直接 `exec`（plan D2，`extractNativeLibs=true`）。 |
| `androidResources.noCompress` | `["gz"] → ["gz","tar"]` | `assets/cli-tools/*.tar`（gzip 内容）与 `pi-web.tar` 保持 STORED，安装期零解压、AssetManager 可 fd 直读。 |
| `.gitignore` | 新增 `app/src/main/assets/cli-tools/` | 确定性工具树 tar 是派生产物（`provision-cli.mjs` 生成，摘要锁在 `cli.lock.json`），不入库。 |

> **未覆写 `androidResources.ignoreAssetsPattern`**：实测 `app/src/main/assets/` 下无松散 dotfile，
> 全部 dotfile（`npm/.npmrc`、node-gyp `.release-please-manifest.json`、qrcode `.travis.yml` 共 4 个）
> 均位于 tar 内部，对 aapt 只是单个 STORED blob，天然保留（见 §4 tar 内 dotfile 校验）。避免影响 pi-web 打包行为。

## 2. APK 内资产实测（central directory 解析，method: 0=STORED / 8=DEFLATE）

### 2.1 ABI 与 native 库

- `native-code: 'arm64-v8a'`（单 ABI，符合约束）。
- `lib/arm64-v8a/` 下 **17 个 `.so`**：
  - CLI 受管 12 件：7 个 exec ELF（`libnode_cli`/`libpython_cli`/`libgit_cli`/`libgit_http_fetch`/`libgit_remote_curl`/`libuv_cli`/`libpnpm_cli`）+ 5 个 shell 壳（`libnpm`/`libnpx`/`libcorepack`/`libpip`/`libpip3`）。
  - 引擎/桥 5 件：`libnode.so`、`libc++_shared.so`、`libpty_node.so`、`libnode_bridge.so`、`libnode_host_client.so`。
- 17 个 `.so` 在 APK 内均为 **DEFLATE**。这不违反 legacy packaging：legacy 的语义是 manifest
  `extractNativeLibs=true`（安装期解压到文件系统），**不要求 APK 内 STORED**；真正裁决见 §3 设备物理落盘。

### 2.2 assets（均 STORED）

| 条目 | method | size (B) |
|---|---|---|
| `assets/cli-tools/git.tar` | STORED | 136,070 |
| `assets/cli-tools/node.tar` | STORED | 2,507,001 |
| `assets/cli-tools/python.tar` | STORED | 6,084,221 |
| `assets/pi-web/pi-web.tar` | STORED | 363,067,392 |

- uv / pnpm 无工具树，**未生成空 tar**（verify-cli 显式拒绝空包）。
- `assets/` 下松散 dotfile 条目数 = **0**（dotfile 全部内聚在 tar 中）。

## 3. 设备物理落盘裁决（legacy packaging 真正判据）

安装：`adb -s emulator-5554 install -r -t app-debug.apk` → **Success**。
manifest 实测：`A: android:extractNativeLibs(0x010104ea)=true`、`debuggable=true`。

`nativeLibraryDir = /data/app/~~U4IrX48AAzcqmS_51OAGlA==/org.fellow99.pi.PiDesktopAndroid-89qR0xa2i9wmea-MQmTd3Q==/lib/arm64`

- 该目录物理落盘 **17 个 `.so`**，权限全为 `-rwxr-xr-x`（可执行），属主 `system:system`。
- 大小与 jniLibs 源逐字一致（抽样）：`libuv_cli.so` 34,979,336、`libnode_cli.so` 62,155,912、
  `libpython_cli.so` 15,754,472、`libpnpm_cli.so` 47,317,088；壳 `libcorepack.so` 382、`libnpm/libnpx.so` 358、`libpip/libpip3.so` 153。
- shell 壳设备侧首行实测均为 `#!/system/bin/sh`（安装期未被破坏）。
- 5 个代表 exec ELF（node/python/git/uv/pnpm `_cli`）设备侧 magic 实测均为 `7f 45 4c 46`（ELF）。

> 注：API 37 模拟器 `run-as <pkg>` 身份为 `u:r:shell:s0`，穿越 App 私有 filesDir 会 `Permission denied`；
> 但 app lib 目录对 shell 可读，故 nativeLibraryDir 落盘可直接裁决。filesDir 工具树物化与 env/短名
> 属于 P2 首启逻辑，将以 App 进程内输出 + logcat 取证。

## 4. 工具树 tar 契约（构建机 verify-cli + 系统 tar 双仲裁）

- 三个 tar 均 gzip magic `1f 8b`，自研 `parseTar` 与系统 `tar.exe -tzf` 双重可读。
- 确定性摘要（锁 `cli.lock.json#toolArchives[].archiveSha256/archiveSize`，重跑同输入逐字节一致）：
  - `node.tar` `d18abfb35e5fcd5fbdf0f8c339768ca06b79a7b2a172e31ce5f99c8d8590756c` / 2,507,001 B（1592 条目）
  - `git.tar` `a21ae3e545b88a988bc9acc31d1007a7ea2d84638e464d18ad5ba3e4df365a47` / 136,070 B（40 条目）
  - `python.tar` `f8a0280f36fba5682e9199c242b2ac1aa13ec6ed6d23f60efe7b0029f8760a4a` / 6,084,221 B（1079 条目）
- tar 内 dotfile 保留校验：`node-bridge-tools/npm/.npmrc` 存在（系统 tar 列表可见）。
- manifest 语义锁（不锁易变 `generatedAt`，只认 `fileCount`/`totalSha256`，git 认 `farmSize`）由 `verify-cli.mjs` 全量逐文件 sha 比对通过。

## 5. 体积增量（相对既有引擎/pi-web 基线）

- 12 个 CLI 受管 `.so` 解压后合计 **181,089,580 B（≈172.7 MiB）**。
- 3 个工具树 tar 合计 **8,727,292 B（≈8.3 MiB）**。
- APK 内 `.so` 经 DEFLATE、tar 保持 STORED；APK 总体 462.43 MiB（pi-web.tar 占 346.3 MiB 为既有大头）。

## 6. 门禁与负例（构建机，承接 P1 脚本验证）

- `node scripts/verify-cli.mjs` → exit 0（7 ELF 六项门禁 + 5 壳 shebang + 受管清单恰 12 件 + 3 tar 双解析 + manifest 语义 + 确定性摘要）。
- `node scripts/provision-cli.mjs --check` → exit 0（子进程委托 verify，判据单一来源）。
- 负例三测均正确 exit 2 并可恢复：N1 翻转 ELF 字节→SHA 不符拦截；N2 删壳→`缺 shell 壳`；N3 截断 tar→`自研 tar 解析失败`。

## 7. 遗留与边界（如实记录）

- 模拟器翻译层（native bridge）裁决有效，但**不能替代 P4 原生 arm64 真机签收**（小米 MIX `cd3fac61`，MIUI 侧载门待人工授权）。
- assets tar 的 App 进程内 AssetManager 读取与 filesDir 物化、env/短名/pip wrapper/gitexec 农场为 **P2** 范围，本阶段不臆测结论。
- 静态裁剪边界（Python `_bz2/_lzma/_zstd/_ctypes` 不可用、无设备编译器）沿用 P0 记录，P2/P4 端到端用例显式规避并上报。
