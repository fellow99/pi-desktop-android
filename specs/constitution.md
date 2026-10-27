# constitution.md — pi-desktop-android 宪法原则

> 本工程的**不可协商原则**。与 `docs/000-工程规划.md` §3.2（设计原则 A1–A10）一一对应，这里是宪法口径的最小集。
> 结论冲突时：规划文档 = 事实权威，本文档 = 行为权威，specs/ = 细化与验收。

## C1 一切经同源 HTTP

前后端只通过同源 HTTP/SSE 通信（WebView ↔ 进程内 pi-web 服务）。**不**加 JavascriptInterface 桥、**不**引入 IPC 载体。
后果：数据面的一切结论都能用 `adb forward + curl` 取证（判据纪律的物理基础）。

## C2 壳薄、契约硬

Kotlin 侧只做四件事：**启动编排、渲染壳（加载/错误/诊断）、宿主能力、围栏与生命周期**。业务全在 Node 侧（pi-web + pi agent）。
宿主能力名沿用库冻结清单；不注册的能力 = Node 侧 `unregistered`（这是对的，不是缺陷）。

## C3 结论以库与真机为准

运行时事实（dlopen/线程/解包/日志）引用 `aosp-node-bridge` 文档章节号；🔶 沿用 ≠ 本工程事实，消费方必须真机/模拟器自证后才可升级 ✅。
证据标记：✅ 实测 · 🔶 沿用 · ⬜ 待验证 · ⚠️ 冲突/风险（规划 §0.2）。

## C4 不改上游

`pi` / `pi-web` 上游源码零修改；只允许**幂等、可反向**的补丁（`patches/v0.12.1/`，按被 patch 的 tag 建目录）。
补丁纪律：先 `--reverse --check`（整栈逆序判定已应用）→ 正向 `--check` → 应用 → 反向 → SHA-256 逐文件还原断言 → 再应用；冲突即终止，**绝不 `--3way`**；流水线收尾 pi-web 必须 pristine。

## C5 失败可见

加载页阶段文本 + 错误页（stage/message/日志尾）+ 诊断能力（`logs()`/`lastCrash()`）。崩溃是终态：明确提示「请重启应用」，
绝不假装可重启（`node::Start` 每进程一次，硬约束 ⑥）。
判据纪律：一切「成功」必须是**可读回的证据**（HTTP 200 JSON / 截图 / marker 文件），**不以 logcat 有没有那行当判据**。

## C6 不隐藏平台真相

能力缺口如实上报：PTY 暂缓（补丁 0001 结构化 unsupported）、spawn 受限（不依赖 exit/close 时序）、共享存储无 POSIX 路径（SAF Phase 2）。
桩能力返回 `unsupported` + 阶段说明，不静默、不降级、不伪造成功。

## C7 端口随机 + 单实例

服务端口 `listen(0)` 先探后用 + marker 回传真实端口；应用 `singleTask`。固定端口互抢 = 硬故障（Phase 0 实测：15577 被同族应用占用 ⇒ Node 事件循环清空 ⇒ Exited）。

## C8 最小权限面

仅 `INTERNET` + `ACCESS_NETWORK_STATE`；不申请 `MANAGE_EXTERNAL_STORAGE` / `QUERY_ALL_PACKAGES` / `REQUEST_INSTALL_PACKAGES` / `SYSTEM_ALERT_WINDOW`。
工作区默认根 = app-specific 外存真实路径（免权限）；共享存储一律走 SAF（Phase 2 桥接）。

## C9 敏感信息不入库

API Key / 密码 / 凭证只落设备沙箱（`auth.json` 0600）或 gitignored 本地文件。仓库（含 specs/docs/日志归档）提交前必须过敏感信息扫描。
日志与文档引用凭证只报**长度/指纹**，不回显。

## C10 可证伪的验收

每条验收写成「能观测到 X」；as-built 与 planned 逐条区分（specs 模板强制）；测不了的写 ⬜ 并登记时限，不写乐观结论。
