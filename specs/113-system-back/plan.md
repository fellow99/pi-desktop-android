# 113-system-back — plan（系统级返回按钮行为改造 · Android）

> 方案。对应 specs/113-system-back/spec.md。

## 1. 方案概览

三件改动，职责分离：

1. **pi-web 补丁（唯一载荷改动）**：在 `components/AppShell.tsx` 加一个 `useEffect`，监听
   `window` 上的 `pi-back` 事件。收到后按优先级：`settingsSection !== null` → 关设置页；
   否则 `isMobile && sidebarOpen` → 收回抽屉；否则 no-op。监听器随组件卸载清理。
   - 用独立补丁文件 `patches/v0.15.0/0008-system-back.patch`（接在既有 0001–0007 之后，按文件名排序应用）。
2. **Android 宿主**：`MainActivity.onBackPressed()` 改为——WebView 已挂载则
   `web.evaluateJavascript("window.dispatchEvent(new Event('pi-back'))", null)` 并返回；
   未挂载则维持 `super.onBackPressed()`（加载/错误页兜底退出）。
   - 移除 READY 态对 `web.canGoBack()/goBack()` 的依赖（SPA 单页面，历史回退无意义且会破坏新语义）。
3. **spec 四件套 + 真机验收**。

## 2. 关键设计决策（含决策链）

| # | 决策 | 依据 |
|---|---|---|
| D1 | **修改载荷** | 设置/抽屉/首页/会话页状态都在 pi-web React 内部（AppShell state），壳与 Node 插件都无法触达或关闭 |
| D2 | **用补丁不用插件** | 插件=服务器端 Node 扩展，无 React 浮层句柄；既有先例（102/203）均是幂等补丁改 pi-web 源码 |
| D3 | **事件协议 `pi-back`（window 级）** | 全平台壳统一用 `evaluateJavascript`/`runJavaScript`/`executeJavaScript` 派发；页面在 AppShell 挂载后监听 |
| D4 | **「关设置页」优先于「收抽屉」** | 需求枚举顺序即优先级（设置页→抽屉）；二者正常导航下不同时打开，顺序影响可忽略 |
| D5 | **READY 后不再 goBack/退出** | 首页/会话页=no-op 的需求意味着返回永不退出主界面；仅未挂载（加载/错误页）保留退出兜底 |
| D6 | **范围：不驱动 HTML 弹窗** | 用户确认 ①：弹窗多为子组件分散状态，无统一注册表，全面覆盖版本脆弱；本轮收敛到设置页+抽屉 |
| D7 | **关闭设置页与既有 onClose 同语义** | `setSettingsSection(null)` + `setModelsRefreshKey(k=>k+1)`，不重置 `settingsOpenAtHome`（下次打开会重设） |
| D8 | **docs 提交** | spec 资产按 git-commit 规范用 Conventional Commits 前缀提交 |

## 3. 实施落点（checklist）

- [ ] 生成并校验补丁 `0008-system-back.patch`（pi-web 工作树改 → `git diff` → 落盘 → `git apply --check` → 还原 pristine）
- [ ] `MainActivity.kt` `onBackPressed()` 改造
- [ ] `logs/20261111-1/DEV_CHECKLIST.md` 建日志
- [ ] 本地 `git apply --check` 通过、`assemble-payload` 可跑
- [ ] 真机覆盖部署（`adb install -r`，不卸载）
- [ ] 验收用例 1–7（spec §4）

## 4. 评审计划（Phase 3.5）

- 用 `requesting-code-review` / `receiving-code-review` 技能：对补丁 diff + Kotlin 改动做 Critical/Important/Minor 分级评审。
- 修复 Critical/Important 后回填 `REVIEW_REPORT.md`，提交 `fix:`。

## 5. 测试计划（Phase 4，真机 8f155833）

- 构建：`python scripts/assemble-payload.mjs` + `./gradlew :app:assembleDebug`（沿用 102 流程）。
- 部署：`adb install -r <apk>`（覆盖更新）。
- 场景：`adb shell input keyevent 4`（BACK）驱动真机；分别验证设置页/抽屉/首页/会话页/加载页。见 test-cases.md。

## 6. 风险与遗留

- **风险**：`pi-back` 事件在 AppShell 未挂载前派发会丢（加载期快速按返回）——语义即 no-op，可接受，不处理。
- **风险**：evaluateJavascript 异步无返回值；壳不再需要「是否已消费」反馈（首页/会话页本来就 no-op）。
- **遗留**：HTML 弹窗不关闭（用户确认 ① 排除）。
