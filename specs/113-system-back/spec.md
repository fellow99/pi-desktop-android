# 113-system-back — spec（系统级返回按钮行为改造 · Android）

> **Module:** 113-system-back ｜ **Status:** 开发中 ｜ **Last Updated:** 2026-11-11
> **需求编号:** 113-system-back ｜ **需求名称:** 修改系统级返回按钮对应用的行为
> **git 分支:** 不改动 ｜ **测试真机:** 8f155833（M2105K81C，SDK 33 / Android 13）
> **上游基线:** pi-web v0.15.0（tag `f130910`）· 关联模块 `102-payload-pipeline-assembly-crop`
> **实现载体:** 上游幂等补丁 `patches/v0.15.0/0008-system-back.patch` + Kotlin 宿主 `MainActivity.kt`
> **产物:** spec.md / plan.md / tasks.md / test-cases.md（本目录）
> **注:** 该需求**不注册到父工程 specs**，仅落到各子工程 `specs/113-system-back/`。

---

## 1. 模块概述

### 1.1 目的

把系统级「返回」键对应用的行为从「退出/WebView 回退」改为「按界面浮层收敛」：

- 设置页打开 → **关闭设置页**；
- 移动端抽屉打开 → **收回抽屉**；
- 首页 / 会话页 / 无浮层 → **不做任何操作**（不退出应用、不 WebView 回退）。

### 1.2 解决的问题

| # | 痛点 | 结论 |
|---|---|---|
| 1 | 主界面按返回直接退出到桌面，误触即丢现场 | READY 态返回键不再退出/goBack；由 Web 收敛浮层 |
| 2 | 设置页在手机上无醒目关闭入口 | 返回键 = 关闭设置页 |
| 3 | 移动端抽屉/侧边栏遮挡内容 | 返回键 = 收回抽屉 |
| 4 | 首页/会话页「返回无意义」 | no-op（壳不退出）——与 ark 现行「主界面不退出」哲学对齐 |
| 5 | Web 浮层状态在 React 内部，壳无法直读 | 走既有**幂等补丁**改 pi-web（AppShell），壳只负责把返回派发进页面 |

**范围收敛（用户确认 ①）：** 本模块**不驱动 HTML 弹窗**（MCP 配置/目录选择器/图片预览等弹层不做返回关闭）。
**范围收敛（用户确认 ②）：** 全自动执行 Specification → Development → Code Review → Testing → Bug Fix → Regression。

### 1.3 范围

**包含**：web 补丁（`pi-back` 事件 → 关设置页/抽屉，其余 no-op）、Android `onBackPressed` 改造、
spec 四件套、真机构建部署（**覆盖更新 `adb install -r`，不卸载**）与验收。

**不包含**：HTML 弹窗返回关闭、桌面端返回语义（壳只会在手机形态派发）、父工程 specs 登记（同 hos/ark）、
WebView 历史 goBack 语义（READY 后不再使用）。

## 2. 用户故事

- 作为用户，我在设置页按系统返回，设置页关闭、回到之前的界面，而不是退出应用。
- 作为用户，我拉出移动端抽屉后按系统返回，抽屉收回。
- 作为用户，我在首页或会话页按系统返回，应用保持现状、不退出到桌面。

## 3. 功能需求

### 3.1 协议（web ⇄ 壳）

- **FR-AND-113-001** 壳在 READY（WebView 已挂载主界面）后捕获系统返回键时，MUST 通过
  `web.evaluateJavascript` 派发 `window.dispatchEvent(new Event('pi-back'))` 到页面主 world。
- **FR-AND-113-002** 壳 MUST NOT 在该路径继续调用 `web.goBack()` 或 `super.onBackPressed()`（不退出、不回退）。
- **FR-AND-113-003** 页面补丁（AppShell）监听 `pi-back` 事件；事件协议名固定为 `'pi-back'`，全平台一致。

### 3.2 Web 补丁行为（pi-web AppShell）

- **FR-AND-113-004** 收到 `pi-back` 且 `settingsSection !== null` ⇒ MUST 关闭设置页
  （`setSettingsSection(null)` + `setModelsRefreshKey(k=>k+1)`，与现有 onClose 同语义）。
- **FR-AND-113-005** 收到 `pi-back` 且设置页未开、`isMobile && sidebarOpen` ⇒ MUST 收回移动端抽屉（`setSidebarOpen(false)`）。
- **FR-AND-113-006** 其余情形（首页 `showChat=false`、会话页 `showChat=true`、桌面端无抽屉）⇒ MUST **no-op**
  （页面不退出、不导航；壳也不退出）。
- **FR-AND-113-007** 补丁 MUST 幂等：重复 `evaluateJavascript` 派发无副作用；监听器随 AppShell 卸载清理。

### 3.3 宿主（MainActivity.kt）

- **FR-AND-113-008** `onBackPressed()`：`webAttached == true` 时派发 `pi-back` 后直接返回（消费返回键）。
- **FR-AND-113-009** `webAttached == false`（加载/错误页，WebView 未挂载）⇒ 保留原 `super.onBackPressed()`
  （退出），作为跳出加载/错误页的兜底。
- **FR-AND-113-010** 派发必须在主线程（`onBackPressed` 本就主线程）；`evaluateJavascript` 结果回调不处理（fire-and-forget）。

## 4. 验收

| # | 判据 | 状态 |
|---|---|---|
| 1 | 6/7 条既有补丁 + 0008 幂等应用，往返校验（SHA-256 逐文件还原） | ⬜ |
| 2 | 设置页打开时按返回 ⇒ 设置页关闭、回原界面、应用不退出 | ⬜ 真机 |
| 3 | 移动端抽屉打开时按返回 ⇒ 抽屉收回、应用不退出 | ⬜ 真机 |
| 4 | 首页按返回 ⇒ 界面不变、应用不退出 | ⬜ 真机 |
| 5 | 会话页按返回 ⇒ 界面不变、应用不退出 | ⬜ 真机 |
| 6 | READY 前（加载页）按返回 ⇒ 仍可退出（原行为） | ⬜ 真机 |
| 7 | 部署用覆盖更新（`adb install -r`），不卸载应用 | ⬜ 真机 |

## 5. 实现锚点

- `patches/v0.15.0/0008-system-back.patch`（pi-web `components/AppShell.tsx`）
- `app/src/main/java/org/fellow99/pi/PiDesktopAndroid/MainActivity.kt`（`onBackPressed()`）
