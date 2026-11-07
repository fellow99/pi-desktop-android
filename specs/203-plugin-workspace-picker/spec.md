# 插件 · 选择工作区目录（203-plugin-workspace-picker）—— 规格

> **Module:** 203-plugin-workspace-picker ｜ **Status:** Proposed（方案 A 已获采纳，实施中） ｜ **Last Updated:** 2026-11-07
> **上游基线:** pi-web v0.15.0（tag `f130910`）· 关联模块 `104-host-capabilities-kotlin-impl`
> **需求编号:** 203-plugin-workspace-picker ｜ **需求名称:** 插件：选择工作区目录
> **git 分支:** 不改动 ｜ **测试真机:** 8f155833（M2105K81C，SDK 33 / Android 13）
> **参考实现:** `dsh-desktop-android/specs/106-workspace-picker/`（同维护者，方案 A 已真机验收）
> **实现载体:** 上游幂等补丁 `patches/v0.15.0/0002/0005/0006(+203)` + Kotlin 宿主 `HostCapabilities.kt`/`PiDesktopRuntime.kt` + `AndroidManifest.xml` + `payload/extensions/android-workspace-roots.js`

## 1. 模块概述

### 1.1 目的

把 Pi Web 的「选择工作区目录」对话框改造为**三主目录**选择器（**沙箱 / 文档 / 下载**），
并对共享目录采用**授权门**语义：

- 点「文档 / 下载」Tab **只查询、不自动申请**权限；
- 有权限 → 直接显示目录列表；
- 无权限 → **不显示列表**，改为两个按钮「**请求权限**」「**刷新**」：
  - 「请求权限」→ 按 **SDK 版本分派**：API 30+ 跳系统「所有文件访问」设置页
    （`ACTION_MANAGE_APP_ALL_FILES_ACCESS`）；API 26–29 发起 `READ/WRITE_EXTERNAL_STORAGE`
    运行时权限（系统弹窗）；
  - 「刷新」→ 重新按权限状态判定并渲染列表。

### 1.2 解决的问题

| # | 痛点 | 结论 |
|---|---|---|
| 1 | 默认选择器起点在沙箱，无法把共享目录注册为工作区 | 宿主声明文档/下载根 + 0005 Tab 契约 |
| 2 | Android 共享存储未授权时 `readdir /storage/emulated/0/{Documents,Download}` 一律 `EACCES`，无引导 | 0006 授权门 + `/api/host/perm` |
| 3 | RAM 平台权限模型分派：API 30+ All-files 设置页 vs API 26–29 运行时弹窗，混用会崩（ActivityNotFoundException / 无效） | 按 `Build.VERSION.SDK_INT` 分派（FR-AND-203-007） |
| 4 | 工程宪法 G7 与方案 A 冲突 | 本轮修订 G7.1（用户目录工作区根特例，见 plan.md §4 与 `docs/000-工程规划.md`） |
| 5 | 手输路径可越根 | 补丁 0007（与 ark 同源）移除路径表单 |

### 1.3 范围

**包含**：三根声明与切换、授权门（SDK 分派）、请求权限/刷新、根围栏、宿主 `perm.*` Android 化、
G7.1 修订、上游补丁 Android 化、spec 四件套、真机构建部署与验收。

**不包含**：桌面目录（Android 无 `READ_WRITE_DESKTOP_DIRECTORY` 概念）、SAF 内容适配（方案 B，未采纳）、
文件选择/多选/整盘浏览/显示隐藏开关、父工程 specs 登记（同 hos/ark）。

## 2. 用户故事

- 作为用户，我希望在选择工作区时切到「文档/下载」，把共享目录中的文件夹注册为工作区。
- 作为用户，未授权时我先看到「请求权限」「刷新」两个按钮，而不是莫名弹窗或裸报错。
- 作为用户，点「请求权限」后系统给我一个明确的授权入口（Android 13 = 「所有文件访问」设置页），
  返回后点「刷新」即可列出目录。
- 作为用户，对话框没有手输路径入口，浏览域锁在所选主目录内。
- 作为用户，下次打开对话框停在最近用的主目录。

