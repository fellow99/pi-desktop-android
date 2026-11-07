package org.fellow99.pi.PiDesktopAndroid.runtime

import android.content.Context
import android.system.Os
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 *
 * 目录契约（HOME 由 node-bridge 库注入为 `<filesDir>/node-bridge`，见 payload/env.js）：
 *   · 工具树：  `<HOME>/cli-tools/<tool>-bridge-tools/`（从 assets/cli-tools/<tool>.tar 解出）
 *   · 短名农场：`<HOME>/bin/`（PATH 前置；纯 PIE 与 node 壳用 symlink，pip 用绝对路径包装脚本）
 *   · git 农场： `<HOME>/gitexec/`（按 git-bridge-tools/gitexec-manifest.json#farm 建 8 链接，GIT_EXEC_PATH 指向它）
 *
 * 关键事实（P0 探针 22/22 PASS 锁定，不在此重新发明）：
 *   · 解包用 `/system/bin/tar -xf`（toybox，API26 真机/API37 模拟器均在）；工具树 tar 不含 symlink，
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
     * 2026-11-05 真域实测）。这些短名在 .profile 里生成 `exec 绝对ELF` 的 shell 函数，
     * 使 argv[0] 为绝对路径，规避 bionic realpath 自检（绝对路径 P0 已证 22/22 PASS）。
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

        for (tool in TOOL_TARS) {
            extractToolTar(context, tool, paths.toolsRoot)
        }
        buildSymlinkFarms(paths)
        buildPythonPrefix(paths) // 非阻断：失败仅影响 uv venv/python -m venv 自愈能力，不影响其余 CLI
        return paths
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
        val pb = ProcessBuilder("/system/bin/tar", "-xf", tar.absolutePath, "-C", destDir.absolutePath)
        pb.environment().clear()
        pb.environment()["PATH"] = "/system/bin"
        pb.redirectErrorStream(false)
        val p = pb.start()
        val err = ByteArrayOutputStream()
        val errThread = Thread {
            p.errorStream.copyTo(err, 4096)
        }.also { it.start() }
        val code = p.waitFor()
        errThread.join(5000)
        if (code != 0) {
            throw CliException("toybox tar 解包失败 rc=$code：${err.toString(Charsets.UTF_8).take(500)}")
        }
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
        // 定义 10 个 CLI shell 函数，函数体 exec 绝对路径，使 argv[0] 为绝对路径——规避 bionic
        // 对裸短名 PIE 的 realpath 自检失败（2026-11-05 真域实测根因）。每次启动无条件重建。
        writeLoginProfile(File(paths.home, ".profile"), paths, nativeDir)
    }

    private fun writeLoginProfile(profile: File, paths: Paths, nativeDir: String) {
        val sb = StringBuilder()
        sb.append("# Pi Desktop CLI 函数表（由 CliTools 每次启动重建，勿手改）\n")
        sb.append("# 根因：untrusted_app 域内 bionic 拒绝裸短名 argv[0] 的 PIE ELF（realpath 自检），\n")
        sb.append("# 故 login shell 用函数把短名改写为 exec 绝对 ELF/壳（argv[0] 绝对，P0 已证可行）。\n")
        sb.append("export PATH=").append(shellQuote(paths.binDir.absolutePath))
        sb.append(":").append(shellQuote(nativeDir))
        sb.append(":\$PATH\n\n")
        // 纯 PIE ELF：直接 exec 绝对 ELF。
        for ((shortName, libName) in BIN_ELF) {
            val elf = File(nativeDir, libName).absolutePath
            sb.append(shortName).append("() { exec ").append(shellQuote(elf)).append(" \"\$@\"; }\n")
        }
        // shell 壳（#!sh 脚本）：经 /system/bin/sh 显式调解释器（libuv 直接 spawn 脚本不走 shebang）。
        for ((shortName, libName) in BIN_SHELL_SHIMS) {
            val shim = File(nativeDir, libName).absolutePath
            sb.append(shortName).append("() { exec /system/bin/sh ").append(shellQuote(shim)).append(" \"\$@\"; }\n")
        }
        // pip/pip3：数据目录脚本在 untrusted_app 不可直接 execve，改用 sh 显式调起包装脚本。
        for ((wrapperName, _) in PIP_WRAPPERS) {
            val wrap = File(paths.binDir, wrapperName).absolutePath
            sb.append(wrapperName).append("() { exec /system/bin/sh ").append(shellQuote(wrap)).append(" \"\$@\"; }\n")
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
