# 112 代码评审修复 + P4 模拟器回归收口证据

- 日期：2026-11-05
- 设备：`emulator-5554`（Android 17 / API37 x86_64 + libndk_translation/berberis，abilist 含 arm64-v8a）
- 包：`org.fellow99.pi.PiDesktopAndroid`（versionName 0.15.0 / versionCode 1500）
- 评审基线：`3972ae5` → 评审时 HEAD `d33cb27`（5 commits，68 files +1808/-250527）
- 修复提交：`87826d9`（fix）、`f465e04`（docs）
- 重建 APK：`app/build/outputs/apk/debug/app-debug.apk`，490974544 B，sha256 前缀 `138fae4d0de8c654`

## 一、代码评审结论

code-reviewer（只读、未跑构建）结论：**无 Critical / Important**，3 项 Minor，五项专项核查全部通过
（cleanup 安全性、nativeLibraryDir 哈希漂移自愈、CI fail-closed、常驻 shell 资源/进程组/哨兵、删扩展后零悬空引用/死代码）。

| 项 | 级别 | 内容 | 处置 |
|---|---|---|---|
| 独立发现 | Important（评审未覆盖）| `cleanupLegacyExtensions` 只清 `agentDir/extensions`，**payload 解包点孤儿不删** | 已修（`87826d9`），设备实测通过 |
| M1 | Minor | git 冒烟硬上限/ shell 死亡路径泄漏 `$TMPDIR/pi-gitsmoke` | 已修（`87826d9` finally 兜底） |
| M2 | Minor | SKILL.md 三处 PTY 描述停留「不提供/暂缓/待 B3」，与 111 已产品化矛盾 | 已修（`f465e04`） |
| M3 | Minor | 现役代码/配置注释停留引擎 24.22.1，实际 26.13.0 | 已修（`f465e04`，7 文件） |

## 二、独立发现：payload 解包点孤儿清理缺口（根因与验证）

### 根因链
1. `PayloadArchive.ensureExtracted`（Kotlin）全量重解包只 `mkdirs()` + 覆盖同名文件，**不删除 tar 中已不存在的孤儿目录**。
2. 112 从载荷 tar 删除 `extensions/android-git`、`extensions/android-pnpm` 后，升级安装（tar sha 变化 → marker 失效 → 全量重解包）不会清掉设备上旧版本解包出的这两个目录。
3. 原 `cleanupLegacyExtensions()` 只处理 `<PI_CODING_AGENT_DIR>/extensions`（扩展加载器 `discoverAndLoadExtensions` 的扫描点），未处理 `<payloadRoot>/extensions`。
4. 影响定性：payload 解包点**不在扩展加载器扫描路径**（加载器只看 `agentDir/extensions` 与 `<cwd>/.pi/extensions`），故无功能危害、旧扩展不会被注册；但违反 112「零违规残留」目标。

### 修复
`cleanupLegacyExtensions(payloadRoot)` 收集 `[agentDir?, payloadRoot?]` 两个根，对每个根下
`extensions/android-git`、`extensions/android-pnpm` 两个具名常量目录 `existsSync` 后 `rmSync(recursive,force)`，
失败只 `logWarn` 不阻断；仍只删这两个硬编码名，无外部输入、无路径穿越面。main 中调用点在
`rotatePreviewSecrets` 后、`materializeAgentResources` 前，传 `payloadRoot`。

### 设备决定性实验（修复后 APK）
1. 两处（`files/pi-agent/extensions` 与 `files/node-bridge/payload/pi-web/extensions`）各预置
   `android-git/orphan.txt`、`android-pnpm/orphan.txt`。
2. 删 `files/node-bridge/payload/.ready-*` 解包 marker（保留无关的 `pi-web.ready.json`）强制下次全量重解包，等价升级 tar sha 变化。
3. force-stop + monkey 重启。logcat（pid 15753）出现 **4 条**清理日志：
   - `已清理废弃扩展残留：…/files/pi-agent/extensions/android-git`
   - `已清理废弃扩展残留：…/files/pi-agent/extensions/android-pnpm`
   - `已清理废弃扩展残留：…/data/data/…/payload/pi-web/extensions/android-git`
   - `已清理废弃扩展残留：…/data/data/…/payload/pi-web/extensions/android-pnpm`
4. 新 marker `.ready-71d868cc55f2` 重建，证明全量重解包确实执行。
5. 重启后断言：两处 `grep -cE "android-git|android-pnpm"` 均为 **0**（BOTH-CLEAN-PASS）；
   其余 6 个合法扩展（android-exec.js / android-pty / android-runtime.js / android-saf.js / android-search.js / android-workspace-roots.js）完好未误伤。

> 对照（修复前，同实验步骤）：全量重解包 marker 重建后，payload 解包点两个孤儿 ORPHAN-SURVIVED
> （含 LEGACY 内容），与 PayloadArchive 只增不删逻辑吻合。agentDir 点在修复前后均由原逻辑正确清理。

## 三、M1：git 冒烟临时目录兜底

- `runGitSmoke` 的 `smokeBase = $TMPDIR/pi-gitsmoke`（固定名，无 pid 后缀）。原清理仅依赖最后一帧 shell `rm -rf`；
  硬上限在 cleanup 帧前命中（guard 直接 push timeout）或常驻 shell 中途 died 时该帧不执行。
