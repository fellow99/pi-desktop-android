package org.fellow99.pi.PiDesktopAndroid

import android.app.Application
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Application 级哨兵（能力清单 §F 第 1 级 #5「错误页在原生崩溃下的可达性」）。
 *
 * 覆盖面（如实声明，规划 A6「不隐藏平台真相」）：
 *   · **Java/Kotlin 未捕获异常**：默认 handler 只在进程将死时被调 ⇒ 这里抢先把现场
 *     落盘到 `<filesDir>/crash/last-crash.txt`，再交回系统默认处置（进程照常终止）。
 *     下次启动由 MainActivity 读回并展示「上次异常退出」横幅（错误恢复路径的入口）。
 *   · **原生崩溃（SIGSEGV 等）**：signal 直接带走进程，任何 Java 层 handler 都不执行 ——
 *     这不是本哨兵能拦的（能力清单 §E 的 berberis SEGV 即此类）。该场景的恢复路径 =
 *     系统自动重启 Activity + 用户手动重开；tombstone 由系统落 `/data/tombstones`。
 *     以上边界已写进 docs/002 错误恢复路径一节。
 *
 * 纪律：哨兵本身绝不能成为新的故障点 —— 落盘全程 runCatching，任何失败都静默让位。
 */
class PiApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching { writeCrashRecord(thread, throwable) }
            // 交回系统默认（进程终止 + 系统 crash 弹窗/logcat），不吞、不假装恢复
            previous?.uncaughtException(thread, throwable)
        }
    }

    private fun writeCrashRecord(thread: Thread, throwable: Throwable) {
        val stack = StringWriter().also { throwable.printStackTrace(PrintWriter(it)) }.toString()
        val text = buildString {
            appendLine("at=${System.currentTimeMillis()}")
            appendLine("iso=${java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).format(java.util.Date())}")
            appendLine("thread=${thread.name}")
            appendLine("exception=${throwable.javaClass.name}")
            appendLine("message=${throwable.message ?: ""}")
            appendLine("---- stack ----")
            append(stack.take(16_000))
            appendLine()
        }
        val dir = File(filesDir, "crash")
        dir.mkdirs()
        // 原子写：先临时文件再改名，避免半截文件被下一次启动当成有效现场
        val tmp = File(dir, "last-crash.txt.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(File(dir, "last-crash.txt"))) {
            File(dir, "last-crash.txt").writeText(text)
            tmp.delete()
        }
    }

    companion object {
        /** 上次 Java 崩溃记录（无则 null）；MainActivity 启动横幅消费。 */
        fun lastCrash(context: android.content.Context): String? {
            val f = File(context.filesDir, "crash/last-crash.txt")
            if (!f.isFile) return null
            return runCatching { f.readText().take(2_000) }.getOrNull()
        }
    }
}
