#!/usr/bin/env node
/**
 * cli-lib.mjs —— 五个真实 CLI（node/python/git/uv/pnpm）构建侧共享原语（112-cli-integration）。
 *
 * 只使用 Node 内置模块（工程根无 package.json，禁止引入第三方依赖），供：
 *   - scripts/provision-cli.mjs：Release tarball/AAR → jniLibs + 确定性 assets/cli-tools/*.tar
 *   - scripts/verify-cli.mjs   ：对投放产物执行 cli.lock.json 锁值 + ELF/壳/工具树门禁
 *
 * 单一事实源 = 工程根 cli.lock.json；引擎三件（libnode.so/libpty_node.so/libc++_shared.so）
 * 仍归 runtime.lock.json + verify-runtime.mjs / verify-pty.mjs，本库不触碰。
 *
 * 归档契约与 scripts/assemble-payload.mjs 的确定性 ustar 写入器、Kotlin 侧 PayloadArchive 一一对应：
 *   512B ustar 头 · mtime=0 · 条目排序 · 超长名走 GNU 'L'（@LongLink）· 结尾 1024 全零 · gzip level 9。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync, gzipSync, gunzipSync } from 'node:zlib'

export const BLOCK = 512

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/* ── 极简 zip 读取：遍历 central directory，支持 store/deflate；返回 Map<name, Buffer> ──────── */
export function readZip(file) {
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
    // 目录条目（以 / 结尾、size=0）也入表，消费端按需过滤
    out.set(name, method === 0 ? raw : inflateRawSync(raw))
  }
  return out
}

/* ── ELF 门禁原语（64-bit little-endian；与 verify-runtime/verify-pty 同判据）──────────────── */
export function parseElf(buf) {
  if (buf.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('ELF magic 不符')
  if (buf[4] !== 2) throw new Error('非 64-bit ELF')
  if (buf[5] !== 1) throw new Error('非 little-endian')
  const elf = {
    buf,
    class: buf[4],
    data: buf[5],
    type: buf.readUInt16LE(16),
    machine: buf.readUInt16LE(18),
    phoff: Number(buf.readBigUInt64LE(32)),
    phentsize: buf.readUInt16LE(54),
    phnum: buf.readUInt16LE(56),
  }
  elf.phAt = (i) => elf.phoff + i * elf.phentsize
  elf.segments = () => {
    const out = []
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phAt(i)
      out.push({
        type: buf.readUInt32LE(at),
        flags: buf.readUInt32LE(at + 4),
        offset: Number(buf.readBigUInt64LE(at + 8)),
        vaddr: Number(buf.readBigUInt64LE(at + 16)),
        filesz: Number(buf.readBigUInt64LE(at + 32)),
        align: Number(buf.readBigUInt64LE(at + 48)),
      })
    }
    return out
  }
  elf.interpreter = () => {
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phAt(i)
      if (buf.readUInt32LE(at) !== 3) continue // PT_INTERP
      const off = Number(buf.readBigUInt64LE(at + 8))
      const size = Number(buf.readBigUInt64LE(at + 32))
      return buf.subarray(off, off + size).toString('utf8').replace(/\0+$/, '')
    }
    return null
  }
  elf.vaddrToFile = (vaddr) => {
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phAt(i)
      if (buf.readUInt32LE(at) !== 1) continue // PT_LOAD
      const pOff = Number(buf.readBigUInt64LE(at + 8))
      const pVa = Number(buf.readBigUInt64LE(at + 16))
      const pSz = Number(buf.readBigUInt64LE(at + 32))
      if (vaddr >= pVa && vaddr < pVa + pSz) return pOff + (vaddr - pVa)
    }
    return null
  }
  elf.neededLibs = () => {
    let dyOff = null, dySize = null
    for (let i = 0; i < elf.phnum; i++) {
      const at = elf.phAt(i)
      if (buf.readUInt32LE(at) !== 2) continue // PT_DYNAMIC
      dyOff = Number(buf.readBigUInt64LE(at + 8))
      dySize = Number(buf.readBigUInt64LE(at + 32))
      break
    }
    if (dyOff === null) return null
    let strtab = null
    const dyn = []
    for (let at = dyOff; at + 16 <= dyOff + dySize; at += 16) {
      const tag = Number(buf.readBigUInt64LE(at))
      const val = Number(buf.readBigUInt64LE(at + 8))
      if (tag === 0) break
      if (tag === 5) strtab = val // DT_STRTAB
      dyn.push([tag, val])
    }
    if (strtab === null) return null
    const strOff = elf.vaddrToFile(strtab)
    if (strOff === null) return null
    const libs = []
    for (const [tag, val] of dyn) {
      if (tag !== 1) continue // DT_NEEDED
      const start = strOff + val
      const end = buf.indexOf(0, start)
      libs.push(buf.subarray(start, end).toString('utf8'))
    }
    return libs
  }
  return elf
}

