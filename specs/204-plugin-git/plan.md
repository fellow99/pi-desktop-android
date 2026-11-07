# 204-plugin-git — plan（已移除 → 真实 git 二进制的实施计划）

> 依赖：`specs/204-plugin-git/spec.md`、`specs/112-cli-integration/spec.md`（C7 移除 + C5 环境暴露）。
> 本工程无 `.specify`，沿用自身约定。分支：`main`（逐阶段提交）。

## 架构（变更后数据流）

```
旧（已移除）：Agent ✗ isomorphic-git（payload/extensions/android-git，21 工具）
新（112 落地）：三通道（Terminal/ptyBash/Agent bash）── git（PATH/.profile 函数）── libgit_cli.so
```

## 关键技术决策

### D1 isomorphic-git 整体移除（112 C7）
- 删除 `payload/extensions/android-git/`、`scripts/sync-git-extension.mjs`、CI 中 sync 步骤、
  launch 的 `runGitSelftest`、env.js 的 `PI_HOS_ROOTS`（harmony-git 单源别名）。
- 启动期清理旧物化残留 `filesDir/pi-agent/extensions/android-git`（防升级残留被加载）。
- 理由：纯 JS git 非真实 git 语义，且真实二进制已随包，双重实现无收益；不保留结构化工具（与 dsh 分歧，见 spec）。

### D2 git 环境暴露（112 C5，已落地）
- `libgit_cli.so` + `libgit_http_fetch.so`/`libgit_remote_curl.so` 入 jniLibs（legacy packaging 物理落盘）。
- `GIT_EXEC_PATH=<filesDir>/gitexec`（8 链接农场，按 `gitexec-manifest.json#farm` 重建）、
  `GIT_SSL_CAINFO`/`GIT_TEMPLATE_DIR`/`GIT_CONFIG_GLOBAL` 指向可写私有目录。
- `.profile` 写 `git() { exec '<nativeDir>/libgit_cli.so' "$@"; }`，三通道 login shell `sh -l` source。

## 分阶段（合并进 112，非独立里程碑）
- P3（112）：删除/清理/CI/合规（T3.1、T3.4、T3.5、T3.6、T3.8）—— ✅ 已完成。
- P4（112）：三通道 git 冒烟 + 能力清单回填。

## 验收
- 组装产物无 android-git；三通道 `git --version`=2.56.0、TLS `ls-remote` 成功；
  git commit 真域边界（G1）如实上报。
