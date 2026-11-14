package top.fellow99.pi.PiDesktopAndroid.runtime

import android.content.Context
import android.system.Os
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.PushbackInputStream
import java.util.zip.GZIPInputStream

/**
 *
 * 目录契约（HOME 由 node-bridge 库注入为 `<filesDir>/node-bridge`，见 payload/env.js）：
 *   · 工具树：  `<HOME>/cli-tools/<tool>-bridge-tools/`（从 assets/cli-tools/<tool>.tar 解出）
 *   · 短名农场：`<HOME>/bin/`（PATH 前置；纯 PIE 与 node 壳用 symlink，pip 用绝对路径包装脚本）
 *   · git 农场： `<HOME>/gitexec/`（按 git-bridge-tools/gitexec-manifest.json#farm 建 8 链接，GIT_EXEC_PATH 指向它）
 *
 * 关键事实（P0 探针 22/22 PASS 锁定，不在此重新发明）：
 *   · 解包用**纯 Java tar 解析**（gzip 魔数探测 + GZIPInputStream；同 PayloadArchive）。
 *     不再用 toybox tar：Android 8（MIX 真机 2026-11-09）toybox 无 gunzip、且解包后
 *     Process.waitFor() 不返回（boot 线程卡死），见 runTarExtract 注释；工具树 tar 不含 symlink，
 *     symlink 全部由本类在运行期用 `android.system.Os.symlink` 显式建立。
 *   · tar 目录条目 mode 必须 0755（cli-lib.buildTarGz 已修），否则 toybox 解出不可进入目录。
 *   · pip 壳 `libpip.so` 写死 `dirname "$0"` 不读 env，经 symlink 调用会找不到主件 ⇒ pip/pip3
 *     必须生成绝对路径包装脚本并 chmod 755（D4 硬约束，P0 实测 code=127）。
 *   · 重装后 nativeLibraryDir 路径变化会使旧链接悬空；`File.exists()` 对 dangling link 返回 false，
 *     故每个短名/农场名无条件 `delete()` 后重建（否则 Os.symlink EEXIST errno=17）。
 *
 * 幂等：以每个 tar 的 SHA-256 为 marker（与 PayloadArchive 同纪律）。marker 命中则跳过解包，
 * 但短名/gitexec 农场每次启动都无条件重建（成本极低，且能自愈 nativeLibraryDir 漂移）。
 */
object CliTools {

    /** 受管工具 tar（assets/cli-tools 下的逻辑名，不含扩展名）。uv/pnpm 无工具树，不在此列。 */
    private val TOOL_TARS = listOf("node", "git", "python")

    /**
     * 纯 PIE ELF（经 PATH 短名调用时 bionic linker 对裸 argv[0] 报 "Unable to get realpath"，
     * 2026-11-05 真域实测）。这些短名在 .profile 里生成**直接执行绝对 ELF** 的 shell 函数
     * （命令词即绝对路径 ⇒ argv[0] 绝对，规避 bionic realpath 自检；P0 已证 22/22 PASS）。
     * 刻意**不用 `exec`**：函数体 exec 会替换整个 login shell 进程 —— 终端面板把击键直接喂给
     * 常驻 mksh（无子 shell 包裹），执行完 `node`/`git` 后 PTY 子进程即消失、终端被判定退出
     * （2026-11-09 MIX 真机证实 mksh 语义与终端故障）。不带 exec 时 mksh fork 子进程执行，
     * argv[0] 仍为绝对路径，shell 存活。
     */
    private val BIN_ELF = linkedMapOf(
        "node" to "libnode_cli.so",
        "python" to "libpython_cli.so",
        "git" to "libgit_cli.so",
        "uv" to "libuv_cli.so",
        "pnpm" to "libpnpm_cli.so",
    )

    /**
     * `#!/system/bin/sh` 壳（位于可 exec 的 nativeLibraryDir）。libuv 直接 spawn 脚本不走
     * shebang，但经 `sh <绝对壳路径>` 显式调解释器可靠；.profile 函数以此形态包装。
     */
    private val BIN_SHELL_SHIMS = linkedMapOf(
        "npm" to "libnpm.so",
        "npx" to "libnpx.so",
        "corepack" to "libcorepack.so",
    )

