#!/usr/bin/env node
/**
 * verify-cli.mjs —— 五个真实 CLI 投放产物的锁值 + ELF/壳/工具树门禁（112-cli-integration）。
 *
 * 单一事实源 = 工程根 cli.lock.json。校验对象 = provision-cli.mjs 的两个投放位：
 *   ① app/src/main/jniLibs/arm64-v8a/ 下 7 个 exec 型 CLI ELF + 5 个 shell 壳；
 *   ② app/src/main/assets/cli-tools/{node,git,python}.tar（gzip 内容，确定性 ustar）。
 * 引擎三件（libnode.so/libpty_node.so/libc++_shared.so）不在本脚本职责内，仍归 verify-runtime/verify-pty。
 *
 * 校验项（任一不符 ⇒ 退出码 2，构建不得继续）：
 *   · ELF：magic/ELF64/LE/ET_DYN/AArch64/PT_INTERP=/system/bin/linker64/16KB PT_LOAD/DT_NEEDED 白名单 + sha/size；
 *   · shell 壳：非 ELF、首行 #!/system/bin/sh、mustContain 全命中 + sha/size；
 *   · 工具树 tar：可被自研解析器与系统 tar 双重读取、根前缀正确、manifest 语义（fileCount/totalSha256/farmSize）；
 *   · 数量：jniLibs 内 CLI 受管文件恰为 12（7 ELF + 5 壳），三个 tar 齐全，uv/pnpm 不得有空工具包。
 *
 * 幂等：纯只读。用法：node scripts/verify-cli.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  sha256Buffer,
  isShellShim,
  elfGateProblems,
  parseTar,
} from './cli-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(root, 'cli.lock.json')
const jniDir = path.join(root, 'app/src/main/jniLibs/arm64-v8a')
const toolsDir = path.join(root, 'app/src/main/assets/cli-tools')

const problems = []
const note = (msg) => console.log(`✓ ${msg}`)
const fail = () => {
  for (const m of problems) console.error(`✗ ${m}`)
  console.error('\n处置：重跑 node scripts/provision-cli.mjs --from <dir> 重新投放；若确为制品升级，先更新 cli.lock.json 再重试。')
  process.exit(2)
}

if (!existsSync(lockPath)) { problems.push(`缺少锁文件：${lockPath}`); fail() }
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const gates = lock.gates
const whitelist = lock.systemNeededWhitelist

/* ── ① jniLibs：7 个 exec ELF + 5 个 shell 壳 ─────────────────────────────── */
if (!existsSync(jniDir)) { problems.push(`jniLibs 投放目录不存在：${jniDir}（先跑 provision-cli.mjs）`); fail() }

for (const item of lock.elf) {
  const file = path.join(jniDir, item.path)
  if (!existsSync(file)) { problems.push(`缺 CLI ELF：${item.path}`); continue }
  const buf = readFileSync(file)
  if (buf.length !== item.size) problems.push(`${item.path} size 不符：实测 ${buf.length} ≠ lock ${item.size}`)
  const sha = sha256Buffer(buf)
  if (sha !== item.sha256) problems.push(`${item.path} SHA-256 不符：实测 ${sha} ≠ lock ${item.sha256}`)
  if (isShellShim(buf)) { problems.push(`${item.path} 应为 ELF，实测是 shell 壳`); continue }
  const elfProblems = elfGateProblems(buf, gates, whitelist)
  for (const p of elfProblems) problems.push(`${item.path}：${p}`)
  if (elfProblems.length === 0) note(`ELF 门禁通过：${item.path}（${item.tool}，${buf.length} B）`)
}

for (const item of lock.shells) {
  const file = path.join(jniDir, item.path)
  if (!existsSync(file)) { problems.push(`缺 shell 壳：${item.path}`); continue }
  const buf = readFileSync(file)
  if (buf.length !== item.size) problems.push(`${item.path} size 不符：实测 ${buf.length} ≠ lock ${item.size}`)
  const sha = sha256Buffer(buf)
  if (sha !== item.sha256) problems.push(`${item.path} SHA-256 不符：实测 ${sha} ≠ lock ${item.sha256}`)
  if (!isShellShim(buf)) { problems.push(`${item.path} 应为 shell 壳（#! 开头），实测非脚本`); continue }
  const text = buf.toString('utf8')
  const firstLine = text.split('\n')[0]
  if (firstLine.trim() !== '#!/system/bin/sh') problems.push(`${item.path} shebang 不符：${firstLine}`)
  for (const needle of item.mustContain) {
    if (!text.includes(needle)) problems.push(`${item.path} 缺少必需内容：${needle}`)
  }
  if (firstLine.trim() === '#!/system/bin/sh' && item.mustContain.every((n) => text.includes(n))) {
    note(`shell 壳门禁通过：${item.path}（${item.tool}，${buf.length} B）`)
  }
}

