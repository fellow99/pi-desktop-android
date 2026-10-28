package org.fellow99.pi.PiDesktopAndroid.host

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.fellow99.nodebridge.NodeHostBridge
import org.fellow99.nodebridge.NodeRuntime
import org.fellow99.pi.PiDesktopAndroid.MainActivity
import org.fellow99.pi.PiDesktopAndroid.service.PiForegroundService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference

/**
 * 宿主能力（模块 104；能力名沿用库冻结清单 + Android 增量，与 ark `HostCapabilities.ets` 同名对标）。
 *
 * 纪律（规划 §3.2 A6「不隐藏平台真相」）：
 *   · **每个**能力都返回结构化 JSON；不注册的能力 Node 侧会得到 unregistered —— 那也是对的；
 *   · 需要用户交互（SAF 选择器 / 系统权限弹窗）的能力是**异步**的，而 bridge 0.2.0 的
 *     `host.register` 只支持同步返回 ⇒ 契约改为「立即受理 + 结果落文件」：
 *       - 返回 `{ok:true, async:true, requestId, resultPath}`，resultPath 在
 *         `<HOME>/saf-results/<requestId>.json`（HOME = `<filesDir>/node-bridge`，Node 可直接读）；
 *       - 用户完成/取消后 Kotlin 原子写结果文件（`{ok, granted, uri?/uris?, …}`）；
 *       - `payload/extensions/android-saf.js` 提供轮询封装（`/saf-pick-folder` 等命令）。
 *   · 支持 `dryRun:true`：不弹 UI，只回「会发什么 Intent」，供自检/测试；
 *   · 桩实现（暂缓项）如实返回 `unsupported`，绝不静默假装成功；
 *   · 主线程执行（库的 dispatcher 已保证）——只做轻活。
 */
object HostCapabilities {

    const val CHANNEL_ID = "pi-desktop-notify"

    /** SAF 异步结果落盘目录（相对 filesDir；HOME=node-bridge ⇒ Node 视角 `<HOME>/saf-results`）。 */
    private const val ASYNC_RESULT_DIR = "node-bridge/saf-results"

    private const val REQ_PERM_NOTIFICATION = 4201

    /** 库冻结的能力名清单 + Android 增量（keepAlive；缺一个 = 注册面不完整，启动时要吼出来）。 */
    val NAMES = listOf(
        "runtime.facts",
        "runtime.keepAlive",
        "perm.check",
        "perm.request",
        "perm.openAppInfo",
        "fs.pickFolder",
        "fs.pickFiles",
        "notify.show",
        "shell.openExternal",
        "log.hilog",
        "terminal.pty",
    )

    // ── Activity 承载（选择器/权限弹窗必须由 Activity 发起）───────────────────────
    private var activityRef: WeakReference<Activity>? = null
    private val pendingActivityResults = HashMap<Int, (resultCode: Int, data: Intent?) -> Unit>()
    private val pendingPermissionResults = HashMap<Int, (granted: Map<String, Boolean>) -> Unit>()
    private var requestCounter = 4300

    fun attach(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    /** Activity 销毁：未决请求一律落「cancelled」，让 Node 侧轮询能收敛（不悬挂）。 */
    fun detach(activity: Activity) {
        if (activityRef?.get() === activity) activityRef = null
        synchronized(this) {
            for ((code, callback) in pendingActivityResults.toList()) {
                pendingActivityResults.remove(code)
                runCatching { writeAsyncResult(activity, "req-$code", JSONObject().put("ok", false).put("error", "cancelled").put("detail", "宿主 Activity 已销毁")) }
                callback(Activity.RESULT_CANCELED, null)
            }
            for ((code, callback) in pendingPermissionResults.toList()) {
                pendingPermissionResults.remove(code)
                callback(emptyMap())
            }
        }
    }

    /** MainActivity.onActivityResult 转发点；返回 true 表示已消费。 */
    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        val callback = synchronized(this) { pendingActivityResults.remove(requestCode) } ?: return false
        callback(resultCode, data)
        return true
    }

