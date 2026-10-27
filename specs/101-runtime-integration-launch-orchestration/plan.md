# 101-runtime-integration-launch-orchestration — plan（运行时接入与启动编排）

> 技术方案与 as-built 说明。

## 方案
- **编排器**：object 单例 + StateFlow 三态（Loading/Ready/Failed）；后台线程跑 boot 链；Activity 只 collect。
- **解包**：assets → cache 暂存 → PayloadArchive（ustar+gzip 流式解析，GNU L 长名，路径穿越校验）→ payloadRoot；marker=`.ready-<sha12>`。
- **不复制 node_modules 到 PI_DIST**：Windows 整树复制实测不可行（10min+）；构建面用硬链接暂存（只读，安全）。
- **偏差登记**：bridge 0.2.0 无 archiveAsset ⇒ app 自实现 PayloadArchive（接口形状按规划 §7.1，库升级替换）。
- **风险**：模拟器为 x86_64+ARM 翻译（真机矩阵 ⬜）；首启解包 18s 需加载页进度覆盖（已实现阶段文本）。
