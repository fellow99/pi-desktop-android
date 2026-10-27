# 101-runtime-integration-launch-orchestration — spec（运行时接入与启动编排）

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
把 aosp-node-bridge/node-runtime 双 AAR 接入 Android 应用，完成「进程内 Node 拉起 pi-web」的启动编排（对标 ark 101）。

## 验收（planned → as-built）
| # | 判据 | 状态 |
|---|---|---|
| 1 | 双 AAR 依赖锁定（bridge 0.2.0 implementation / runtime 24.2.0 runtimeOnly） | ✅ |
| 2 | 启动顺序：注册宿主能力 → 解包载荷 → rt.start（顺序不可反，bridge README） | ✅ |
| 3 | 就绪判据 = marker 真实端口 + /api/web-auth 200（不猜端口） | ✅ |
| 4 | 失败可见：Failed(stage,message,logTail) → 错误页 | ✅ |
| 5 | 解包幂等：SHA-256 marker 二次启动 0ms 跳过 | ✅（O4：18.0s 冷解/0ms 幂等） |
| 6 | 优雅关停尽力而为（bridge 0.2.0 无 Node 侧 handle，如实登记） | ✅ |

## 实现锚点
- `app/src/main/java/org/fellow99/pi/PiDesktopAndroid/runtime/PiDesktopRuntime.kt`
- `app/src/main/java/org/fellow99/pi/PiDesktopAndroid/payload/PayloadArchive.kt`
- 证据：`docs/002-真机验证记录.md`、`docs/evidence/`
