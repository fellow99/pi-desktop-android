# 插件 · 选择工作区目录（203-plugin-workspace-picker）—— 测试用例

> 对应 `spec.md` 验收场景；状态列：`⬜ 未执行 / ✅ 通过 / ❌ 失败`。
> 本轮真机 = `8f155833`（SDK 33 / Android 13）⇒ 授权门走 **API 30+ All-files 设置页**路径。

## 一、离线 / 静态核对（无需真机）

| # | 用例 | 步骤 | 预期 | 状态 |
|---|---|---|---|---|
| TC-AND-203-00 | 补丁往返 | pristine `pi-web` v0.15.0 上按序应用 0001…0007 | 全 PASS；反向 → 受影响文件 SHA 还原；`../pi-web` pristine | ⬜ |
| TC-AND-203-01 | 0007 无手输路径 | 应用后 `grep` DirectoryPicker | 无 `pathInput`/`handlePathSubmit`/`FormEvent` 残留 | ⬜ |
| TC-AND-203-02 | 0006 Android 化 | 读 `permissionForRoot`/`ALLOWED_PERMISSIONS` | 只接受 Android 存储语义，非 `ohos.permission.*` | ⬜ |
| TC-AND-203-03 | roots env | 静态读 `PiDesktopRuntime.kt` | `PI_ANDROID_ROOTS` 含三根且路径符合 FR-AND-203-002 | ⬜ |
| TC-AND-203-04 | manifest | 读 `AndroidManifest.xml` | 含 `MANAGE_EXTERNAL_STORAGE` + `READ/WRITE_EXTERNAL_STORAGE`(maxSdk=29) | ⬜ |
| TC-AND-203-05 | G7.1 | 读 `docs/000-工程规划.md` §17 | G7.1 特例存在、scope 明确、回引 203 | ⬜ |
| TC-AND-203-06 | /roots 扩展 | 静态读 `android-workspace-roots.js` | `EXPECTED_IDS`=三根；`permissionStatus` 如实 | ⬜ |

## 二、真机交互（8f155833）

| # | 用例 | 步骤 | 预期 | 状态 |
|---|---|---|---|---|
| TC-AND-203-10 | 三 Tab | 添加工作区 → 逐个点沙箱/文档/下载 | Tab=三根；切换栈重置 | ⬜ |
| TC-AND-203-11 | 沙箱建区 | 沙箱根新建文件夹并选中「选择此文件夹」 | 工作区创建成功；路径为 app-specific 外存 workspace | ⬜ |
| TC-AND-203-12 | 沙箱对话 | 新工作区发起一轮对话 | 模型 `deepseek-flash` 正常回复 | ⬜ |
| TC-AND-203-13 | 沙箱看图 | 对话中上传图片并提问 | 图可上传、模型分析回复 | ⬜ |
| TC-AND-203-14 | 文档未授权门 | 撤销 All-files 后切「文档」 | 无弹窗；只显示「请求权限」「刷新」 | ⬜ |
| TC-AND-203-15 | 文档请求权限 | 点「请求权限」 | 跳「所有文件访问」设置页（不崩溃） | ⬜ |
| TC-AND-203-16 | 文档授权后刷新 | 设置页授予 → 返回 → 点「刷新」 | 列出 `/storage/emulated/0/Documents/*`；无残留提示态 | ⬜ |
| TC-AND-203-17 | 文档建区/对话/看图 | 在文档下建区 → 对话 → 看图 | 全程可用 | ⬜ |
| TC-AND-203-18 | 下载授权门 | 同 14/15/16/17 于「下载」根 | 同上；`/storage/emulated/0/Download/*` 可列 | ⬜ |
| TC-AND-203-19 | 根围栏 | 文档根下钻多层 → 返回按钮 | 最高到文档根；无手输输入框 | ⬜ |
| TC-AND-203-20 | 记忆/默认名 | 停在下载根关重开；新建默认名两次 | 记忆只记根 id（非法回退沙箱）；`未命名文件夹`→`… 2` | ⬜ |
| TC-AND-203-21 | `/roots` | 应用内调 `/roots` | 三根路径/可读性/授权状态与系统一致 | ⬜ |

## 三、验收对照

| 验收 | 回引 | 用例子集 |
|---|---|---|
| AC-AND-203-01 | FR-AND-203-001/003 | TC-10 |
| AC-AND-203-02 | FR-AND-203-002 | TC-11 |
| AC-AND-203-03 | FR-AND-203-004/005 | TC-14 |
| AC-AND-203-04 | FR-AND-203-006/007 | TC-15/16 |
| AC-AND-203-05 | FR-AND-203-008 | TC-16/18 |
| AC-AND-203-06 | FR-AND-203-009/010/011 | TC-19 |
| AC-AND-203-07 | FR-AND-203-012/013 | TC-17/20 → 11/12/13 |
| AC-AND-203-08 | FR-AND-203-016/017/018 | TC-00/01/05 |
