package org.fellow99.pi.PiDesktopAndroid.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.fellow99.pi.PiDesktopAndroid.MainActivity
import org.fellow99.pi.PiDesktopAndroid.R

/**
 * 前台服务（能力清单 §F 第 2 级 #3「后台常驻」——Android 相对 ark 的增量能力）。
 *
 * 形态映射（规划 §8 #27/#29）：ark/桌面端的「托盘/常驻」在 Android = 前台服务 + 常驻通知；
 * 不申请任何受限权限（合规红线 G7：无 SYSTEM_ALERT_WINDOW / 开机自启）。
 *
 * 启动入口：宿主能力 `runtime.keepAlive {enable:true}`（HostCapabilities），
 * 或调试期 `adb shell am start-foreground-service`（模拟器取证用）。
 *
 * Doze 下 SSE 行为（O9）：本服务保住进程优先级 ⇒ 理论上 SSE 不断；**端到端取证依赖
 * pi-web 起来之后**，模拟器被 berberis 翻译层阻塞（能力清单 §E）⇒ 本轮只验证
 * 「服务在位 + 通知可见 + Doze idle 下进程/服务存活」，SSE 项如实记 ⬜。
 */
class PiForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
        // START_STICKY：进程被杀后系统尽力拉回（不是开机自启，合规 G7 不受限）
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Pi Desktop 前台服务",
                    NotificationManager.IMPORTANCE_LOW, // 常驻通知不发声
                ),
            )
        }
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_fg_service)
            .setContentTitle("Pi Desktop 运行中")
            .setContentText("长会话保活（前台服务 · dataSync）")
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "pi-desktop-foreground"
        const val NOTIFICATION_ID = 2001

        fun start(context: Context) {
            val intent = Intent(context, PiForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PiForegroundService::class.java))
        }
    }
}
