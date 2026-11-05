# 真域 `git commit` 段错误裁决（untrusted_app，API 37 模拟器）

> 日期：2026-11-05 ｜ 设备：`emulator-5554`（Android 17 / API 37，x86_64 内核 + `libndk_translation`/berberis 翻译执行 arm64 ELF）
> 包：`org.fellow99.pi.PiDesktopAndroid`（versionCode 1500）｜ git：**2.56.0**（`libgit_cli.so`，arm64 PIE）
> 结论性质：模拟器翻译层裁决；**原生 arm64 真机（小米 MIX，MIUI 门未解）对照保留到 P4**，本结论不能替代原生签收。

## 1. 一句话结论

在 App 真实 SELinux 域 `u:r:untrusted_app_34:s0` 下，`git commit` 在应用私有数据目录落 ref/对象时触发
`link(2)`，被 SELinux **enforcing 拒绝**；git 2.56.0 的该构建在 `link` 失败后**不回退 `rename(2)`，直接解引用空指针**，
进程收 `SIGSEGV`（rc=139）。这是 **git 二进制自身的健壮性缺陷被平台 SELinux 策略触发**，不是 run-as/翻译层独有假象，
也**没有任何配置层 workaround**。

## 2. 复现路径（真域，与生产三通道同路径）

- 执行体：常驻 login shell `sh -l` 自动 source `$HOME/.profile`，其中 `git()` shell 函数 `exec` 绝对路径
  `libgit_cli.so`；TERM / PTY（ptyBash）/ EXEC（android-exec）三通道统一为 `sh -l`，走同一条短名解析与 env。
- 仓库：全程离线，仓库落在应用私有 `$TMPDIR`（`files/node-bridge/tmp/pi-gitsmoke-*`），结束 `rm -rf`。
- 七步：setup → init → config（user.name/email）→ add → **commit** → log → cleanup。
- 完整结构化结果见 [`cli-facts-app-untrusted.json`](./cli-facts-app-untrusted.json)（探针 revision 28，10 个 `--version`
  全 ok、PATH 10/10 命中；git 冒烟段耗时 1071ms）。

## 3. 因果链证据

| 环节 | 证据 | 原文要点 |
|---|---|---|
| ① SELinux 拒 `link` | [`avc-link-denied.txt`](./avc-link-denied.txt) audit 1008/1009（untrusted_app_34） | `avc: denied { link } for name="tmp_obj_kkHVYo" ... scontext=u:r:untrusted_app_34:s0 tcontext=u:object_r:app_data_file:s0 tclass=file permissive=0` |
| ② 随即 SIGSEGV | [`tombstone-git.txt`](./tombstone-git.txt) | `Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 ... (libgit_cli.so)`；`Cmdline: ... libgit_cli.so commit -m pi cli smoke` |
| ③ 崩溃点在 git 自身 | tombstone 回溯 #00–#06 全在 `libgit_cli.so`，#07 `__libc_init`；无应用栈 | 故障地址 `0x0`（read）= NULL 指针解引用；经 `libndk_translation.so`（berberis 拦截 `rt_sigaction`）翻译执行 |
| ④ run-as 同型拒绝 | avc 1018–1027、1036–1038、1063–1064、1073–1074（`runas_app`） | 两域**都**拒 `link`，且 run-as 下同样 SIGSEGV（tombstone 第二组，`commit -q -m smoke`），证明非 run-as 独有 |

时间线（真域那一组）：`01:21:09.900` AVC link 拒绝（pid 19759）→ `01:21:10.111` Fatal SIGSEGV（tid 19765）
→ `01:21:10.104` 第二次 link 拒绝（pid 19765）。`tmp_obj_*` 是 git 写 loose object 的临时名，说明崩溃发生在
**对象临时文件 hardlink 进 `objects/` 的落盘环节**。

## 4. 最小写操作判别（界定崩溃面）

在完整产品 env + identity 齐备前提下，逐项实测（设备端 `timeout` 包裹，结构化回收 rc）：

| git 操作 | rc | 判定 |
|---|---|---|
| `git init` | 0 | 正常（不触发 link 落盘路径） |
| `git hash-object -w` | 0 | loose object 直写正常 |
| `git write-tree` | 0 | 正常 |
| `git add` | 0 | 索引写正常 |
| `git commit-tree`（缺 identity） | 128 | 提前因 identity 失败，**走不到 link 路径，不崩** |
| `git commit`（identity 齐备） | **139** | 走到 ref/对象 link 落盘即崩 |
| `git log`（commit 失败后） | 128 | `your current branch 'master' does not have any commits yet`（无提交产生） |

结论：**崩溃限定在 `git commit` 的 ref/对象 `link` 落盘路径**；不触发该路径的写操作（init/add/hash-object/write-tree）全部正常。
mksh R59 无 `link` 内建（rc=127），无法用 shell 内建绕过。

