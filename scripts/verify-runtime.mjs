#!/usr/bin/env node
/**
 * verify-runtime.mjs —— 运行时锁值校验（pi-desktop-android 001-building-workflow；移植自 oc-desktop-android 同款）。
 *
 * 引擎经 Maven 双包（io.github.fellow99:node-bridge/node-runtime）接入：node-bridge = Kotlin API/JNI 引导件，
 * node-runtime = libnode.so + libc++_shared.so（AAR），单一事实源 = 工程根 runtime.lock.json（镜像 aosp-node-runtime）。
 * 本脚本断言「node-runtime AAR 内容」与锁值逐字一致，并执行 ELF 门禁（= lock.gates）。
 *
 * 校验项（任一不符 ⇒ 退出码 2，构建不得继续）：
 *   ① runtime.lock.json 存在且版本可读；
 *   ② node-runtime-<ver>.aar 存在（优先 --aar / PDA_NODE_RUNTIME_AAR，其次 mavenLocal、Gradle 缓存）；
 *   ③ AAR 内 jni/arm64-v8a/libnode.so 的 SHA-256 = lock.libnodeSha256；
 *   ④ AAR 内 jni/arm64-v8a/libc++_shared.so 的 SHA-256 = lock.libcxxSharedSha256；
 *   ⑤ ELF 门禁：ET_DYN · 无 PT_INTERP · EM_AARCH64 · DT_SONAME=libnode.so ·
 *      导出 node::Start(_ZN4node5StartEiPPc) · PT_LOAD 16KB 页对齐。
 *
 * 幂等：纯只读校验（zip 解压仅入内存），重复执行结果一致。
 * 用法：node scripts/verify-runtime.mjs [--aar <path>]（CI 预取 Central AAR 后 --aar 注入）
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(root, 'runtime.lock.json')
const argv = process.argv.slice(2)
const aarArg = argv.includes('--aar') ? argv[argv.indexOf('--aar') + 1] : process.env.PDA_NODE_RUNTIME_AAR

const problems = []
const fail = () => {
  for (const m of problems) console.error(`✗ ${m}`)
  console.error('\n处置：核对 node-runtime 包来源（Gradle 刷新），或确认引擎确已升级后更新 runtime.lock.json 再重试。')
  process.exit(2)
}

if (!existsSync(lockPath)) { problems.push(`缺少锁文件：${lockPath}`); fail() }
const lock = JSON.parse(readFileSync(lockPath, 'utf8')).active
const nodeVer = lock.node

/* ── ① gradle 版本目录与 lock 一致 ───────────────────────────────────────── */
const toml = readFileSync(path.join(root, 'gradle/libs.versions.toml'), 'utf8')
const tomlRuntime = /nodeRuntime\s*=\s*"([^"]+)"/.exec(toml)?.[1]
const tomlBridge = /nodeBridge\s*=\s*"([^"]+)"/.exec(toml)?.[1]
if (tomlRuntime !== nodeVer) problems.push(`libs.versions.toml nodeRuntime=${tomlRuntime ?? '<缺>'} ≠ lock.node=${nodeVer}`)
if (tomlBridge !== lock.bridge) problems.push(`libs.versions.toml nodeBridge=${tomlBridge ?? '<缺>'} ≠ lock.bridge=${lock.bridge}`)

/* ── ② 定位 node-runtime AAR（mavenLocal 优先，其次 Gradle 缓存）─────────── */
function findAar() {
  if (aarArg) return existsSync(aarArg) ? aarArg : null
  const candidates = []
  const mavenLocal = path.join(process.env.USERPROFILE || process.env.HOME || '', '.m2', 'repository', 'io', 'github', 'fellow99', 'node-runtime', nodeVer)
  candidates.push(path.join(mavenLocal, `node-runtime-${nodeVer}.aar`))
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.gradle')
  const base = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1', 'io.github.fellow99', 'node-runtime', nodeVer)
  if (existsSync(base)) {
    for (const hash of readdirSync(base)) {
      const dir = path.join(base, hash)
      for (const name of readdirSync(dir)) {
        if (name === `node-runtime-${nodeVer}.aar`) candidates.push(path.join(dir, name))
      }
    }
  }
  for (const c of candidates) if (existsSync(c)) return c
  return null
}
const aar = findAar()
if (!aar) {
  problems.push(`未找到 node-runtime-${nodeVer}.aar（先跑一次 ./gradlew :app:assembleDebug 让 Gradle 拉取；或用 --aar 指定）`)
  fail()
}
console.log(`✓ AAR：${aar}`)

