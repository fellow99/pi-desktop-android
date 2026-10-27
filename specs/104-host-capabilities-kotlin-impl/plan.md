# 104-host-capabilities-kotlin-impl — plan（宿主能力（Kotlin 10 项））

> 技术方案与 as-built 说明。

## 方案
- 能力名清单取自 ark HostCapabilities.ets 冻结表（去掉 ohos.* 专有项）。
- 全部主线程执行（库 dispatcher 保证）；桩返回 {ok:false,error:unsupported,phase} —— 宪法 C6 不假装成功。
- Phase 2：SAF ACTION_OPEN_DOCUMENT_TREE + takePersistableUriPermission；通知权限请求流接 Activity。
