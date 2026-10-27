package org.fellow99.pi.PiDesktopAndroid.runtime

import android.content.Context
import kotlinx.coroutines.flow.asStateFlow
import org.fellow99.nodebridge.NodeRuntime
import kotlinx.coroutines.flow.asStateFlow
import org.fellow99.nodebridge.NodeRuntimeOptions
import org.fellow99.nodebridge.NodeState
import org.fellow99.pi.PiDesktopAndroid.host.HostCapabilities
import org.fellow99.pi.PiDesktopAndroid.payload.PayloadArchive
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 启动编排（模块 101；对标 ark `PiDesktopRuntime`）：
 *
 *   注册宿主能力 → 解包载荷（assets → payloadRoot，SHA-256 幂等）→ rt.start
 *   → 轮询就绪 marker（拿真实端口）→ HTTP 探活 /api/web-auth → markRunning → WebView loadUrl
 *
 * 状态机（失败可见，A5）：Loading(阶段文本) → Ready(url) / Failed(stage, message, logTail)。
 * 判据纪律：就绪 = marker 里的真实端口 + `/api/web-auth` 200，**不**以 logcat 为判据。
 */
object PiDesktopRuntime {

    sealed class ShellState {
        data class Loading(val stage: String) : ShellState()
        data class Ready(val port: Int, val url: String) : ShellState()
        data class Failed(val stage: String, val message: String, val logTail: List<String>) : ShellState()
    }

    private val _state = kotlinx.coroutines.flow.MutableStateFlow<ShellState>(ShellState.Loading("初始化"))

    /** 壳 UI 观察这个状态流；只在主线程消费。 */
    val state: kotlinx.coroutines.flow.StateFlow<ShellState> = _state

    private val started = AtomicBoolean(false)
    private lateinit var appContext: Context
    private lateinit var rt: NodeRuntime

    val payloadRoot: File get() = File(appContext.filesDir, "node-bridge/payload")
    val readyMarker: File get() = File(appContext.filesDir, "node-bridge/payload/pi-web.ready.json")

    private fun say(stage: String) {
        _state.value = ShellState.Loading(stage)
    }

    private fun fail(stage: String, message: String, t: Throwable? = null): Nothing {
        val detail = buildString {
            append(message)
            t?.let { append("（${it.javaClass.simpleName}: ${it.message}）") }
        }
        _state.value = ShellState.Failed(stage, detail, tailLogs())
        throw IllegalStateException(detail)
    }

    private fun tailLogs(): List<String> {
        return runCatching { rt.logs(120).map { "[${it.stream}] ${it.text}" } }.getOrDefault(emptyList())
    }

    /** 幂等启动；重复调用（Activity 重建）只返回既有状态流。 */
    fun start(context: Context) {
        appContext = context.applicationContext
        if (!started.compareAndSet(false, true)) return
        Thread({
            try {
                runBoot()
            } catch (t: Throwable) {
                // fail() 已写入状态；这里是兜底（异常从 runBoot 抛出的路径）
                if (_state.value !is ShellState.Failed) {
                    _state.value = ShellState.Failed("boot", t.message ?: t.javaClass.simpleName, emptyList())
                }
            }
        }, "pi-desktop-boot").start()
    }

