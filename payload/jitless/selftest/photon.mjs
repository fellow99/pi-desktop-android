#!/usr/bin/env node
/**
 * selftest/photon.mjs —— `payload/jitless` 纯 JS photon 垫片自检（PC 侧）
 *
 * 用法：
 *   node --jitless payload/jitless/selftest/photon.mjs            # compat 形态（本垫片的目标形态）
 *   node payload/jitless/selftest/photon.mjs                     # 对照组（WASM 可用；垫片不该被选中）
 *   node --jitless payload/jitless/selftest/photon.mjs --only=resize,fliph
 *
 * 只用内置模块 + 本目录的 image-codec.js / photon-shim.js（+ vendored jpeg-js/pngjs），
 * 测试素材全部现造，不依赖外部文件。
 *
 * 覆盖：
 *   - 头部宽高解析（JPEG / PNG / GIF / WebP VP8 / VP8L / VP8X）
 *   - 惰性解码（new_from_byteslice 不得触发解码；PNG 直通零编解码）
 *   - get_bytes (PNG) / get_bytes_jpeg (JPEG) 魔数
 *   - resize 尺寸、同尺寸快路径、各 SamplingFilter
 *   - fliph / flipv 逐像素
 *   - new PhotonImage(raw,w,h) + get_raw_pixels 往返
 *   - free() 语义（幂等、之后抛明确错误）
 *   - 上游真实路径：pi-dist 的 image-resize-core.js（临时 node_modules 指向本垫片）
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const JITLESS_DIR = path.resolve(HERE, '..');
const LOG = '[jitless:photon][selftest]';

const photon = require(path.join(JITLESS_DIR, 'photon-shim.js'));
const codec = require(path.join(JITLESS_DIR, 'image-codec.js'));
const jpeg = require(path.join(JITLESS_DIR, 'vendor', 'jpeg-js'));
const { PNG } = require(path.join(JITLESS_DIR, 'vendor', 'pngjs'));

/* -------------------------------------------------------------------------- */
/* 断言与素材                                                                  */
/* -------------------------------------------------------------------------- */

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || '断言失败'}：期望 ${String(expected)}，实际 ${String(actual)}`);
    }
}

/** 渐变 + 微噪声（确定性，不依赖随机数种子） */
function makeRGBA(w, h) {
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            px[i] = (x * 255) / Math.max(1, w - 1) | 0;
            px[i + 1] = (y * 255) / Math.max(1, h - 1) | 0;
            px[i + 2] = (x * 7 + y * 13) & 0xff;
            px[i + 3] = 255;
        }
    }
    return px;
}

/** 带缓存的素材构造（--only 时只为需要的用例付费） */
const cache = new Map();
function memo(key, factory) {
    if (!cache.has(key)) cache.set(key, factory());
    return cache.get(key);
}

function pngBytes(w, h) {
    return memo(`png:${w}x${h}`, () => {
        const buf = PNG.sync.write(
            { width: w, height: h, data: Buffer.from(makeRGBA(w, h)) },
            { filterType: 4, deflateLevel: 6 },
        );
        return new Uint8Array(buf);
    });
}

function jpegBytes(w, h, quality) {
    return memo(`jpeg:${w}x${h}:${quality}`, () => {
        const out = jpeg.encode({ data: makeRGBA(w, h), width: w, height: h }, quality);
        return new Uint8Array(out.data);
    });
}

/** 手工拼一个 GIF 头（GIF89a + 逻辑屏宽高） */
function gifHeader(w, h) {
    const b = Buffer.alloc(13);
    b.write('GIF89a', 0, 'ascii');
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    b[10] = 0; // packed
    b[11] = 0; // background color index
    b[12] = 0x3b; // trailer
    return new Uint8Array(b);
}

function riffHeader(payloadChunks) {
    const total = payloadChunks.reduce((s, c) => s + 8 + c.length, 4);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(total, 4);
    head.write('WEBP', 8, 'ascii');
    const parts = [head];
    for (const chunk of payloadChunks) parts.push(chunk);
    return new Uint8Array(Buffer.concat(parts));
}

function webpChunk(fourcc, payload) {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'ascii');
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([head, payload]);
}

/** VP8L（无损）：0x2F + 14 位(宽-1) + 14 位(高-1) */
function webpVP8L(w, h) {
    const p = Buffer.alloc(5);
    p[0] = 0x2f;
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
    p.writeUInt32LE(bits >>> 0, 1);
    return riffHeader([webpChunk('VP8L', p)]);
}

/** VP8（有损关键帧）：3 字节帧标签 + 起始码 + 14 位宽 + 14 位高 */
function webpVP8(w, h) {
    const p = Buffer.alloc(10);
    p[3] = 0x9d;
    p[4] = 0x01;
    p[5] = 0x2a;
    p.writeUInt16LE(w & 0x3fff, 6);
    p.writeUInt16LE(h & 0x3fff, 8);
    return riffHeader([webpChunk('VP8 ', p)]);
}

/** VP8X（扩展）：flags(1) + 保留(3) + 24 位(宽-1) + 24 位(高-1) */
function webpVP8X(w, h) {
    const p = Buffer.alloc(10);
    p[0] = 0x00;
    p.writeUIntLE(w - 1, 4, 3);
    p.writeUIntLE(h - 1, 7, 3);
    return riffHeader([webpChunk('VP8X', p)]);
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('headers-jpeg', () => {
    const info = codec.sniff(jpegBytes(800, 600, 80));
    assertEqual(info.format, 'jpeg', 'format');
    assertEqual(info.width, 800, 'width');
    assertEqual(info.height, 600, 'height');
});

test('headers-png', () => {
    const info = codec.sniff(pngBytes(800, 600));
    assertEqual(info.format, 'png', 'format');
    assertEqual(info.width, 800, 'width');
    assertEqual(info.height, 600, 'height');
});

test('headers-gif', () => {
    const info = codec.sniff(gifHeader(320, 240));
    assertEqual(info.format, 'gif', 'format');
    assertEqual(info.width, 320, 'width');
    assertEqual(info.height, 240, 'height');
});

test('headers-webp-vp8', () => {
    const info = codec.sniff(webpVP8(1280, 720));
    assertEqual(info.format, 'webp', 'format');
    assertEqual(info.width, 1280, 'width');
    assertEqual(info.height, 720, 'height');
});

test('headers-webp-vp8l', () => {
    const info = codec.sniff(webpVP8L(321, 241));
    assertEqual(info.format, 'webp', 'format');
    assertEqual(info.width, 321, 'width');
    assertEqual(info.height, 241, 'height');
});

test('headers-webp-vp8x', () => {
    const info = codec.sniff(webpVP8X(4000, 3000));
    assertEqual(info.format, 'webp', 'format');
    assertEqual(info.width, 4000, 'width');
    assertEqual(info.height, 3000, 'height');
});

test('sniff-unknown-throws', () => {
    let err = null;
    try {
        codec.sniff(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    } catch (e) {
        err = e;
    }
    assert(err, '未知格式必须抛错');
    assert(/无法解析图片尺寸/.test(err.message), `错误信息应可读：${err.message}`);
});

test('unsupported-decode-throws', () => {
    let err = null;
    try {
        codec.decodeToRGBA(gifHeader(320, 240));
    } catch (e) {
        err = e;
    }
    assert(err, 'GIF 解码不支持时必须抛错');
    assert(/不支持解码 GIF/.test(err.message), `错误信息应明确：${err.message}`);
});

test('lazy-new-from-byteslice-no-decode', () => {
    const bytes = jpegBytes(2000, 1500, 80);
    photon.__resetCodecStats();
    const img = photon.PhotonImage.new_from_byteslice(bytes);
    assertEqual(img.get_width(), 2000, 'width');
    assertEqual(img.get_height(), 1500, 'height');
    assertEqual(photon.__codecStats().decodes, 0, 'new_from_byteslice/get_width/get_height 不得解码');
    // 真正取像素时才解一次
    const px = img.get_raw_pixels();
    assertEqual(photon.__codecStats().decodes, 1, 'get_raw_pixels 应解一次');
    assert(px instanceof Uint8Array, 'get_raw_pixels 必须是 Uint8Array');
    assertEqual(px.length, 2000 * 1500 * 4, 'RGBA 长度 = w*h*4');
    img.free();
});

test('lazy-png-passthrough-no-codec', () => {
    const bytes = pngBytes(800, 600);
    photon.__resetCodecStats();
    const img = photon.PhotonImage.new_from_byteslice(bytes);
    const out = img.get_bytes();
    assertEqual(photon.__codecStats().decodes, 0, 'PNG 直通不得解码');
    assertEqual(photon.__codecStats().encodes, 0, 'PNG 直通不得编码');
    assertEqual(out.length, bytes.length, '直通返回原始字节');
    img.free();
});

test('get-bytes-png-magic', () => {
    const img = photon.PhotonImage.new_from_byteslice(jpegBytes(800, 600, 80));
    try {
        const png = img.get_bytes();
        assert(png instanceof Uint8Array, 'get_bytes 必须返回 Uint8Array');
        assertEqual(Array.from(png.subarray(0, 8)).join(','), '137,80,78,71,13,10,26,10', 'PNG 魔数');
        const info = codec.sniff(png);
        assertEqual(info.format, 'png', 'format');
        assertEqual(info.width, 800, 'width');
        assertEqual(info.height, 600, 'height');
    } finally {
        img.free();
    }
});

test('get-bytes-jpeg-magic', () => {
    const img = photon.PhotonImage.new_from_byteslice(pngBytes(800, 600));
    try {
        const jb = img.get_bytes_jpeg(80);
        assert(jb instanceof Uint8Array, 'get_bytes_jpeg 必须返回 Uint8Array');
        assertEqual(jb[0], 0xff, 'JPEG SOI 第一字节');
        assertEqual(jb[1], 0xd8, 'JPEG SOI 第二字节');
        const info = codec.sniff(jb);
        assertEqual(info.format, 'jpeg', 'format');
        assertEqual(info.width, 800, 'width');
        assertEqual(info.height, 600, 'height');
    } finally {
        img.free();
    }
});

test('resize-dims', () => {
    const img = photon.PhotonImage.new_from_byteslice(jpegBytes(2000, 1500, 80));
    try {
        const t0 = Date.now();
        const out = photon.resize(img, 640, 480, photon.SamplingFilter.Lanczos3);
        const ms = Date.now() - t0;
        assertEqual(out.get_width(), 640, 'width');
        assertEqual(out.get_height(), 480, 'height');
        assertEqual(out.get_raw_pixels().length, 640 * 480 * 4, 'RGBA 长度');
        const png = out.get_bytes();
        assertEqual(codec.sniff(png).width, 640, '编码后宽度');
        console.log(`${LOG} resize 2000x1500 → 640x480 Lanczos3 耗时 ${ms} ms`);
        out.free();
    } finally {
        img.free();
    }
});

test('resize-identity-fast-path', () => {
    const px = makeRGBA(64, 48);
    const img = new photon.PhotonImage(px, 64, 48);
    const out = photon.resize(img, 64, 48, photon.SamplingFilter.Lanczos3);
    assertEqual(out.get_width(), 64, 'width');
    assertEqual(out.get_height(), 48, 'height');
    assert(Buffer.compare(Buffer.from(out.get_raw_pixels()), Buffer.from(px)) === 0, '同尺寸必须逐像素一致');
    out.free();
    img.free();
});

test('resize-sampling-filters', () => {
    const px = makeRGBA(64, 64);
    const img = new photon.PhotonImage(px, 64, 64);
    try {
        for (const name of ['Nearest', 'Triangle', 'CatmullRom', 'Gaussian', 'Lanczos3']) {
            const filter = photon.SamplingFilter[name];
            assert(typeof filter === 'number', `SamplingFilter.${name} 必须是数字`);
            const out = photon.resize(img, 17, 13, filter);
            assertEqual(out.get_width(), 17, `${name} width`);
            assertEqual(out.get_height(), 13, `${name} height`);
            const data = out.get_raw_pixels();
            assertEqual(data.length, 17 * 13 * 4, `${name} 长度`);
            // 常量图缩放到任意尺寸都应保持常量（权重已归一化）
            out.free();
            const flat = new photon.PhotonImage(new Uint8Array(32 * 32 * 4).fill(200), 32, 32);
            const scaled = photon.resize(flat, 9, 7, filter);
            const sd = scaled.get_raw_pixels();
            let min = 255;
            let max = 0;
            for (let i = 0; i < sd.length; i++) {
                if (sd[i] < min) min = sd[i];
                if (sd[i] > max) max = sd[i];
            }
            assertEqual(min, 200, `${name} 常量图最小值（归一化权重）`);
            assertEqual(max, 200, `${name} 常量图最大值（归一化权重）`);
            scaled.free();
            flat.free();
        }
    } finally {
        img.free();
    }
});

test('resize-nearest-exact', () => {
    // 4x4 每像素 R = 索引，Nearest 缩到 2x2 必须精确取出 (1,1)(3,1)(1,3)(3,3)
    const w = 4;
    const h = 4;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4] = i;
        px[i * 4 + 3] = 255;
    }
    const img = new photon.PhotonImage(px, w, h);
    const out = photon.resize(img, 2, 2, photon.SamplingFilter.Nearest);
    const d = out.get_raw_pixels();
    const expect = [5, 7, 13, 15];
    const actual = [d[0], d[4], d[8], d[12]];
    assertEqual(actual.join(','), expect.join(','), 'Nearest 取样点');
    out.free();
    img.free();
});

test('fliph-flipv-in-place', () => {
    const w = 4;
    const h = 2;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4] = i;
        px[i * 4 + 1] = 100 + i;
        px[i * 4 + 2] = 200 + i;
        px[i * 4 + 3] = 255;
    }
    const img = new photon.PhotonImage(px, w, h);
    photon.fliph(img);
    assertEqual(
        Array.from(img.get_raw_pixels().filter((_, i) => i % 4 === 0)).join(','),
        '3,2,1,0,7,6,5,4',
        'fliph 后 R 通道顺序',
    );
    assertEqual(img.get_width(), 4, 'fliph 不改宽');
    photon.flipv(img);
    assertEqual(
        Array.from(img.get_raw_pixels().filter((_, i) => i % 4 === 0)).join(','),
        '7,6,5,4,3,2,1,0',
        'flipv 后 R 通道顺序',
    );
    // 再各做一次应回到原状
    photon.fliph(img);
    photon.flipv(img);
    assertEqual(
        Array.from(img.get_raw_pixels().filter((_, i) => i % 4 === 0)).join(','),
        '0,1,2,3,4,5,6,7',
        'fliph+flipv 复原',
    );
    img.free();
});

test('ctor-roundtrip', () => {
    const w = 32;
    const h = 16;
    const px = makeRGBA(w, h);
    const img = new photon.PhotonImage(px, w, h);
    assertEqual(img.get_width(), w, 'width');
    assertEqual(img.get_height(), h, 'height');
    const back = img.get_raw_pixels();
    assert(back instanceof Uint8Array, 'Uint8Array');
    assert(Buffer.compare(Buffer.from(back), Buffer.from(px)) === 0, '新构造实例像素往返一致');
    const png = img.get_bytes();
    assertEqual(Array.from(png.subarray(0, 4)).join(','), '137,80,78,71', 'PNG 魔数');
    img.free();
});

test('ctor-rejects-bad-pixels', () => {
    let err = null;
    try {
        // eslint-disable-next-line no-new
        new photon.PhotonImage(new Uint8Array(10), 2, 2);
    } catch (e) {
        err = e;
    }
    assert(err && /像素长度不匹配/.test(err.message), `长度不符必抛：${err && err.message}`);
});

test('free-semantics', () => {
    const img = photon.PhotonImage.new_from_byteslice(jpegBytes(800, 600, 80));
    img.get_raw_pixels();
    img.free();
    img.free(); // 幂等，不得抛
    assertEqual(img.get_width(), 800, 'free 后仍可读宽高');
    let err = null;
    try {
        img.get_raw_pixels();
    } catch (e) {
        err = e;
    }
    assert(err, 'free 后取像素必须抛错（不得静默返回脏数据）');
    assert(/free\(\)/.test(err.message), `错误信息应说明 free：${err.message}`);
});

test('decode-jpeg-2000x1500-timing', () => {
    const bytes = jpegBytes(2000, 1500, 80);
    photon.__resetCodecStats();
    const t0 = Date.now();
    const img = photon.PhotonImage.new_from_byteslice(bytes);
    const px = img.get_raw_pixels();
    const ms = Date.now() - t0;
    assertEqual(px.length, 2000 * 1500 * 4, 'RGBA 长度');
    console.log(
        `${LOG} 解码 2000x1500 JPEG 耗时 ${ms} ms（jitless=${typeof WebAssembly === 'undefined'}，${(bytes.length / 1024).toFixed(0)} KB 输入）`,
    );
    img.free();
});

/* -------------------------------------------------------------------------- */
/* 上游真实路径：image-resize-core.js（临时 node_modules 指向本垫片）            */
/* -------------------------------------------------------------------------- */

function findPiDistUtils() {
    const candidate = [];
    if (process.env.PI_DIST_UTILS) candidate.push(process.env.PI_DIST_UTILS);
    // 同工作区已知布局：<workspace>/pi-desktop-ark/payload/jitless/selftest → <workspace>/pi-desktop-hos/pi-dist/...
    candidate.push(
        path.resolve(
            HERE,
            '../../../../pi-desktop-hos/pi-dist/node_modules/@earendil-works/pi-coding-agent/dist/utils',
        ),
    );
    candidate.push(
        path.resolve(
            HERE,
            '../../../pi-desktop-hos/pi-dist/node_modules/@earendil-works/pi-coding-agent/dist/utils',
        ),
    );
    for (const dir of candidate) {
        if (fs.existsSync(path.join(dir, 'photon.js')) && fs.existsSync(path.join(dir, 'image-resize-core.js'))) {
            return dir;
        }
    }
    return null;
}

test('esm-named-exports', async () => {
    // 垫片自身被 ESM `import` 时必须给出全部 5 个具名导出
    // （cjs-module-lexer 只识别 `module.exports = { A, B }` 这类形态；`A: impl.A` 只出第一个）
    const ns = await import(pathToFileURL(path.join(JITLESS_DIR, 'photon-shim.js')).href);
    for (const name of ['PhotonImage', 'resize', 'fliph', 'flipv', 'SamplingFilter']) {
        assert(typeof ns[name] !== 'undefined', `photon-shim.js 的 ESM 命名空间缺少 ${name}`);
    }
    assertEqual(typeof ns.resize, 'function', 'resize 类型');
    assertEqual(ns.SamplingFilter.Lanczos3, 4, 'Lanczos3 数值');
});

/** 建临时树：node_modules 里的 @silvia-odwyer/photon-node 指向本垫片，utils 是 pi-dist 的副本 */
function prepareUpstreamSandbox(piUtils) {
    const base = process.env.PI_SCRATCH_DIR || os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'jitless-photon-selftest-'));
    const pkgDir = path.join(root, 'node_modules', '@silvia-odwyer', 'photon-node');
    const utilsDir = path.join(root, 'utils');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });

    fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
            { name: '@silvia-odwyer/photon-node', version: '0.0.0-jitless-shim', main: 'index.cjs' },
            null,
            2,
        ),
    );
    // 条件入口的等价物：显式具名再导出（与组装期生成的 pi-jitless-entry.cjs 同形）
    const shimPath = path.join(JITLESS_DIR, 'photon-shim.js').split(path.sep).join('/');
    fs.writeFileSync(
        path.join(pkgDir, 'index.cjs'),
        [
            "'use strict';",
            '// selftest 临时条件入口：只把本垫片的具名导出显式再导出，',
            '// 保证 `import("@silvia-odwyer/photon-node")` 拿到完整命名空间（不是只有 default）。',
            `const impl = require(${JSON.stringify(shimPath)});`,
            'const { PhotonImage, resize, fliph, flipv, SamplingFilter } = impl;',
            'module.exports = { PhotonImage, resize, fliph, flipv, SamplingFilter };',
            '',
        ].join('\n'),
    );
    for (const file of ['photon.js', 'image-resize-core.js', 'exif-orientation.js']) {
        fs.copyFileSync(path.join(piUtils, file), path.join(utilsDir, file));
    }
    return root;
}

test('upstream-image-resize-core', async () => {
    const piUtils = findPiDistUtils();
    if (!piUtils) {
        throw new Error('SKIP: 找不到 pi-dist 的 utils 目录（可用 PI_DIST_UTILS 指定）');
    }
    const root = prepareUpstreamSandbox(piUtils);
    try {
        const mod = await import(pathToFileURL(path.join(root, 'utils', 'image-resize-core.js')).href);

        // 0) ESM 具名导出面：上游用 `await import("@silvia-odwyer/photon-node")`，
        //    命名空间必须包含全部 5 个名字（cjs-module-lexer 只认特定赋值形态）。
        const photonMod = await import(pathToFileURL(path.join(root, 'utils', 'photon.js')).href);
        const loaded = await photonMod.loadPhoton();
        assert(loaded, 'loadPhoton() 必须拿到垫片（拿不到说明条件入口/导出面有问题）');
        for (const name of ['PhotonImage', 'resize', 'fliph', 'flipv', 'SamplingFilter']) {
            assert(typeof loaded[name] !== 'undefined', `ESM 命名空间缺少 ${name}`);
        }
        assertEqual(loaded.SamplingFilter.Lanczos3, photon.SamplingFilter.Lanczos3, 'SamplingFilter.Lanczos3');
        // 1) 已达标：800x600 JPEG + base64 < 4.5MB ⇒ 原样返回（wasResized:false），且**一次解码都不发生**
        const smallJpeg = jpegBytes(800, 600, 80);
        photon.__resetCodecStats();
        const r1 = await mod.resizeImageInProcess(smallJpeg, 'image/jpeg', {});
        assert(r1, 'upstream 800x600 JPEG 不应返回 null');
        assertEqual(r1.wasResized, false, '800x600 应判为无需缩放');
        assertEqual(r1.width, 800, 'width');
        assertEqual(r1.height, 600, 'height');
        assertEqual(r1.originalWidth, 800, 'originalWidth');
        assertEqual(r1.originalHeight, 600, 'originalHeight');
        assertEqual(r1.mimeType, 'image/jpeg', 'mimeType 原样');
        assertEqual(r1.data, Buffer.from(smallJpeg).toString('base64'), 'data 应为原始字节的 base64');
        assertEqual(photon.__codecStats().decodes, 0, '零解码早退路径不得解码（惰性解码的核心收益）');
        console.log(`${LOG} upstream 800x600 JPEG：wasResized=false，解码次数=${photon.__codecStats().decodes}`);

        // 2) 超限：2000x1500 PNG，限制 800x600 ⇒ 必须缩放并重新编码
        const bigPng = pngBytes(2000, 1500);
        photon.__resetCodecStats();
        const r2 = await mod.resizeImageInProcess(bigPng, 'image/png', { maxWidth: 800, maxHeight: 600 });
        assert(r2, 'upstream 2000x1500 PNG 不应返回 null（缩放路径失败会被 catch 成 null）');
        assertEqual(r2.wasResized, true, '2000x1500 应判为需要缩放');
        assertEqual(r2.originalWidth, 2000, 'originalWidth');
        assertEqual(r2.originalHeight, 1500, 'originalHeight');
        assertEqual(r2.width, 800, 'width');
        assertEqual(r2.height, 600, 'height');
        assert(photon.__codecStats().decodes >= 1, '缩放路径必须解码一次');
        const outBytes = Buffer.from(r2.data, 'base64');
        const info = codec.sniff(new Uint8Array(outBytes));
        assertEqual(info.width, 800, '输出宽度');
        assertEqual(info.height, 600, '输出高度');
        assert(info.format === 'png' || info.format === 'jpeg', `输出格式应可被识别：${info.format}`);
        console.log(
            `${LOG} upstream 2000x1500 PNG：wasResized=true，输出 ${info.width}x${info.height} ${info.format}，解码次数=${photon.__codecStats().decodes}`,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* 跑                                                                          */

/** 带 EXIF orientation 的 JPEG（jpeg-js 的 exifBuffer 会原样写进 APP1，需自带 "Exif\0\0" 头） */
function orientationJpeg(w, h, orientation) {
    const tiff = Buffer.alloc(26);
    tiff[0] = 0x49; // 'II' 小端
    tiff[1] = 0x49;
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4); // 第一个 IFD 偏移
    tiff.writeUInt16LE(1, 8); // 条目数
    tiff.writeUInt16LE(0x0112, 10); // tag = Orientation
    tiff.writeUInt16LE(3, 12); // type = SHORT
    tiff.writeUInt32LE(1, 14); // count
    tiff.writeUInt16LE(orientation, 18); // value
    tiff.writeUInt32LE(0, 22); // 下一个 IFD
    const exifBuffer = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const out = jpeg.encode({ data: makeRGBA(w, h), width: w, height: h, exifBuffer }, 80);
    return new Uint8Array(out.data);
}

test('exif-orientation-6-via-upstream', async () => {
    const piUtils = findPiDistUtils();
    if (!piUtils) {
        throw new Error('SKIP: 找不到 pi-dist 的 utils 目录（可用 PI_DIST_UTILS 指定）');
    }
    const root = prepareUpstreamSandbox(piUtils);
    try {
        const mod = await import(pathToFileURL(path.join(root, 'utils', 'exif-orientation.js')).href);
        // 2x3 图，R 通道 = 线性索引；orientation 6（顺时针 90°）⇒ 3x2，且像素按 rotate90 规则重排
        const w = 2;
        const h = 3;
        const raw = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            raw[i * 4] = i;
            raw[i * 4 + 3] = 255;
        }
        const bytes = orientationJpeg(8, 8, 6);
        const img = new photon.PhotonImage(raw, w, h);
        const rotated = mod.applyExifOrientation(photon, img, bytes);
        assert(rotated !== img, 'orientation 6 必须返回新图');
        assertEqual(rotated.get_width(), 3, '旋转后宽度 = 原高度');
        assertEqual(rotated.get_height(), 2, '旋转后高度 = 原宽度');
        const px = rotated.get_raw_pixels();
        assert(px instanceof Uint8Array, 'get_raw_pixels 必须是 Uint8Array');
        assertEqual(px.length, 3 * 2 * 4, 'RGBA 长度 = 新宽*新高*4');
        assertEqual(
            Array.from(px.filter((_, i) => i % 4 === 0)).join(','),
            '4,2,0,5,3,1',
            'rotate90（orientation 6）像素顺序',
        );
        rotated.free();
        img.free();

        // orientation 3 = fliph + flipv（原地），尺寸不变
        const raw2 = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            raw2[i * 4] = i;
            raw2[i * 4 + 3] = 255;
        }
        const img2 = new photon.PhotonImage(raw2, w, h);
        const same = mod.applyExifOrientation(photon, img2, orientationJpeg(8, 8, 3));
        assert(same === img2, 'orientation 3 必须原地返回同一实例');
        assertEqual(
            Array.from(same.get_raw_pixels().filter((_, i) => i % 4 === 0)).join(','),
            '5,4,3,2,1,0',
            'fliph+flipv（orientation 3）像素顺序',
        );
        img2.free();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
/* -------------------------------------------------------------------------- */

function parseOnly(argv) {
    const arg = argv.find((a) => a.startsWith('--only='));
    if (!arg) return null;
    const names = arg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return names.length ? names : null;
}

const only = parseOnly(process.argv.slice(2));
const selected = only ? tests.filter((t) => only.some((n) => t.name === n || t.name.startsWith(n))) : tests;

console.log(
    `${LOG} 开始：${selected.length}/${tests.length} 个用例，WebAssembly=${typeof WebAssembly}（undefined ⇒ compat 形态）`,
);
if (only && selected.length === 0) {
    console.error(`${LOG} --only 没有匹配到任何用例：${only.join(',')}`);
    process.exit(2);
}

let failed = 0;
let skipped = 0;
const failures = [];
const tAll = Date.now();
for (const t of selected) {
    const t0 = Date.now();
    try {
        await t.fn();
        console.log(`PASS ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (/^SKIP:/.test(msg)) {
            skipped++;
            console.log(`SKIP ${t.name}：${msg.replace(/^SKIP:\s*/, '')}`);
            continue;
        }
        failed++;
        failures.push({ name: t.name, msg });
        console.log(`FAIL ${t.name}：${msg}`);
        if (process.env.PI_JITLESS_SELFTEST_VERBOSE === '1' && e && e.stack) console.error(e.stack);
    }
}

console.log(
    `${LOG} 结束：${selected.length - failed - skipped} 通过 / ${failed} 失败 / ${skipped} 跳过，总耗时 ${Date.now() - tAll} ms`,
);
if (failed) {
    for (const f of failures) console.error(`${LOG} FAILED ${f.name}: ${f.msg}`);
    process.exit(1);
}
process.exit(0);