/* ── ②③④ 从 AAR(zip) 提取 .so 并校验 SHA-256 ────────────────────────────── */
/** 极简 zip 读取：遍历 central directory，支持 store/deflate。返回 Map<name, Buffer> */
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
try {
  zip = readZip(aar)
} catch (e) {
  problems.push(`AAR(zip) 解析失败：${e.message}`)
  fail()
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const libnode = zip.get('jni/arm64-v8a/libnode.so')
const libcxx = zip.get('jni/arm64-v8a/libc++_shared.so')
if (!libnode) { problems.push('AAR 内缺 jni/arm64-v8a/libnode.so'); fail() }
if (!libcxx) { problems.push('AAR 内缺 jni/arm64-v8a/libc++_shared.so'); fail() }
const nodeSha = sha256(libnode)
const cxxSha = sha256(libcxx)
if (nodeSha !== lock.libnodeSha256) problems.push(`libnode.so SHA-256 不符：期望 ${lock.libnodeSha256}，实测 ${nodeSha}`)
if (cxxSha !== lock.libcxxSharedSha256) problems.push(`libc++_shared.so SHA-256 不符：期望 ${lock.libcxxSharedSha256}，实测 ${cxxSha}`)
if (problems.length > 0) fail()
console.log(`✓ libnode.so SHA-256 = lock（${nodeSha.slice(0, 16)}…，${libnode.length} B）`)
console.log(`✓ libc++_shared.so SHA-256 = lock（${cxxSha.slice(0, 16)}…）`)

/* ── ⑤ ELF 门禁（64-bit little-endian）──────────────────────────────────── */
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
    shoff: Number(buf.readBigUInt64LE(40)),
    shentsize: buf.readUInt16LE(58),
    shnum: buf.readUInt16LE(60),
    shstrndx: buf.readUInt16LE(62),
  }
  elf.segments = () => {
    const out = []
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phoff + i * elf.phentsize
      out.push({ type: buf.readUInt32LE(at), align: Number(buf.readBigUInt64LE(at + 48)) })
    }
    return out
  }
  elf.sections = () => {
    const out = []
    for (let i = 0; i < elf.shnum; i++) {
      const at = elf.shoff + i * elf.shentsize
      out.push({
        nameOff: buf.readUInt32LE(at),
        offset: Number(buf.readBigUInt64LE(at + 24)),
        size: Number(buf.readBigUInt64LE(at + 32)),
        entsize: Number(buf.readBigUInt64LE(at + 56)),
      })
    }
    return out
  }
  const secName = (strTab, off) => {
    const end = buf.indexOf(0, strTab + off)
    return buf.subarray(strTab + off, strTab + end).toString('utf8')
  }
  elf.vaddrToFile = (vaddr) => {
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phoff + i * elf.phentsize
      const ptype = buf.readUInt32LE(at)
      if (ptype !== 1) continue // PT_LOAD
      const pOffset = Number(buf.readBigUInt64LE(at + 8))
      const pVaddr = Number(buf.readBigUInt64LE(at + 16))
      const pFilesz = Number(buf.readBigUInt64LE(at + 32))
      if (vaddr >= pVaddr && vaddr < pVaddr + pFilesz) return pOffset + (vaddr - pVaddr)
    }
    return null
  }
  elf.dynamic = () => {
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phoff + i * elf.phentsize
      if (buf.readUInt32LE(at) === 2) { // PT_DYNAMIC
        return {
          offset: Number(buf.readBigUInt64LE(at + 8)),
          vaddr: Number(buf.readBigUInt64LE(at + 16)),
          filesz: Number(buf.readBigUInt64LE(at + 32)),
        }
      }
    }
    return null
  }
  /** 走 PT_DYNAMIC：{strtab, symtab, strsz, sonameOff, hash}（vaddr 已转文件偏移） */
  elf.dynamicTable = () => {
    const dyn = elf.dynamic()
    if (!dyn) return null
    let strtab = null, symtab = null, strsz = null, sonameOff = null, hashVaddr = null
    for (let at = dyn.offset; at + 16 <= dyn.offset + dyn.filesz; at += 16) {
      const tag = Number(buf.readBigUInt64LE(at))
      const val = Number(buf.readBigUInt64LE(at + 8))
      if (tag === 0) break
      if (tag === 5) strtab = val       // DT_STRTAB
      else if (tag === 6) symtab = val  // DT_SYMTAB
      else if (tag === 10) strsz = val  // DT_STRSZ
      else if (tag === 14) sonameOff = val // DT_SONAME
      else if (tag === 4) hashVaddr = val  // DT_HASH
    }
    if (strtab === null || symtab === null) return null
    const strOff = elf.vaddrToFile(strtab)
    const symOff = elf.vaddrToFile(symtab)
    if (strOff === null || symOff === null) return null
    return { strOff, symOff, strsz, sonameOff, hashVaddr }
  }
  elf.soname = () => {
    const t = elf.dynamicTable()
    if (!t || t.sonameOff === undefined || t.sonameOff === null) return null
    const start = t.strOff + t.sonameOff
    const end = buf.indexOf(0, start)
    return buf.subarray(start, end).toString('utf8')
  }
  elf.dynsymHas = (symbol) => {
    const t = elf.dynamicTable()
    if (!t) return null
    /* 符号数：优先 DT_HASH 的 nchain；否则用「.dynsym 紧邻 .dynstr」布局估算（Elf64_Sym=24B） */
    let count = 0
    if (t.hashVaddr) {
      const hashOff = elf.vaddrToFile(t.hashVaddr)
      if (hashOff !== null) count = buf.readUInt32LE(hashOff + 4) // nchain = 符号数
    }
    if (!count || count > 1_000_000) {
      if (t.strOff > t.symOff) count = Math.floor((t.strOff - t.symOff) / 24)
      else count = 200_000
    }
    for (let i = 0; i < count; i++) {
      const at = t.symOff + i * 24
      if (at + 24 > buf.length) break
      const nameOff = buf.readUInt32LE(at)
      if (nameOff === 0) continue
      const start = t.strOff + nameOff
      if (start >= buf.length) break
      const end = buf.indexOf(0, start)
      if (buf.subarray(start, end).toString('utf8') === symbol) return true
    }
    return false
  }
  return elf
}

