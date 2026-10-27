# 105-auth-loopback-no-password — plan（鉴权（loopback 免密，路线 ①））

> 技术方案与 as-built 说明。

## 方案
- 上游机制零改动（proxy.ts/request-security.ts 对 loopback 放行为上游事实，ark §6.1 已核）。
- Kotlin 侧不设密码变量；env.js 在 loopback 路线显式警告「被设置的密码」。
- Phase 0 教训进宪法 C7：固定端口互抢=硬故障。