## 5. 配置层 workaround 对照（全部失败）

| 尝试 | 手段 | commit rc |
|---|---|---|
| baseline | 标准 `git commit -m` | 139 |
| 关签名 | `merge.gpgSign=false` + `commit.gpgsign=false` | 139 |
| 关 fsync | `core.fsync=none` | 139 |
| 关 fsmonitor | `core.fsmonitor=false` + `core.useBuiltinFSMonitor=false` | 139 |
| 换临时目录 | 仓库内 `TMPDIR=<repo>/tmp`（仍 app_data_file 标签） | 139 |
| 换 ref 格式 | `git init --ref-format=reftable` | **init 自身即 139**（reftable 落盘也走 link） |

`link(2)` 被拒是 SELinux **域 + type** 层面的强制策略（`untrusted_app` → `app_data_file` 的 hardlink 受
`neverallow`/`link` 权限约束），任何 git 配置都改变不了内核裁决；故配置层无解。

## 6. 为什么这是 git 缺陷而非纯平台限制

POSIX 语义下 `link(2)` 失败（EACCES/EPERM）应返回错误并由上层处理；git 在对象文件原子落盘时本应能回退
`rename(2)`（同目录 rename 在 app_data_file 上是允许的——`git init/add/hash-object` 的 rename/直写均成功）。
该 2.56.0 arm64 构建在 link 报错路径上未做空指针保护即解引用，属上游健壮性缺陷。本期约束**不 fork/不改上游**
（见 spec「非目标」），因此本期不修二进制，只固化证据并在产品层规避。

## 7. 工程侧附带平台事实：长会话 mksh 状态污染

排查中另钉死一条与 git 无关、但影响探针架构的平台事实：

- 内嵌引擎（`libnode.so` v24，由 app_process dlopen）下，**常驻 `/system/bin/sh`（mksh R59）长会话**在累积
  约 10 条 `--version` 哨兵帧 + PATH 探测帧后，会进入**续行等待**：`/proc/<sh>/wchan = unix_stream_read_generic`、
  State `S (sleeping)`，此后 Node 侧流全程健康（`stdin.writable=true/writableLength=0`、`stdout.readable=true`，
  `write` 返回 true）但 shell 不执行、不回送，buffer 长度恒定。
- 帧语法、`setInterval`、PATH 帧转义先后被对照排除：同一高保真序列在 CLI Node v26（`libnode_cli.so`，可离线直跑）
  下全部 rc=0；但内嵌 `libnode.so` 设计上不可直跑（直跑即 SIGSEGV），无法 1:1 离线复刻其管道行为。
- **工程解**：git 冒烟改用**独立的、短生命周期的 login shell**（模块级 `runGitSmoke`，自 `spawn sh -l`、独立 buffer、
  `finally` 以进程组负 pid `SIGKILL` 销毁）。实测 git 段从长会话下的 84s 哨兵超时压缩到 **1071ms** 并稳定取证；
  探针总耗时由约 124s 降到 **43.0s**。主探针的 10 个 `--version` 仍跑常驻 shell（未观测到污染），PATH 探测帧已与
  `runOne` 同构（BEGIN/END 双 printf 标记 + while/sleep 轮询，弃用 setInterval）。

## 8. 产品处置（待评审决策，本期不展开实现）

1. **文档化规避（倾向）**：能力清单/提示明确「设备 SELinux 禁 app 数据目录 hardlink，`git commit` 本地落库在当前
   git 构建上会崩溃」；引导需要版本管理的工作流走 `git ls-remote`/clone/fetch（TLS 已验）或在可写且允许 link 的
   外部存储（SAF，后续模块）评估。
2. **修补/更换 git 构建**：向上游 `aosp-git-cli` 反馈 link 失败应回退 rename 的缺陷，拿到修复构建后经
   `cli.lock.json` 升版（第二期 Maven 切换时一并处理）。
3. **P4 原生 arm64 裁决（必做）**：MIUI 安装门解除后，在小米 MIX 原生 arm64 内核（无 berberis）上复跑本七步，
   裁决「link 被拒后 git 是否同样不回退而 SIGSEGV」。若原生内核仅拒绝 link 但 git 能回退 rename，则本缺陷为
   翻译层叠加，结论需修订。

## 9. 原始证据清单

- `avc-link-denied.txt`：logcat SELinux AVC 原文（untrusted_app_34 audit 1008/1009；runas_app 1018+ 多组）。
- `tombstone-git.txt`：`libc` Fatal signal 11 + DEBUG tombstone（cmdline、signal、backtrace，含两组崩溃）。
- `cli-facts-app-untrusted.json`：探针 revision 28 完整结构化结果（env、PATH 解析、10 检查、gitSmoke 七步、summary）。