/* 受管 CLI 文件清点：jniLibs 内 CLI 部分恰为 12 个（引擎三件可能并存，单独白名单排除） */
const engineNames = new Set(['libnode.so', 'libpty_node.so', 'libc++_shared.so'])
const managedNames = new Set([...lock.elf.map((e) => e.path), ...lock.shells.map((s) => s.path)])
const onDisk = readdirSync(jniDir).filter((n) => n.endsWith('.so'))
const unknown = onDisk.filter((n) => !managedNames.has(n) && !engineNames.has(n))
if (unknown.length > 0) problems.push(`jniLibs 出现非受管 .so：${unknown.join(',')}`)
for (const name of managedNames) {
  if (!onDisk.includes(name)) problems.push(`jniLibs 缺受管文件：${name}`)
}
note(`jniLibs 清点：CLI 受管 ${managedNames.size} 个（7 ELF + 5 壳），引擎白名单 ${onDisk.filter((n) => engineNames.has(n)).length} 个，磁盘共 ${onDisk.length} 个 .so`)

/* ── ② 工具树 tar：node/git/python ────────────────────────────────────────── */
if (!existsSync(toolsDir)) { problems.push(`cli-tools 目录不存在：${toolsDir}（先跑 provision-cli.mjs）`); fail() }

const tarExe = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
  : 'tar'

