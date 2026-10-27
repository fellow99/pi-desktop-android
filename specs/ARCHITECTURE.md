# ARCHITECTURE.md — 整体架构

> 架构图与数据流。细节依据 `docs/000-工程规划.md` §4；本文件随 as-built 演进。

## 分层

```
┌─ APK（Pi Desktop / org.fellow99.pi.PiDesktopAndroid）──────────────────────────────┐
│ app 模块                                                                            │
│  ┌─ Kotlin 宿主（本工程）─────────────────────────────────────────────┐            │
│  │ MainActivity（singleTask）                                          │            │
│  │   ├ 三态壳 UI：加载页（阶段文本）/ WebView / 错误页（stage+日志尾+重启）│            │
│  │   ├ 围栏：非 loopback 主 frame → 系统浏览器；禁止多窗口；返回键守卫    │            │
│  │ runtime/PiDesktopRuntime（启动编排，StateFlow 三态）                  │            │
│  │   ├ HostCapabilities（10 能力，库冻结名）                            │            │
│  │   ├ PayloadArchive（tar.gz → payloadRoot，SHA-256 幂等）             │            │
│  │   └ 就绪判定：pi-web.ready.json 端口 + /api/web-auth 200             │            │
│  └──────────────▲────────────────────────────┬────────────────────────┘            │
│                 │ JNI + StateFlow              │ loadUrl(127.0.0.1:<port>/)         │
│  ┌──────────────┴────────────────────────────▼────────────────────────┐            │
│  │ node-bridge 0.2.0（libnode_bridge.so + libnode_host_client.so）     │            │
│  │ node-runtime 24.2.0（libnode.so + libc++_shared.so，arm64）          │            │
│  └──────────────┬────────────────────────────────────────────────────┘            │
│                 │ 同一进程：detached 线程 dlopen → node::Start                     │
│  ┌──────────────▼────────────────────────────────────────────────────┐            │
│  │ 载荷（assets/pi-web/pi-web.tar.gz → 首启解包到 filesDir/node-bridge/payload）    │
│  │  bootstrap.js → pi-web/pi-web-launch.js（env→随机端口→进程内 Next）→ pi agent     │
│  │  extensions/{android-exec,search,runtime,workspace-roots} · jitless/ · config/   │
│  │  监听 127.0.0.1:<随机端口> ｜ SPA + /api/* + SSE ｜ marker + PI_WEB_READY        │
│  └───────────────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## 启动时序（失败可见）

1. `MainActivity.onCreate` → 加载页
2. `PiDesktopRuntime.start`（后台线程）：
   `注册宿主能力` → `解包载荷（marker 幂等）` → `rt.start(entry=bootstrap.js, appEntry=pi-web-launch.js, cwd=payloadRoot/pi-web)` → `轮询 marker（真实端口，150s）` → `探活 /api/web-auth（400ms 间隔，90s）` → `markRunning()` → **Ready**
3. 任一步失败 → **Failed(stage, message, logTail)** → 错误页（重启 = 重启应用进程，Node 不可重启）
4. Ready → WebView `loadUrl("http://127.0.0.1:<port>/")`（同源、零 CORS、无 IPC 载体）

## 责任分界

| 层 | 归属 | 内容 |
|---|---|---|
| Node 运行时层 | `aosp-node-bridge`（Maven） | dlopen/node::Start、线程与生命周期、内建载荷物化、HOME/TMPDIR、日志与崩溃取证、宿主桥传输 |
| 应用宿主层 | **本工程** | 启动编排、渲染壳、载荷解包（app 侧）、宿主能力、围栏、环境装配（Kotlin 侧 options.env） |
| 载荷层 | 本工程 `payload/`（Node 代码） | pi-web-launch / env 契约 / 同名顶替扩展 / jitless 兼容层 / config / skills |
| 上游层 | `pi` / `pi-web`（只读） | 原样复用；仅幂等补丁（`patches/v0.12.1/`） |

## 数据流

- **UI 数据面**：WebView ⇄ 同源 `http://127.0.0.1:<port>/`（fetch /api/* + SSE）——无 CORS、无桥。
- **宿主桥**：Node `host.invoke(name,args)` → libnode_host_client.so → 槽位表 → libnode_bridge.so → Kotlin `Handler` 分发 → 结构化 JSON 返回。
- **构建面**（宿主机）：`patches → pi-web 工作树` →（标记缺失时）`next build --webpack` → `PI_DIST` → 裁剪暂存（硬链接）→ 壳资产 → 确定性 tar.gz → `app/src/main/assets/pi-web/` → Gradle APK。

## 环境契约（Kotlin ↔ 载荷，`payload/env.js` 为唯一事实源）

| 变量 | 装配方 | 值 |
|---|---|---|
| `HOME` | 库 | `<filesDir>/node-bridge` |
| `PI_CODING_AGENT_DIR` | Kotlin | `<filesDir>/pi-agent` |
| `PI_ANDROID_ROOTS` | Kotlin | `[{"id":"sandbox","label":"工作区","path":"<getExternalFilesDir>/workspace","permType":null}]` |
| `NO_PROXY`/`no_proxy` | Kotlin（保留继承+追加 loopback） | `127.0.0.1,localhost,::1` |
| `PI_WEB_HOSTNAME`/`PI_WEB_PORT` | env.js | `127.0.0.1` / `0`（Node 侧随机探取，marker 回传） |
| `PI_WEB_PASSWORD` | 不设（路线 ① 免密） | — |
| `PI_WEB_APP_NAME` / `PI_WEB_SKIP_VERSION_CHECK` | env.js | `Pi Desktop` / `1` |
| `PI_OFFLINE` | **刻意不设**（Android 出网可达；显式 `1` 才离线） | — |
