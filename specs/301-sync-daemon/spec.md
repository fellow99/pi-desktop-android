# 301 — 中枢服务同步（sync-daemon 内嵌）功能规格【pi-desktop-android：本轮暂不实现】

> 需求编号 `301-sync-daemon`。跨端需求，**本轮仅在 pi-desktop 实现**；
> 权威规格见 `pi-desktop/specs/301-sync-daemon/spec.md`（+ `plan.md` / `test-cases.md`）。

## 决策记录

- **范围**：本工程本轮**不实现**中枢服务同步（sync-daemon 内嵌 / 托盘设置入口 / 设置窗口）。
- **理由**：需求明确「pi-desktop-android、pi-desktop-hos、pi-desktop-ark 暂不实现」；
  各端宿主形态（WebView/ArkWeb + 进程内 Node）与 pi-desktop 的 Electron 壳不同，
  daemon 内嵌方案（Electron 二进制 + ELECTRON_RUN_AS_NODE 子进程链路）不直接适用，需另行设计。
- **后续**：若本端启动该需求，另立 plan（参考 pi-desktop 301 plan 的 D1/D2 决策与 pi-agent-hub 文档）。
- **本目录无任何代码改动**。
