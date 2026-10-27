# 104-host-capabilities-kotlin-impl — spec（宿主能力（Kotlin 10 项））

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
库冻结能力名的 Kotlin 实现（对标 ark 104 的 Android 形态）；每个调用返回结构化 JSON。

## 能力面与验收
| 能力 | v1 行为 | 状态 |
|---|---|---|
| runtime.facts | 设备/进程事实 JSON | ✅（E2E 宿主桥往返） |
| perm.check | sandbox=true；SAF 类 null（Phase 2 判定） | ✅ 桩如实 |
| perm.request / perm.openAppInfo | unsupported + Phase 2 标注 | ✅ 桩如实 |
| fs.pickFolder / fs.pickFiles | unsupported + Phase 2（SAF） | ✅ 桩如实 |
| notify.show | 真实通知（POST_NOTIFICATIONS 未授权⇒结构化 permission 错误） | ✅ |
| shell.openExternal | http(s) only → Intent 系统浏览器；其余 bad-arg | ✅ |
| log.hilog | 追加 host.log 审计 | ✅ |
| terminal.pty | 结构化 unsupported（PTY 暂缓） | ✅ |
| 注册面完整性 | NAMES 全注册，缺一即 check 失败 | ✅
