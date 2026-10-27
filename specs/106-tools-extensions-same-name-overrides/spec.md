# 106-tools-extensions-same-name-overrides — spec（同名顶替扩展四件）

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
bash/find/grep 与运行时事实、工作区根的扩展顶替（对标 ark 106 的 Android 形态）。

## 能力面与验收
| 扩展 | 行为 | 状态 |
|---|---|---|
| android-exec.js | 内建 bash 顶替：/system/bin/sh 常驻 + 哨兵行 + 超时 | ✅ 移植（O5 语义实测成立） |
| android-search.js | find/grep 纯 JS 走查（无 rg/fd 依赖） | ✅ 移植 |
| android-runtime.js | /android-info 命令：运行时事实与工具可用性 | ✅ 移植（文案 Android 化） |
| android-workspace-roots.js | /roots 命令：消费 PI_ANDROID_ROOTS（v1 仅 sandbox 根） | ✅ 手写 Android 版 |
| 物化 | launch 脚本复制 payload/extensions → PI_CODING_AGENT_DIR/extensions（幂等） | ✅（E2E 验证 /roots 与工具面）
