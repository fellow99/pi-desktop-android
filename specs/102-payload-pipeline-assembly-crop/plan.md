# 102-payload-pipeline-assembly-crop — plan（载荷组装流水线（补丁/裁剪/打包））

> 技术方案与 as-built 说明。

## 方案
- **补丁栈幂等**：整栈**逆序**反向检查判定「已应用」（正序逐条会因后条改前条上下文而误判——本轮实测教训）；应用路径 = pristine 前提下逐条正向 + 单条往返断言。
- **PI_DIST**：只放产品面（package.json/next.config.ts/public/.next）；node_modules **不复制**（Windows 不可行），暂存期从 pi-web 硬链接。
- **裁剪**：规则数据化（8 条，含 keep 白名单/平台标记/纯 JS 跳过 + assertKeepSound 自审）；KEEP_PATH_MARKERS=['linux-arm64','arm64','android']。
- **确定性归档**：mtime=0 + 条目排序 + gzip9 + 1024 零块结尾；与 Kotlin PayloadArchive 一一对应。
- **并发纪律（R11）**：共享 pi-web 工作树禁止并发 assemble（兄弟工程同机同源，本期实测互踩）；运行前检查无并发实例。
- **偏差登记**：0005/0006 上下文随 env 改名同步文本变换；0003 整库替换为 lib/android-sandbox-path.ts（别名集 Android 化，marker=pi-android-sandbox-alias）。