function verifyToolArchive(toolKey, spec) {
  const tarPath = path.join(toolsDir, spec.archive)
  if (!existsSync(tarPath)) { problems.push(`缺工具树归档：${spec.archive}`); return }
  const raw = readFileSync(tarPath)
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b
  if (!isGzip) problems.push(`${spec.archive} 不是 gzip 流（魔数不符；.tar 仅为后缀，内容必须 gzip）`)
  // 确定性归档摘要（同输入必须同字节；漂移即说明打包契约被破坏）
  if (typeof spec.archiveSize === 'number' && raw.length !== spec.archiveSize) {
    problems.push(`${spec.archive} size 不符：实测 ${raw.length} ≠ lock ${spec.archiveSize}`)
  }
  if (spec.archiveSha256 && sha256Buffer(raw) !== spec.archiveSha256) {
    problems.push(`${spec.archive} SHA-256 不符 lock（确定性归档漂移）`)
  }

  // 自研解析器（含路径穿越保护）
  let entries
  try {
    entries = parseTar(raw)
  } catch (e) {
    problems.push(`${spec.archive} 自研 tar 解析失败：${e.message}`)
    return
  }
  const fileEntries = entries.filter((e) => e.typeflag === '0')
  const dirEntries = entries.filter((e) => e.typeflag === '5')
  const rootPrefix = `${spec.root}/`
  const badRoot = entries.filter((e) => !e.name.startsWith(rootPrefix))
  if (badRoot.length > 0) problems.push(`${spec.archive} 有条目不落在根前缀 ${rootPrefix} 下：${badRoot.slice(0, 3).map((e) => e.name).join(',')}`)

  // 系统 tar 权威可读性仲裁（独立第三方实现）
  const res = spawnSync(tarExe, ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error || res.status !== 0) {
    problems.push(`${spec.archive} 系统 tar 无法完整读取：${res.error ? res.error.message : String(res.stderr || '').slice(-200)}`)
  } else {
    const sysLines = res.stdout.split('\n').filter((l) => l.length > 0)
    if (sysLines.length !== entries.length) {
      problems.push(`${spec.archive} 条目数不一致：自研 ${entries.length} ≠ 系统 tar ${sysLines.length}`)
    }
  }

  // manifest 语义校验
  const manifestName = `${rootPrefix}${spec.manifest}`
  const manifestEntry = fileEntries.find((e) => e.name === manifestName)
  if (!manifestEntry) { problems.push(`${spec.archive} 缺 manifest：${manifestName}`); return }
  const manifestSha = sha256Buffer(manifestEntry.data)
  let manifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'))
  } catch (e) {
    problems.push(`${spec.archive} manifest 非法 JSON：${e.message}`)
    return
  }

  if (toolKey === 'git') {
    // git 用 gitexec-manifest.json#farm（名称 → 物理 ELF），无 fileCount/totalSha256
    const farm = manifest.farm
    if (!farm || typeof farm !== 'object') { problems.push('git manifest 缺 farm 对象'); return }
    const farmNames = Object.keys(farm)
    if (farmNames.length !== spec.farmSize) {
      problems.push(`git farm 数量不符：实测 ${farmNames.length} ≠ lock ${spec.farmSize}`)
    }
    const elfBaseNames = new Set(lock.elf.filter((e) => e.tool === 'git').map((e) => e.path))
    for (const [farmName, target] of Object.entries(farm)) {
      if (!elfBaseNames.has(target)) problems.push(`git farm ${farmName} 指向非受管 ELF：${target}`)
    }
    note(`git 工具树：${fileEntries.length} 文件 / ${dirEntries.length} 目录，farm ${farmNames.length} 项，manifest sha ${manifestSha.slice(0, 16)}…`)
    return
  }

  // node/python：fileCount + totalSha256（内容聚合，不受 generatedAt 时间戳影响）
  if (manifest.fileCount !== spec.manifestFileCount) {
    problems.push(`${toolKey} manifest.fileCount 不符：实测 ${manifest.fileCount} ≠ lock ${spec.manifestFileCount}`)
  }
  if (manifest.totalSha256 !== spec.manifestTotalSha256) {
    problems.push(`${toolKey} manifest.totalSha256 不符：实测 ${manifest.totalSha256} ≠ lock ${spec.manifestTotalSha256}`)
  }
  // manifest 内登记的每个文件都必须在 tar 中存在且 sha 一致（全量校验，工具树 ≤1592 文件，可接受）
  const byName = new Map()
  for (const e of fileEntries) byName.set(e.name, e.data)
  let mismatch = 0
  let missing = 0
  const relFiles = manifest.files || {}
  for (const [rel, wantSha] of Object.entries(relFiles)) {
    const candidate = `${rootPrefix}${rel}`
    const data = byName.get(candidate)
    if (!data) { missing += 1; continue }
    if (sha256Buffer(data) !== wantSha) mismatch += 1
  }
  if (missing > 0) problems.push(`${toolKey} 工具树有 ${missing} 个 manifest 登记文件在 tar 中缺失`)
  if (mismatch > 0) problems.push(`${toolKey} 工具树有 ${mismatch} 个文件 SHA-256 与 manifest 不符`)
  note(`${toolKey} 工具树：${fileEntries.length} 文件 / ${dirEntries.length} 目录，fileCount=${manifest.fileCount}，逐文件校验 ${Object.keys(relFiles).length} 项，manifest sha ${manifestSha.slice(0, 16)}…`)
}

for (const [toolKey, spec] of Object.entries(lock.toolArchives)) {
  verifyToolArchive(toolKey, spec)
}

// uv/pnpm 不得生成空工具包
const allowedTars = new Set(Object.values(lock.toolArchives).map((s) => s.archive))
const onDiskTars = readdirSync(toolsDir).filter((n) => n.endsWith('.tar'))
const extraTars = onDiskTars.filter((n) => !allowedTars.has(n))
if (extraTars.length > 0) problems.push(`cli-tools 出现非受管 .tar：${extraTars.join(',')}（uv/pnpm 无工具树，不得生成空包）`)
for (const name of allowedTars) {
  if (!onDiskTars.includes(name)) problems.push(`cli-tools 缺受管归档：${name}`)
}

if (problems.length > 0) fail()
console.log(`\n✓ CLI 锁值校验全过：${lock.elf.length} ELF + ${lock.shells.length} shell 壳 + ${Object.keys(lock.toolArchives).length} 工具树（arm64-v8a，= cli.lock.json 锁值）`)
