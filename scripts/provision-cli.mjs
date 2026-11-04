#!/usr/bin/env node
/**
 * provision-cli.mjs —— 五个真实 CLI 的构建侧投放（112-cli-integration）。
 *
 * 输入（二选一）：
 *   --from <dir>      本地已解包的 Release 工作区（布局见下 SOURCE_LAYOUT），离线可用；
 *   --download        按 cli.lock.json#releases 的 URL 拉取五个 tarball，SHA-256 校验后解包到临时目录。
 *   --check           只读校验当前投放态（jniLibs + cli-tools），不写任何文件；失败 exit 2。
 *
 * 投放位（均 gitignored，二进制/工具树不入库）：
 *   ① app/src/main/jniLibs/arm64-v8a/：7 个 exec 型 CLI ELF + 5 个 shell 壳（共 12 个 .so）；
 *   ② app/src/main/assets/cli-tools/{node,git,python}.tar：gzip 内容的确定性 ustar（.tar 仅为后缀）。
 * 引擎三件（libnode.so/libpty_node.so/libc++_shared.so）由 runtime.lock 链路负责，本脚本不投放、不删除。
 *
 * 工具树权威来源：node/python 取各自 AAR 内 assets/<bridge>-tools（与顶层解包逐字节一致，
 * 且 AAR 是 python 唯一带 manifest 的来源）；git 无 AAR 工具树，取 Release 内 assets/git-bridge-tools。
 * uv/pnpm 无工具树，不生成空包。
 *
 * 幂等：每次投放先清空受管目标再重建；确定性 tar（mtime=0、排序、gzip level 9）⇒ 同输入同字节。
 * 用法：node scripts/provision-cli.mjs --from <dir> | --download | --check
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  sha256Buffer,
  isShellShim,
  elfGateProblems,
  readZip,
  buildTarGz,
  walkDirToEntries,
} from './cli-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(root, 'cli.lock.json')
const jniDir = path.join(root, 'app/src/main/jniLibs/arm64-v8a')
const toolsDir = path.join(root, 'app/src/main/assets/cli-tools')

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const checkOnly = process.argv.includes('--check')
const wantDownload = process.argv.includes('--download')
const fromArg = argOf('--from')

function fail(msg, code = 2) {
  console.error(`[provision-cli] ${msg}`)
  process.exit(code)
}
function log(msg) { console.log(`[provision-cli] ${msg}`) }

if (!existsSync(lockPath)) fail(`找不到锁文件：${lockPath}`)
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const gates = lock.gates
const whitelist = lock.systemNeededWhitelist

/* ── 源布局解析：把 --from 根目录映射到每个工具的具体文件/AAR/工具树目录 ──────────────────────── */
const GIT_VER = `git-cli-v${lock.releases.git.version}-android-arm64-v8a`
const PY_VER = `python-cli-v${lock.releases.python.version}-android-arm64-v8a`
const PNPM_VER = `pnpm-cli-v${lock.releases.pnpm.version}-android-arm64-v8a`

function resolveSources(base) {
  if (!existsSync(base)) fail(`--from 目录不存在：${base}`)
  const pick = (...cands) => {
    for (const c of cands) { if (existsSync(c)) return c }
    return null
  }
  const src = {
    node: {
      aar: pick(path.join(base, 'x-node/node-cli-release.aar')),
      // 顶层 .so（与 AAR jni/ 内容同源；--from 布局下直接可见）
      shimDir: pick(path.join(base, 'x-node')),
    },
    python: {
      aar: pick(path.join(base, `x-python/${PY_VER}/python-cli-release.aar`)),
      shimDir: pick(path.join(base, `x-python/${PY_VER}`)),
    },
    git: {
      dir: pick(path.join(base, `x-git/${GIT_VER}`)),
    },
    uv: {
      dir: pick(path.join(base, 'x-uv')),
    },
    pnpm: {
      dir: pick(path.join(base, `x-pnpm/${PNPM_VER}`)),
    },
  }
  const missing = []
  if (!src.node.aar) missing.push('node AAR')
  if (!src.node.shimDir) missing.push('node 壳目录')
  if (!src.python.aar) missing.push('python AAR')
  if (!src.python.shimDir) missing.push('python 壳目录')
  if (!src.git.dir) missing.push('git 目录')
  if (!src.uv.dir) missing.push('uv 目录')
  if (!src.pnpm.dir) missing.push('pnpm 目录')
  if (missing.length > 0) fail(`源目录缺组件：${missing.join('、')}（--from ${base}）`)
  return src
}

