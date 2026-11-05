# T2.7 模拟器验证 —— uv venv 与 pnpm lifecycle 平台边界（emulator-5554）

> 日期：2026-11-05 · 设备：`emulator-5554`（Android 17 / API 37，x86_64 + libndk_translation/berberis）
> 包：`org.fellow99.pi.PiDesktopAndroid` versionCode 1500 · 域：`u:r:untrusted_app_34:s0`（run-as 复现产品 env）
> 关联：`specs/112-cli-integration/{spec,plan,tasks,test-cases}.md`（TC-112-D-007 / D-008 / D-009）、`../git-commit-segfault/`
> 方法：全程离线，夹具落 App 私有 `$TMPDIR`，结束 `rm -rf`；每个 CLI 调用放进 `( )` 子 shell 或独立 `sh -l -c`
> （`.profile` 短名函数以 `exec` 收尾，会替换当前 shell，与产品「每条命令独立 login shell」语义一致）。

## 0. 一句话结论

- **pnpm 纯 JS lifecycle 可用，但有调用约定**：pnpm(Rust) 内部跑 lifecycle 用的是**非 login 子 shell**，
  不继承 mksh 的 `.profile` 函数，脚本里裸 `node` 会经 PATH 命中 `bin/node` symlink 短名，撞 bionic
  `Unable to get realpath of node`（rc=255）；把脚本解释器写成**绝对 ELF `libnode_cli.so`** 后
  preinstall/postinstall/`pnpm run` 全部 rc=0。
- **`uv venv` 在本交叉编译形态下为硬边界（不可用）**：uv 以 isolated 模式（`python -I` 语义，
  `environment=0`）探测解释器，主动清空环境变量，导致依赖 `PYTHONHOME` 定位外置 stdlib 的
  Python 启动即 `No module named 'encodings'`；非配置可解。
- **主 Python/pip 工作流健康**：`pip` 26.2.2 正常；离线 `--no-index` 明确返回「No matching distribution」，
  失败原因正确指向无本地源，而非 CLI 损坏。

## 1. 平台机制（先于结论的事实）

`.profile` 函数只在 **login shell（`sh -l`）** 内可见；函数体 `exec '<nativeDir>/lib*.so'` 把短名改写为
绝对 ELF，规避 bionic 对裸短名 argv[0] PIE 的 realpath 自检失败。`$HOME/bin` 农场是指向同一 ELF 的
**symlink**，供绝对路径后备。对照实验（`spawn-compare.sh`）：

| 调用形态 | 结果 |
|---|---|
| 非 login `sh -c 'node --version'`（PATH 命中 `bin/node` symlink 短名） | ✘ rc=255 `Unable to get realpath of node` |
| 绝对 ELF `libnode_cli.so --version` 直跑 | ✅ v26.13.0 |
| 非 login `sh -c 'python --version'`（symlink 短名，即使 export PYTHONHOME） | ✘ rc=255 |
| 绝对 ELF `libpython_cli.so --version` 直跑 | ✅ Python 3.14.10 |
| login `sh -l -c 'node --version; python --version'`（走 `.profile` 函数） | ✅ 两版本均回程 |

产品三通道（TERM/PTY/EXEC）的**顶层命令**都由常驻 `sh -l` 执行，短名走函数 → 正常（探针 10/10 已证）。
本记录覆盖的是**下一层**：CLI 程序内部再 spawn 子进程的场景。

## 2. TC-112-D-008：pnpm 纯 JS lifecycle

最小夹具 `package.json`（无依赖，仅 lifecycle 脚本），`pnpm install --offline --ignore-workspace`。

### 2.1 裸短名（默认写法）—— 暴露边界

```json
"scripts": { "preinstall": "node -e \"console.log('preinstall node='+process.version)\"" }
```

```
. preinstall$ node -e ...
. preinstall: Error running .../bin/node: Unable to get realpath of node
. preinstall: Failed
ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED ... exited with exit status: 255
```

根因：pnpm 以非 login `sh -c` 执行 lifecycle，`.profile` 函数不可见，`node` 解析到 `bin/node`
（symlink 短名）→ bionic realpath rc=255。

### 2.2 绝对 ELF 解释器 —— 验证可行

把脚本改为绝对 `libnode_cli.so`：

