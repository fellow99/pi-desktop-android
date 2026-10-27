# 103-webview-shell-render-pages — spec（渲染壳（三态 UI/围栏/返回键））

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
系统 WebView 渲染本机 pi-web；加载/错误页失败可见；导航围栏；返回键守卫（对标 ark 103）。

## 验收
| # | 判据 | 状态 |
|---|---|---|
| 1 | 加载页阶段文本随启动编排推进 | ✅ |
| 2 | Ready 后 WebView 渲染 Pi Web UI 首屏 | ✅（E2E 截图） |
| 3 | 错误页 = stage + message + 日志尾 + 「重启应用」 | ✅ |
| 4 | 围栏：非 loopback 主 frame → 系统浏览器；多窗口禁用 | ✅ |
| 5 | 返回键：WebView 历史优先 | ✅ |
| 6 | DOM Storage 开启；JS 开启 | ✅（O3 实测 localStorage 可用）
