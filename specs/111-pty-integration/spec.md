# 111-pty-integration — spec（引入 node-pty，实现 pty 能力）

> 模块规格（需求/验收）。事实权威：`docs/111-PTY实现方案.md`；宪法：`specs/constitution.md`。
> 需求编号：`111-pty-integration` ｜ 需求名称：引入 node-pty，实现 pty 能力
> Git 分支：**不改动**（工作于 `main`，逐阶段提交）

## 需求（WHAT）

`pi-desktop-android` 引入 node-pty 原生件，把能力清单 #16（PTY / 终端面板）从「结构化 unsupported
（评估件）」翻转为「产品化 supported」；**V1 范围**：① 终端面板全量可用（upstream `TerminalPanel` +
`/api/terminal`）；② 实现 **1 个最简 PTY bash 工具**做试运行（拿到真实退出码）；其余工具维持非 PTY
`android-exec` 不动；bash 工具深化留待第二轮。

### 库版本（决策 D2，Maven Central 直用）

| 库 | 版本 | 用途 | 说明 |
|---|---|---|---|
| `io.github.fellow99:node-bridge` | `0.2.0` | Kotlin JNI 桥 | 不变 |
| `io.github.fellow99:node-runtime` | `26.13.0` | `libnode.so` + `libc++_shared.so` | 升；small-icu（锁 `--with-intl=small-icu`，Next 载荷安全；满足 pi-ai Node 25+） |
| `io.github.fellow99:node-pty` | `26.13.0` | `libpty_node.so`（node-pty **1.1.0** 交叉编译） | **新增**；与 runtime **逐字同版本**（NODE_MODULE_VERSION 147 配对） |

> **版本对齐纪律（关键）**：
> - pty AAR 的 `libpty_node.so` 由 `aosp-node-pty` 从 **node-pty 1.1.0** 构建（`pty.lock.json#builtFrom.nodePty`）。
> - pi-web 声明的 `node-pty` 依赖是 **1.2.0-beta.15**（`pi-web/package.json`），与原生 1.1.0 **不配对**。
> - 因此**运行期 `require("node-pty")` 必须解析到 node-pty **1.1.0** JS**（与原生同版本），
>   单源取自 `payload/extensions/android-pty/vendor/node-pty`（已是 1.1.0，路线 A 已验证的双件套装）。

## 能力面与验收

### C1 依赖 / 随包（决策 D2 + D3）
| 项 | 行为 | 验收 |
|---|---|---|
| Maven 三件 | bridge 0.2.0 / runtime 26.13.0 / pty 26.13.0 进 APK | `nativeLibraryDir` 出现 `libnode.so` + `libc++_shared.so` + `libpty_node.so`（`unzip -l` 佐证） |
| 锁门禁 | 新增 `verify-pty.mjs`；升级 `verify-runtime.mjs` | AAR 内 3 个 `.so` 的 SHA-256 与 `runtime.lock.json`/`pty.lock.json` 镜像一致；ELF 门禁过 |
| 16KB 对齐 | `useLegacyPackaging=false` | 三个 `.so` 页对齐（packaging 门禁） |
| node-pty 运行期 JS | 载荷 `node_modules/node-pty` = **1.1.0**（vendored overlay）；`prebuilds/` 不随包 | crop 后 overlay；`require("node-pty")` 解析为 1.1.0 |

### C2 启动期原生件装载（决策 D3）
| 项 | 行为 | 验收 |
|---|---|---|
| 常驻加载器 | 把 `runPtyNodeSelftest` 的 route-2 提升为**启动恒执行**（pi-web boot 前）：dlopen `libpty_node.so`（nativeLibraryDir）+ 种子全局 require cache（键=`<pkg>/build/Release/pty.node` 绝对路径，放占位文件） | boot-facts `pty.ready=true`；`require("node-pty")` 命中 |
| 失败结构化 | 装载失败 ⇒ `pty.ready=false` + capability unsupported + boot-facts 落盘；**绝不静默降级成假终端** | 宪法 A6 |

### C3 能力翻转（patch 0001）
| 项 | 行为 | 验收 |
|---|---|---|
| 平台名单 | `PTY_LESS_PLATFORMS` 移除 `"android"`（保留 openharmony/harmonyos） | `GET /api/terminal` 返 `supported:true, platform:"android"` |
| 运行时实测门 | supported 不只靠名单：`ptyEvidence()` 增补 `libpty_node.so` 在位/可装载实测 | 装载失败仍返 supported:false + 结构化 reason |
| 逆可逆 | patch 幂等可反向，`--check` 门禁 | 组装 `--check` 过 |

### C4 终端面板（V1 正主）
| 项 | 行为 | 验收 |
|---|---|---|
| 创建/订阅/写/改/杀 | `/api/terminal` + SSE 事件流全链 | `tty` 返 `/dev/pts/N`；回显/退格/颜色（xterm-256color）正常 |
| 交互 | SIGINT（Ctrl-C）中断前台进程、shell 存活；resize 生效；`exit` 关闭面板 | 真机 T1a–T1e |
| 清理 | `TERMINAL_RECONNECT_MS` 回收；无泄漏 | 关闭后 registry 清理 |

### C5 最简 PTY bash 工具（决策 D1，V1 试运行）
| 项 | 行为 | 验收 |
|---|---|---|
| 单次 spawn | 每次调用 `pty.spawn('/system/bin/sh',['-c',cmd],{cols,rows,cwd,env})`（真 PTY，非常驻） | 输出正确；`tty` 语义在 PTY 内 |
| 完成判据 | **靠 PTY `onExit` 事件取真实退出码**（node-pty waitpid；区别于 android-exec 哨兵法） | 退出码正确返回 |
| 兜底 | 120s 超时 + 进程组 kill（沿用 `android-exec.js` `detached+kill(-pid)` 纪律）；输出有界（截 64KiB） | 超时/中止不泄漏子进程 |
| 围栏 | cwd=会话目录（不存在直接失败）；围栏同现制 | 越界访问被拒 |

### C6 收敛（Node 26 红利）
| 项 | 行为 | 验收 |
|---|---|---|
| 删除 Node 侧 `throwIfAborted` 垫片 | pi-ai 1.2.0 需 Node 25+，26.13.0 满足 | boot 无垫片注入；对话正常 |
| 保留客户端垫片 | Chrome 94 WebView 的 throwIfAborted/timeout/dvh 等 `polyfill-webview.js` | 不变 |

## 平台边界（A6 如实）
- x86_64 模拟器 berberis 翻译层 SIGSEGV（L-ENV）不属本需求；PTY 探针/装载可在模拟器轻探，主体验收走真机。
- mksh 交互兼容（`-l`/prompt/`tty`）以真机 T1 实测为准，必要时微调（不改 upstream terminal-manager）。
- `terminal.pty` 能力符从"unsupported"翻为"supported"；产品取证后回填能力清单 §B.3 #16 → ✅。