    private fun runBoot() {
        rt = NodeRuntime.getInstance(appContext)

        say("注册宿主能力…")
        HostCapabilities.register(appContext, rt)
        // 桩能力只消费 applicationContext；Phase 2 的 SAF/通知请求流改接前台 Activity（specs/104）。

        say("准备载荷（首启解包 27k 文件，约 20-40s；二次启动毫秒级）…")
        val archive = materializeArchive()
        PayloadArchive.ensureExtracted(archive, payloadRoot)

        // 工作区根（规划 §5 #10 ①）：app-specific 外存真实路径
        val workspace = HostCapabilities.workspaceRoot(appContext)
        val agentDir = File(appContext.filesDir, "pi-agent")
        agentDir.mkdirs()

        val roots = JSONArray().put(
            JSONObject()
                .put("id", "sandbox")
                .put("label", "工作区")
                .put("path", workspace.absolutePath.replace('\\', '/'))
                .put("permType", JSONObject.NULL),
        )
        val noProxyBase = System.getenv("NO_PROXY") ?: System.getenv("no_proxy") ?: ""
        val noProxy = (noProxyBase.split(',').map { it.trim() }.filter { it.isNotEmpty() } +
            listOf("127.0.0.1", "localhost", "::1")).distinct().joinToString(",")

        val env = mapOf(
            "PI_CODING_AGENT_DIR" to agentDir.absolutePath,
            "PI_ANDROID_ROOTS" to roots.toString(),
            "NO_PROXY" to noProxy,
            "no_proxy" to noProxy,
            "PI_WEB_APP_NAME" to "Pi Desktop",
            "PI_WEB_SKIP_VERSION_CHECK" to "1",
        )

        say("启动进程内 Node…")
        val appEntryAbs = File(payloadRoot, "pi-web/pi-web-launch.js")
        check(appEntryAbs.isFile) { "载荷缺入口：$appEntryAbs（组装产物不完整？）" }
        // jitless 策略：翻译环境（x86_64 宿主跑 arm64 引擎）下 V8 JIT 触发 berberis memcpy SEGV
        // （tombstone：memmove_generic ← libproxy_arm64_to_x86_64，01:47 crash）⇒ 翻译环境强制
        // 解释器模式；真机 arm64 无翻译 ⇒ 原生 JIT（O1 实测可用）。
        val jitless = android.os.Build.SUPPORTED_ABIS.any { it.contains("x86") }
        say(if (jitless) "翻译环境：解释器模式（jitless）…" else "JIT 模式…")
        val result = rt.start(
            NodeRuntimeOptions(
                entry = "bootstrap.js",
                jitless = jitless,
                appEntry = appEntryAbs.absolutePath,
                cwd = File(payloadRoot, "pi-web").absolutePath,
                env = env,
            ),
        )
        if (!result.ok) {
            fail("start", "运行时投递失败 rc=${result.code}：${result.message ?: "-"}")
        }

        say("等待服务就绪（marker + /api/web-auth）…")
        val port = waitReadyPort(timeoutMs = 150_000)
        say("探活 http://127.0.0.1:$port/api/web-auth …")
        awaitHttpReady(port, timeoutMs = 90_000)
        rt.markRunning()
        _state.value = ShellState.Ready(port, "http://127.0.0.1:$port/")
    }

    /** 把 assets 载荷复制到 cache（PayloadArchive 需要 File 入口做 SHA-256 幂等）。 */
    private fun materializeArchive(): File {
        val incoming = File(appContext.cacheDir, "payload-incoming")
        incoming.mkdirs()
        val out = File(incoming, "pi-web.tar.gz")
        if (!out.isFile || out.length() == 0L) {
            // AGP 会把 noCompress 的 .gz 资产「去壳」改名 .tar ⇒ 两个名字都兼容
            val hasGzName = appContext.assets.list("pi-web")?.contains("pi-web.tar.gz") == true
            val assetPath = if (hasGzName) "pi-web/pi-web.tar.gz" else "pi-web/pi-web.tar"
            appContext.assets.open(assetPath).use { input ->
                out.outputStream().use { output -> input.copyTo(output, 256 * 1024) }
            }
        }
        return out
    }

    /** 读就绪 marker 拿真实端口（不猜、不硬编码；规划 §4 启动时序）。 */
    private fun waitReadyPort(timeoutMs: Long): Int {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (rt.state.value is NodeState.Failed) {
                fail("node", "运行时失败：${(rt.state.value as NodeState.Failed).message}")
            }
            val marker = readyMarker
            if (marker.isFile) {
                val record = runCatching { JSONObject(marker.readText()) }.getOrNull()
                val port = record?.optInt("port", 0) ?: 0
                if (port > 0) return port
            }
            Thread.sleep(400)
        }
        fail("ready-marker", "就绪 marker 超时（${timeoutMs}ms）", null)
    }

    /** HTTP 探活 /api/web-auth（400ms 间隔，90s 超时；与 ark 同口径）。 */
    private fun awaitHttpReady(port: Int, timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last = "(尚未探测)"
        while (System.currentTimeMillis() < deadline) {
            try {
                val conn = URL("http://127.0.0.1:$port/api/web-auth").openConnection() as HttpURLConnection
                conn.connectTimeout = 2000
                conn.readTimeout = 5000
                val code = conn.responseCode
                conn.disconnect()
                if (code in 200..299) return
                last = "HTTP $code"
            } catch (t: Throwable) {
                last = t.javaClass.simpleName
            }
            Thread.sleep(400)
        }
        fail("probe", "就绪探活超时（最后：$last）")
    }
}
