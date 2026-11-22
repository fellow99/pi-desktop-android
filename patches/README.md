# patches/ — 上游补丁集

> 当前上游基线：`pi-web` tag **`v0.18.0`**（commit `2daa0d1`）。

## 0.0 v0.18.0 rebase 记录（2026-11-22）

| 项 | 内容 |
|---|---|
| 上游基线 | `pi-web` tag **`v0.18.0`**（`2daa0d131eae6c2fd8c2a80872eee01ea3c7a0a1`，annotated tag `38bb6805`）· `pi` tag **`v1.6.0`**（`faac585884ae2c013a6b1400f3e9e77f10b34bac`） |
| 生成方式 | 独立 detached worktree `git worktree add --detach ../.tmp/wt-018 v0.18.0`；逐条 `git apply`（冲突条目手工重放）→ `git add` → `git commit` → `git diff HEAD^ HEAD > patches/v0.18.0/<同名>.patch`；全目录 **UTF-8 / LF** |
| 行尾口径修正 | v0.17.0 目录下 7 条补丁中 6 条为 **CRLF**（仅 `0007` 为 LF）。LF 工作树上 `git apply` 对 CRLF 补丁必然失败，只有 Git-for-Windows（`core.autocrlf=true`）能容错。本轮起统一 LF，并已在 LF 环境逐条验证 |
| 冲突与处置 | `0001`/`0004` 与上游 v0.18.0 冲突，见下「本轮变更」 |

### 本轮变更

| 补丁 | 变更 |
|---|---|
| `0001-terminal-capability-unsupported` | **重定位**：上游 #1750 在 `app/api/terminal/route.ts` 顶部新增 `import { cwdMissingBody } from "@/lib/missing-cwd"` 并把 `stat(cwd)` 包进 try/catch 返回 400，致原 hunk 上下文漂移。本轮把 `import { terminalCapability }` 插到 `cwdMissingBody` 之后、`createTerminal` 之前，`GET()` 与 `POST` 能力门位置不变 |
| `0002-cwd-sandbox-root-from-android-roots` | 无冲突，重新生成 |
| `0003-cwd-adb-path-alias-normalize` | 无冲突，重新生成 |
| `0004-session-export-runtime-identity-guard` | **删除冗余 hunk 片段**：上游 #1695 已自行加 `/* webpackIgnore: true */`，本轮保留首 hunk 与 `console.warn` 诊断块，删去重复的 import 行改写与 4 行中文说明 |
| `0005-directory-picker` | 无冲突，重新生成 |
| `0007-sync-daemon-settings-tab` | 无冲突，重新生成 |
| `0008-system-back` | 无冲突，重新生成 |

## 附录：P301-A1 — 中枢服务设置分区（2026-11-22）

| 项 | 内容 |
|---|---|
| 文件 | `patches/v0.18.0/0007-sync-daemon-settings-tab.patch` |
| 全局编号 | `P301-A1` |
| 打补丁的上游 | `pi-web` tag `v0.18.0` |
| 内容 | `lib/settings-navigation.ts`（加 `sync`）、`components/SettingsPanel.tsx`（分区项/渲染）、新增 `components/SyncConfig.tsx`（fetch `/api/sync-daemon`）、新增 `app/api/sync-daemon/route.ts`（代理进程内控制面）、三套 `lib/i18n/messages/*.ts` |
| 触发条件 | 301 第三轮：pi-desktop-android 无可用子进程，sync-daemon 与插件改为**进程内**运行；设置入口统一到 pi-web 设置对话框 |
| 实施时机 | `assemble-payload.mjs` / `collect-pi.mjs` 构建期幂等应用，构建后回退（`../pi-web` 保持 pristine） |
| 替代方案 | 原生设置页（重复建设，否决）；运行时 DOM 注入（依赖上游结构、升级静默失效，否决） |
| 回退方式 | `git -C ../pi-web apply --reverse patches/v0.17.0/0007-sync-daemon-settings-tab.patch` |
| 规格 | `specs/301-sync-daemon/{spec,plan}.md` |