## 3. 功能需求

### 3.1 主目录与解析

- **FR-AND-203-001** 对话框 Tab 集合 MUST 恰好为 `sandbox` / `documents` / `download`（由服务端按宿主声明给出，顺序固定）。宿主 `PI_ANDROID_ROOTS` MUST 声明这三项。
- **FR-AND-203-002** `sandbox` = app-specific 外存真实路径（`getExternalFilesDir/files/workspace`，免权限，自动 mkdir）；`documents` / `download` = `${Environment.getExternalStorageDirectory()}/{Documents,Download}`（POSIX 绝对路径），`permType` 标为存储类。
- **FR-AND-203-003** 根清单 MUST 由宿主经 `PI_ANDROID_ROOTS` 传给同进程的 Next；前端只消费 `/api/cwd/browse` 响应里的 `roots`，MUST NOT 硬编码路径/权限名。

### 3.2 授权门

- **FR-AND-203-004** 点「文档 / 下载」Tab MUST **不自动申请**权限：仅浏览；`readdir` 返回 `EACCES/EPERM`（403 + `permission`/`canRequest`）时 MUST 不渲染列表，改为「请求权限」+「刷新」两按钮。
- **FR-AND-203-005** 有权限（`readdir` 成功）MUST 正常渲染列表并可下钻/新建/选择；`canRequest=false`（sandbox）MUST 走通用错误话术。
- **FR-AND-203-006** 「请求权限」MUST 经 `POST /api/host/perm`（白名单：仅存储类权限名）→ 宿主 `perm.request`。
- **FR-AND-203-007** 「请求权限」MUST 按 SDK 分派：
  - **API 30+**：`Environment.isExternalStorageManager()` 为真 → 直接 `granted`；否则跳
    `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`（带 `resolveActivity` 守卫，无入口时结构化报错，不崩溃）；
  - **API 26–29**：发起 `READ_EXTERNAL_STORAGE` + `WRITE_EXTERNAL_STORAGE` **运行时权限**（系统弹窗），
    结果经 `MainActivity.onRequestPermissionsResult` 回传；
  - 两条路径 MUST 结构化上报（无 All-files 设置页 / 无前台 Activity 等不得抛栈），不得伪造成功。
- **FR-AND-203-008** 授权被拒/跳设置返回后，「刷新」MUST 重新判定（重探 `readdir`）并渲染列表；结果以文件系统真实可读性为准，不以权限 API 返回值伪造（避免假阴性）。

### 3.3 浏览与围栏

- **FR-AND-203-009** 浏览 MUST 复用 `/api/cwd/browse`；只列目录、hidden 不渲染、`truncated` 提示（上限 500）。
- **FR-AND-203-010** 服务端 `findEnclosingPickerRoot` MUST 对 path 浏览做根围栏（根上 `parentPath=null`、根内截断到根）；POST 建目录 MUST 拒绝越界路径（`isPathInsideRoot`）。
- **FR-AND-203-011** 客户端 MUST NOT 存在手输路径入口（补丁 0007）；「返回上级」以 `parentPath` 为唯一目标。
- **FR-AND-203-012** 主目录记忆 MUST 只记根 id（`pi-hos-picker-root`），非法值回退 `sandbox`；切换 MUST 重置浏览栈。
- **FR-AND-203-013** 新建文件夹 MUST 复用 `createDirectoryAuto`（默认名去重）；采纳 MUST 复用既有 `onSelect` 链路。

### 3.4 宿主能力

- **FR-AND-203-014** `perm.check` MUST 对存储类权限名返回 `storageGranted()` 真实可读判定；`perm.request` MUST 实现 FR-AND-203-007 分派。两者 MUST NOT 伪造成功。
- **FR-AND-203-015** `payload/extensions/android-workspace-roots.js#EXPECTED_IDS` MUST 为 `["sandbox","documents","download"]`，`/roots` 打印三根的存在性/可读性/授权状态。

### 3.5 治理与纪律

