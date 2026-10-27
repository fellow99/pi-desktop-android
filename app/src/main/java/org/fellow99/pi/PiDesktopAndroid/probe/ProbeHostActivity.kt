package org.fellow99.pi.PiDesktopAndroid.probe

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.graphics.Typeface
import org.fellow99.nodebridge.NodeRuntime
import org.fellow99.nodebridge.NodeRuntimeOptions
import org.fellow99.pi.PiDesktopAndroid.payload.PayloadArchive
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Phase 0 探针宿主（000-scaffold 专用；**探针清理时整包删除**，含 Manifest 声明）。
 *
 * 取证入口（宿主机侧）：
 *   adb forward tcp:15577 tcp:15577
 *   curl http://127.0.0.1:15577/facts        # O1/O2/O5 + fs/worker/宿主桥
 *   curl http://127.0.0.1:15577/o3-report    # O3 WebView 数据面（页面内自测回传）
 *   adb shell run-as org.fellow99.pi.PiDesktopAndroid cat files/probe-archive/o4-report.json
 *
 * O4 需要先把归档推进应用沙箱：
 *   adb push pi-web.tar.gz /data/local/tmp/pda.tar.gz
 *   adb shell run-as org.fellow99.pi.PiDesktopAndroid mkdir -p files/probe-archive
 *   adb shell "cat /data/local/tmp/pda.tar.gz | run-as org.fellow99.pi.PiDesktopAndroid sh -c 'cat > files/probe-archive/pi-web.tar.gz'"
 */
class ProbeHostActivity : Activity() {

    private lateinit var runtime: NodeRuntime
    private lateinit var status: TextView
    private lateinit var output: TextView
    private lateinit var web: WebView

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    // 注意：模拟器上有同族探针应用（dsh.android / sample.modern）占用 15577 ⇒ 用独立端口
    private val port = 15677

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runtime = NodeRuntime.getInstance(this)
        registerHostCapabilities()
        setContentView(buildUi())
        say(banner())