/* ── 单文件 ELF/壳 + sha/size 校验（投放前在源上先验，坏源不落地）────────────────────────────── */
function validateManagedFile(absPath, lockItem, kind) {
  if (!existsSync(absPath)) fail(`源缺文件：${absPath}`)
  const buf = readFileSync(absPath)
  if (buf.length !== lockItem.size) fail(`${lockItem.path} size 不符：${buf.length} ≠ lock ${lockItem.size}`)
  if (sha256Buffer(buf) !== lockItem.sha256) fail(`${lockItem.path} SHA-256 不符 lock`)
  if (kind === 'elf') {
    if (isShellShim(buf)) fail(`${lockItem.path} 应为 ELF，实测是 shell 壳`)
    const probs = elfGateProblems(buf, gates, whitelist)
    if (probs.length > 0) fail(`${lockItem.path} ELF 门禁失败：${probs.join('；')}`)
  } else {
    if (!isShellShim(buf)) fail(`${lockItem.path} 应为 shell 壳（#! 开头）`)
    const text = buf.toString('utf8')
    if (text.split('\n')[0].trim() !== '#!/system/bin/sh') fail(`${lockItem.path} shebang 非 #!/system/bin/sh`)
    for (const needle of lockItem.mustContain) {
      if (!text.includes(needle)) fail(`${lockItem.path} 缺必需内容：${needle}`)
    }
  }
}

/* ── 从 AAR（zip，内存）抽取工具树为 tar 条目：name 以 `<rootPrefix>/` 打头 ───────────────────── */
function aarToolEntries(aarPath, assetRoot, rootPrefix) {
  const zip = readZip(aarPath)
  const prefix = `assets/${assetRoot}/`
  const entries = []
  const dirs = new Set([rootPrefix])
  for (const [name, data] of zip) {
    if (!name.startsWith(prefix) || name === prefix) continue
    const rel = name.slice(prefix.length)
    if (rel.length === 0) continue
    if (name.endsWith('/')) {
      dirs.add(`${rootPrefix}/${rel.replace(/\/$/, '')}`)
      continue
    }
    // 补全中间目录
    const segs = rel.split('/')
    for (let i = 1; i < segs.length; i++) dirs.add(`${rootPrefix}/${segs.slice(0, i).join('/')}`)
    entries.push({ name: `${rootPrefix}/${rel}`, data })
  }
  const dirEntries = [...dirs].sort().map((d) => ({ name: `${d}/`, data: Buffer.alloc(0) }))
  return [...dirEntries, ...entries]
}

/* ── 投放 ─────────────────────────────────────────────────────────────────── */
function provision(src) {
  mkdirSync(jniDir, { recursive: true })
  mkdirSync(toolsDir, { recursive: true })

  // 1) 清旧受管文件（只清锁内 12 个 CLI 文件与 3 个 tar；引擎三件不动）
  const managedSo = new Set([...lock.elf.map((e) => e.path), ...lock.shells.map((s) => s.path)])
  for (const name of readdirSync(jniDir)) {
    if (managedSo.has(name)) rmSync(path.join(jniDir, name), { force: true })
  }
  for (const spec of Object.values(lock.toolArchives)) {
    rmSync(path.join(toolsDir, spec.archive), { force: true })
  }

  // 2) jniLibs：按锁逐项源校验后拷贝
  const copyOne = (absSrc, lockItem, kind) => {
    validateManagedFile(absSrc, lockItem, kind)
    copyFileSync(absSrc, path.join(jniDir, lockItem.path))
    log(`${kind === 'elf' ? 'ELF ' : '壳  '} ${lockItem.path}（${lockItem.size} B，sha ✓）`)
  }
  for (const item of lock.elf) {
    const abs = sourcePathForElf(src, item.path)
    copyOne(abs, item, 'elf')
  }
  for (const item of lock.shells) {
    const abs = sourcePathForShim(src, item.path)
    copyOne(abs, item, 'shim')
  }

  // 3) 工具树 tar
  // node：AAR assets/node-bridge-tools
  const nodeSpec = lock.toolArchives.node
  const nodeEntries = aarToolEntries(src.node.aar, nodeSpec.root, nodeSpec.root)
  writeTar(nodeSpec.archive, nodeEntries)

  // python：AAR assets/python-bridge-tools
  const pySpec = lock.toolArchives.python
  const pyEntries = aarToolEntries(src.python.aar, pySpec.root, pySpec.root)
  writeTar(pySpec.archive, pyEntries)

  // git：磁盘 assets/git-bridge-tools（无 AAR 工具树）
  const gitSpec = lock.toolArchives.git
  const gitToolDir = path.join(src.git.dir, 'assets', gitSpec.root)
  if (!existsSync(gitToolDir)) fail(`git 工具树目录不存在：${gitToolDir}`)
  const gitEntries = walkDirToEntries(gitToolDir, gitSpec.root)
  writeTar(gitSpec.archive, gitEntries)

  log('投放完成（jniLibs 12 个 CLI 文件 + cli-tools 3 个确定性 .tar）')
}

