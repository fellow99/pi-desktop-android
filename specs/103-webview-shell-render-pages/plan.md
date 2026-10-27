# 103-webview-shell-render-pages — plan（渲染壳（三态 UI/围栏/返回键））

> 技术方案与 as-built 说明。

## 方案
- 经典 View 体系（零 AndroidX）：FrameLayout 三层（loading/error/web）按 StateFlow 切换。
- WebView 配置：JS+DOMStorage 必开（O3 依据）；shouldOverrideUrlLoading 主 frame 判 host；setSupportMultipleWindows(false)。
- 重启语义：进程内 Node 不可重启（⑥）⇒ 错误页按钮 = 重启应用进程（launch intent + exit）。
- cleartext：networkSecurityConfig 仅 loopback（O3 已证页面可载 + isSecureContext=true）。