- 修复：`finally` 块在进程组 SIGKILL 之后追加 Node 侧
  `fs.rmSync($TMPDIR/pi-gitsmoke, {recursive,force})`，try/catch 吞错，与 shell 帧同名幂等。
- 验证：设备脚本 1083 行确认兜底在位；本次启动 git 冒烟 cleanup 帧 rc=0，且
  `files/node-bridge/tmp` 下 `grep gitsmoke` 无残留（GITSMOKE-CLEAN，仅余 node-compile-cache）。

## 四、M2 / M3 文档与注释同步（提交 f465e04，7 文件）

- **M2** SKILL.md 三处改为「PTY 已产品化（111）」：`terminal.pty` 按 `globalThis.__piWebPty.ok`
  运行期裁决、node-pty 1.1.0 + 随包 `libpty_node.so`、`ptyBash` 已在 defaultTools。
  依据核实：`payload/config/settings.json:3` defaultTools 含 ptyBash；`android-pty/index.js` registerTool ptyBash + registerCommand pty-test；
  patch `0001-terminal-capability-unsupported` 在 `__piWebPty.ok` 时返 `supported:true`。
- **M3** 现役代码/配置版本注释 24.22.1 → 26.13.0：`app/build.gradle.kts`、`EngineFacts.kt`（jitlessReason 运行期字符串）、
  `PiDesktopRuntime.kt`、`settings.gradle.kts`、`.gitignore`、SKILL.md 第 25 行；
  `pty.node.lock.json` nodeHeaders/enginePairing 改 26.13.0 / NODE_MODULE_VERSION 147，
  并加 `$runtimeNote` 显式标注该文件是 vendor 占位溯源留痕、**非运行件**（运行件以 Maven node-pty:26.13.0 的 libpty_node.so 为准）。
- 历史 `docs/`、`specs/` 中的 24.22.1 属时点记录，按文档保留纪律不改。

## 五、P4 模拟器回归（修复后 APK）

### 5.1 CLI 探针（pi-web.cli-facts.json，常驻 login shell sh -l + .profile 函数）
- summary：`total=10, onPath=10, ok=8, failed=2, timedOut=2, gitCommitSegfault=true, gitSmokeOk=false, elapsedMs=41211`。
- 8 个 ok：node v26.13.0 / corepack 0.36.0 / python 3.14.10 / pip 26.2.2 / pip3 26.2.2 / git 2.56.0 / uv 0.13.6 / pnpm 12.16.1。
- 2 个 timedOut：**npm / npx**，均为哨兵 12000ms 踩线（历史同口径冷启动就需 10–12s）。手动 login shell 复跑
  `npm --version`=11.20.0、`npx --version`=11.20.0 均 rc=0，功能正常 → 定性 berberis 翻译层冷启动抖动，非本次改动回归。
- git 冒烟：setup/init/config/add/cleanup 全 rc=0；**commit code=139 Segmentation fault、log code=128**（G1 边界复现，非回归）。

### 5.2 三通道同路径 login shell 10 短名回归
经 `sh -l -c ". <script>"`（与 TERM/PTY/EXEC 产品三通道同一 .profile 函数路径），补 NODE_TOOLS_DIR/NODE_HOME/PYTHONHOME 后：
node v26.13.0、npm 11.20.0、npx 11.20.0、corepack 0.36.0、python 3.14.10、pip 26.2.2、pip3 26.2.2、
git 2.56.0、uv 0.13.6、pnpm 12.16.1 —— **10/10 全 rc=0**。

### 5.3 平台边界 G1/G2/G3 稳定性（新构建复核）
- **G1**：git commit 落 ref 触发 SELinux 拒 `link(2)` → rc=139（cli-facts 复现），无配置层 workaround，原生 arm64 裁决留真机 P4。
- **G2**：非 login `sh -c 'node --version'`（PATH 命中 bin/node symlink）→ `Unable to get realpath of node` **rc=255**；
  对照绝对 `libnode_cli.so --version` → v26.13.0 rc=0。规避＝lifecycle 脚本解释器用绝对 ELF；三通道顶层命令走 sh -l 函数不受影响。
- **G3**：`libpython_cli.so -I`（isolated，忽略 PYTHONHOME）→ path configuration 失败（head 截断致管道 rc=141，核心是 encodings/prefix 缺失）；
  对照普通模式 `python -c` → `normal ok 3.14`。uv venv/uv pip 隔离探测不可用维持结论。

## 六、环境清理
- App 私有域本会话测试脚本（cleanup-repro/cleanup-rm/npm-recheck/step-inner/p4-inner/boundary-inner 等）全部删除，`grep` 无残留。
- `files/node-bridge/tmp` 无 pi-gitsmoke 残留。
- `/data/local/tmp` 的 `pnpm-cli`、`uv-probe`、`git-cli-probe` 等为 11-03/11-04 历史 P0/T2.7 探针夹具（shell 用户，非 App 私有域、非本会话产物），按证据保留纪律不删。

## 七、未决签收项（不阻塞本轮）
- 小米 MIX（cd3fac61）MIUI `INSTALL_FAILED_USER_RESTRICTED` 人工门未解除；G1 是否 berberis 翻译层叠加、G2/G3 在原生 arm64 内核是否同样成立，留真机 P4 裁决。
- DeepSeek Agent E2E（T4.2）待 API Key 运行时注入后单独执行并脱敏归档。
