#!/usr/bin/env node
/**
 * verify-pty.mjs —— PTY 原生件锁值校验（111-pty-integration；镜像 verify-runtime.mjs 纪律）。
 *
 * node-pty 经 Maven AAR（io.github.fellow99:node-pty:26.13.0）接入：AAR 只带
 * jni/arm64-v8a/libpty_node.so（node-pty@1.1.0 交叉编译，DT_NEEDED libnode.so）。
 * 单一事实源 = 工程根 runtime.lock.json 的 libptyNodeSha256 / ptyPkgVersion（镜像 aosp-node-pty pty.lock.json）。
 *
 * 校验项（任一不符 ⇒ 退出码 2，构建不得继续）：
 *   ① runtime.lock.json 存在且版本可读（also 校验 toml nodePty 一致）；
 *   ② node-pty-<ver>.aar 存在（优先 --aar / PDA_NODE_PTY_AAR，其次 mavenLocal、Gradle 缓存）；
 *   ③ AAR 内 jni/arm64-v8a/libpty_node.so 的 SHA-256 = lock.libptyNodeSha256；
 *   ④ ELF 门禁：ET_DYN · 无 PT_INTERP · EM_AARCH64 · DT_NEEDED 含 libnode.so · PT_LOAD 16KB 页对齐。
 *
 * 幂等：纯只读校验（zip 解压仅入内存）。
 * 用法：node scripts/verify-pty.mjs [--aar <path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(root, 'runtime.lock.json')
const argv = process.argv.slice(2)
const aarArg = argv.includes('--aar') ? argv[argv.indexOf('--aar') + 1] : process.env.PDA_NODE_PTY_AAR

const problems = []
const fail = () => {
  for (const m of problems) console.error(`✗ ${m}`)
  console.error('\n处置：核对 node-pty 包来源（Gradle 刷新），或确认 pty 确已升级后更新 runtime.lock.json 再重试。')
  process.exit(2)
}

if (!existsSync(lockPath)) { problems.push(`缺少锁文件：${lockPath}`); fail() }
const lock = JSON.parse(readFileSync(lockPath, 'utf8')).active
const nodeVer = lock.node

/* ── ① toml nodePty 与 lock 一致 ──────────────────────────────────────── */
const toml = readFileSync(path.join(root, 'gradle/libs.versions.toml'), 'utf8')
const tomlPty = /nodePty\s*=\s*"([^"]+)"/.exec(toml)?.[1]
if (tomlPty !== nodeVer) problems.push(`libs.versions.toml nodePty=${tomlPty ?? '<缺>'} ≠ lock.node=${nodeVer}`)

/* ── ② 定位 node-pty AAR ──────────────────────────────────────────────── */
function findAar() {
  if (aarArg) return existsSync(aarArg) ? aarArg : null
  const candidates = []
  const mavenLocal = path.join(process.env.USERPROFILE || process.env.HOME || '', '.m2', 'repository', 'io', 'github', 'fellow99', 'node-pty', nodeVer)
  candidates.push(path.join(mavenLocal, `node-pty-${nodeVer}.aar`))
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.gradle')
  const base = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1', 'io.github.fellow99', 'node-pty', nodeVer)
  if (existsSync(base)) {
    for (const hash of readdirSync(base)) {
      const dir = path.join(base, hash)
      for (const name of readdirSync(dir)) {
        if (name === `node-pty-${nodeVer}.aar`) candidates.push(path.join(dir, name))
      }
    }
  }
  for (const c of candidates) if (existsSync(c)) return c
  return null
}
const aar = findAar()
if (!aar) {
  problems.push(`未找到 node-pty-${nodeVer}.aar（先跑一次 ./gradlew :app:assembleDebug 让 Gradle 拉取；或用 --aar 指定）`)
  fail()
}
console.log(`✓ AAR：${aar}`)

/* ── zip 极简读取（store/deflate） ─────────────────────────────────────── */
function readZip(file) {
  const buf = readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法 zip（无 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`zip central directory 损坏 @${at}`)
    const method = buf.readUInt16LE(at + 10)
    const compSize = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extraLen + commentLen
    const lNameLen = buf.readUInt16LE(localAt + 26)
    const lExtraLen = buf.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataAt, dataAt + compSize)
    out.set(name, method === 0 ? raw : inflateRawSync(raw))
  }
  return out
}

let zip
try { zip = readZip(aar) } catch (e) { problems.push(`AAR(zip) 解析失败：${e.message}`); fail() }
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const libpty = zip.get('jni/arm64-v8a/libpty_node.so')
if (!libpty) { problems.push('AAR 内缺 jni/arm64-v8a/libpty_node.so（pty AAR 只应带这一个 .so）'); fail() }
const ptySha = sha256(libpty)
if (ptySha !== lock.libptyNodeSha256) problems.push(`libpty_node.so SHA-256 不符：期望 ${lock.libptyNodeSha256}，实测 ${ptySha}（lock.ptyPkgVersion=${lock.ptyPkgVersion}）`)
if (problems.length > 0) fail()
console.log(`✓ libpty_node.so SHA-256 = lock（${ptySha.slice(0, 16)}…，${libpty.length} B；${lock.ptyPkgVersion}）`)

