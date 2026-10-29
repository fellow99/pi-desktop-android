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
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.fellow99.pi.PiDesktopAndroid.host.HostCapabilities
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
    /** 图片上传（<input type=file>）回调：onShowFileChooser 暂存，onActivityResult 回传。 */
    private var filePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private var fileChooserRequestCode = 0x1F10
    /** 上次崩溃横幅（Loading 态持续显示；null=无记录）。 */
    private var crashBanner: String? = null

    private val ui = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // WebView 远程调试仅 debug（G11 诊断面纪律）：release 不暴露 chrome://inspect
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

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
                // 旧版系统 WebView（实测 Chrome 94）缺 ES2022 API（findLast(Index)/structuredClone），
                // 必须在页面任何脚本执行前同步注入垫片，否则消息渲染期 TypeError 会炸掉整页
                // （Next global-error「This page couldn't load」）。onPageStarted 早于页面 JS。
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    injectWebViewPolyfill(view)
                }
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // 复查：onPageStarted 的注入在极少数时序下可能落空（about:blank 过渡）。
                    // 检测三个垫片是否都在，缺则补注入并记录，便于真机排查。
                    view?.evaluateJavascript(
                        "(typeof [].findLastIndex==='function' && typeof structuredClone==='function' " +
                        "&& typeof AbortSignal.prototype.throwIfAborted==='function' " +
                        "&& typeof AbortSignal.timeout==='function') ? '1' : '0'"
                    ) { result ->
                        if (result?.trim('"') != "1") {
                            android.util.Log.w("pi-web-polyfill", "onPageFinished 检测垫片缺失，补注入 url=$url")
                            injectWebViewPolyfill(view)
                        }
                    }
                }

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

        // 转发页面 console 与 JS 异常到 logcat（默认 WebView 完全静默，否则客户端
        // TypeError 无处可查）。tag=pi-web-console，仅取 message/lineNumber。
        web.settings.javaScriptCanOpenWindowsAutomatically = false
        web.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(cm: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i("pi-web-console", "[${cm.messageLevel()}] ${cm.message()} @${cm.sourceId()}:${cm.lineNumber()}")
                return true
            }

            // <input type=file accept=image/*>（对话上传图片按钮）：WebView 默认不弹选择器，
            // 点击无反应。这里接住请求，用系统文档/相册选择器（SAF，无需存储权限）。
            override fun onShowFileChooser(
                view: WebView?,
                callback: android.webkit.ValueCallback<Array<Uri>>?,
                params: WebChromeClient.FileChooserParams?
            ): Boolean {
                android.util.Log.i("pi-web-filechooser", "onShowFileChooser invoked accept=${params?.acceptTypes} capture=${params?.isCaptureEnabled}")
                // 上一次未收尾的回调先取消，避免泄漏/按钮卡死
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = (params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT)).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    // params 已带 accept（image/*）；为空时兜底允许任意文件
                    if (type == null) type = "image/*"
                }
                return try {
                    startActivityForResult(intent, fileChooserRequestCode)
                    true
                } catch (e: Exception) {
                    android.util.Log.e("pi-web-filechooser", "无可用文件选择器", e)
                    filePathCallback = null
                    false
                }
            }
        }

        root.addView(loadingText)
        root.addView(errorBox, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // Phase 2：SAF/权限弹窗需要 Activity 承载（HostCapabilities 经此发起 startActivityForResult）
        HostCapabilities.attach(this)

        // 崩溃哨兵（PiApplication）留下的「上次异常退出」记录 ⇒ 启动横幅（错误恢复路径入口）。
        // ⚠️ 存字段而非只改一次 text：observeState 的 Loading 分支每 250ms 覆写 loadingText，
        //    不入字段横幅会被第一个 tick 抹掉。
        crashBanner = PiApplication.lastCrash(this)?.let { crash ->
            val iso = Regex("iso=([^\\n]+)").find(crash)?.groupValues?.get(1) ?: "未知时间"
            val exc = Regex("exception=([^\\n]+)").find(crash)?.groupValues?.get(1) ?: "未知异常"
            "⚠ 上次异常退出（$iso，$exc）——若反复出现请查 app.log 与 docs/evidence\n"
        }
        loadingText.text = (crashBanner ?: "") + loadingText.text

        val selftest = intent?.getBooleanExtra("selftest", false) == true
        PiDesktopRuntime.start(this, selftest)
        observeState()

        maybeDebugHooks(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        // singleTask：运行中再 am start（带 selftest/crash-test extra）走这里，不走 onCreate
        setIntent(intent)
        maybeDebugHooks(intent)
    }

    /** 受控验收钩子（模拟器调试用；发布包无入口）。 */
    private fun maybeDebugHooks(intent: Intent?) {
        if (intent == null) return
        // `--ez crash-test` 会把 extra 名存成连字符形态 ⇒ 两种键名都认
        val crashTest = intent.getBooleanExtra("crashTest", false) || intent.getBooleanExtra("crash-test", false)
        if (crashTest) {
            // 800ms 后主线程抛未捕获异常 ⇒ 端到端验证 PiApplication 哨兵落盘 + 下次启动横幅
            ui.postDelayed({
                throw IllegalStateException("crash-test：受控验收（PiApplication 哨兵验证）")
            }, 800)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == fileChooserRequestCode) {
            val cb = filePathCallback ?: return
            // 必须置空：用户取消/重选时旧回调要收尾，否则上传按钮后续点击无反应
            filePathCallback = null
            val uris: Array<Uri>? = when {
                resultCode != RESULT_OK -> null
                data?.clipData != null -> {
                    val clip = data.clipData!!
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            cb.onReceiveValue(uris)
            android.util.Log.i("pi-web-filechooser", "onActivityResult resultCode=$resultCode uris=${uris?.joinToString { it.toString() }}")
            return
        }
        HostCapabilities.handleActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        HostCapabilities.handlePermissionResult(requestCode, permissions, grantResults)
    }

    private fun observeState() {
        ui.post(object : Runnable {
            override fun run() {
                if (isDestroyed || isFinishing) return; // 评审修复：销毁后停止 UI 轮询（防泄漏/视图越权更新）
                when (val s = PiDesktopRuntime.state.value) {
                    is ShellState.Loading -> {
                        loadingText.visibility = View.VISIBLE
                        loadingText.text = (crashBanner ?: "") + "Pi Desktop\n${s.stage}"
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

    /**
     * 注入旧 WebView 兼容垫片（assets/webview/polyfill-webview.js）。在 onPageStarted 调用，
     * 早于页面任何脚本；只注入一次/每次导航都幂等（垫片自身 if-exists 保护）。
     * 读 asset 失败不阻断加载（新 WebView 上即便漏注也不缺这些 API）。
     */
    private fun injectWebViewPolyfill(view: WebView?) {
        view ?: return
        val js = runCatching {
            assets.open("webview/polyfill-webview.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        }.getOrNull() ?: return
        // evaluateJavascript 在 onPageStarted 点对当前新 document 的全局上下文立即生效，
        // 早于页面脚本；用 JSONObject 安全转义源码，IIFE 返回 1 避开返回值解析。
        // 直接把垫片源码（自身是 IIFE）作为脚本体注入；evaluateJavascript 接受多行 JS。
        // 不要用 "eval(字符串字面量)" 包裹：源码含正则/模板与换行，经 JSON 转义后曾出现
        // 「missing ) after argument list」导致整段失效（2026-10-29 真机定位）。
        view.evaluateJavascript(js, null)
    }

    override fun onDestroy() {
        // 未决 SAF/权限请求落「cancelled」→ Node 侧轮询可收敛；随后优雅关停（仅 finish 路径）
        HostCapabilities.detach(this)
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