function sourcePathForElf(src, fileName) {
  // git 三 ELF 在 git dir；uv/pnpm 各自 dir；node/python 主 ELF 在各自 shimDir
  if (fileName.startsWith('libgit')) return path.join(src.git.dir, fileName)
  if (fileName === 'libuv_cli.so') return path.join(src.uv.dir, fileName)
  if (fileName === 'libpnpm_cli.so') return path.join(src.pnpm.dir, fileName)
  if (fileName === 'libnode_cli.so') return path.join(src.node.shimDir, fileName)
  if (fileName === 'libpython_cli.so') return path.join(src.python.shimDir, fileName)
  fail(`未配置 ELF 来源：${fileName}`)
}
function sourcePathForShim(src, fileName) {
  if (['libnpm.so', 'libnpx.so', 'libcorepack.so'].includes(fileName)) {
    return path.join(src.node.shimDir, fileName)
  }
  if (['libpip.so', 'libpip3.so'].includes(fileName)) {
    return path.join(src.python.shimDir, fileName)
  }
  fail(`未配置壳来源：${fileName}`)
}

function writeTar(archiveName, entries) {
  const tarGz = buildTarGz(entries)
  const out = path.join(toolsDir, archiveName)
  writeFileSync(out, tarGz)
  const fileCount = entries.filter((e) => !e.name.endsWith('/')).length
  log(`tar  ${archiveName}（${fileCount} 文件，${tarGz.length} B，gzip deterministic）`)
}

/* ── --check：复用 verify-cli 的同一判据（子进程调用，避免判据漂移）─────────────────────────── */
function runCheck() {
  const verify = path.join(root, 'scripts', 'verify-cli.mjs')
  const res = spawnSync(process.execPath, [verify], { cwd: root, stdio: 'inherit' })
  process.exit(res.status ?? 1)
}

/* ── --download：拉取五个 tarball，校验 sha，系统 tar 解包到临时目录后按 --from 处理 ─────────── */
function downloadAndProvision() {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'pda-cli-dl-'))
  for (const [tool, rel] of Object.entries(lock.releases)) {
    const tarPath = path.join(stage, rel.tarball)
    log(`下载 ${tool} ${rel.tag} …`)
    const buf = httpsGet(rel.url)
    if (buf.length !== rel.size) fail(`${tool} tarball size 不符：${buf.length} ≠ lock ${rel.size}`)
    if (sha256Buffer(buf) !== rel.sha256) fail(`${tool} tarball SHA-256 不符 lock`)
    writeFileSync(tarPath, buf)
    const ex = spawnSync(tarExe(), ['-xzf', tarPath, '-C', stage], { encoding: 'utf8' })
    if (ex.error || ex.status !== 0) fail(`${tool} 解包失败：${ex.error ? ex.error.message : ex.stderr}`)
  }
  log(`下载并解包完成：${stage}`)
  return stage
}

// 同步下载：用 child_process 调 curl（Windows 10+ 自带 curl.exe），自带重定向/重试，避免手写 https 状态机
function httpsGet(url) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const res = spawnSync(curl, ['-fsSL', '--retry', '3', '--connect-timeout', '30', '-o', '-', url], {
    encoding: null, maxBuffer: 512 * 1024 * 1024,
  })
  if (res.error || res.status !== 0) {
    fail(`下载失败（${url}）：${res.error ? res.error.message : Buffer.from(res.stderr || []).toString('utf8').slice(-200)}`)
  }
  return res.stdout
}

function tarExe() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
    : 'tar'
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */
if (checkOnly) {
  runCheck()
} else if (wantDownload) {
  const stage = downloadAndProvision()
  provision(resolveSources(stage))
  runCheck()
} else if (fromArg) {
  provision(resolveSources(path.resolve(fromArg)))
  runCheck()
} else {
  fail('必须指定 --from <dir>、--download 或 --check')
}