    /** 兼容保留：短名 symlink 农场（绝对路径后备；P0 ProcessBuilder 走绝对路径，不触发 bionic argv0 问题）。 */
    private val BIN_SYMLINKS: LinkedHashMap<String, String> = LinkedHashMap<String, String>().apply {
        putAll(BIN_ELF)
        putAll(BIN_SHELL_SHIMS)
    }

    /** 需要绝对路径包装脚本（而非 symlink）的短名：pip 壳硬编码 dirname "$0"。 */
    private val PIP_WRAPPERS = listOf("pip" to "pip", "pip3" to "pip3")

    data class Paths(
        val home: File,
        val binDir: File,
        val toolsRoot: File,
        val gitExecDir: File,
        val tmpDir: File,
        val nativeLibDir: String,
    ) {
        fun nodeTools() = File(toolsRoot, "node-bridge-tools")
        fun pythonTools() = File(toolsRoot, "python-bridge-tools")
        fun gitTools() = File(toolsRoot, "git-bridge-tools")
    }

    class CliException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    /**
     * 全量物化：解包工具树（marker 幂等）→ 重建 bin/gitexec 农场 → 返回路径契约。
     * 在 `rt.start` 之前调用，使 D5 env 一次到位、无首启竞态。
     */
    fun materialize(context: Context): Paths {
        val home = File(context.filesDir, "node-bridge")
        val paths = Paths(
            home = home,
            binDir = File(home, "bin"),
            toolsRoot = File(home, "cli-tools"),
            gitExecDir = File(home, "gitexec"),
            tmpDir = File(context.filesDir, "tmp"),
            nativeLibDir = context.applicationInfo.nativeLibraryDir,
        )
        paths.binDir.mkdirs()
        paths.toolsRoot.mkdirs()
        paths.tmpDir.mkdirs()

        writeProgress(paths, "start")
        for (tool in TOOL_TARS) {
            writeProgress(paths, "extract-$tool")
            extractToolTar(context, tool, paths.toolsRoot)
        }
        writeProgress(paths, "farms")
        buildSymlinkFarms(paths)
        writeProgress(paths, "python-prefix")
        buildPythonPrefix(paths) // 非阻断：失败仅影响 uv venv/python -m venv 自愈能力，不影响其余 CLI
        writeProgress(paths, "done")
        return paths
    }

    /** 诊断面包屑（真机无屏幕可读时定位物化阶段；永不抛）。 */
    private fun writeProgress(paths: Paths, stage: String) {
        try {
            File(paths.toolsRoot, ".materialize-progress").writeText(
                "${System.currentTimeMillis()} $stage\n",
            )
        } catch (_: Exception) {
            /* 诊断资产，成功路径不留痕也 ok */
        }
    }

