# 104-host-capabilities-kotlin-impl — spec（宿主能力（Kotlin 10 项 + Android 增量））

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
库冻结能力名的 Kotlin 实现（对标 ark 104 的 Android 形态）+ Android 增量能力；每个调用返回结构化 JSON。

## 能力面与验收
| 能力 | 行为 | 状态 |
|---|---|---|
| runtime.facts | 设备/进程事实 JSON | ✅（E2E 宿主桥往返） |
| **runtime.keepAlive**（Android 增量） | 前台服务启停（dataSync + 常驻通知）；dryRun 支持 | ✅ Phase 2（模拟器实测 isForeground=true；Doze SSE ⬜ 随 pi-web） |
| perm.check | 四态真判定：sandbox=true / notification=运行时权限实查 / saf=持久化授权数 / ohos.*=false+平台映射说明 | ✅ Phase 2（selftest 14/14） |
| perm.request | notification → API33+ 运行时请求（异步落 `<HOME>/saf-results/<id>.json`）；ohos.* → 结构化 platform-mapping（指向 SAF）；saf → interactive-only | ✅ Phase 2 |
| perm.openAppInfo | 跳系统应用详情（权限管理入口） | ✅ Phase 2 |
| fs.pickFolder / fs.pickFiles | **SAF 真接入**：ACTION_OPEN_DOCUMENT[_TREE] + takePersistableUriPermission(read\|write) + 树 id/displayName 回读；**异步契约**=立即受理+结果落文件（bridge 0.2.0 同步返回限制）；dryRun 支持 | ✅ Phase 2（dryRun ✅；真弹窗人工路径 ⬜ headless） |
| notify.show | 真实通知（POST_NOTIFICATIONS 未授权⇒结构化 permission 错误，指路 perm.request）；点击回应用（PendingIntent）；BigText | ✅（Phase 2 增强点击行为） |
| shell.openExternal | http(s) only → Intent 系统浏览器；其余 bad-arg；dryRun 支持 | ✅ |
| log.hilog | 追加 host.log 审计 | ✅ |
| terminal.pty | 结构化 unsupported（PTY 暂缓） | ✅ |
| 注册面完整性 | NAMES 全注册（含增量 keepAlive），缺一即 check 失败 | ✅ |

## Phase 2 异步契约（bridge 0.2.0 适配，重要）

`host.register` 只支持同步返回，而 SAF 选择器/权限弹窗是用户交互（分钟级）⇒

1. Node 调 `fs.pickFolder/pickFiles/perm.request(notification)` 立即得到
   `{ok:true, async:true, requestId, resultPath:"<HOME>/saf-results/<id>.json"}`；
2. 用户完成/取消（或 Activity 销毁）后 Kotlin **原子写**结果 JSON；
3. `payload/extensions/android-saf.js` 提供 `invoke + 轮询` 封装（`/saf-pick-folder`、`/saf-pick-files` 命令）；
4. 结果文件目录 = `<filesDir>/node-bridge/saf-results/`（HOME=node-bridge ⇒ Node 可直接 fs 读）。

## 平台边界（A6 如实）
- SAF 返回 `content://` URI，**不是 POSIX 路径**——Node fs 不能直接读；内容消费须走
  ContentResolver（如需落沙箱 inbox 拷贝，另行立项）。
- ohos.* 权限名在 Android 无对应物 ⇒ perm.request 返回 `platform-mapping` 结构化错误并指向 SAF，
  绝不假装授予。
