# 111-pty-integration — plan（技术实施计划）

> 依赖：`specs/111-pty-integration/spec.md`；方案权威：`docs/111-PTY实现方案.md`。
> 本工程无 `.specify`，沿用自身约定（`specs/<模块>/spec.md` + `plan.md` + `tasks.md` + `test-cases.md`）。

## 架构（数据流）

```
TerminalPanel(xterm) ⇄ /api/terminal(+SSE) ⇄ lib/terminal-manager.ts ⇄ require("node-pty")[1.1.0]
   ⇄ (启动期常驻加载器 dlopen+种子cache) ⇄ libpty_node.so(nativeLibraryDir) ⇄ /dev/ptmx ⇄ mksh
```

- 前端/API/事件/重建：upstream `pi-web v0.12.1` 原样，**无前端 fork、无自研 PTY**。
- node-pty 原生：`io.github.fellow99:node-pty:26.13.0` AAR（node-pty 1.1.0 编译），随包进 nativeLibraryDir。
- node-pty JS：载荷 `node_modules/node-pty` = **1.1.0**（vendored overlay），与原生配对。

## 关键技术决策

1. **依赖三件（Maven）**：`libs.versions.toml` 升级 `nodeRuntime=26.13.0`、新增 `nodePty=26.13.0`；
   `app/build.gradle.kts` 加 `runtimeOnly(libs.node.pty)`。锁：`runtime.lock.json` active→26.13.0 +
   三个 .so 的 sha；新增 `verify-pty.mjs`（镜像 `verify-runtime.mjs`：AAR 内 libpty_node.so sha + ELF 门禁 +
   **DT_NEEDED 含 libnode.so**）。`provision-pty.mjs` 退役（随 AAR 不再投放 jniLibs）。
2. **node-pty 1.1.0 运行期 JS**：patch 计划——① `crop-rules.mjs` 保留裁掉 pi-web 的 `node_modules/node-pty/**`
   （1.2.0-beta.15 wrong）；② `assemble-payload.mjs` 在裁剪+壳资产之后、vendor 兼容/packaging 之前，把
   `payload/extensions/android-pty/vendor/node-pty`（1.1.0：`lib/`+`package.json`）复制为
   `stageRoot/node_modules/node-pty`，并补 `build/Release/pty.node` 占位文件。`serverExternalPackages` 已含
   `node-pty` ⇒ Next 运行期真实 require 命中。
3. **启动期常驻加载器**：`pi-web-launch.js` 在 pi-web server boot 之前执行一次（不再受
   `PI_ANDROID_SELFTEST` 门控）：读 `PI_ANDROID_NATIVE_LIB_DIR` → `process.dlopen('libpty_node.so')` →
   用 `Module` 种子 `require.cache[require('<pkg>/build/Release/pty.node')绝对路径]` → 记 boot-facts `pty.ready`。
   失败结构化上报，不阻断启动（capability 置 unsupported）。
4. **能力翻转**：patch 0001 `lib/terminal-capability.ts` 移除 `"android"` 名单 + `ptyEvidence()` 增补
   `libpty_node.so` 在位/可装载实测；supported 仅当真装载。
5. **shell**：复用 upstream `terminal-manager`（`SHELL||/bin/sh`→`/system/bin/sh` mksh，`-l`），不改 upstream。
6. **最简 PTY bash 工具**：`payload/extensions/android-pty/index.js` 新增单次 spawn 工具（`ptyBash`），完成判据
   靠 `onExit`；保留 `/pty-test`。不进 `android-exec.js` 主体。
7. **收敛**：删 `pi-web-launch.js` 的 Node 侧 `throwIfAborted` 垫片（Node 26 ≥25）。

## 文件变更清单

| 文件 | 改 | 内容 |
|---|---|---|
| `gradle/libs.versions.toml` | M | nodeRuntime=26.13.0、nodePty=26.13.0、node-pty 坐标 |
| `app/build.gradle.kts` | M | `runtimeOnly(libs.node.pty)` |
| `runtime.lock.json`（根） | M | active→26.13.0 + 3 .so sha + pty 坐标 |
| **`scripts/verify-pty.mjs`** | A | node-pty AAR sha + ELF 门禁 |
| `scripts/verify-runtime.mjs` | M | 锁口径 26.13.0 |
| `scripts/provision-pty.mjs` | R | 退役（并入 verify-pty --check 语义） |
| `scripts/provision-engine.mjs` | M | 26.13.0 零网兜底 sha |
| `scripts/crop-rules.mjs` | M | node-pty 规则：保留裁 1.2.0-beta.15，注释指向 overlay |
| `scripts/assemble-payload.mjs` | M | node-pty 1.1.0 overlay + 占位文件步骤 |
| `scripts/devtest.mjs` | M | G1 锁口径 → 26.13.0 + pty；新增 pty.ready 断言 |
| `payload/pi-web-launch.js` | M | 常驻加载器 + boot-facts pty.ready；删 Node 侧 throwIfAborted 垫片 |
| `patches/v0.12.1/0001-….patch` | M | 移 android 名单 + evidence 实测门 |
| `payload/extensions/android-pty/index.js` | M | 保留 /pty-test；新增最简 PTY bash 工具 |
| `payload/config/settings.json` | M(可选) | 试运行工具注册 |

## 分阶段
- **P0 依赖/随包**：toml/gradle/runtime.lock/verify-pty/verify-runtime/crop/assemble overlay → `assembleDebug` 过 + verify 全绿。
- **P1 运行期**：launch 常驻加载器 + boot-facts；patch 0001 能力翻转；android-pty 最简工具。
- **P2 验证**：真机终端面板 T1a–T1e + 最简工具 + 回归四件套 + 合规 G3；回填能力清单。
