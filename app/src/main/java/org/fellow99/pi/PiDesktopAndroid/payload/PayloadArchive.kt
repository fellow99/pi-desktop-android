package org.fellow99.pi.PiDesktopAndroid.payload

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/**
 * 载荷归档（tar.gz → payloadRoot）解包器。
 *
 * 为什么在 app 侧做（规划 §7.1）：Android `assets/` 不是文件系统路径，Node 的 `require`
 * 读不到；解包执行者是 **Kotlin 侧**。库 `node-bridge:0.2.0` 只内建「散装 assets 目录」
 * 的物化（`Env.materializeAssetDir`），没有归档解包选项（规划预告的 `archiveAsset` 在
 * 该版本尚未发布）⇒ 本类按同一契约补齐：SHA-256 幂等 + `.ready-<sha12>` marker +
 * 路径穿越校验，**接口形状与规划一致**，库升级后可平滑替换。
 *
 * 归档格式 = `scripts/assemble-payload.mjs` 的确定性 ustar 写入器产物：
 *   · 512B 头（name/prefix/name+prefix≤255），mtime=0，条目排序；
 *   · 超长名走 GNU `L`（@LongLink）条目；
 *   · 结尾 1024 全零块；gzip level 9。
 */
object PayloadArchive {

    data class ExtractReport(
        val skipped: Boolean,
        val files: Int,
        val dirs: Int,
        val longNames: Int,
        val skippedEntries: Int,
        val bytes: Long,
        val elapsedMs: Long,
    ) {
        override fun toString(): String =
            "Extract{skipped=$skipped files=$files dirs=$dirs longNames=$longNames " +
                "skippedEntries=$skippedEntries bytes=$bytes elapsedMs=$elapsedMs}"
    }

    class ArchiveException(message: String) : IOException(message)

    private const val BLOCK = 512

    /** marker：`.ready-<sha256 前 12 位>`（规划 §7.1 幂等键） */
    fun markerFile(payloadRoot: File, sha256: String): File =
        File(payloadRoot, ".ready-" + sha256.substring(0, 12))