    /** 组装 D5 进程级环境变量（三通道 TERM/PTY/EXEC 均继承 Node 的 process.env，无需逐通道改）。 */
    fun environment(base: Map<String, String>, paths: Paths): Map<String, String> {
        val env = LinkedHashMap(base)
        val home = paths.home.absolutePath
        val bin = paths.binDir.absolutePath
        val nativeDir = paths.nativeLibDir

        env["HOME"] = home
        env["TMPDIR"] = paths.tmpDir.absolutePath
        // PATH：$HOME/bin 前置（短名命中），再接 nativeLibraryDir（绝对 .so 可执行），保留系统路径。
        env["PATH"] = listOf(bin, nativeDir, "/system/bin", "/system/xbin")
            .joinToString(File.pathSeparator)
        env["LD_LIBRARY_PATH"] = nativeDir

        // Node
        env["NODE_NATIVE_DIR"] = nativeDir
        env["NODE_TOOLS_DIR"] = paths.nodeTools().absolutePath
        env["NODE_HOME"] = paths.nodeTools().absolutePath
        env["NODE_EXTRA_CA_CERTS"] = File(paths.gitTools(), "cacert.pem").absolutePath

        // Python：PYTHONHOME 指向标准布局根（其下 lib/python3.14 + site-packages）；刻意不设 PYTHONPATH（D5）。
        env["PYTHONHOME"] = paths.pythonTools().absolutePath
        // C1（node-bridge 20261105 设计）：自洽 python prefix + UV_PYTHON，使 `uv venv`/`python -m venv`
        // 的隔离解释器自检（-I 忽略 PYTHONHOME）能找到 stdlib，解除 G3 边界。
        env["UV_PYTHON"] = File(paths.toolsRoot, "pyruntime/bin/python").absolutePath
        env["SSL_CERT_FILE"] = File(paths.pythonTools(), "cacert.pem").absolutePath

        // Git：exec-path 农场 + TLS + 模板 + 全局配置落点（均可写私有目录）。
        env["GIT_EXEC_PATH"] = paths.gitExecDir.absolutePath
        env["GIT_SSL_CAINFO"] = File(paths.gitTools(), "cacert.pem").absolutePath
        env["GIT_TEMPLATE_DIR"] = File(paths.gitTools(), "templates").absolutePath
        env["GIT_CONFIG_GLOBAL"] = File(paths.home, ".gitconfig").absolutePath

        // uv（rustls 自带根证书，不依赖 SSL_CERT_FILE）与 pnpm 的可写缓存/存储，全部关进私有目录。
        env["UV_CACHE_DIR"] = File(paths.home, ".cache/uv").absolutePath
        env["UV_PYTHON_INSTALL_DIR"] = File(paths.home, ".local/share/uv/python").absolutePath
        env["UV_TOOL_DIR"] = File(paths.home, ".local/share/uv/tools").absolutePath
        env["XDG_CACHE_HOME"] = File(paths.home, ".cache").absolutePath
        env["PNPM_HOME"] = File(paths.home, ".local/share/pnpm").absolutePath
        return env
    }

    // ── D3 工具树物化（SHA-256 marker 幂等）──────────────────────────────────────

    private fun extractToolTar(context: Context, tool: String, toolsRoot: File) {
        val assetName = "cli-tools/$tool.tar"
        // assets 是流式 blob，先落 cache 临时文件供 toybox tar 读取（adb/AssetManager 都不能直接喂路径给子进程）。
        val staging = File(context.cacheDir, "cli-incoming").apply { mkdirs() }
        val tmpTar = File(staging, "$tool.tar.tmp")
        context.assets.open(assetName).use { input ->
            FileOutputStream(tmpTar).use { out -> input.copyTo(out, 256 * 1024) }
        }
        val sha = sha256File(tmpTar)
        val targetRoot = File(toolsRoot, "$tool-bridge-tools")
        val marker = File(toolsRoot, ".ready-$tool-${sha.substring(0, 12)}")
        if (marker.isFile && targetRoot.isDirectory) {
            tmpTar.delete()
            return // 内容未变：二次启动零解包
        }
        // 内容变化/首启：清旧树与该工具的历史 marker，再原子解包。
        targetRoot.deleteRecursively()
        toolsRoot.listFiles { f -> f.isFile && f.name.startsWith(".ready-$tool-") }?.forEach { it.delete() }
        targetRoot.mkdirs()
        runTarExtract(tmpTar, toolsRoot)
        if (!targetRoot.isDirectory) {
            throw CliException("CLI 工具树解包后缺失根目录：$targetRoot（tar=$assetName）")
        }
        marker.writeText("${System.currentTimeMillis()} sha256=$sha\n")
        tmpTar.delete()
    }