- **FR-AND-203-016** 本模块规格 ONLY 落 `pi-desktop-android/specs/203-plugin-workspace-picker/`；父工程零新增规范。
- **FR-AND-203-017** G7.1 修订（允许工作区选择器用户目录根使用 All-files）MUST 在 `docs/000-工程规划.md` §17 落实，并回引本模块；其余 G7 红线不变。
- **FR-AND-203-018** 上游改动 MUST 只以幂等补丁落地（0002/0005/0006/0007）；可往返；`../pi-web` pristine；提交遵循 Conventional Commits。

## 4. 关键实体

| 实体 | 说明 | 属性 |
|---|---|---|
| PickerRoot | 主目录 Tab | `id`、`label`、`path`、`permType` |
| PermissionPrompt | 客户端未授权态 | `permission`、`directory?`、`rootId?` |
| StorageGrant | 存储可读事实 | `granted = isExternalStorageManager() \|\| READ/WRITE 已授`（以 `readdir` 收尾判定） |
| PermRequestOutcome | 授权结果 | `ok`、`granted`、`pending?`、`mode`（all-files-settings / storage-runtime）、`error?` |

## 5. 验收场景

| # | 场景 | 判据 |
|---|---|---|
| AC-AND-203-01 | 三 Tab 可见可切换 | Tab = 沙箱/文档/下载（无桌面）；根清单来自服务端 |
| AC-AND-203-02 | 沙箱根自动创建 | 外存 workspace 缺失时自动重建 |
| AC-AND-203-03 | 文档/下载未授权 | 点 Tab 不弹窗；只显示「请求权限」「刷新」；403 带 permission |
| AC-AND-203-04 | 请求权限（API30+） | 跳「所有文件访问」设置页；授予后返回；「刷新」后列出 |
| AC-AND-203-05 | 刷新 | 重新判定并渲染列表，无残留提示态 |
| AC-AND-203-06 | 根围栏 | 无手输路径；返回最高到根；path 浏览被服务端截断 |
| AC-AND-203-07 | 新建/采纳/记忆 | 默认名去重、创建后选中；采纳复用既有链路；记忆只记根 id、非法回退沙箱 |
| AC-AND-203-08 | 治理 | G7.1 已修订并回引；补丁可往返；上游零改动 |

## 6. 非功能需求

- **安全**：授权门白名单（FR-AND-203-006）、根围栏（FR-AND-203-010/011）、结构化失败不崩溃（FR-AND-203-007）。
- **可靠**：`perm.request` 对无设置页/无前台 Activity 结构化报错；授权状态以 `readdir` 为准（FR-AND-203-008）。
- **合规**：G7.1 有明确 scope 与理由；不扩大 All-files 应用面。
- **可逆**：补丁幂等可往返；upstream pristine。

## 7. 假设与约束

- **A1（决策 2026-11-07）**：方案 A（All-files）获采纳；G7.1 修订随之（FR-AND-203-017）。
- **A2（测试机 8f155833）**：SDK 33 ⇒ 走 API 30+ All-files 设置页路径；API26–29 运行时权限按代码评审 + deepseek 真机证据（2026-11-01）承接，本轮真机只验 30+。
- **A3（证据纪律）**：授权是否生效以 `readdir` 真实结果为准（`probeAccess`），不以 `isExternalStorageManager` 一个 API 结论替代。
- **A4（边界）**：`Documents`/`Download` 为 `/storage/emulated/0` 下的标准目录（`Environment.getExternalStorageDirectory()` 默认卷）；共享存储无 All-files 时不可达是平台语义，非本模块缺陷。

## 8. 依赖

- **上游**：pi-web DirectoryPicker / directory-browser / browse route / host route（补丁 0002/0005/0006/0007）。
- **本工程**：`104-host-capabilities-kotlin-impl`（`perm.*` + SAF 桥）、`PiDesktopRuntime.kt`（roots env）、`MainActivity`（onRequestPermissionsResult 转发）、`AndroidManifest.xml`。
- **治理**：`docs/000-工程规划.md` §17（G7.1）；`specs/104-*` 的 SAFe/存储表述（随 104 spec 收敛）。
