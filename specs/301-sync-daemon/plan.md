# 301 — 中枢服务同步 技术实现方案【pi-desktop-android：本轮暂不实现】

> 与 `spec.md` 成对。本轮无设计、无实现：见 spec.md 决策记录。
> 复用要点（供后续轮次参考）：`@pi-agent-hub/sync-daemon` 提供编程 API（`Daemon` 类 / `runDaemon`）
> 与 CLI（`dist/main.js run --config`）；插件 `sync-plugin-pi-web` 以 JSON-RPC/stdio 子进程对接
> 独立 pi-web HTTP server；配置结构见 `pi-agent-hub/packages/sync-daemon/src/config.ts`。
