# P3 移除纯 JS 替代 —— 模拟器验证证据（emulator-5554，API37 翻译层）

> 日期：2026-11-05 · 设备：`emulator-5554`（Android 17 / API 37，x86_64 + libndk_translation/berberis）
> 包：`org.fellow99.pi.PiDesktopAndroid` versionCode 1500 · 域：`u:r:untrusted_app_34:s0`（app-untrusted 真域）
> 关联：`specs/112-cli-integration/{spec,plan,tasks}.md`、`logs/2026-11-05/git-commit-segfault/`

## 1. 打包契约（APK 解包机械验证）

debug APK（`app-debug.apk`，重建于载荷重组装之后）：

- **jniLibs/arm64-v8a 共 17 个 `.so`** = 引擎/桥/PTY 5 件（libnode、libc++_shared、libnode_bridge、
  libnode_host_client、libpty_node）+ CLI 受管 12 件（7 ELF：libnode_cli/libpython_cli/libgit_cli/
  libgit_http_fetch/libgit_remote_curl/libuv_cli/libpnpm_cli；5 shell 壳：libnpm/libnpx/libcorepack/
  libpip/libpip3）。
- **assets/cli-tools 三个确定性工具树**：`node.tar` 2,507,524 B、`git.tar` 136,112 B、`python.tar` 6,084,874 B。
- **载荷归档**：AGP 把 noCompress 的 `pi-web.tar.gz` 去 gzip 壳改名 `assets/pi-web/pi-web.tar`（裸 ustar，
  魔数 `pi-web/.next/`）。裸 tar 内实测：
  - `pi-web/pi-web-launch.js` 含 `cleanupLegacyExtensions`（3 处引用 = 1 定义 + 1 调用 + 1 注释）；
  - `extensions/android-git/`、`extensions/android-pnpm/` 条目数 = **0**；
  - `extensions/` 仅 6 项：android-exec.js、android-pty/、android-runtime.js、android-saf.js、
    android-search.js、android-workspace-roots.js；
  - `env.js` 中 `PI_HOS_ROOTS` 计数 = **0**；
  - `extensions/android-exec.js` 含新 promptGuidelines（`Real CLIs on PATH`）。

## 2. 升级清理路径（cleanupLegacyExtensions 实测）

模拟升级残留：在 App 私有目录手动预置假目录
`files/pi-agent/extensions/android-git/marker.txt` 与 `android-pnpm/marker.txt`，force-stop 后重启。

logcat 实测（NODE_BRIDGE）：

```
已清理废弃扩展残留：.../files/pi-agent/extensions/android-git
已清理废弃扩展残留：.../files/pi-agent/extensions/android-pnpm
```

重启后 `files/pi-agent/extensions/` 仅剩 6 个合法扩展，两假目录被删除，其它扩展不受影响。

- **作用域事实**：扩展加载器 `discoverAndLoadExtensions` 只读 `<PI_CODING_AGENT_DIR>/extensions`
  （= `files/pi-agent/extensions`）与 `<cwd>/.pi/extensions`，**不读**载荷解包树
  `files/node-bridge/payload/pi-web/extensions`。故解包树（tar 只增不删）里即便有同名死目录也不会被加载，
  属惰性死文件；真实升级时新 tar 已不含这两个目录，重解包后除历史死文件外无新增。
- **重复调用修复**：初版 cleanup 在 main 中被调用两次（物化前 + Next 启动前），logcat 打印重复日志。
  已删除第二次调用，仅保留 `materializeAgentResources` 之前的唯一调用（launch 行 1450），`node --check` 通过。

## 3. 延迟 CLI 探针（pi-web.cli-facts.json，真域常驻 login shell）

文件：`cli-facts-p3-emulator.json`（6157 B，同目录归档）。`summary`：

| 指标 | 值 |
|---|---|
| total / ok / failed / timedOut | **10 / 10 / 0 / 0** |
| onPath | **10/10** |
| gitCommitOk / gitCommitSegfault | false / **true** |
| gitSmokeOk | false |
| elapsedMs | 36172 |

十命令 `--version`（app-untrusted 真域，`sh -l` source `$HOME/.profile` 函数 + 哨兵帧）：

| 短名 | 实测版本 | 短名 | 实测版本 |
|---|---|---|---|
| node | v26.13.0 | pip | 26.2.2 |
| npm | 11.20.0 | pip3 | 26.2.2 |
| npx | 11.20.0 | git | 2.56.0 |
| corepack | 0.36.0 | uv | 0.13.6 (aarch64-linux-android) |
| python | 3.14.10 | pnpm | 12.16.1 |

git 冒烟 7 步（独立短生命周期 login shell，1308 ms）：setup/init/config/add/cleanup 全 code=0；
**commit code=139（SIGSEGV）、log code=128**。与 `git-commit-segfault/` 裁决完全复现，非本次移除引入的回归。

## 4. 三通道短名解析（独立 login shell 等价 TERM/PTY/EXEC）

用与 `CliTools.environment()` 完全一致的产品 env（含 NODE_TOOLS_DIR/NODE_NATIVE_DIR/PYTHONHOME/
SSL_CERT_FILE/GIT_EXEC_PATH/PNPM_HOME/UV_CACHE_DIR 等），以 `sh -l -c '<短名> --version'` 模拟
PTY/TERM 形态、`sh -l -c '复合命令'` 模拟 EXEC 常驻 shell：

- **10/10 短名全部回程**（含 shell 壳类 npm/npx/corepack/pip/pip3；仅注入 HOME/TMPDIR 的不完整 env 下
  壳类报 `NODE_TOOLS_DIR not set`，补齐全 env 后正常——证伪产品缺陷，确认为测试 env 不全）。
- `type git/node/pnpm/pip` 均报 `is a function`（确认走 `.profile` 函数，非 PATH 裸二进制）。
- `python -c "import ssl,sqlite3,zlib,hashlib"` → `py-stdlib-ok`（PYTHONHOME 生效，无 prefix 警告）。
- 复合命令 `node -e 'console.log(process.arch)'` → `arm64`；`git --version` 正常；`command -v uv` 命中。

## 5. 结论

- T3.1–T3.8 代码/打包/运行期目标在模拟器达成：旧两扩展零残留、升级清理生效、五真实 CLI 三通道 10/10。
- 已知限制不变：`git commit` 在 untrusted_app 真域稳定 rc=139（SELinux 拒 link + git 不回退 rename），
  原生 arm64 裁决留 P4（小米 MIX MIUI 门解除后）。
- 本轮为验证而重建的载荷/APK 属 gitignored 派生产物，不入库；入库证据仅本目录文档与脱敏 cli-facts。
