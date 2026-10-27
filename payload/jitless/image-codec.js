'use strict';
/**
 * image-codec.js —— 纯 JS 图片编解码分派（compat 形态专用）
 *
 * 职责：
 *   1. `sniff()`          只解析**文件头**拿宽高（不解码像素）；
 *   2. `decodeToRGBA()`   JPEG / PNG 解码为 RGBA；
 *   3. `encodePNG()`      RGBA → PNG；
 *   4. `encodeJPEG()`     RGBA → JPEG。
 *
 * 约束（需求 108-jitless）：
 *   - **全同步**：上游 `image-resize-core.js` / `image-convert.js` 调用点无 await；
 *   - **不碰 WebAssembly**：只用 vendored 的 jpeg-js / pngjs（纯 JS，均无运行时依赖）；
 *   - GIF / WebP 只支持取宽高，解码**明确报错**（上游会转成用户可见提示）。
 */

const jpeg = require('./vendor/jpeg-js');
const { PNG } = require('./vendor/pngjs');

const LOG_PREFIX = '[jitless:photon]';
const DEBUG = process.env.PI_JITLESS_PHOTON_DEBUG === '1';

/** 内部统计：selftest 用它断言"惰性解码"（new_from_byteslice 不得解码） */
const stats = {
    /** 真正执行的像素解码次数 */
    decodes: 0,
    /** 真正执行的编码次数 */
    encodes: 0,
    /** 累计解码耗时（毫秒） */
    decodeMs: 0,
    /** 累计编码耗时（毫秒） */
    encodeMs: 0,
};

function resetStats() {
    stats.decodes = 0;
    stats.encodes = 0;
    stats.decodeMs = 0;
    stats.encodeMs = 0;
}

function getStats() {
    return { ...stats };
}

function log(...args) {
    if (DEBUG) {
        console.error(LOG_PREFIX, ...args);
    }
}

/** 统一成 Uint8Array 视图（不拷贝） */
function asUint8Array(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new Error(`${LOG_PREFIX} 输入不是 Uint8Array/Buffer/ArrayBuffer`);
}