    fun sha256File(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * 幂等解包 `archive`（tar.gz，条目根 `pi-web/`）到 `payloadRoot`。
     * marker 命中且目标根目录存在 ⇒ 跳过（二次启动零拷贝）。
     */
    fun ensureExtracted(archive: File, payloadRoot: File): ExtractReport {
        if (!archive.isFile) throw ArchiveException("归档不存在：$archive")
        val sha = sha256File(archive)
        val marker = markerFile(payloadRoot, sha)
        if (marker.isFile && payloadRoot.isDirectory) {
            return ExtractReport(
                skipped = true, files = 0, dirs = 0, longNames = 0,
                skippedEntries = 0, bytes = archive.length(), elapsedMs = 0,
            )
        }
        payloadRoot.mkdirs()
        val startedAt = System.currentTimeMillis()
        var files = 0
        var dirs = 0
        var longNames = 0
        var skippedEntries = 0
        var bytesWritten = 0L
        val rootCanonical = payloadRoot.canonicalPath

        GZIPInputStream(BufferedInputStream(FileInputStream(archive), 256 * 1024)).use { gunzip ->
            var pendingLongName: String? = null
            while (true) {
                val header = ByteArray(BLOCK)
                readFully(gunzip, header)
                if (isZeroBlock(header)) break // 结束块（写端固定 1024 全零；首块全零即止）
                val nameField = field(header, 0, 100)
                val prefixField = field(header, 345, 155)
                var name = if (prefixField.isEmpty()) nameField else "$prefixField/$nameField"
                val size = parseOctal(field(header, 124, 12))
                val typeflag = header[156].toInt().toChar()

                if (typeflag == 'L') {
                    // GNU 长名：本体 = 下一条目的名字
                    val buf = ByteArray(size.toInt())
                    readFully(gunzip, buf)
                    skipPadding(gunzip, size)
                    pendingLongName = field(buf, 0, buf.size)
                    longNames += 1
                    continue
                }
                if (pendingLongName != null) {
                    name = pendingLongName
                    pendingLongName = null
                }
                if (name.isEmpty()) throw ArchiveException("条目名为空（会破坏解包判定），归档损坏")

                when (typeflag) {
                    '0', '\u0000' -> {
                        val target = safeTarget(payloadRoot, rootCanonical, name)
                        File(target.parent).mkdirs()
                        FileOutputStream(target).use { out -> copyN(gunzip, out, size).also { bytesWritten += it } }
                        files += 1
                    }
                    '5' -> {
                        safeTarget(payloadRoot, rootCanonical, name.trimEnd('/')).mkdirs()
                        dirs += 1
                    }
                    else -> {
                        // symlink/link/pax 等本归档不应出现；出现即跳过内容并如实计数
                        skipFully(gunzip, size)
                        skippedEntries += 1
                    }
                }
                skipPadding(gunzip, size)
            }
        }

        val report = ExtractReport(
            skipped = false, files = files, dirs = dirs, longNames = longNames,
            skippedEntries = skippedEntries, bytes = bytesWritten,
            elapsedMs = System.currentTimeMillis() - startedAt,
        )
        marker.writeText("${System.currentTimeMillis()} $report\n")
        return report
    }

    // ── tar 基元 ─────────────────────────────────────────────────────────────

    private fun readFully(input: InputStream, buf: ByteArray) {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) throw ArchiveException("归档提前结束（off=$off/${buf.size}）")
            off += n
        }
    }

    private fun copyN(input: InputStream, out: FileOutputStream, size: Long): Long {
        val buf = ByteArray(256 * 1024)
        var remaining = size
        while (remaining > 0) {
            val want = if (remaining > buf.size) buf.size else remaining.toInt()
            val n = input.read(buf, 0, want)
            if (n < 0) throw ArchiveException("归档数据段提前结束（剩 $remaining）")
            out.write(buf, 0, n)
            remaining -= n
        }
        return size
    }

    private fun skipFully(input: InputStream, size: Long) {
        var remaining = size
        val buf = ByteArray(64 * 1024)
        while (remaining > 0) {
            val want = if (remaining > buf.size) buf.size else remaining.toInt()
            val n = input.read(buf, 0, want)
            if (n < 0) throw ArchiveException("归档数据段提前结束（跳过阶段，剩 $remaining）")
            remaining -= n
        }
    }

    private fun skipPadding(input: InputStream, size: Long) {
        val padding = ((BLOCK - (size % BLOCK)) % BLOCK).toInt()
        if (padding > 0) skipFully(input, padding.toLong())
    }

    private fun isZeroBlock(block: ByteArray): Boolean {
        for (b in block) if (b.toInt() != 0) return false
        return true
    }

    private fun field(header: ByteArray, offset: Int, length: Int): String {
        var end = offset
        val limit = offset + length
        while (end < limit && header[end].toInt() != 0) end += 1
        return String(header, offset, end - offset, Charsets.UTF_8).trim('\u0000', ' ')
    }

    private fun parseOctal(text: String): Long {
        val t = text.replace("\u0000", " ").trim()
        if (t.isEmpty()) return 0L
        return t.toLong(8)
    }

    /** 路径穿越校验（规划 §7.1「安全」行）：拒绝绝对路径与 `..`，结果必须落在 payloadRoot 内 */
    private fun safeTarget(root: File, rootCanonical: String, name: String): File {
        if (name.startsWith("/") || name.contains("\\")) throw ArchiveException("拒绝归档条目名：$name")
        val target = File(root, name)
        val canonical = target.canonicalPath
        if (canonical != rootCanonical && !canonical.startsWith(rootCanonical + File.separator)) {
            throw ArchiveException("路径穿越被拒绝：$name → $canonical")
        }
        return target
    }
}
