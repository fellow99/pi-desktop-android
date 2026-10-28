# 104-host-capabilities-kotlin-impl — plan（宿主能力（Kotlin 10 项 + Android 增量））

> 技术方案与 as-built 说明。

## 方案
- 能力名清单取自 ark HostCapabilities.ets 冻结表（去掉 ohos.* 专有项）+ Android 增量 `runtime.keepAlive`。
- 全部主线程执行（库 dispatcher 保证）；暂缓项返回结构化 unsupported —— 宪法 C6 不假装成功。
- **Phase 1（as-built ✅）**：桩实现如实返回 unsupported/结构化错误（specs/104 v1 口径）。
- **Phase 2（as-built ✅ 2026-10-29）**：
  - SAF：`ACTION_OPEN_DOCUMENT_TREE` / `ACTION_OPEN_DOCUMENT` + `takePersistableUriPermission`；
    Activity 承载经 `HostCapabilities.attach/detach`（WeakReference）+ `handleActivityResult/PermissionResult`
    由 MainActivity 转发；Activity 销毁时未决请求一律落 `cancelled`（轮询可收敛）。
  - 异步通道：结果原子写 `<filesDir>/node-bridge/saf-results/<requestId>.json`（tmp+rename），
    Node 侧 `android-saf.js` 扩展轮询（5min 超时，只读 home/payload/host.js 复用 bridge 客户端）。
  - 授权流：`perm.request` 白名单式映射（notification/ohos.*/saf/未知），`POST_NOTIFICATIONS` 走
    `Activity.requestPermissions`（API 33+），结果同通道落盘；`perm.openAppInfo` 跳应用详情。
  - 前台服务：`PiForegroundService`（`foregroundServiceType="dataSync"`，IMPORTANCE_LOW 常驻通知，
    START_STICKY，contentIntent 回 MainActivity）；`runtime.keepAlive {enable}` 启停；
    Manifest 增 POST_NOTIFICATIONS / FOREGROUND_SERVICE(_DATA_SYNC)；无开机自启（合规 G7）。
  - dryRun：pick*/keepAlive/openExternal 支持 `dryRun:true` —— 回「会发什么 Intent」不弹 UI，
    供 selftest 与回归（`pi-web.selftest.json`）。

## 验收证据（模拟器 emulator-5554，API 37）
- selftest 14/14（`pi-web.selftest.json`；`am start --ez selftest true` 注入 `PI_ANDROID_SELFTEST=1`，
  launch 脚本在 startNext 之前跑全能力面只读/dryRun 调用）。
- 前台服务：`isForeground=true types=0x1` + 常驻通知；Doze deep-idle 20s 进程/服务存活
  （SSE 端到端 ⬜ 随 pi-web，真机项）。
- 崩溃哨兵（P1-5）：`PiApplication` + `am start --ez crash-test true` 受控验收 ⇒
  `files/crash/last-crash.txt` 完整落盘 + 重启横幅（evidence/crash-banner-emulator.png）。
- 引擎事实（P1-3）：`EngineFacts.kt` 启动写 + 轮询合并 `pi-web.boot-facts.json`（launch 侧 Intl/WASM 探针）。

## 踩坑记录（docs/002 详版）
1. cacheDir 跨升级存活 ⇒ materializeArchive 必须每次重拷（幂等键归解包 marker）。
2. singleTask 的 `am start --ez` extras 走 onNewIntent ⇒ 钩子两处都接。
3. `--ez crash-test` 的 extra 名带连字符；`am crash` 打到 WebView 沙箱进程，不可用于哨兵验证。
4. API 37 shell 不能启动非导出服务 ⇒ 服务验证走应用内能力调用。
