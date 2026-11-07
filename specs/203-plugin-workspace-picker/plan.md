# 插件 · 选择工作区目录（203-plugin-workspace-picker）—— 方案

> 对应 `spec.md`（WHAT）。本文件记 HOW 与决策链（as-built 随实施更新）。

## 1. 方案概览

```
┌─ pi-desktop-android（本工程）─────────────────────────────────────────────┐
│ Kotlin 宿主                                                             │
│   PiDesktopRuntime.kt    PI_ANDROID_ROOTS = [sandbox, documents, download]│
│   HostCapabilities.kt    perm.check / perm.request（存储 SDK 分派）      │
│   MainActivity           onRequestPermissionsResult 转发                 │
│   AndroidManifest.xml    +MANAGE_EXTERNAL_STORAGE + READ/WRITE(≤29)     │
│ payload/extensions/android-workspace-roots.js  /roots（三根）            │
└──────────────────────────────────────────────────────────────────────────┘
                    │ 文件信箱 / PI_ANDROID_ROOTS / /api/host/perm
┌─ patches/v0.15.0/ ────────────────────────────────────────────────────────┐
│ 0002 ?root=<id> 入口 + 沙箱根 ｜ 0005 roots 契约 + 围栏 + 默认名去重      │
│ 0006 403+permission + /api/host/perm + 「请求权限/刷新」 UI（Android 化）  │
│ 0007 移除手输路径                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 关键设计决策（含决策链）

| # | 决策 | 理由 | 依据 |
|---|---|---|---|
| D1 | 三根（沙箱/文档/下载） | 需求明示；Android 无「桌面」概念 | 需求描述 |
| D2 | **方案 A：All-files 授权门** | POSIX 浏览 `/storage/emulated/0/{Documents,Download}` 在 API30+ 仅 All-files 一条路；参考工程（dsh-desktop-android）同方案已真机验收（含 API26–29 崩溃修复 2026-11-01） | 用户 2026-11-07 采纳 A |
| D3 | SDK 分派（API30+ 设置页 / API26–29 运行时弹窗） | 混用会 `ActivityNotFoundException` 或无效（参考工程已踩） | FR-AND-203-007 |
| D4 | 授权是否生效以 `readdir` 为准（probeAccess），不以权限 API 假阳性/假阴性 | 权限 API 有假阴性；真实可读性才是「现在能不能用」的唯一事实 | FR-AND-203-008 |
| D5 | 「请求权限」跳设置返回后由「刷新」重探（不自动回钩） | 最小改动；需求文本即「刷新按钮：重新尝试判断权限、渲染列表」 | FR-AND-203-005/008 |
| D6 | G7.1 修订（用户目录工作区根特例） | G7 红线与方案 A 冲突，方案 A 采纳 ⇒ 加特例；应用面严格限定在工作区选择器的文档/下载根 | FR-AND-203-017 |

## 3. 实施落点（checklist）

| # | 落点 | 文件 | 状态 |
|---|---|---|---|
| 1 | 规格四件套 | `specs/203-plugin-workspace-picker/{spec,plan,test-cases}.md` + `specs/README.md` 登记 | ✅/🔄 |
| 2 | 治理修订 | `docs/000-工程规划.md` §17 G7.1；回引本模块 | 🔄 |
| 3 | roots env | `PiDesktopRuntime.kt`（+documents/download 根） | 🔄 |
| 4 | 宿主授权门 | `HostCapabilities.kt`（`storageGranted()` / `perm.request` SDK 分派 / `perm.check` 存储分支） | 🔄 |
| 5 | Activity 转发 | `MainActivity.kt`（`onResume` 可选 / 已具备 onRequestPermissionsResult） | ✅ 已具备 |
| 6 | manifest | `AndroidManifest.xml`（+`MANAGE_EXTERNAL_STORAGE`、+`READ/WRITE_EXTERNAL_STORAGE` maxSdk=29） | 🔄 |
| 7 | 扩展自检 | `payload/extensions/android-workspace-roots.js`（EXPECTED_IDS 三根 + 授权状态） | 🔄 |
| 8 | 补丁 Android 化 | `patches/v0.15.0/0006`：`permissionForRoot` + `ALLOWED_PERMISSIONS` 改 Android 权限语义；往返验证 | 🔄 |
| 9 | 构建 | 载荷重装配（assemble-payload）+ `gradlew assembleDebug` | 🔄 |
| 10 | 部署验收 | adb 安装 → 沙箱 + 文档/下载授权门 → 建区/对话/看图 | 🔄 |

## 4. 治理修订（G7.1）内容草案

在 `docs/000-工程规划.md` §17 G7 追加：

- **G7.1 特例（需求 203-plugin-workspace-picker，2026-11-07 采纳方案 A）**：仅「选择工作区目录」的
  文档/下载根，允许用户在系统设置授予「所有文件访问」（`MANAGE_APP_ALL_FILES_ACCESS`，API30+）
  或授权 `READ/WRITE_EXTERNAL_STORAGE`（API26–29）。理由：Android 共享存储 POSIX 访问只有该通路，
  需求要求文档/下载可作工作区根；范围严格限定（不用于整盘浏览/不用于其它功能）；
  授权动作由用户显式触发（点「请求权限」），应用不自启、不静默申请；不扩及
  `QUERY_ALL_PACKAGES` / `REQUEST_INSTALL_PACKAGES` / `SYSTEM_ALERT_WINDOW`。

## 5. 评审计划（Phase 3）

- 实施后按 requesting/receiving-code-review 走一遍：重点核对 SDK 分派正确性、`readdir` 终判、白名单、
  越界防护、繁忙态、无需设备即可静态核对项 + 真机证据项。
- 结果落 `logs/<date>-<n>/REVIEW_REPORT.md` + `TEST_REPORT.md`。

## 6. 风险与遗留

| # | 风险 | 缓解 |
|---|---|---|
| R1 | All-files 对部分厂商 ROM 设置页入口缺失 | `resolveActivity` 守卫 + 结构化提示 + 去应用信息兜底 |
| R2 | API26–29 运行时权限无法在本机（API33）验 | 沿用 deepseek 2026-11-01 真机证据 + 代码评审；登记 ⬜ |
| R3 | 授权后共享目录可读时延 | 刷新重探；如遇滞后按 deepseek 的短轮询思路补充 |
| R4 | 手输路径回归 | 0007 往返验证 + 静态断言 |
