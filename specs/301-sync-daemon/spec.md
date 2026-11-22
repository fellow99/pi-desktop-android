# 301 — 中枢服务同步（sync-daemon 内嵌）功能规格【pi-desktop-android】

> 需求编号 `301-sync-daemon`（跨端）。行为基准：`pi-desktop/specs/301-sync-daemon/spec.md`
> （FR-301-001~023）＋第二轮改版（设置并入 pi-web，D18–D20）。
> 本文件定义 **Android 版**的实现口径；与桌面版的差异只在「进程模型」与「宿主接入点」。

## 1. 目标与范围

- 在 **Android 版**内嵌 `@pi-agent-hub/sync-daemon@0.1.2` + `@pi-agent-hub/sync-plugin-pi-web@0.1.2`，
  把本机 pi 会话上行到中枢，并接收下行事件。
- 设置入口与桌面版一致：**pi-web 设置对话框的「中枢服务」分区**（构建期补丁），不新增原生设置页。
- **不实现**独立 sync-daemon 进程：Android 应用内 Node 运行时不支持可用的 `fork/exec` 子进程链路
  （参见 `docs/000-工程规划.md` 平台能力结论），daemon 与插件必须在**同一个 Node 运行时内**运行。

## 2. 与桌面版的差异（关键）

| 项 | pi-desktop | **pi-desktop-android** |
|---|---|---|
| daemon 运行 | 独立子进程（`ELECTRON_RUN_AS_NODE`） | **同进程**（进程内 Node），无 spawn |
| 插件通信 | JSON-RPC / stdio 子进程 | **直接 import 插件类**，方法调用（无 stdio） |
| daemon 启动点 | pi-web 就绪后 | 同（`payload/pi-web-launch.js` 写 ready marker 之后） |
| 设置桥 | preload `piDesktopSync` + IPC | **同源 HTTP**：`/api/sync-daemon`（新增 route，经补丁） |
| 状态推送 | 主进程推送/轮询 | 分区挂载期间每 2.5s 轮询同源 route |
| 崩溃处理 | 子进程隔离，崩溃不影响主进程 | **不得安装会 `process.exit` 的全局崩溃钩子**（会杀整个 App）；同步循环错误只记状态与日志 |

## 3. 功能需求

> 本端新增编号 `FR-301-1xx`；未列出的行为沿用桌面版 FR-301-001~023 的产品语义。

- **FR-301-101**：pi-web 就绪（`writeReadyMarker` 成功）之后，MUST 按配置 `enabled` 在**同一 Node 运行时**
  启动同步运行时；MUST NOT 阻塞首屏（启动失败只置状态与日志）。
- **FR-301-102**：同步运行时 MUST 复用 `@pi-agent-hub/sync-daemon` 的 `Daemon`（hub 客户端 / 调度 / SSE / 下发 /
  串行化），但 MUST NOT 调用会安装 `process.exit` 全局崩溃钩子的启动路径；MUST 以嵌入式启动序列
  （logger.init → manager.start → executor.init → events + initial sync + 30s 定时）运行。
- **FR-301-103**：插件 MUST 以**进程内客户端**接入：直接 `import` `PiWebPlugin`，按其 `dist/main.js` 的方法表
  （initialize/detect/list_sessions/read_session/deliver/get_model_info/check_idle/import_session/export_native/ping）
  实现 `request(method, params, timeout)`；MUST NOT spawn 子进程、MUST NOT 使用 stdio/JSON-RPC。
- **FR-301-104**：配置 MUST 落于 `<HOME>/.pi-desktop/sync-daemon.json`（结构 = SyncDaemonConfig + `enabled`，
  与桌面版同构）；注入项 `agents["pi-web"].options = {server, agentDir, password?}` 由运行时自动填充；
  `pluginRoot = <HOME>/.pi-desktop/sync-daemon`；`pluginInstall = false`。
