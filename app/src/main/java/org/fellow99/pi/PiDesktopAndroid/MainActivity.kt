package org.fellow99.pi.PiDesktopAndroid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.fellow99.pi.PiDesktopAndroid.runtime.PiDesktopRuntime
import org.fellow99.pi.PiDesktopAndroid.runtime.PiDesktopRuntime.ShellState

/**
 * 主入口（singleTask；模块 103 渲染壳）。
 *
 * 三态（失败可见，A5）：加载页（阶段文本）→ WebView（同源 Pi Web UI）/ 错误页（stage+日志尾）。
 * 围栏（§5 #11）：主 frame 非 loopback 一律交系统浏览器；禁止多窗口；返回键 = WebView 历史 → 退出。
 * 崩溃语义（§6.2 ⑥）：进程内 Node 不可重启 ⇒ 错误页明确提示「请重启应用」。
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var loadingText: TextView
    private lateinit var errorBox: LinearLayout
    private lateinit var errorTitle: TextView
    private lateinit var errorLog: TextView
    private lateinit var web: WebView
    private var webAttached = false

    private val ui = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this)
        loadingText = TextView(this).apply {
            gravity = Gravity.CENTER
            typeface = Typeface.MONOSPACE
            setPadding(32, 32, 32, 32)
            text = "Pi Desktop\n初始化…"
        }
        errorBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(24, 24, 24, 24)
        }
        errorTitle = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        errorLog = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 9f)
            setTextIsSelectable(true)
        }
        errorBox.addView(errorTitle)
        errorBox.addView(ScrollView(this).apply { addView(errorLog) })
        errorBox.addView(Button(this).apply {
            text = "重启应用"
            setOnClickListener { restartApp() }
        })

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setSupportMultipleWindows(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url ?: return false
                    val host = url.host ?: return false
                    // 围栏：只放行 loopback；其余主 frame 导航交系统浏览器（§5 #11）
                    if (host == "127.0.0.1" || host == "localhost") return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                        true
                    }.getOrDefault(true)
                }
            }
            visibility = View.GONE
        }

        root.addView(loadingText)
        root.addView(errorBox, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)

        PiDesktopRuntime.start(this)
        observeState()
    }

    private fun observeState() {
        ui.post(object : Runnable {
            override fun run() {
                if (isDestroyed || isFinishing) return; // 评审修复：销毁后停止 UI 轮询（防泄漏/视图越权更新）
                when (val s = PiDesktopRuntime.state.value) {
                    is ShellState.Loading -> {
                        loadingText.visibility = View.VISIBLE
                        loadingText.text = "Pi Desktop\n${s.stage}"
                    }
                    is ShellState.Ready -> {
                        loadingText.visibility = View.GONE
                        errorBox.visibility = View.GONE
                        if (!webAttached) {
                            webAttached = true
                            web.loadUrl(s.url)
                            web.visibility = View.VISIBLE
                        }
                    }
                    is ShellState.Failed -> {
                        loadingText.visibility = View.GONE
                        errorBox.visibility = View.VISIBLE
                        errorTitle.text = "启动失败（stage=${s.stage}）\n${s.message}"
                        errorLog.text = "---- node_bridge.log 尾部 ----\n" + s.logTail.takeLast(60).joinToString("\n")
                    }
                }
                ui.postDelayed(this, 250)
            }
        })
    }

    private fun restartApp() {
        // 进程内 Node 不可重启（硬约束 ⑥）⇒ 唯一恢复路径 = 重启应用进程
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        startActivity(intent)
        finishAffinity()
        Runtime.getRuntime().exit(0)
    }

    override fun onBackPressed() {
        // 返回键守卫（§5 #11）：WebView 能退就退，否则交给系统默认（退出）
        if (webAttached && web.canGoBack()) {
            web.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        // 优雅关停：尽力而为（bridge 0.2.0 无 Node 侧钩子；server 随进程退出释放）
        if (isFinishing) {
            runCatching {
                val rt = org.fellow99.nodebridge.NodeRuntime.getInstance(applicationContext)
                rt.shutdown("activity-destroy")
            }
        }
        super.onDestroy()
    }
}
