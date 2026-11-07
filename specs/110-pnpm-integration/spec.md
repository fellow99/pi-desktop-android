# 110-pnpm-integration — spec（pnpm 运行时装包：已移除 → 走真实 pnpm 二进制）

> 模块规格（需求/验收）。宪法：`specs/constitution.md`；替换来源：`specs/112-cli-integration/`。
> 需求编号：`110-pnpm-integration` ｜ 需求名称：pnpm 运行时装包
> Git 分支：**不改动**（工作于 `main`，逐阶段提交）
> 本模块仅入 `pi-desktop-android/specs/`，不加入父工程 specs。

## 现状结论（2026-11-07 评审）

**本模块原计划提供「进程内 pnpm 运行时装包」能力，已被 `112-cli-integration` 取代并整体移除：**

- 原实现为**进程内 JS 版 pnpm**——`payload/extensions/android-pnpm/`（vendored bundle，package.json 自述
  pnpm 9.15.9；统称「pnpm v10 内进程 JS 方案」）。
- `112-cli-integration`（spec C7）决策：**移除该 JS pnpm bundle 整套扩展**（`payload/extensions/android-pnpm/`、
  launch 的 `runPnpmSelftest` 及其报告、相关 TMPDIR 注释），真实 `pnpm` 12.16.1（Rust 独立二进制）经
  `aosp-pnpm-cli` 随之随 APK 预置，Agent/终端经三通道敲真实 `pnpm`（运行期依赖 PATH 上 node，由 112 C5 保证）。
- 移除后 pnpm 以「运行期二进制」形态出现，不再提供进程内 JS worker / desktopPnpm 契约。

### 与 dsh-desktop-android 的设计分歧（非缺陷，记录对照）

| 项 | dsh-desktop-android | pi-desktop-android |
|---|---|---|
| 后端 | 真实 `aosp-pnpm-cli` 二进制（spawn `$HOME/bin/pnpm`） | 同（`libpnpm_cli.so`） |
| 工具形态 | 保留 `desktopPnpm` 契约（install/lookup 成员，spawn 真实 pnpm） | **不保留任何 desktopPnpm 契约/结构化 worker**；经三通道敲真实 `pnpm` |
| 布局配置 | 保留 `pnpm-workspace.yaml`（nodeLinker hoisted + copy） | 无宿主侧生成，用户/脚本自建（可选） |

**判定**：pi-desktop-android 采用「纯 bash 面 / 无结构化 pnpm worker」的简模型（spec 112 C7 记录），
不照搬 dsh 的 desktopPnpm 契约。能力面以真实二进制可用为准。

## 能力面与验收（替换后语义 → 指向 112）

| 项 | 行为 | 验收 |
|---|---|---|
| 真实 pnpm 可用 | `pnpm` 经三通道 PATH/`.profile` 函数命中 `libpnpm_cli.so`；运行期能找到同 PATH 的 `node` | 三通道 `pnpm --version`=12.16.1；最小 `pnpm install`（纯 JS 包） |
| 无 JS 残留 | android-pnpm bundle 目录/启动 selftest 全清；升级首启清理旧物化残留 | 组装产物无 `android-pnpm`；grep 无运行时引用 |
| 平台边界如实 | lifecycle 脚本内裸 `node` 短名在非 login 子 shell 不可见（G2）；`uv venv`/`python -I` 隔离边界（G3） | 能力清单/提示如实标注，不伪报 |

## 非目标
- 不恢复进程内 JS pnpm；不实现 desktopPnpm 契约；pnpm 的 store/cache 落 filesDir 可写私有目录。

## 测试与证据
- 用例并入 `specs/112-cli-integration/test-cases.md`（CLI 三通道 + pnpm 冒烟）。
- 证据：`specs/112-cli-integration/logs/*`（P0 pnpm 版本、G2 lifecycle 边界、P3 移除取证）。
