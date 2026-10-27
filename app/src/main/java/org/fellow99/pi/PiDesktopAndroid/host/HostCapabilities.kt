package org.fellow99.pi.PiDesktopAndroid.host

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.fellow99.nodebridge.NodeHostBridge
import org.fellow99.nodebridge.NodeRuntime
import org.json.JSONObject
import java.io.File

/**
 * 宿主能力（模块 104；能力名沿用库冻结清单，与 ark `HostCapabilities.ets` 同名对标）。
 *
 * 纪律（规划 §3.2 A6「不隐藏平台真相」）：
 *   · **每个**能力都返回结构化 JSON；不注册的能力 Node 侧会得到 unregistered —— 那也是对的；
 *   · 桩实现（Phase 2 才接的）如实返回 `unsupported`，绝不静默假装成功；
 *   · 主线程执行（库的 dispatcher 已保证）——只做轻活，重活交系统组件。
 */
object HostCapabilities {

    const val CHANNEL_ID = "pi-desktop-notify"

    /** 库冻结的能力名清单（缺一个 = 注册面不完整，启动时要吼出来）。 */
    val NAMES = listOf(
        "runtime.facts",
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

        host.register("perm.check") { argsJson ->
            val perm = runCatching { JSONObject(argsJson).optString("permType") }.getOrDefault("")
            JSONObject()
                .put("ok", true)
                .put("permType", perm)
                .put(
                    "granted",
                    when (perm) {
                        "", "sandbox" -> true // app-specific 目录无 OS 权限门槛
                        else -> JSONObject.NULL // SAF/通知类：Phase 2 桥接后可判定
                    },
                )
                .put("note", if (perm.isEmpty() || perm == "sandbox") "不适用（app-specific）" else "Android v1 未接 SAF 判定（Phase 2）")
                .toString()
        }

        host.register("perm.request") { argsJson ->
            stubAsync(context, argsJson, "perm.request")
        }
        host.register("perm.openAppInfo") { argsJson ->
            stubAsync(context, argsJson, "perm.openAppInfo")
        }

        // SAF 选择器：Phase 1 返回结构化 unsupported（pi-web 补丁 0005/0006 的契约面保持可探测）
        host.register("fs.pickFolder") { argsJson ->
            stubAsync(context, argsJson, "fs.pickFolder")
        }
        host.register("fs.pickFiles") { argsJson ->
            stubAsync(context, argsJson, "fs.pickFiles")
        }

        host.register("notify.show") { argsJson ->
            val args = runCatching { JSONObject(argsJson) }.getOrDefault(JSONObject())
            val title = args.optString("title", "Pi Desktop")
            val body = args.optString("body", "")
            showNotification(context, title, body)
        }

        host.register("shell.openExternal") { argsJson ->
            val url = runCatching { JSONObject(argsJson).optString("url") }.getOrDefault("")
            if (url.isBlank() || !(url.startsWith("http://") || url.startsWith("https://"))) {
                """{"ok":false,"error":"bad-arg","detail":"url 必须是 http(s)（围栏：只放行系统浏览器可处理的外链）"}"""
            } else {
                return@register try {
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

    private fun stubAsync(context: Context, argsJson: String, name: String): String {
        appendAppLog(context, "host $name（Phase 2 接入）：$argsJson")
        return JSONObject()
            .put("ok", false)
            .put("error", "unsupported")
            .put("capability", name)
            .put("phase", "Phase 2（SAF/授权桥接）")
            .toString()
    }

    private fun showNotification(context: Context, title: String, body: String): String {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Pi Desktop", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return """{"ok":false,"error":"permission","detail":"POST_NOTIFICATIONS 未授权（Phase 2 请求流）"}"""
        }
        val notification = android.app.Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
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
