# 301 — 中枢服务同步 技术实现方案【pi-desktop-android】

> 与 `spec.md` 成对。行为基准：`pi-desktop/specs/301-sync-daemon/{spec,plan}.md`（D1–D20）。
> 本方案只解决「Android 无子进程可用」这一差异。

## 1. 技术上下文

- 宿主：Kotlin `Activity` + 系统 WebView；Node 通过 `aosp-node-bridge 0.2.0` + Maven `node-runtime 26.13.0`（small-ICU）
  在**应用进程内**运行；`payload/pi-web-launch.js`（CJS）进程内起 Next，写 `pi-web.ready.json`。
- 不依赖 Chromium/Electron；端口为 loopback 随机端口；`HOME` 指向应用沙箱。
- 依赖分发：`scripts/assemble-payload.mjs` 把 `build/pi-dist` 裁剪后打成 `assets/pi-web/pi-web.tar.gz`。
- 上游包：`@pi-agent-hub/sync-daemon@0.1.2`（导出 `Daemon`；`dist/plugin-manager.js` 内含
  `PluginManager`/`stableAgentId`）、`@pi-agent-hub/sync-plugin-pi-web@0.1.2`（导出 `PiWebPlugin`）。

## 2. 关键决策

| # | 决策 | 理由 / 影响 |
|---|---|---|
| DA-1 | daemon 与插件**同进程**运行，不 spawn | Android 应用内无可用的 Node 子进程链路（平台封死）；与 spec FR-301-102/103 |
| DA-2 | 复用上游 `Daemon`，替换 `manager` 与 `executor` | 复用 hub 客户端/调度/SSE/下发/串行化；避免自研同步引擎。`Daemon` 构造后 `daemon.manager = inproc; daemon.executor = new DeliverExecutor({... manager: inproc})` |
| DA-3 | **不调用** `daemon.start()` | 上游 `start()` 会 `installCrashHandlers()`，其中 `uncaughtException/unhandledRejection → process.exit(1)`，会杀整个 App。改为嵌入式启动序列（logger.init → manager.start → executor.init → runEvents + initial sync + 30s 定时） |
| DA-4 | 插件用 `InProcessClient`（直接方法调用） | `dist/main.js` 的处理器表一一映射；无 stdio；`request()` 带超时；`close()` 置位即可 |
| DA-5 | 设置 UI 用 pi-web 补丁 + 同源 route | 与桌面版功能一致；WebView 无法使用 Electron preload；route 代理控制面，令牌不出服务端 |
| DA-6 | 配置路径 `<HOME>/.pi-desktop/sync-daemon.json` | 与桌面同构；沙箱 HOME 使多端互不干扰 |
| DA-7 | 依赖装入 pi-dist staging 的 `node_modules` | 运行期由 pi-dist 解析；`pluginInstall=false`，离线可用；裁剪 keep `@pi-agent-hub/**` |

## 3. 组件

```
payload/sync-runtime.js（CJS，单文件）
  ├─ resolvePackages(piDistRoot)：createRequire 定位 daemon/plugin 入口
  ├─ InProcessPluginManager extends PluginManager（file: import 内部模块）
  ├─ InProcessClient：initialize/detect/list_sessions/read_session/deliver/...（超时/关闭）
  ├─ Supervisor：配置读写(0600/原子)、状态机、串行队列、控制面(127.0.0.1 + Bearer + control.json)
  └─ start/stop/apply；嵌入式 daemon 启动序列（DA-3）
```

- `payload/pi-web-launch.js`：`writeReadyMarker` 之后调用 `startSyncRuntime({ piDistRoot, serverUrl, agentDir, password })`
  （不 await 阻塞就绪）；`registerShutdownHook` 内调用 `stopSyncRuntime()`。
- 控制面：`GET /local/status`（state/reason/settings）、`POST /local/apply`（校验/写盘/重启）。
- route（补丁）：`app/api/sync-daemon/route.ts`
  - GET：读 `<HOME>/.pi-desktop/sync-daemon/control.json` → 调控制面；不可达返回 `stopped`。
  - PUT：转发到 `/local/apply`；错误以可读文案返回。
  - 标记：`pi-sync-daemon-route-v1`（装配脚本断言）。

## 4. 文件与落点

| 文件 | 动作 |
|---|---|
| `payload/sync-runtime.js` | **新增**（与 Ark 同源） |
| `payload/pi-web-launch.js` | **改**：就绪后启动、关停钩子停止 |
| `scripts/assemble-payload.mjs` | **改**：payload 条目 + 安装/复制 `@pi-agent-hub/*` + keep 规则 + 补丁标记 |
| `patches/v0.17.0/0007-sync-daemon-settings-tab.patch` | **新增**：设置分区 + route + i18n |
| `patches/README.md` | **改**：登记 P301-A1 |
| `specs/301-sync-daemon/{spec,plan}.md` | **新增/替换**（本文件） |
| `docs/000-工程规划.md`、`README(_zh).md`、`specs/README.md` | **改**：口径（嵌入式、0 子进程、补丁数 6→7） |

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 同进程同步循环阻塞 UI | 上游 0.1.2 已串行化；控制面/设置轮询走异步；观测首屏与交互延迟（交接方） |
| 上游 `Daemon` 内部字段（logger/manager/executor/runEvents）变化 | 版本固定 0.1.2；升级时复核并更新补丁/运行时（登记在补丁 README） |
| Node 26 small-ICU / 无 Intl 影响 | 现有 pi-web 已验证；同步不使用 Intl |
| 全局崩溃钩子缺失导致静默失败 | 运行时自行捕获 daemon 启动/循环错误，写状态与日志；不吞掉主流程 |
| 依赖遗漏被裁剪 | keep `node_modules/@pi-agent-hub/**`；装配后断言入口文件存在 |

## 6. 交付与验证

- 补丁往返（apply→reverse→SHA-256 还原）、`node --check`、`assemble-payload.mjs` 装配（含标记断言）。
- 真机由交接方按 `301-sync-daemon-测试交接安卓鸿蒙.md` 执行：安装 → pi-web 设置配置 → hub 观察 → 禁用/恢复。
