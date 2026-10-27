# 105-auth-loopback-no-password — spec（鉴权（loopback 免密，路线 ①））

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
服务只监听 127.0.0.1 随机端口、不设 PI_WEB_PASSWORD；WebView 同源加载（对标 ark 105）。

## 验收
| # | 判据 | 状态 |
|---|---|---|
| 1 | 未设 PI_WEB_PASSWORD ⇒ 认证整体关闭；loopback 放行 | ✅（E2E 首屏免密直达） |
| 2 | 端口随机（listen(0) 先探后用）+ marker 回传 | ✅（E2E marker 端口 ≠ 固定值） |
| 3 | 密码路线 ② 仅作回退（显式 PI_WEB_PASSWORD 才启用并警告） | ✅（env.js 同 ark 口径） |
| 4 | 局域网路线禁 0.0.0.0（无密码即拒） | ✅（env.js 抛错路径）