```
. preinstall$ <nativeDir>/libnode_cli.so -e "console.log('preinstall abs-node='+process.version+' arch='+process.arch)"
. preinstall: preinstall abs-node=v26.13.0 arch=arm64
. preinstall: Done
Done in 5.3s using pnpm v12.16.1            # install rc=0
pnpm-run-ok                                  # pnpm run hello rc=0
.../node-bridge/.local/share/pnpm/store/v11  # pnpm store path（App 可写域）rc=0
```

- pnpm 12.16.1 Rust CLI 自身不依赖已删除的 JS bundle；store 落在 `PNPM_HOME` 可写域。
- **lifecycle 找得到 node 26.13.0（arm64），前提是脚本用绝对 ELF 路径**；裸 `node` 短名在非 login
  子 shell 不可用。这是本平台调用约定，应在能力文档/SKILL 中登记。

## 3. TC-112-D-007：uv venv（硬边界）

### 3.1 现象（默认与 `--python` 绝对 ELF 均失败）

```
$ uv venv --offline .venv
error: Failed to inspect Python interpreter from first executable in the search path at `.../bin/python`
  cause: Querying Python ... failed with exit status: 1
    PYTHONHOME = (not set)   isolated = 1   environment = 0
    Fatal Python error: Failed to import encodings module
    ModuleNotFoundError: No module named 'encodings'
```

`uv venv --python <nativeDir>/libpython_cli.so` 同样失败，报错逐字相同（`isolated = 1`）。

### 3.2 根因定性（手动复现 isolated 语义）

| 命令 | 结果 |
|---|---|
| `libpython_cli.so -I -c '...'`（isolated，清 env，模拟 uv 探测） | ✘ `Could not find platform independent libraries <prefix>` / encodings 失败 |
| `libpython_cli.so -c '...'`（普通模式 + 产品 PYTHONHOME） | ✅ `normal ok 3.14.10` |

交叉编译 Python 的 stdlib 不在 ELF 内置 prefix（默认猜 `/usr/local/lib/python3.14`），而由
`PYTHONHOME=$HOME/cli-tools/python-bridge-tools` 外置注入。uv 探测解释器时强制 isolated（`-I`，
`environment=0`）忽略 PYTHONHOME → 必崩。**与 PATH 短名、权限、网络均无关，非配置层可修复。**

### 3.3 仍可用的 uv 能力

`uv --version`（0.13.6）、`uv cache dir`（`$HOME/.cache/uv`，App 可写域）正常；rustls 自带根证书。
受限项明确为「需要 spawn/inspect Python 解释器」的 `uv venv` / `uv pip`（后者同样要探测解释器）。

## 4. TC-112-D-009：无编译器生态边界（旁证）

login shell 内 `command -v bash curl gcc g++ make cc clang` 全部 absent；
`android-exec.js` promptGuidelines 已明示 `No bash/curl; no gcc/make/toolchain, so native node-gyp
builds and pip sdist compilation are unavailable`。可行域 = 纯 JS / 纯 Python wheel / 预置原生件，
失败原因指向缺 toolchain 而非 CLI 损坏，不静默降级。

## 5. 处置建议（本期不扩范围，仅登记）

1. **pnpm/npm lifecycle**：在 SKILL/能力清单登记「设备上 lifecycle 脚本的 node 解释器须用绝对 ELF
   （`libnode_cli.so`），裸 `node` 短名仅在 login shell 顶层可用」。是否在 `.profile` 之外补一层
   非-login 短名可用性（如让 `bin/node` 成为可被 bionic realpath 接受的形态）留后续专项评估——
   受 untrusted_app 禁 execve 数据目录常规文件约束，不能简单换成实体可执行文件。
2. **uv venv**：登记为平台不支持；Python 隔离环境需求改用「主解释器 + `pip install --target` /
   `--user`」或预置 wheel。待 uv 支持注入 PYTHONHOME/非 isolated 探测，或 Python 改为内置 prefix
   构建后再评估（经 `cli.lock.json` 升版）。
3. 本记录全部为离线实测；网络相关的 `uv pip install` / `pnpm install <registry 包>` 按网络条件另记。

## 6. 复现脚本与清理

- 复现脚本（scratch，不入库）：`spawn-compare.sh`（短名机制对照）、`t27-workaround.sh`（pnpm 绝对 node /
  uv --python）、`uv-root-cause.sh`（isolated 根因 + pip 对照）。
- 设备侧夹具全部落 `$TMPDIR` 并 `rm -rf`；验证后清理了 tmp 内历史 t27/pnpm/pyboot/uv 诊断残留，
  仅保留产品目录 `node-compile-cache`；`/data/local/tmp` 无残留。