        val autorun = intent?.getStringExtra("autorun") == "1"
        if (autorun) ui.postDelayed({ startProbeRuntime() }, 300)
    }

    // ── UI ───────────────────────────────────────────────────────────────────

    private fun buildUi(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(20, 24, 20, 8)
            typeface = Typeface.MONOSPACE
        }
        root.addView(status)

        root.addView(row(
            "① 启动" to { startProbeRuntime() },
            "② /facts" to { fetchFacts() },
        ))
        root.addView(row(
            "③ 日志" to { showLogs() },
            "④ O4解包" to { runExtractBenchmark() },
        ))

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
        }
        root.addView(
            web,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1.4f),
        )

        output = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f)
            setPadding(20, 4, 20, 16)
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        }
        root.addView(
            ScrollView(this).apply { addView(output) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        return root
    }

    private fun row(vararg defs: Pair<String, () -> Unit>): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(12, 2, 12, 2)
        }
        for ((label, action) in defs) {
            r.addView(Button(this).apply {
                text = label
                setOnClickListener { action() }
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
        }
        return r
    }

    private fun banner(): String =
        "Pi Desktop probe · ${android.os.Build.MODEL} / API ${android.os.Build.VERSION.SDK_INT} / " +
            android.os.Build.SUPPORTED_ABIS.joinToString(",") + "\nlibDir=${applicationInfo.nativeLibraryDir}"

    private fun say(line: String) {
        val stamped = "${timeFmt.format(Date())} $line"
        ui.post {
            val cur = output.text?.toString().orEmpty()
            output.text = if (cur.isEmpty()) stamped else "$cur\n$stamped"
            (output.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun setStatus(text: String) = ui.post { status.text = text }

    private fun startStateTicker() {
        val tick = object : Runnable {
            override fun run() {
                val s = runtime.state.value
                setStatus("state=${s::class.simpleName} stage=${runtime.stage} " +
                    "native=${if (runtime.nativeAvailable) "ok" else "missing"}")
                ui.postDelayed(this, 500)
            }
        }
        ui.post(tick)
    }

    // ── 动作 ─────────────────────────────────────────────────────────────────

    private fun registerHostCapabilities() {
        runtime.host.register("echo") { args ->
            """{"ok":true,"echo":$args,"handledBy":"kotlin","at":${System.currentTimeMillis()}}"""
        }
        runtime.host.register("runtime.facts") {
            """{"ok":true,"pkg":"$packageName","sdk":${android.os.Build.VERSION.SDK_INT},""" +
                """"model":"${android.os.Build.MODEL}","pid":${android.os.Process.myPid()}}"""
        }
        runtime.host.register("shutdown") { """{"ok":true,"note":"shutdown hook registered"}""" }
    }

    /** 把 assets/probe 下的文件物化到 payloadRoot（探针期载荷与库内建载荷共存） */
    private fun materializeProbeAssets() {
        val payloadRoot = File(filesDir, "node-bridge/payload")
        payloadRoot.mkdirs()
        val names = assets.list("probe") ?: return
        for (name in names) {
            assets.open("probe/$name").use { input ->
                FileOutputStream(File(payloadRoot, name)).use { out -> input.copyTo(out) }
            }
        }
    }

    private fun startProbeRuntime() {
        io.execute {
            try {
                materializeProbeAssets()
            } catch (t: Throwable) {
                say("materialize failed: $t")
            }
            ui.post { startStateTicker() }
            val opts = NodeRuntimeOptions(
                entry = "bootstrap.js",
                appEntry = "probe-entry.js",
                env = mapOf("NODE_BRIDGE_PORT" to port.toString()),
            )
            val r = runtime.start(opts)
            say("start ok=${r.ok} code=${r.code} state=${r.state} msg=${r.message ?: "-"}")
            if (!r.ok) {
                say("lastError=${runtime.lastError}")
                runtime.lastCrash()?.let { say("lastCrash=${it.raw.trim()}") }
                return@execute
            }
            val st = runtime.awaitRunning(30_000)
            say("awaitRunning -> $st")
            if (st is org.fellow99.nodebridge.NodeState.Running ||
                st is org.fellow99.nodebridge.NodeState.Starting
            ) {
                waitForHttpThenLoadO3()
            }
        }
    }

    private fun waitForHttpThenLoadO3() {
        var attempts = 0
        val poll = object : Runnable {
            override fun run() {
                attempts += 1
                io.execute {
                    val ok = try {
                        val conn = URL("http://127.0.0.1:$port/api/ping").openConnection() as HttpURLConnection
                        conn.connectTimeout = 1500
                        conn.readTimeout = 3000
                        val code = conn.responseCode
                        conn.disconnect()
                        code in 200..299
                    } catch (t: Throwable) {
                        false
                    }
                    ui.post {
                        if (ok) {
                            say("server ready after $attempts attempts -> loading /o3.html in WebView")
                            web.loadUrl("http://127.0.0.1:$port/o3.html")
                        } else if (attempts < 40) {
                            ui.postDelayed(this, 500)
                        } else {
                            say("server never became ready ($attempts attempts)")
                        }
                    }
                }
            }
        }
        ui.post(poll)
    }

    private fun fetchFacts() {
        io.execute {
            try {
                val conn = URL("http://127.0.0.1:$port/facts").openConnection() as HttpURLConnection
                conn.connectTimeout = 3000
                conn.readTimeout = 30_000
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty()
                say("HTTP $code\n$body")
                conn.disconnect()
            } catch (t: Throwable) {
                say("HTTP 失败：${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }

    private fun showLogs() {
        io.execute {
            val logs = runtime.logs(300)
            say("---- node_bridge.log 尾部 ${logs.size} 行 ----")
            for (e in logs.takeLast(140)) say("[${e.stream}] ${e.text}")
        }
    }

    /**
     * O4：解包耗时/幂等三连测。
     * 前置：filesDir/probe-archive/pi-web.tar.gz 已由 adb 推入沙箱。
     */
    private fun runExtractBenchmark() {
        io.execute {
            try {
                val probeDir = File(filesDir, "probe-archive")
                val archive = File(probeDir, "pi-web.tar.gz")
                val payloadRoot = File(filesDir, "node-bridge/payload")
                val results = mutableListOf<Map<String, Any?>>()

                fun cleanDest() {
                    File(payloadRoot, "pi-web").deleteRecursively()
                    payloadRoot.listFiles { f -> f.name.startsWith(".ready-") }?.forEach { it.delete() }
                }

                // ① 首次解包（冷）
                cleanDest()
                val r1 = PayloadArchive.ensureExtracted(archive, payloadRoot)
                results.add(mapOf("run" to "cold", "report" to r1.toString()))

                // ② 删除后二次解包（第二次冷解包，验证可重复）
                cleanDest()
                val r2 = PayloadArchive.ensureExtracted(archive, payloadRoot)
                results.add(mapOf("run" to "warm-after-clean", "report" to r2.toString()))

                // ③ 幂等（marker 命中 ⇒ skip）
                val r3 = PayloadArchive.ensureExtracted(archive, payloadRoot)
                results.add(mapOf("run" to "idempotent", "report" to r3.toString()))

                // 记录内存峰值参考（dumpsys 由宿主机侧取证）
                val reportJson = results.joinToString(",\n") { m ->
                    "  {\"run\": \"${m["run"]}\", \"report\": \"${m["report"]}\"}"
                }
                val out = File(probeDir, "o4-report.json")
                probeDir.mkdirs()
                out.writeText("[\n$reportJson\n]\n")
                say("O4 完成 → ${out.absolutePath}\n$reportJson")
            } catch (t: Throwable) {
                say("O4 失败：${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }
}
