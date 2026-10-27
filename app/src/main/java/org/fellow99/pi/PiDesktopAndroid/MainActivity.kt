package org.fellow99.pi.PiDesktopAndroid

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/**
 * 主入口（launchMode=singleTask，硬约束 ⑰）。
 *
 * Phase 0 期间是占位壳：探针在 [org.fellow99.pi.PiDesktopAndroid.probe.ProbeHostActivity] 里跑；
 * 探针清理后这里替换为完整启动编排（加载页 → 运行时 → WebView）。
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply { text = "Pi Desktop\n(脚手架阶段：探针见 ProbeHostActivity)" }
        setContentView(tv)
    }
}
