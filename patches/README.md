
## 附录：P301-A1 — 中枢服务设置分区（2026-11-22）

| 项 | 内容 |
|---|---|
| 文件 | `patches/v0.17.0/0007-sync-daemon-settings-tab.patch` |
| 全局编号 | `P301-A1` |
| 打补丁的上游 | `pi-web` tag `v0.17.0` |
| 内容 | `lib/settings-navigation.ts`（加 `sync`）、`components/SettingsPanel.tsx`（分区项/渲染）、新增 `components/SyncConfig.tsx`（fetch `/api/sync-daemon`）、新增 `app/api/sync-daemon/route.ts`（代理进程内控制面）、三套 `lib/i18n/messages/*.ts` |
| 触发条件 | 301 第三轮：pi-desktop-android 无可用子进程，sync-daemon 与插件改为**进程内**运行；设置入口统一到 pi-web 设置对话框 |
| 实施时机 | `assemble-payload.mjs` / `collect-pi.mjs` 构建期幂等应用，构建后回退（`../pi-web` 保持 pristine） |
| 替代方案 | 原生设置页（重复建设，否决）；运行时 DOM 注入（依赖上游结构、升级静默失效，否决） |
| 回退方式 | `git -C ../pi-web apply --reverse patches/v0.17.0/0007-sync-daemon-settings-tab.patch` |
| 规格 | `specs/301-sync-daemon/{spec,plan}.md` |
