package org.fellow99.pi.PiDesktopAndroid.runtime

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File

/**
 * 形态事实落盘（能力清单 §F 第 1 级 #3；对标 ark `node-mode.json`）。
 *
 * 写 `<payloadRoot>/engine-facts.json`（payloadRoot = `<filesDir>/node-bridge/payload`），
 * 用途是**归因**：出问题时一眼看出「哪个引擎、什么 ICU 口径、JIT 决策、载荷版本」。
 *
 * 事实分三层，全部 as-built、不写预期：
 *   ① 平台与决策（Kotlin 侧，启动即知）：abi/sdk/机型、jitless 决策、载荷 SHA-256；
 *   ② 引擎引导事实（`pi-web.boot-facts.json`，由 pi-web-launch.js 在 require 任何 Next
 *      代码**之前**写）：node 版本、Intl 逐项探针、WASM、execPath —— 引擎换装的回归守门
 *      （能力清单 §F 第 1 级 #4 的端上取证半边）；
 *   ③ 合并规则：② 每次引导都刷新；① 保持；`bootFacts` 缺席时记 `pending`
 *      （首启解包后、launch 脚本跑起来之前的窗口）。
 *
 * 纪律：写文件失败绝不打断启动（runCatching 全包）——这是诊断资产，不是主链路。
 */
object EngineFacts {

    private const val FACTS_NAME = "engine-facts.json"
    private const val BOOT_FACTS_NAME = "pi-web.boot-facts.json"

    /** 载荷版本（SHA-256，assets 组装期写入并随 tar 解包？否——version 不在 tar 里，从 assets 侧材料读）。 */
    fun payloadSha256(context: Context): String? {
        // pi-web.version 与 tar 同放 assets/pi-web/；materializeArchive 只搬 tar，
        // 这里从 assets 直读（128KB 量级以下的文本，读一次成本可忽略）。
        return runCatching {
            context.assets.open("pi-web/pi-web.version").bufferedReader().use { it.readText().trim() }
        }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    /** 启动即写一版（无 bootFacts）；waitReadyPort 轮询里检测到 boot-facts 后再合并刷新。 */
    fun writeAll(context: Context, payloadRoot: File) {
        runCatching { writeMerged(context, payloadRoot) }
    }

    /**
     * 轮询钩子：boot-facts 存在且内容变化 ⇒ 重写 engine-facts.json。
     * 返回值供启动日志一句话取证；任何 IO 问题都不抛。
     */
    fun observeBootFacts(context: Context, payloadRoot: File): Boolean {
        return runCatching {
            val boot = File(payloadRoot, BOOT_FACTS_NAME)
            if (!boot.isFile) return false
            val target = File(payloadRoot, FACTS_NAME)
            val bootText = boot.readText()
            if (target.isFile) {
                val current = runCatching { JSONObject(target.readText()) }.getOrNull()
                if (current == null) {
                    writeMerged(context, payloadRoot)
                    return true
                }
                val existing = current.optJSONObject("bootFacts")
                if (existing != null && existing.toString() == runCatching { JSONObject(bootText) }.getOrNull().toString()) {
                    return false // 未变化
                }
            }
            writeMerged(context, payloadRoot)
            true
        }.getOrDefault(false)
    }

    private fun writeMerged(context: Context, payloadRoot: File) {
        val boot = runCatching {
            JSONObject(File(payloadRoot, BOOT_FACTS_NAME).takeIf { it.isFile }?.readText() ?: "{}")
        }.getOrDefault(JSONObject())

        val facts = JSONObject()
            .put("at", System.currentTimeMillis())
            .put(
                "platform",
                JSONObject()
                    .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                    .put("sdkInt", Build.VERSION.SDK_INT)
                    .put("model", Build.MODEL)
                    .put("device", Build.DEVICE),
            )
            .put(
                "decision",
                JSONObject()
                    .put("jitless", false)
                    .put(
                        "jitlessReason",
                        "24.22.1(small-icu) 默认 JIT；ohos 式编译期 jitless 不适用（能力清单 §A「JIT 形态」）",
                    ),
            )
            .put("payloadSha256", payloadSha256(context) ?: JSONObject.NULL)
            .put(
                "bootFacts",
                if (boot.length() == 0) "pending" else boot,
            )

        val tmp = File(payloadRoot, "$FACTS_NAME.tmp")
        tmp.writeText(facts.toString(2) + "\n")
        if (!tmp.renameTo(File(payloadRoot, FACTS_NAME))) {
            File(payloadRoot, FACTS_NAME).writeText(facts.toString(2) + "\n")
            tmp.delete()
        }
    }
}
