# 110-pnpm-integration — plan（已移除 → 真实 pnpm 二进制的实施计划）

> 依赖：`specs/110-pnpm-integration/spec.md`、`specs/112-cli-integration/spec.md`（C7 移除 + C5 环境暴露）。
> 本工程无 `.specify`，沿用自身约定。分支：`main`（逐阶段提交）。

## 架构（变更后数据流）

```
旧（已移除）：Agent ✗ 进程内 JS pnpm（payload/extensions/android-pnpm，bundle 9.15.9）
新（112 落地）：三通道（Terminal/ptyBash/Agent bash）── pnpm（PATH/.profile 函数）── libpnpm_cli.so ── node（PATH 上）
```

## 关键技术决策

### D1 JS pnpm 整体移除（112 C7）
- 删除 `payload/extensions/android-pnpm/`（vendored JS bundle）、launch 的 `runPnpmSelftest` 及其报告。
- 启动期清理旧物化残留 `filesDir/pi-agent/extensions/android-pnpm`（防升级残留被加载）。
- 区分构建机 pnpm 与设备 CLI：`crop-rules.mjs` 中 `pnpm-virtual-store` 规则服务于**载荷裁剪**
  （构建机装 pi-web 依赖产物），与设备 pnpm CLI 无关 → **保留**。
- 理由：JS pnpm 9.x 与真实 pnpm 12.x 行为/版本不一致，且真实二进制已随包；不预留 desktopPnpm 契约（与 dsh 分歧，见 spec）。

### D2 pnpm 环境暴露（112 C5，已落地）
- `libpnpm_cli.so` 入 jniLibs（legacy packaging 物理落盘）；`.profile` 写 `pnpm() { exec '<nativeDir>/libpnpm_cli.so' "$@"; }`。
- PATH 含 node（`libnode_cli.so` 经 `.profile` 函数），满足 pnpm 运行期依赖。
- store/cache 落 filesDir 可写私有目录（`PNPM_HOME`/`XDG_CACHE_HOME`）。

## 分阶段（合并进 112，非独立里程碑）
- P3（112）：删除/清理/CI/合规（T3.2、T3.3、T3.5、T3.6、T3.8）—— ✅ 已完成。
- P4（112）：三通道 pnpm 冒烟 + 能力清单回填。

## 验收
- 组装产物无 android-pnpm；三通道 `pnpm --version`=12.16.1、最小 `pnpm install`（纯 JS 包）成功；
  G2 lifecycle 裸 `node` 边界如实上报。