let elf
try {
  elf = parseElf(libnode)
} catch (e) {
  problems.push(`ELF 解析失败：${e.message}`)
  fail()
}
if (elf.type !== 3) problems.push(`ELF 门禁失败：e_type=${elf.type} ≠ ET_DYN(3)`)
if (elf.machine !== 183) problems.push(`ELF 门禁失败：e_machine=${elf.machine} ≠ EM_AARCH64(183)`)
const segs = elf.segments()
if (segs.some((s) => s.type === 3)) problems.push('ELF 门禁失败：存在 PT_INTERP（引擎必须无解释器段）')
const loads = segs.filter((s) => s.type === 1)
if (loads.length === 0) {
  problems.push('ELF 门禁失败：无 PT_LOAD')
} else {
  for (const l of loads) {
    if (l.align !== 0 && (l.align < 16384 || l.align % 16384 !== 0)) {
      problems.push(`ELF 门禁失败：PT_LOAD p_align=${l.align} 非 16KB 页对齐`)
      break
    }
  }
}
const soname = elf.soname()
if (soname !== 'libnode.so') problems.push(`ELF 门禁失败：DT_SONAME=${soname ?? '<未找到>'} ≠ libnode.so`)
const hasStart = elf.dynsymHas('_ZN4node5StartEiPPc')
if (hasStart === null) problems.push('ELF 门禁失败：.dynsym 不可解析（无法验证 node::Start 导出）')
else if (!hasStart) problems.push('ELF 门禁失败：未导出 node::Start(_ZN4node5StartEiPPc)')
if (problems.length > 0) fail()

console.log('✓ ELF 门禁全过：ET_DYN · 无 PT_INTERP · EM_AARCH64 · SONAME=libnode.so · node::Start 导出 · 16KB 页对齐')
console.log(`✓ 运行时锁值校验全过：node-bridge@${lock.bridge} + node-runtime@${lock.node}（arm64-v8a，= runtime.lock.json 锁值）`)