    private fun runTarExtract(tar: File, destDir: File) {
        // 纯 Java 解包（与 PayloadArchive 同策略，该解析器已在本机对 27k 条目的载荷归档验证）。
        // 为什么不再用 toybox tar（2026-11-09 MIX/Android 8 真机实测双重陷阱）：
        //   ① 工具树 tar 以 gzip 压缩，而 Android 8 toybox 靠 exec 外部 gunzip 解压——
        //      该设备 /system/bin、/system/xbin 无 gunzip，应用域也拒绝对其 exec
        //      （"tar: exec gunzip: Permission denied"）；
        //   ② 即使 Java 侧先解出纯 tar，toybox tar 解完进程退出后 **Process.waitFor() 在本平台
        //      不再返回**（boot 线程在解包完成后卡死，无任何异常产物：marker 未写、tmp 未删）。
        // 全 Java 解析不依赖 /system/bin/tar、gunzip 存在性与进程回收语义，任何设备行为一致。
        val startedAt = System.currentTimeMillis()
        var files = 0
        var dirs = 0
        var longNames = 0
        val rootCanonical = destDir.canonicalPath
        val buffered = PushbackInputStream(BufferedInputStream(FileInputStream(tar), 256 * 1024), 2)
        buffered.use { pushed ->
            val magic = ByteArray(2)
            pushed.read(magic)
            pushed.unread(magic)
            // 工具树 tar 契约（cli.lock.json）为 gzip；按魔数自适应，兼容未来改回裸 tar。
            val isGzip = magic[0] == 0x1f.toByte() && magic[1] == 0x8b.toByte()
            val stream: InputStream = if (isGzip) GZIPInputStream(pushed) else pushed
            stream.use { input ->
                var pendingLongName: String? = null
                while (true) {
                    val header = ByteArray(BLOCK)
                    if (!readFullyOrEof(input, header)) break
                    if (isZeroBlock(header)) break // 结束块（1024 全零）
                    var name = field(header, 0, 100)
                    val prefixField = field(header, 345, 155)
                    val size = parseOctal(field(header, 124, 12))
                    val typeflag = header[156].toInt().toChar()
                    if (typeflag == 'L') {
                        // GNU 长名：本体 = 下一条目的名字；跳过其内容后继续
                        val buf = ByteArray(size.toInt())
                        readFully(input, buf)
                        skipPadding(input, size)
                        pendingLongName = field(buf, 0, buf.size)
                        longNames += 1
                        continue
                    }
                    if (pendingLongName != null) {
                        name = pendingLongName
                        pendingLongName = null
                    }
                    if (name.isEmpty()) throw CliException("工具树 tar 条目名为空（归档损坏）：$tar")
                    when (typeflag) {
                        '0', '\u0000' -> {
                            val target = safeTarget(destDir, rootCanonical, name, tar)
                            File(target.parent).mkdirs()
                            FileOutputStream(target).use { out -> copyN(input, out, size) }
                            files += 1
                        }
                        '5' -> {
                            safeTarget(destDir, rootCanonical, name.trimEnd('/'), tar).mkdirs()
                            dirs += 1
                        }
                        else -> {
                            // symlink/link/pax 等本契约不应出现；出现即跳过内容并计数（不打断解包）
                            skipFully(input, size)
                        }
                    }
                    skipPadding(input, size)
                }
            }
        }
        if (files == 0 && dirs == 0) {
            throw CliException("工具树 tar 解包结果为空（0 文件 0 目录）：$tar")
        }
        // 解包完成面包屑（真机无屏幕可读时定位阶段；永不抛）
        try {
            File(destDir, ".materialize-progress").writeText(
                "${System.currentTimeMillis()} extracted-${tar.name.removeSuffix(".tmp")}-files=$files-dirs=$dirs-ms=${System.currentTimeMillis() - startedAt}\n",
            )
        } catch (_: Exception) {
            /* 诊断资产 */
        }
    }

    // ── 解包 tar 基元（同 PayloadArchive 口径）─────────────────────────────────

    private const val BLOCK = 512

