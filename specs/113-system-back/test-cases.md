# 113-system-back — 测试用例（系统级返回按钮行为改造 · Android）

> 真机：8f155833（M2105K81C，SDK 33 / Android 13）。BACK 键 = `adb shell input keyevent 4`。
> 部署：`adb install -r <apk>`（覆盖更新，**不卸载**，已核验 Success）。
> 构建：`assemble-payload --apply`（8 补丁）+ `assembleDebug`；WebView DevTools（CDP）驱动/断言 + 真 BACK。

## 一、真机交互（干净构建最终验收）

### TC-AND-001：设置页关闭 — **PASS** ✅
**步骤**：CDP 点底栏「设置」→ 面板出现（含「字体与排版」）→ 真 BACK
**结果**：BACK 后面板消失、恢复首页、进程存活（pid 不变）。webAttached π回 pi-back → AppShell 设置分支生效。

### TC-AND-002：移动端抽屉收回 — **SKIP（设备形态）**
**步骤**：—（本机关侧栏形态，非移动布局）
**结果**：真机 `innerWidth=711`（>pi-web 移动断点 640）→ **桌面布局**，无移动抽屉。编译产物静态核对 `isMobile&&sidebarOpen → setSidebarOpen(false)` 分支在位 ✓。桌面侧边栏 BACK 时保持 no-op（与 TC-003 一致，符合设计）。⬜ 需更窄视口/真机复核。

### TC-AND-003：首页 no-op — **PASS** ✅
**结果**：首页按 BACK → innerText 逐字一致、进程存活、焦点不变（不退出、不导航）。

### TC-AND-004：会话页 no-op — **SKIP（无会话可进入）**
**结果**：真机无会话/无已配模型，「新建」无法进入真实会话页。会话页与首页对补丁同构（无浮层即 no-op），首页已证该路径。⬜ 需配置会话后复核。

### TC-AND-005：加载页兜底退出 — **SKIP（时序不可复现）**
**结果**：引擎热启动极快，BACK 注入时已 webAttached（→ 派发 pi-back no-op），无法命中 Loading 窗口。代码路径 `webAttached=false → super.onBackPressed()` 已静态核实。

### TC-AND-006：连续返回不退出 — **PASS** ✅
**结果**：首页连按 5 次 BACK → 进程存活、仍在首页、无退出。

### TC-AND-007：应用内非 SPA 页返回不困死（I-1 评审修复）— **PASS** ✅
**结果**：`location.href → /api/home`（loopback 非根，等义于会话导出页），BACK → **goBack 回到根** `/`（两次循环复现稳定），进程存活；`web.url=/api/home root=false canGoBack=true` 日志证实分支命中。

## 二、离线 / 静态核对

### TC-AND-008：补丁幂等与协议 — **PASS** ✅
**结果**：`git apply --check 0008-system-back.patch` 通过；事件协议名 `'pi-back'` 三平台（android/ark/hos）逐字一致；补丁文件三平台逐字节相同。

### TC-AND-009：载荷补丁往返校验 — **PASS** ✅
**结果**：`assemble-payload --apply` 完整跑通（EXIT 0）：8 条补丁应用→重编→裁剪→归档 75.6 MiB→`assets/pi-web.tar.gz`；**收尾还原 pi-web pristine**（核验干净）；tar 内 `.next/.../page-*.js` 含 `addEventListener("pi-back",e)` 编译产物 ✓。

## 三、验收对照

| AC# | 判据 | 结论 |
|---|---|---|
| 1 | 0008 幂等 + 往返校验 | ✅ PASS |
| 2 | 设置页关闭 | ✅ PASS |
| 3 | 抽屉收回 | ⬜ SKIP（本机无移动形态）· 静态核对通过 |
| 4 | 首页不退出 | ✅ PASS |
| 5 | 会话页不退出 | ⬜ SKIP（无会话）· 与首页同构 |
| 6 | 加载页可退出 | ⬜ SKIP（时序）· 代码路径静态核实 |
| 7 | 覆盖更新部署（未卸载） | ✅ PASS（install -r Success） |
| 8 | 导出页返回不困死（I-1） | ✅ PASS |
