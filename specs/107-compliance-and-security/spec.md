# 107-compliance-and-security — spec（合规与敏感信息纪律）

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
规划 §17 G1–G11 的 Android 口径落实 + 敏感信息不入库（宪法 C9）。

## 验收
| # | 项 | 状态 |
|---|---|---|
| G1/G2 | 系统 WebView、无浏览器语义（无深链/地址栏；围栏拦截） | ✅ |
| G3 | 无动态下发可执行代码（.so 只随 AAR；运行期只解包 JS 载荷） | ✅ |
| G5 | 16KB 页对齐（库门禁 ✅ + jniLibs useLegacyPackaging=false） | ✅ |
| G6 | targetSdk 36 政策项（权限最小化：仅 INTERNET+NETWORK_STATE） | ✅ |
| G7 | 不申请四类受限权限 | ✅ Manifest 核对 |
| G10 | 包名/应用名一致 | ✅ |
| G11 | 诊断后门/release 关闭纪律（debug-only） | ✅ |
| C9 | 敏感信息扫描（提交前 grep） | ✅（见下） |

## 敏感信息扫描（可复核）
- `git grep -nI "sk-[a-zA-Z0-9]{20,}"` ⇒ 空
- `git grep -nIE "(password|token|secret)\s*=\s*['\"][^'"]{8,}"` ⇒ 仅结构性占位/文档说明
- 测试用 API Key 只写设备沙箱 auth.json（run-as 确认 0600）；本仓任何文件不落 Key。