/* ── ELF 门禁（64-bit LE）─────────────────────────────────────────────── */
function parseElf(buf) {
  if (buf.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('ELF magic 不符')
  if (buf[4] !== 2) throw new Error('非 64-bit ELF')
  if (buf[5] !== 1) throw new Error('非 little-endian')
  const elf = {
    buf,
    type: buf.readUInt16LE(16),
    machine: buf.readUInt16LE(18),
    phoff: Number(buf.readBigUInt64LE(32)),
    phentsize: buf.readUInt16LE(54),
    phnum: buf.readUInt16LE(56),
  }
  elf.segments = () => {
    const out = []
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phoff + i * elf.phentsize
      out.push({ type: buf.readUInt32LE(at), align: Number(buf.readBigUInt64LE(at + 48)) })
    }
    return out
  }
  elf.neededLibs = () => {
    const dynSeg = null
    let dyOff = null, dySize = null
    // 定位 PT_DYNAMIC
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phoff + i * elf.phentsize
      if (buf.readUInt32LE(at) === 2) { dyOff = Number(buf.readBigUInt64LE(at + 8)); dySize = Number(buf.readBigUInt64LE(at + 32)); break }
    }
    if (dyOff === null) return null
    // 需要 strtab（DT_STRTAB=5）与 strsz（DT_STRSZ=10），以及 vaddr→file
    let strtab = null, strsz = null
    const dyn = []
    for (let at = dyOff; at + 16 <= dyOff + dySize; at += 16) {
      const tag = Number(buf.readBigUInt64LE(at)); const val = Number(buf.readBigUInt64LE(at + 8))
      if (tag === 0) break
      if (tag === 5) strtab = val
      else if (tag === 10) strsz = val
      dyn.push([tag, val])
    }
    // vaddr→file（PT_LOAD）
    const vaddrToFile = (vaddr) => {
      for (let i = 0; i < elf.phnum; i++) {
        const at = elf.phoff + i * elf.phentsize
        if (buf.readUInt32LE(at) !== 1) continue
        const pOff = Number(buf.readBigUInt64LE(at + 8))
        const pVa = Number(buf.readBigUInt64LE(at + 16))
        const pSz = Number(buf.readBigUInt64LE(at + 32))
        if (vaddr >= pVa && vaddr < pVa + pSz) return pOff + (vaddr - pVa)
      }
      return null
    }
    const strOff = strtab === null ? null : vaddrToFile(strtab)
    if (strOff === null) return null
    const libs = []
    for (const [tag, val] of dyn) {
      if (tag === 1) { // DT_NEEDED
        const off = strOff + val
        const end = buf.indexOf(0, off)
        libs.push(buf.subarray(off, end).toString('utf8'))
      }
    }
    return libs
  }
  return elf
}

let elf
try { elf = parseElf(libpty) } catch (e) { problems.push(`ELF 解析失败：${e.message}`); fail() }
if (elf.type !== 3) problems.push(`ELF 门禁失败：e_type=${elf.type} ≠ ET_DYN(3)`)
if (elf.machine !== 183) problems.push(`ELF 门禁失败：e_machine=${elf.machine} ≠ EM_AARCH64(183)`)
const segs = elf.segments()
if (segs.some((s) => s.type === 3)) problems.push('ELF 门禁失败：存在 PT_INTERP（原生件必须无解释器段）')
const loads = segs.filter((s) => s.type === 1)
if (loads.length === 0) problems.push('ELF 门禁失败：无 PT_LOAD')
else for (const l of loads) if (l.align !== 0 && (l.align < 16384 || l.align % 16384 !== 0)) { problems.push(`ELF 门禁失败：PT_LOAD p_align=${l.align} 非 16KB 页对齐`); break }
const needed = elf.neededLibs()
if (needed === null) problems.push('ELF 门禁失败：DT_STRTAB/PT_DYNAMIC 不可解析（无法验证 DT_NEEDED）')
else if (!needed.includes('libnode.so')) problems.push(`ELF 门禁失败：DT_NEEDED 缺 libnode.so（实测 ${needed.join(',')}）`)
if (problems.length > 0) fail()

console.log('✓ ELF 门禁全过：ET_DYN · 无 PT_INTERP · EM_AARCH64 · DT_NEEDED 含 libnode.so · 16KB 页对齐')
console.log(`✓ pty 锁值校验全过：node-pty@${lock.ptyPkgVersion} + node-runtime@${lock.node}（arm64-v8a，= runtime.lock.json 锁值）`)
