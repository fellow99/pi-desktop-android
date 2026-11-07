# 204-plugin-git — spec（git 工具扩展：已移除 → 走真实 `git` 二进制）

> 模块规格（需求/验收）。宪法：`specs/constitution.md`；替换来源：`specs/112-cli-integration/`。
> 需求编号：`204-plugin-git` ｜ 需求名称：git 工具扩展
> Git 分支：**不改动**（工作于 `main`，逐阶段提交）
> 本模块仅入 `pi-desktop-android/specs/`，不加入父工程 specs。

## 现状结论（2026-11-07 评审）

**本模块原计划提供 git 工具化能力，已被 `112-cli-integration` 取代并整体移除：**

- 原实现为 **isomorphic-git（纯 JS）扩展**——`payload/extensions/android-git/`（单源自 `pi-desktop-hos/harmony-git`），
  提供 21 个按动词封装的结构化 git 工具。其结构化直连与「真实 git 行为」存在偏差（纯 JS 实现，非真实 git 语义）。
- `112-cli-integration`（spec C7）决策：**移除 isomorphic-git 整套扩展**（`payload/extensions/android-git/` 目录、
  `scripts/sync-git-extension.mjs`、CI sync 步骤、launch 的 `runGitSelftest`、env.js 的 harmony-git 单源别名），
  真实 `git` 2.56.0 二进制经 `aosp-git-cli` 随之随 APK 预置，Agent/终端经 `bash`/terminal 直接敲 `git`。

### 与 dsh-desktop-android 的设计分歧（非缺陷，记录对照）

| 项 | dsh-desktop-android | pi-desktop-android |
|---|---|---|
| 后端 | 真实 `aosp-git-cli` 二进制 | 同（`libgit_cli.so` + 2 传输件） |
| 工具形态 | 保留**单一 `git` passthrough 工具**（argv 原样、围栏/凭据桥 `GIT_CREDENTIAL_<HOST>`/设置页） | **不保留任何结构化 git 工具**；经三通道（Terminal/ptyBash/Agent bash）敲真实 `git` |
| 凭据管理 | 设置页 + `$HOME/.git-credentials`（0600） | 无结构化凭据页；依赖 git 自身 `credential.helper` 与用户交互 |

**判定**：pi-desktop-android 采用「纯 bash 面 / 无结构化 git 工具」的简模型（spec 112 C7 记录），
不照搬 dsh 的 passthrough 工具。能力面以真实二进制可用为准。

## 能力面与验收（替换后语义 → 指向 112）

| 项 | 行为 | 验收 |
|---|---|---|
| 真实 git 可用 | `git` 经三通道 PATH/`.profile` 函数命中 `libgit_cli.so`（http(s) 传输） | 三通道 `git --version`=2.56.0；`init/add/hash-object/write-tree/log` 正常；`ls-remote` TLS 成功 |
| 无 JS 残留 | isomorphic-git 扩展目录/同步脚本/CI/启动 selftest/别名全清；升级首启清理旧物化残留 | 组装产物无 `android-git`；grep 无运行时引用；`PI_HOS_ROOTS` 别名=0 |
| 平台边界如实 | `git commit` 在真域受 SELinux `link(2)` 限制段错误（G1）；ssh 远程不在本期 | 能力清单/提示如实标注，不伪报 |

## 非目标
- 不恢复 isomorphic-git；不实现结构化 `git` 工具；不引入 openssh/dropbear（ssh 远程二期）。

## 测试与证据
- 用例并入 `specs/112-cli-integration/test-cases.md`（CLI 三通道 + git 冒烟）。
- 证据：`specs/112-cli-integration/logs/*`（P0 git TLS、G1 segfault 因果链、P3 移除取证）。
