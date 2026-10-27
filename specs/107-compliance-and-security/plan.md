# 107-compliance-and-security — plan（合规与敏感信息纪律）

> 技术方案与 as-built 说明。

## 方案
- 发布门禁（Phase 3）：zipalign -P 16、unzip -l 产物核对、签名材料本地不入库。
- 本期把「敏感信息扫描」固化为提交前检查步骤（107 模块记录命令与输出）。