- **FR-301-105**：设置 UI MUST 为 pi-web 设置对话框最后一个分区「中枢服务」（状态灯 / 地址 / 本端名称 / 令牌 /
  是否启用 / 应用），由构建期补丁实现；文案随 zh-CN / en / zh-TW。
- **FR-301-106**：设置数据面 MUST 经**同源 HTTP** `GET/PUT /api/sync-daemon`（补丁新增 route）：
  route 读取控制文件并代理到本地控制面；令牌 MUST NOT 下发到页面；未知来源/非本机请求按 pi-web 既有鉴权与 Host 校验处理。
- **FR-301-107**：应用 MUST 校验（enabled=true 时 URL 为 http(s)、名称/令牌非空）→ 原子写配置 → 停旧运行时 →
  按新 `enabled` 重启 → 更新状态；错误 MUST 以可读文案返回并保留原配置。
- **FR-301-108**：状态语义 MUST 与桌面版一致（进程/运行时级）：`running / starting / disabled / stopped(reason)`；
  绿色只代表同步运行时存活，不代表中枢连通。
- **FR-301-109**：应用退出/宿主关停时 MUST 停止同步运行时（daemon loop/定时器/控制面），MUST NOT 安装额外
  全局崩溃钩子、MUST NOT 调用 `process.exit`。
- **FR-301-110**：本端 MUST NOT 修改 `../pi` / `../pi-web` 工作树之外的产物；pi-web 改动以
  `patches/v0.17.0/` 下的幂等补丁交付，构建后回退 pristine。
- **FR-301-111**：依赖 MUST 固定 `@pi-agent-hub/sync-daemon@0.1.2` 与 `@pi-agent-hub/sync-plugin-pi-web@0.1.2`，
  随 payload 的 `node_modules` 分发；运行期 MUST NOT 执行 npm install。

## 4. 非功能

- 内存/事件循环：daemon 与 pi-web 同进程，同步循环 MUST 串行（上游 0.1.2 已提供）且不得阻塞 HTTP 事件循环。
- 安全：配置文件 0600；日志不回显令牌/密码；控制面只绑 `127.0.0.1` + Bearer。
- 兼容：Android Node 26.13（small-ICU）；`fetch` / `AbortSignal.timeout` / ESM 动态 import 可用。
- 网络：中枢地址为可达的 http(s) URL（测试用局域网 hub）。

## 5. 场景

- S1：pi-web 首屏可见 → 设置 ›「中枢服务」→ 状态「运行中」；hub 出现本 host 与会话。
- S2：关闭「是否启用」→「应用」→ 运行时停止、状态「未启用」。
- S3：地址不可达 → 主功能正常、状态红、日志有原因；改对后再应用可恢复。
- S4：应用退出 → 无同步定时器/连接残留（进程内无子进程可残留）。
- S5：地址/名称/令牌为空 → 应用被拒，配置文件不变。

## 6. 依赖与落点

- 运行时模块：`payload/sync-runtime.js`（与 Ark 版同一份实现），加入 `scripts/assemble-payload.mjs` 的 payload 条目。
- 装配：`scripts/assemble-payload.mjs` 在 pi-dist staging 的 `node_modules` 内补齐两个 npm 包；
  裁剪规则 MUST 保留 `@pi-agent-hub/**`；补丁标记 MUST 增加 `/api/sync-daemon` 的构建产物断言。
- 补丁：`patches/v0.17.0/0007-sync-daemon-settings-tab.patch`（设置分区 + route + i18n）。
- 文档：`docs/000-工程规划.md`、`README(_zh).md`、`specs/README.md`、补丁 README 同步。

## 7. 验证

真机验证由交接方执行，步骤与判据见
`D:\knowledge-base\pi-workspace\301-sync-daemon-测试交接安卓鸿蒙.md`。本端交付前只做静态/构建门禁
（补丁往返、`node --check`、payload 装配）。