/**
 * 对 exec 型 CLI ELF 执行完整门禁；返回问题字符串数组（空数组 = 通过）。
 * 判据 = cli.lock.json#gates：ELF64/LE · ET_DYN · AArch64 · 恰有 PT_INTERP=/system/bin/linker64 ·
 *        PT_LOAD 16KB 页对齐（p_align=0x4000 且 (p_offset-p_vaddr) % 0x4000 = 0）· DT_NEEDED 全在白名单。
 */
export function elfGateProblems(buf, gates, neededWhitelist) {
  const problems = []
  let elf
  try {
    elf = parseElf(buf)
  } catch (e) {
    return [`ELF 解析失败：${e.message}`]
  }
  if (elf.class !== gates.elfClass) problems.push(`ELF 门禁：ei_class=${elf.class} ≠ ELF64(${gates.elfClass})`)
  if (elf.data !== gates.elfData) problems.push(`ELF 门禁：ei_data=${elf.data} ≠ little-endian(${gates.elfData})`)
  if (elf.type !== gates.eTypeDyn) problems.push(`ELF 门禁：e_type=${elf.type} ≠ ET_DYN(${gates.eTypeDyn})`)
  if (elf.machine !== gates.eMachineAArch64) problems.push(`ELF 门禁：e_machine=${elf.machine} ≠ EM_AArch64(${gates.eMachineAArch64})`)
  const interp = elf.interpreter()
  if (interp !== gates.expectedInterpreter) {
    problems.push(`ELF 门禁：PT_INTERP=${interp ?? '<无>'} ≠ ${gates.expectedInterpreter}`)
  }
  const loads = elf.segments().filter((s) => s.type === 1)
  if (loads.length === 0) {
    problems.push('ELF 门禁：无 PT_LOAD')
  } else {
    for (const l of loads) {
      if (l.align !== gates.pageSize || ((l.offset - l.vaddr) % gates.pageSize) !== 0) {
        problems.push(`ELF 门禁：PT_LOAD 非 16KB 页对齐（p_align=${l.align}, offset-vaddr=${l.offset - l.vaddr}）`)
        break
      }
    }
  }
  const needed = elf.neededLibs()
  if (needed === null) {
    problems.push('ELF 门禁：PT_DYNAMIC/DT_STRTAB 不可解析（无法验证 DT_NEEDED）')
  } else {
    const illegal = needed.filter((lib) => !neededWhitelist.includes(lib))
    if (illegal.length > 0) {
      problems.push(`ELF 门禁：DT_NEEDED 越白名单：${illegal.join(',')}（允许 ${neededWhitelist.join('/')}）`)
    }
  }
  return problems
}

/** shell 型 .so（libnpm/libnpx/libcorepack/libpip/libpip3）：首行必须是 #!/system/bin/sh。 */
export function isShellShim(buf) {
  return buf.subarray(0, 2).toString('utf8') === '#!'
}

/* ── 确定性 ustar 写入（与 assemble-payload.mjs / PayloadArchive 同契约）────────────────────── */
function byteLen(t) { return Buffer.byteLength(t, 'utf8') }

function splitUstarName(name) {
  const isDir = name.endsWith('/')
  const core = isDir ? name.slice(0, -1) : name
  if (byteLen(name) <= 100) return { headerName: name, prefix: '' }
  const slash = core.lastIndexOf('/')
  if (slash > 0) {
    const prefix = core.slice(0, slash)
    const base = core.slice(slash + 1)
    const headerName = isDir ? `${base}/` : base
    if (byteLen(headerName) <= 100 && byteLen(prefix) <= 155) return { headerName, prefix }
  }
  return null
}

function ustarHeader(name, size, typeflag, mode = 0o644) {
  const buf = Buffer.alloc(512, 0)
  const write = (text, offset, length) => {
    Buffer.from(text, 'utf8').copy(buf, offset, 0, length)
  }
  const plan = splitUstarName(name)
  if (plan === null) throw new Error(`ustar 头容纳不下该条目名（需要 GNU 'L' 长名条目）：${name}`)
  write(plan.headerName, 0, 100)
  // 目录必须带可执行位（0755）：Android toybox tar 严格按头 mode 落盘，
  // 若目录写 0644 会解出 drw-r--r--，无法进入 → 后续条目全部 Permission denied/bad symlink。
  // 普通文件与 GNU L 长名块用 0644。GNU tar 会智能补位，显式写对两端都确定。
  write(mode.toString(8).padStart(7, '0') + '\0', 100, 8)   // mode
  write('0000000\0', 108, 8)  // uid
  write('0000000\0', 116, 8)  // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12) // size
  write('00000000000\0', 136, 12) // mtime = 0（确定性）
  write('        ', 148, 8)  // checksum 占位
  buf[156] = typeflag.charCodeAt(0)
  write('ustar\0', 257, 6)
  write('00', 263, 2)
  if (plan.prefix.length > 0) write(plan.prefix, 345, 155)
  let sum = 0
  for (const b of buf) sum += b
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

function padTo512(size) {
  const remainder = size % BLOCK
  return remainder === 0 ? 0 : BLOCK - remainder
}

function truncateUtf8Bytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > maxBytes) break
    out += char
  }
  return out
}