    /** MainActivity.onRequestPermissionsResult 转发点；返回 true 表示已消费。 */
    fun handlePermissionResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        val callback = synchronized(this) { pendingPermissionResults.remove(requestCode) } ?: return false
        val granted = permissions.indices.associate { i -> permissions[i] to (grantResults[i] == PackageManager.PERMISSION_GRANTED) }
        callback(granted)
        return true
    }

    // ── 注册 ────────────────────────────────────────────────────────────────────
    fun register(context: Context, rt: NodeRuntime) {
        val host: NodeHostBridge = rt.host

        host.register("runtime.facts") { _ ->
            JSONObject()
                .put("ok", true)
                .put("pkg", context.packageName)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("model", Build.MODEL)
                .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                .put("pid", android.os.Process.myPid())
                .put("bridgeVersion", "node-bridge:0.2.0")
                .toString()
        }

        // Android 增量（能力清单 §D「前台服务」）：ark 无对应物（其形态映射为常驻通知）
        host.register("runtime.keepAlive") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val enable = args.optBoolean("enable", true)
            if (args.optBoolean("dryRun", false)) {
                return@register JSONObject()
                    .put("ok", true)
                    .put("dryRun", true)
                    .put("would", if (enable) "startForegroundService(PiForegroundService)" else "stopService(PiForegroundService)")
                    .put("type", "dataSync")
                    .toString()
            }
            try {
                if (enable) {
                    PiForegroundService.start(context)
                } else {
                    PiForegroundService.stop(context)
                }
                JSONObject()
                    .put("ok", true)
                    .put("foreground", enable)
                    .put("note", if (enable) "前台服务已启动（常驻通知；Doze 下 SSE 取证随 pi-web 就绪）" else "前台服务已停止")
                    .toString()
            } catch (t: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("error", "keep-alive-failed")
                    .put("detail", "${t.javaClass.simpleName}: ${t.message}")
                    .toString()
            }
        }

        host.register("perm.check") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val perm = args.optString("permType", args.optString("permission", ""))
            val result = JSONObject().put("ok", true).put("permType", perm)
            when {
                perm.isEmpty() || perm == "sandbox" -> result
                    .put("granted", true)
                    .put("note", "不适用（app-specific，无 OS 权限门槛）")
                perm == "notification" || perm == "android.permission.POST_NOTIFICATIONS" -> result
                    .put("granted", notificationGranted(context))
                    .put("note", if (Build.VERSION.SDK_INT >= 33) "POST_NOTIFICATIONS 运行时权限" else "API<33 无通知运行时权限（默认可发）")
                perm == "saf" || perm == "storage" -> {
                    val persisted = persistedUriPermissions(context)
                    result
                        .put("granted", persisted.isNotEmpty())
                        .put("persistedCount", persisted.size)
                        .put("note", "SAF 持久化授权数（fs.pick* 授予；content:// 非 POSIX 路径）")
                }
                perm.startsWith("ohos.") -> result
                    .put("granted", false)
                    .put("note", "OHOS 权限模型在 Android 不存在；共享目录授权 = SAF（fs.pickFolder/fs.pickFiles）")
                else -> result
                    .put("granted", JSONObject.NULL)
                    .put("note", "未知权限名；Android 侧可判定：sandbox/notification/saf")
            }
            result.toString()
        }

        host.register("perm.request") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val requested = mutableListOf<String>()
            args.optJSONArray("permissions")?.let { arr ->
                for (i in 0 until arr.length()) requested.add(arr.optString(i))
            }
            if (requested.isEmpty() && args.has("permType")) requested.add(args.optString("permType"))
            if (requested.isEmpty() && args.has("permission")) requested.add(args.optString("permission"))

            val results = JSONArray()
            var grantedCount = 0
            var deniedCount = 0
            var asyncCount = 0
            for (perm in requested) {
                val entry = JSONObject().put("permission", perm)
                when {
                    perm == "notification" || perm == "android.permission.POST_NOTIFICATIONS" -> {
                        if (notificationGranted(context)) {
                            grantedCount += 1
                            entry.put("granted", true).put("note", "已授权或平台无需运行时授权")
                        } else {
                            val activity = activityRef?.get()
                            if (activity == null) {
                                deniedCount += 1
                                entry.put("granted", false).put("error", "no-activity")
                            } else {
                                asyncCount += 1
                                val requestId = "perm-$perm-${nextRequestId()}"
                                val callback = fun(granted: Map<String, Boolean>) {
                                    val yes = granted.values.any { it }
                                    runCatching {
                                        writeAsyncResult(
                                            context, requestId,
                                            JSONObject()
                                                .put("ok", true)
                                                .put("capability", "perm.request")
                                                .put("permission", perm)
                                                .put("granted", yes)
                                                .put("at", System.currentTimeMillis()),
                                        )
                                    }
                                }
                                synchronized(this) { pendingPermissionResults[REQ_PERM_NOTIFICATION] = callback }
                                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_PERM_NOTIFICATION)
                                entry.put("granted", JSONObject.NULL).put("async", true).put("requestId", requestId)
                            }
                        }
                    }
                    perm.startsWith("ohos.") -> {
                        deniedCount += 1
                        entry.put("granted", false)
                            .put("error", "platform-mapping")
                            .put("note", "OHOS user_grant 权限在 Android 不存在；共享目录授权走 SAF（fs.pickFolder/fs.pickFiles）")
                    }
                    perm == "saf" -> {
                        deniedCount += 1
                        entry.put("granted", JSONObject.NULL)
                            .put("error", "interactive-only")
                            .put("note", "SAF 授权必须经系统选择器：调用 fs.pickFolder/fs.pickFiles")
                    }
                    else -> {
                        deniedCount += 1
                        entry.put("granted", false).put("error", "unknown-permission")
                    }
                }
                results.put(entry)
            }
            JSONObject()
                .put("ok", true)
                .put("requested", requested.size)
                .put("granted", grantedCount)
                .put("denied", deniedCount)
                .put("async", asyncCount)
                .put("results", results)
                .toString()
        }

        host.register("perm.openAppInfo") { argsJson ->
            try {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                """{"ok":true,"note":"已跳转系统应用详情（权限管理入口）"}"""
            } catch (t: Throwable) {
                """{"ok":false,"error":"no-handler","detail":"${t.javaClass.simpleName}"}"""
            }
        }

        // SAF 选择器：Phase 2 真接入（能力清单 §F 第 2 级 #1）
        host.register("fs.pickFolder") { argsJson ->
            pickViaSaf(context, argsJson, "fs.pickFolder")
        }
        host.register("fs.pickFiles") { argsJson ->
            pickViaSaf(context, argsJson, "fs.pickFiles")
        }

        host.register("notify.show") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val title = args.optString("title", "Pi Desktop")
            val body = args.optString("body", "")
            showNotification(context, title, body)
        }

        host.register("shell.openExternal") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val url = args.optString("url")
            if (args.optBoolean("dryRun", false)) {
                return@register """{"ok":true,"dryRun":true,"would":"ACTION_VIEW $url（仅 http(s) 放行）"}"""
            }
            if (url.isBlank() || !(url.startsWith("http://") || url.startsWith("https://"))) {
                """{"ok":false,"error":"bad-arg","detail":"url 必须是 http(s)（围栏：只放行系统浏览器可处理的外链）"}"""
            } else {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(intent)
                    """{"ok":true}"""
                } catch (t: Throwable) {
                    """{"ok":false,"error":"no-handler","detail":"${t.javaClass.simpleName}"}"""
                }
            }
        }

        host.register("log.hilog") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val line = "${args.optString("level", "info")} ${args.optString("text", "")}"
            appendAppLog(context, line)
            """{"ok":true}"""
        }

        // 能力标志（补丁 0001 的对端）：PTY 在 Android v1 暂缓 ⇒ 结构化 unsupported
        host.register("terminal.pty") { _ ->
            JSONObject()
                .put("ok", false)
                .put("capability", "terminal.pty")
                .put("supported", false)
                .put("platform", "android")
                .put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                .put("reason", "PTY 随 Phase 4+ 评估（用户决策 2026-10-24；规划 §8 #16 / §14.2 O6）")
                .toString()
        }

        val missing = NAMES.filter { host.names().contains(it).not() }
        check(missing.isEmpty()) { "宿主能力注册面不完整：缺 $missing（注册了 ${host.names()}）" }
    }

    // ── SAF 选择器实现 ──────────────────────────────────────────────────────────
    private fun pickViaSaf(context: Context, argsJson: String, capability: String): String {
        val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
        val isFolder = capability == "fs.pickFolder"
        if (args.optBoolean("dryRun", false)) {
            return JSONObject()
                .put("ok", true)
                .put("dryRun", true)
                .put(
                    "would",
                    if (isFolder) "ACTION_OPEN_DOCUMENT_TREE（系统目录选择器）" else "ACTION_OPEN_DOCUMENT（系统文件选择器）",
                )
                .put("async", true)
                .toString()
        }
        val activity = activityRef?.get()
            ?: return JSONObject()
                .put("ok", false)
                .put("error", "no-activity")
                .put("detail", "SAF 选择器必须由前台 Activity 发起（MainActivity 未就绪）")
                .toString()

        val intent = if (isFolder) {
            Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                // MIME：主类型 setType + 可选多类型 EXTRA_MIME_TYPES
                val extra = args.optJSONArray("mimeTypes")
                val first = args.optString("mimeType", "*/*")
                if (extra != null && extra.length() > 0) {
                    setType(extra.optString(0, first))
                    val list = arrayOfNulls<String>(extra.length())
                    for (i in 0 until extra.length()) list[i] = extra.optString(i)
                    putExtra(Intent.EXTRA_MIME_TYPES, list)
                } else {
                    type = first
                }
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.optBoolean("multiple", true))
            }
        }

        val requestCode = synchronized(this) { ++requestCounter }
        val requestId = "$capability-$requestCode"
        val callback: (resultCode: Int, data: Intent?) -> Unit = { resultCode, data ->
            val result = JSONObject()
                .put("ok", resultCode == Activity.RESULT_OK)
                .put("capability", capability)
                .put("at", System.currentTimeMillis())
            if (resultCode != Activity.RESULT_OK) {
                result.put("error", "cancelled").put("detail", "用户取消（resultCode=$resultCode）")
            } else if (isFolder) {
                val treeUri: Uri? = data?.data
                if (treeUri == null) {
                    result.put("error", "no-uri")
                } else {
                    takePersistable(context, treeUri)
                    result
                        .put("uri", treeUri.toString())
                        .put("treeDocumentId", treeDocumentId(treeUri))
                        .put("displayName", queryDisplayName(context, treeUri))
                        .put(
                            "note",
                            "已 takePersistableUriPermission（read|write）。content:// 不是 POSIX 路径：" +
                                "Node fs 不能直接读，须经 ContentResolver（扩展 android-saf.js 提供查询命令）",
                        )
                }
            } else {
                val uris = mutableListOf<String>()
                data?.data?.let { uris.add(it.toString()) }
                data?.clipData?.let { clip ->
                    for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it.toString()) }
                }
                for (u in uris) runCatching { takePersistable(context, Uri.parse(u)) }
                result
                    .put("uris", JSONArray(uris))
                    .put("count", uris.size)
                    .put("note", "已对每个 URI takePersistableUriPermission（读）")
            }
            runCatching { writeAsyncResult(context, requestId, result) }
        }
        synchronized(this) { pendingActivityResults[requestCode] = callback }

        activity.startActivityForResult(intent, requestCode)
        return JSONObject()
            .put("ok", true)
            .put("async", true)
            .put("requestId", requestId)
            .put("resultPath", resultPathFor(context, requestId))
            .put("note", "系统选择器已弹出；完成后结果落 resultPath（JSON），Node 侧轮询读取")
            .toString()
    }

    private fun takePersistable(context: Context, uri: Uri) {
        runCatching {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
        }
    }

    private fun treeDocumentId(uri: Uri): String? = runCatching {
        android.provider.DocumentsContract.getTreeDocumentId(uri)
    }.getOrNull()

    private fun queryDisplayName(context: Context, uri: Uri): String? = runCatching {
        context.contentResolver.query(
            uri,
            arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),
            null, null, null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()

    private fun resultPathFor(context: Context, requestId: String): String {
        val file = asyncResultFile(context, requestId)
        // Node 视角：HOME=<filesDir>/node-bridge ⇒ 显示为 <HOME>/saf-results/<id>.json
        return "<HOME>/saf-results/${file.name}"
    }

    private fun asyncResultFile(context: Context, requestId: String): File {
        val dir = File(context.filesDir, ASYNC_RESULT_DIR)
        dir.mkdirs()
        return File(dir, sanitizeRequestId(requestId) + ".json")
    }

    private fun sanitizeRequestId(requestId: String): String =
        requestId.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun nextRequestId(): Int = synchronized(this) { ++requestCounter }

    /** 异步结果原子落盘（Node 侧轮询消费）。 */
    private fun writeAsyncResult(context: Context, requestId: String, result: JSONObject) {
        val file = asyncResultFile(context, requestId)
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(result.toString(2) + "\n")
        if (!tmp.renameTo(file)) {
            file.writeText(result.toString(2) + "\n")
            tmp.delete()
        }
    }

    private fun persistedUriPermissions(context: Context): List<Uri> =
        context.contentResolver.persistedUriPermissions.map { it.uri }

    private fun notificationGranted(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    // ── 通知 / 日志 / 工作区 ────────────────────────────────────────────────────
    private fun showNotification(context: Context, title: String, body: String): String {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Pi Desktop", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        if (!notificationGranted(context)) {
            return """{"ok":false,"error":"permission","detail":"POST_NOTIFICATIONS 未授权（请走 perm.request {permissions:['notification']} 或 perm.openAppInfo）"}"""
        }
        val contentIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = android.app.Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(org.fellow99.pi.PiDesktopAndroid.R.drawable.ic_fg_service)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(android.app.Notification.BigTextStyle().bigText(body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
        nm.notify((System.currentTimeMillis() and 0x7fffffff).toInt(), notification.build())
        return """{"ok":true}"""
    }

    private fun appendAppLog(context: Context, line: String) {
        runCatching {
            val dir = File(context.filesDir, "host-log")
            dir.mkdirs()
            File(dir, "host.log").appendText("${System.currentTimeMillis()} $line\n")
        }
    }

    /** 工作区默认根（规划 §5 #10 ①：app-specific 外存真实路径，免权限）。 */
    fun workspaceRoot(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        val root = File(base, "workspace")
        root.mkdirs()
        return root
    }
}
