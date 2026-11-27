# patches/ — 上游补丁集

> 当前上游基线：`pi-web` tag **`v0.19.0`**（commit `7b77aa1a`）。

## 0.0 v0.19.0 rebase 记录（2026-11-27）

| 项 | 内容 |
|---|---|
| 上游基线 | `pi-web` tag **`v0.19.0`**（`7b77aa1a01a74597280dd5bbc9221195411bddf4`，annotated tag `e5192a7557f73dadea42a76aab785f65597f2197`，`Release v0.19.0`）· `pi` tag **`v1.6.1`**（`ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe`） |
| 生成方式 | 独立 detached worktree `git worktree add --detach ../.tmp/wt-019 v0.19.0`；逐条 `git apply`（冲突条目手工重放）→ `git add` → `git commit` → `git diff HEAD^ HEAD > patches/v0.19.0/<同名>.patch`；**未经 PowerShell 重定向**，全目录 **UTF-8 / LF** |
| 上游变更（v0.18.0→v0.19.0） | 284 文件，+8976/−2383，44 提交 |
| 冲突与处置 | 见下「本轮变更」 |
| 验证 | ① pristine v0.19.0 上按文件名排序逐条 `git apply --check` + `git apply` 全绿（6/6）；② 反序 `git apply --reverse` 后 `git status --porcelain` 为空 |

### 本轮变更

| 补丁 | 变更 |
|---|---|
| `0001-terminal-capability-unsupported` | **导入重定位**：上游给 `app/api/terminal/route.ts` 加了 `import { errorMessage } from "@/lib/errors"`，正好落在本补丁插入 `terminalCapability` 导入的位置。本轮改为插在 `errorMessage` 之后。`lib/terminal-capability.ts` 的 Android PTY 分支（`globalThis.__piWebPty`）不变 |
| `0002-cwd-sandbox-root-from-android-roots` | 无冲突，逐字节沿用 |
| `0003-cwd-adb-path-alias-normalize` | 无冲突，逐字节沿用 |
| `0004-session-export-runtime-identity-guard` | 无冲突，逐字节沿用 |
| `0005-directory-picker` | **1 处上下文冲突**：同 Ark，上游 `createDirectory` 改用 `readJsonOrThrow` + 两处 `errorMessage(cause)`。处置：`--exclude=components/DirectoryPicker.tsx` 应用其余文件后在 v0.19.0 上重放该文件（上游 4 处改动逐一采纳；`loadDirectories` 保留 `BrowseError`）。补丁 44093 B |
| `0008-system-back` | 无冲突，逐字节沿用 |

## 0.0b v0.18.0 rebase 记录（2026-11-22）

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
| `0008-system-back` | 无冲突，重新生成 |

> **301 退场（2026-11-24）**：`0007-sync-daemon-settings-tab` 已移除 —— 中枢服务（`301-sync-daemon`）对接由 `pi-desktop` 单独提供，本工程不再内嵌 sync-daemon、不再随载荷分发 `@pi-agent-hub/*`；补丁目录保留编号空洞（0006 早已并入 0005，0007 本轮退役），既有编号不复用。