/**
 * 生成确定性 gzip ustar（同步、内存内；工具树最大 ~7MB，可接受）。
 * @param {Array<{name:string, data:Buffer}>} entries 条目名（相对，正斜杠）；目录以 '/' 结尾、data 长度 0
 * @returns {Buffer} gzip 流（level 9；gzipSync 默认 mtime=0 → 可重复字节）
 */
export function buildTarGz(entries) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const chunks = []
  const push = (b) => chunks.push(b)
  for (const entry of sorted) {
    const name = entry.name
    const data = entry.data ?? Buffer.alloc(0)
    const isDir = name.endsWith('/')
    const needsLong = splitUstarName(name) === null
    if (needsLong) {
      const longName = Buffer.from(name, 'utf8')
      const longBlock = Buffer.concat([longName, Buffer.from([0])])
      push(ustarHeader('././@LongLink', longBlock.length, 'L'))
      push(longBlock)
      push(Buffer.alloc(padTo512(longBlock.length)))
      push(ustarHeader(truncateUtf8Bytes(name, 100), isDir ? 0 : data.length, isDir ? '5' : '0', isDir ? 0o755 : 0o644))
    } else {
      push(ustarHeader(name, isDir ? 0 : data.length, isDir ? '5' : '0', isDir ? 0o755 : 0o644))
    }
    if (!isDir && data.length > 0) {
      push(data)
      const padding = padTo512(data.length)
      if (padding > 0) push(Buffer.alloc(padding))
    }
  }
  push(Buffer.alloc(1024)) // 结尾两个全零块
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

/**
 * 解析 gzip（或裸）tar 为条目列表（verify 侧内存自检；权威可读性另由系统 tar 仲裁）。
 * 支持 GNU 'L' 长名、typeflag 0/'\0'（文件）与 '5'（目录）；含路径穿越保护。
 * @returns {Array<{name:string, typeflag:string, data:Buffer|null}>}
 */
export function parseTar(tarGzBuf) {
  const isGzip = tarGzBuf[0] === 0x1f && tarGzBuf[1] === 0x8b
  const tar = isGzip ? gunzipSync(tarGzBuf) : tarGzBuf
  const entries = []
  let at = 0
  let pendingLongName = null
  const readField = (header, off, len) => {
    let end = off
    const limit = off + len
    while (end < limit && header[end] !== 0) end++
    return header.subarray(off, end).toString('utf8').replace(/\0/g, ' ').trim()
  }
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK)
    if (header.every((b) => b === 0)) break // 结束块
    const nameField = readField(header, 0, 100)
    const prefixField = readField(header, 345, 155)
    let name = prefixField ? `${prefixField}/${nameField}` : nameField
    const size = parseInt(readField(header, 124, 12).replace(/\s/g, '') || '0', 8)
    const typeflag = String.fromCharCode(header[156])
    at += BLOCK
    const dataStart = at
    at += size + padTo512(size)
    if (typeflag === 'L') {
      pendingLongName = tar.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (pendingLongName !== null) {
      name = pendingLongName
      pendingLongName = null
    }
    if (!name) throw new Error('tar 条目名为空（归档损坏）')
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error(`tar 路径穿越被拒绝：${name}`)
    }
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name, typeflag: '0', data: tar.subarray(dataStart, dataStart + size) })
    } else if (typeflag === '5') {
      entries.push({ name: name.endsWith('/') ? name : `${name}/`, typeflag: '5', data: null })
    }
    // 其余类型（symlink/link/pax）本产物不应出现；忽略
  }
  return entries
}

/**
 * 递归把磁盘目录收集为 tar 条目（含 dotfile；目录条目补全；条目名以 `${rootPrefix}/` 打头）。
 * 不在此排序——buildTarGz 内部统一排序，保证确定性只依赖写入器。
 * @returns {Array<{name:string, data:Buffer}>}
 */
export function walkDirToEntries(rootDirAbs, rootPrefix) {
  const entries = []
  const seenDirs = new Set()
  const addDir = (relDir) => {
    const name = relDir ? `${rootPrefix}/${relDir}/` : `${rootPrefix}/`
    if (!seenDirs.has(name)) { seenDirs.add(name); entries.push({ name, data: Buffer.alloc(0) }) }
  }
  addDir('')
  const walk = (absDir, relPrefix) => {
    for (const name of readdirSync(absDir).sort()) {
      const abs = path.join(absDir, name)
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      const st = statSync(abs)
      if (st.isDirectory()) {
        addDir(rel)
        walk(abs, rel)
      } else if (st.isFile()) {
        entries.push({ name: `${rootPrefix}/${rel}`, data: readFileSync(abs) })
      }
      // 符号链接/其他类型不进入工具树（五个 Release 工具树内无 symlink）
    }
  }
  walk(rootDirAbs, '')
  return entries
}
