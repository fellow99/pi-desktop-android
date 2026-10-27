# 102-payload-pipeline-assembly-crop — spec（载荷组装流水线（补丁/裁剪/打包））

> 模块规格（需求/验收）。事实权威：docs/000-工程规划.md；宪法：specs/constitution.md。

## 需求
从上游 pi-web@v0.12.1 组装 Android 载荷：幂等补丁 → 编译 → 裁剪 → 壳资产 → 确定性归档 → assets（对标 ark 102）。

## 验收
| # | 判据 | 状态 |
|---|---|---|
| 1 | 6 条补丁幂等应用 + 往返校验（SHA-256 逐文件还原） | ✅ |
| 2 | 6 条补丁标记进编译产物（缺 ⇒ 重编，重编后仍缺 ⇒ exit 2） | ✅ |
| 3 | 裁剪规则命中可见（nft.json/win32 SWC/sharp/node-pty/*.node） | ✅ |
| 4 | 归档可读性自检（逐块走 tar，防空名字头块回归） | ✅ |
| 5 | 收尾 pi-web pristine（--keep-patches 除外） | ✅ |
| 6 | 产出 assets/pi-web/{pi-web.tar.gz, pi-web.version(SHA-256)} | ✅ |

## 实现锚点
- `scripts/assemble-payload.mjs`（流水线）+ `scripts/crop-rules.mjs`（规则数据）+ `patches/v0.12.1/`（6 条 Android 化补丁）