/** 不要拷贝的 Buffer 视图（供 pngjs / jpeg-js 使用） */
function asBuffer(bytes) {
    const u8 = asUint8Array(bytes);
    if (Buffer.isBuffer(u8)) return u8;
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

function u16be(b, pos) {
    return (b[pos] << 8) | b[pos + 1];
}

function u16le(b, pos) {
    return b[pos] | (b[pos + 1] << 8);
}

function u24le(b, pos) {
    return b[pos] | (b[pos + 1] << 8) | (b[pos + 2] << 16);
}

function u32be(b, pos) {
    return ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
}

function u32le(b, pos) {
    return (b[pos] | (b[pos + 1] << 8) | (b[pos + 2] << 16) | (b[pos + 3] << 24)) >>> 0;
}

function hasAscii(b, pos, text) {
    if (pos + text.length > b.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (b[pos + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/**
 * JPEG 段扫描：读 SOF0..SOF15（跳过 C4=DHT / C8=JPG / CC=DAC）拿高宽。
 * 结构：FF D8 之后是 N 个「FF marker + 2 字节长度」的段；SOF 段里
 *   长度(2) 精度(1) 高(2) 宽(2) ...
 */
function sniffJpeg(b) {
    const len = b.length;
    let pos = 2;
    while (pos + 1 < len) {
        // 容忍非 marker 位置的杂字节（少量手机图会在段间插入垃圾）
        if (b[pos] !== 0xFF) {
            pos++;
            continue;
        }
        // 跳过 0xFF 填充
        while (pos + 1 < len && b[pos + 1] === 0xFF) pos++;
        const marker = b[pos + 1];
        pos += 2;
        // 无长度的独立 marker
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
        if (marker === 0xD9) break; // EOI
        if (pos + 1 >= len) break;
        const segLen = u16be(b, pos);
        if (segLen < 2) {
            pos++;
            continue;
        }
        const isSof =
            marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
        if (isSof) {
            if (pos + 7 > len) break;
            const height = u16be(b, pos + 3);
            const width = u16be(b, pos + 5);
            if (width > 0 && height > 0) return { width, height };
            break;
        }
        if (marker === 0xDA) break; // SOS：SOF 必在其之前
        pos += segLen;
    }
    return null;
}

/** PNG：89 50 4E 47 0D 0A 1A 0A + IHDR(length,type,width,height) */
function sniffPng(b) {
    if (b.length < 24) return null;
    if (!(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)) return null;
    if (!(b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)) return null;
    if (!hasAscii(b, 12, 'IHDR')) return null;
    const width = u32be(b, 16);
    const height = u32be(b, 20);
    if (width > 0 && height > 0) return { width, height };
    return null;
}

/** GIF87a / GIF89a：逻辑屏宽高（小端 16 位） */
function sniffGif(b) {
    if (b.length < 10) return null;
    if (!(hasAscii(b, 0, 'GIF87a') || hasAscii(b, 0, 'GIF89a'))) return null;
    const width = u16le(b, 6);
    const height = u16le(b, 8);
    if (width > 0 && height > 0) return { width, height };
    return null;
}

/** WebP：RIFF....WEBP，再按 chunk 找 VP8 / VP8L / VP8X */
function sniffWebp(b) {
    if (b.length < 16) return null;
    if (!hasAscii(b, 0, 'RIFF') || !hasAscii(b, 8, 'WEBP')) return null;
    let pos = 12;
    while (pos + 8 <= b.length) {
        const type = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
        const size = u32le(b, pos + 4);
        const payload = pos + 8;
        if (type === 'VP8X') {
            // 1 字节 flags + 3 字节保留 + 3 字节(宽-1) + 3 字节(高-1)
            if (payload + 10 > b.length) return null;
            return { width: u24le(b, payload + 4) + 1, height: u24le(b, payload + 7) + 1 };
        }
        if (type === 'VP8 ') {
            // 3 字节帧标签 + 起始码 9D 01 2A + 14 位宽 + 14 位高
            if (payload + 10 > b.length) return null;
            if (!(b[payload + 3] === 0x9d && b[payload + 4] === 0x01 && b[payload + 5] === 0x2a)) {
                return null;
            }
            return {
                width: u16le(b, payload + 6) & 0x3fff,
                height: u16le(b, payload + 8) & 0x3fff,
            };
        }
        if (type === 'VP8L') {
            // 签名 0x2F + 14 位(宽-1) + 14 位(高-1)
            if (payload + 5 > b.length) return null;
            if (b[payload] !== 0x2f) return null;
            const bits = u32le(b, payload + 1);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        const next = payload + size + (size & 1);
        if (next <= pos) return null;
        pos = next;
    }
    return null;
}

/**
 * 解析图片文件头。
 * @returns {{format:'jpeg'|'png'|'gif'|'webp', width:number, height:number}}
 * @throws 取不到宽高时抛明确错误（上游 catch 后转成可见提示，不崩）
 */
function sniff(bytes) {
    const b = asUint8Array(bytes);
    if (b.length < 4) {
        throw new Error(`${LOG_PREFIX} 无法解析图片尺寸（格式 unknown：数据过短，${b.length} 字节）`);
    }
    let format = 'unknown';
    let dim = null;
    if (b[0] === 0xff && b[1] === 0xd8) {
        format = 'jpeg';
        dim = sniffJpeg(b);
    } else if (b[0] === 0x89 && hasAscii(b, 1, 'PNG')) {
        format = 'png';
        dim = sniffPng(b);
    } else if (hasAscii(b, 0, 'GIF8')) {
        format = 'gif';
        dim = sniffGif(b);
    } else if (hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WEBP')) {
        format = 'webp';
        dim = sniffWebp(b);
    }
    if (!dim) {
        throw new Error(`${LOG_PREFIX} 无法解析图片尺寸（格式 ${format}）`);
    }
    return { format, width: dim.width, height: dim.height };
}

/**
 * 解码为 RGBA（同步）。
 * @returns {{data: Uint8Array, width: number, height: number}}
 */
function decodeToRGBA(bytes) {
    const b = asUint8Array(bytes);
    const { format, width, height } = sniff(b);
    const t0 = Date.now();
    let out;
    if (format === 'jpeg') {
        // useTArray：返回 Uint8Array（不依赖全局 Buffer 语义）；formatAsRGBA：统一 4 通道
        out = jpeg.decode(asBuffer(b), { useTArray: true, formatAsRGBA: true });
    } else if (format === 'png') {
        const png = PNG.sync.read(asBuffer(b));
        out = { data: png.data, width: png.width, height: png.height };
    } else {
        throw new Error(`${LOG_PREFIX} 不支持解码 ${format.toUpperCase()}（compat 形态仅支持 JPEG/PNG 解码）`);
    }
    if (!out || !out.data || out.width !== width || out.height !== height) {
        // 头部与解码结果不一致：按解码结果为准，但不静默
        if (!out || !out.data || !out.width || !out.height) {
            throw new Error(`${LOG_PREFIX} 解码 ${format.toUpperCase()} 失败（无像素输出）`);
        }
        log(`头部宽高 ${width}x${height} 与解码结果 ${out.width}x${out.height} 不一致，按解码结果处理`);
    }
    stats.decodes++;
    stats.decodeMs += Date.now() - t0;
    const elapsed = Date.now() - t0;
    if (DEBUG) {
        log(`解码 ${format.toUpperCase()} ${out.width}x${out.height} 耗时 ${elapsed} ms`);
    } else if (elapsed > 2000) {
        // 解释器下慢是事实，必须留痕（真机可用性评估用）
        console.error(`${LOG_PREFIX} 解码 ${format.toUpperCase()} ${out.width}x${out.height} 耗时 ${elapsed} ms（--jitless 慢）`);
    }
    return { data: asUint8Array(out.data), width: out.width, height: out.height };
}

/**
 * RGBA → PNG（同步）。
 * filterType=4（Paeth）+ deflateLevel=6：pngjs 默认会对每行试 5 种过滤器（-1），
 * 解释器下代价约为 5 倍；这里固定 Paeth 换取速度，压缩率略降但体积仍可控。
 */
function encodePNG(rgba, width, height) {
    const t0 = Date.now();
    const data = asBuffer(rgba);
    const expected = width * height * 4;
    if (data.length < expected) {
        throw new Error(`${LOG_PREFIX} encodePNG 像素不足：需要 ${expected} 字节，实际 ${data.length}`);
    }
    const buf = PNG.sync.write(
        { width, height, data: data.length === expected ? data : data.subarray(0, expected) },
        { filterType: 4, deflateLevel: 6, inputColorType: 6, colorType: 6 },
    );
    stats.encodes++;
    stats.encodeMs += Date.now() - t0;
    log(`编码 PNG ${width}x${height} 耗时 ${Date.now() - t0} ms，${buf.length} 字节`);
    return buf;
}

/**
 * RGBA → JPEG（同步）。quality 缺省 80（与上游 DEFAULT_OPTIONS.jpegQuality 一致）。
 */
function encodeJPEG(rgba, width, height, quality) {
    const t0 = Date.now();
    const data = asBuffer(rgba);
    const expected = width * height * 4;
    if (data.length < expected) {
        throw new Error(`${LOG_PREFIX} encodeJPEG 像素不足：需要 ${expected} 字节，实际 ${data.length}`);
    }
    const q = typeof quality === 'number' && quality > 0 ? Math.min(100, Math.round(quality)) : 80;
    const out = jpeg.encode(
        { data: data.length === expected ? data : data.subarray(0, expected), width, height },
        q,
    );
    stats.encodes++;
    stats.encodeMs += Date.now() - t0;
    log(`编码 JPEG ${width}x${height} q=${q} 耗时 ${Date.now() - t0} ms，${out.data.length} 字节`);
    return out.data;
}

module.exports = {
    sniff,
    decodeToRGBA,
    encodePNG,
    encodeJPEG,
    // 给 selftest / 诊断用
    getStats,
    resetStats,
};