    /** 读满 buffer；文件（单成员 gzip 流）提前结束返回 false（正常文件尾）。 */
    private fun readFullyOrEof(input: InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) return off == 0
            off += n
        }
        return true
    }

    private fun readFully(input: InputStream, buf: ByteArray) {
        if (!readFullyOrEof(input, buf)) throw CliException("工具树 tar 提前结束（读 header/长名）")
    }

    private fun copyN(input: InputStream, out: FileOutputStream, size: Long) {
        val buf = ByteArray(256 * 1024)
        var remaining = size
        while (remaining > 0) {
            val want = if (remaining > buf.size) buf.size else remaining.toInt()
            val n = input.read(buf, 0, want)
            if (n < 0) throw CliException("工具树 tar 数据段提前结束（剩 $remaining）")
            out.write(buf, 0, n)
            remaining -= n
        }
    }

    private fun skipFully(input: InputStream, size: Long) {
        var remaining = size
        val buf = ByteArray(64 * 1024)
        while (remaining > 0) {
            val want = if (remaining > buf.size) buf.size else remaining.toInt()
            val n = input.read(buf, 0, want)
            if (n < 0) throw CliException("工具树 tar 数据段提前结束（跳过，剩 $remaining）")
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

    /** 路径穿越校验（与 PayloadArchive 同纪律）：拒绝绝对路径，结果必须落在 destDir 内。 */
    private fun safeTarget(root: File, rootCanonical: String, name: String, tar: File): File {
        if (name.startsWith("/") || name.contains("\\")) throw CliException("拒绝工具树 tar 条目名：$name（$tar）")
        val target = File(root, name)
        val canonical = target.canonicalPath
        if (canonical != rootCanonical && !canonical.startsWith(rootCanonical + File.separator)) {
            throw CliException("工具树 tar 路径穿越被拒绝：$name → $canonical")
        }
        return target
    }

    // ── C1 python 自洽 prefix（node-bridge 20261105 设计 §4.2；非阻断）──────────
    // 目标：让 `uv venv`/`python -m venv` 的隔离解释器（`-I`，忽略 PYTHONHOME）能自检到 stdlib。
    // 结构：<tools>/pyruntime/pyvenv.cfg(home=自身) + bin/python -> libpython_cli.so
    //       + lib/python3.14 -> stdlib（软链失败降级整树复制，幂等）。
    private fun buildPythonPrefix(paths: Paths) {
        try {
            val prefix = File(paths.toolsRoot, "pyruntime")
            val binDir = File(prefix, "bin")
            val libDir = File(prefix, "lib")
            prefix.mkdirs(); binDir.mkdirs(); libDir.mkdirs()
            File(prefix, "pyvenv.cfg").writeText(
                "home = ${prefix.absolutePath}\n" +
                    "include-system-site-packages = false\n" +
                    "version = 3.14.10\n"
            )
            forceSymlink(
                File(paths.nativeLibDir, "libpython_cli.so").absolutePath,
                File(binDir, "python")
            )
            val stdlibSrc = File(paths.pythonTools(), "lib/python3.14")
            if (stdlibSrc.isDirectory) {
                val link = File(libDir, "python3.14")
                try {
                    forceSymlink(stdlibSrc.absolutePath, link)
                } catch (e: Exception) {
                    // SELinux 收紧时软链失败 → 整树复制兜底（幂等，仅首启一次性成本）。
                    if (!link.isDirectory) stdlibSrc.copyRecursively(link, overwrite = true)
                }
            }
        } catch (_: Exception) {
            // C1 为增强项，失败不阻断启动；能力边界由 boot-facts 如实暴露（宪法 A6）。
        }
    }

    // ── D4 短名 + gitexec 农场（每次启动无条件重建，自愈 nativeLibraryDir 漂移）──────────

    private fun buildSymlinkFarms(paths: Paths) {
        val nativeDir = paths.nativeLibDir

        // gitexec 农场：严格按 manifest#farm（8 名称 → 物理 libgit_*.so）。
        paths.gitExecDir.deleteRecursively()
        paths.gitExecDir.mkdirs()
        val farmManifest = File(paths.gitTools(), "gitexec-manifest.json")
        if (!farmManifest.isFile) {
            throw CliException("缺 gitexec-manifest.json：$farmManifest（git 工具树不完整？）")
        }
        val farm = JSONObject(farmManifest.readText()).getJSONObject("farm")
        val farmNames = farm.keys()
        while (farmNames.hasNext()) {
            val linkName = farmNames.next()
            val targetName = farm.getString(linkName)
            forceSymlink(File(nativeDir, targetName).absolutePath, File(paths.gitExecDir, linkName))
        }

        // $HOME/bin 短名：symlink 派。
        for ((shortName, libName) in BIN_SYMLINKS) {
            forceSymlink(File(nativeDir, libName).absolutePath, File(paths.binDir, shortName))
        }
        // pip/pip3：绝对路径包装脚本（不能 symlink 到 libpip.so，dirname "$0" 会落空）。
        for ((wrapperName, _) in PIP_WRAPPERS) {
            writePipWrapper(File(paths.binDir, wrapperName), nativeDir)
        }

        // $HOME/.profile：mksh login shell（sh -l，TERM/PTY/EXEC 三通道统一）自动 source。
        // 定义 10 个 CLI shell 函数，函数体**直接执行绝对路径（不用 exec）**，使 argv[0] 为绝对
        // 路径——规避 bionic 对裸短名 PIE 的 realpath 自检失败（2026-11-05 真域实测根因）；
        // 不用 exec 是为保住终端面板的常驻 login shell（2026-11-09 MIX 终端故障根因）。
        // 每次启动无条件重建。
        writeLoginProfile(File(paths.home, ".profile"), paths, nativeDir)
    }

    private fun writeLoginProfile(profile: File, paths: Paths, nativeDir: String) {
        val sb = StringBuilder()
        sb.append("# Pi Desktop CLI 函数表（由 CliTools 每次启动重建，勿手改）\n")
        sb.append("# 根因：untrusted_app 域内 bionic 拒绝裸短名 argv[0] 的 PIE ELF（realpath 自检），\n")
        sb.append("# 故 login shell 用函数把短名改写为执行绝对 ELF/壳（argv[0] 绝对，P0 已证可行）。\n")
        sb.append("# 函数体刻意不用 exec：exec 会替换整个 login shell（终端面板敲函数名即 shell 退出）。\n")
        sb.append("export PATH=").append(shellQuote(paths.binDir.absolutePath))
        sb.append(":").append(shellQuote(nativeDir))
        sb.append(":\$PATH\n\n")
        // 纯 PIE ELF：函数体**直接执行绝对 ELF**（命令词即绝对路径 ⇒ argv[0] 绝对，绕过 bionic
        // realpath 自检）。**不用 exec**：函数体 exec 会替换整个 login shell 进程，终端面板里
        // 敲 `node`/`git`（函数名，无子 shell 包裹）执行完即 shell 被替换、PTY 判定退出 ——
        // 2026-11-09 MIX 真机终端故障根因（mksh 语义已证实）。不带 exec 时 mksh fork 子进程，
        // argv[0] 仍为绝对路径（P0 绝对路径路径 22/22 PASS 的前提不变），shell 存活。
        for ((shortName, libName) in BIN_ELF) {
            val elf = File(nativeDir, libName).absolutePath
            sb.append(shortName).append("() { ").append(shellQuote(elf)).append(" \"\$@\"; }\n")
        }
        // shell 壳（#!sh 脚本）：经 /system/bin/sh 显式调解释器（libuv 直接 spawn 脚本不走 shebang）。同去 exec。
        for ((shortName, libName) in BIN_SHELL_SHIMS) {
            val shim = File(nativeDir, libName).absolutePath
            sb.append(shortName).append("() { /system/bin/sh ").append(shellQuote(shim)).append(" \"\$@\"; }\n")
        }
        // pip/pip3：数据目录脚本在 untrusted_app 不可直接 execve，改用 sh 显式调起包装脚本。同去 exec。
        for ((wrapperName, _) in PIP_WRAPPERS) {
            val wrap = File(paths.binDir, wrapperName).absolutePath
            sb.append(wrapperName).append("() { /system/bin/sh ").append(shellQuote(wrap)).append(" \"\$@\"; }\n")
        }
        profile.delete()
        FileOutputStream(profile).use { it.write(sb.toString().toByteArray(Charsets.UTF_8)) }
        profile.setReadable(true, false)
        profile.setWritable(true, true)
        // 只读取/ source，不需可执行位；显式去掉执行位避免被当命令直接 execve（数据目录本就禁 exec）。
    }

    /** POSIX 单引号转义（路径不含单引号场景的通用安全形态）。 */
    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    private fun forceSymlink(target: String, link: File) {
        // File.delete 删链接本身而不跟随目标；dangling link 的 exists()=false，故无条件删。
        link.delete()
        link.parentFile?.mkdirs()
        Os.symlink(target, link.absolutePath)
    }

    private fun writePipWrapper(script: File, nativeDir: String) {
        script.delete()
        val pythonElf = File(nativeDir, "libpython_cli.so").absolutePath
        val body = "#!/system/bin/sh\nexec \"$pythonElf\" -m pip \"\$@\"\n"
        FileOutputStream(script).use { it.write(body.toByteArray(Charsets.UTF_8)) }
        script.setReadable(true, false)
        script.setExecutable(true, false)
        script.setWritable(true, true)
    }

    // ── 基元 ────────────────────────────────────────────────────────────────────

    private fun sha256File(file: File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
