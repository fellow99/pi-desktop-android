'use strict';
/**
 * photon-shim.js —— `@silvia-odwyer/photon-node` 的纯 JS 同步替身（compat 形态）
 *
 * 只在 `typeof WebAssembly === 'undefined'`（Node `--jitless`）时由条件入口选中；
 * jit 形态下不得被加载（NFR-108-001）。
 *
 * 上游真实调用面（逐字对齐，见 pi-dist/.../utils/）：
 *   photon.js:            `await import("@silvia-odwyer/photon-node")`
 *   image-convert.js:     `PhotonImage.new_from_byteslice(bytes)` → `get_bytes()` → `free()`
 *   image-resize-core.js: `new_from_byteslice` → `applyExifOrientation` → `get_width()/get_height()`
 *                         → `resize(image, w, h, SamplingFilter.Lanczos3)`
 *                         → `get_bytes()` / `get_bytes_jpeg(q)` → `free()`
 *   exif-orientation.js:  `get_raw_pixels()`（RGBA / Uint8Array / 长度 = w*h*4）、
 *                         `new PhotonImage(raw, w, h)`、`fliph(image)`、`flipv(image)`（**原地**）
 *
 * 两条关键设计：
 *   1. **惰性解码**：`new_from_byteslice()` 只解析文件头取宽高。上游在"尺寸与体积已达标"时直接
 *      返回原始字节（image-resize-core.js:63-71），常用路径一次解码都不发生。
 *   2. **零多余拷贝**：编码字节按引用保存（调用方本来就持有）；`get_raw_pixels()` 返回内部数组；
 *      `resize()` 在目标尺寸等于源尺寸时走"整块复制"快路径（上游尺寸未超限、仅体积超限时就是这种）。
 *
 * free() 语义：释放 `_rgba` 与 `_bytes`（置 null）。之后任何取像素/编码/缩放操作都会抛
 * 明确错误（上游所有 free() 都是 finally 里的最后一次使用，不存在 free 后复用）。
 */

const codec = require('./image-codec');

const LOG_PREFIX = '[jitless:photon]';
const DEBUG = process.env.PI_JITLESS_PHOTON_DEBUG === '1';

function log(...args) {
    if (DEBUG) console.error(LOG_PREFIX, ...args);
}

/** 与 photon 的枚举同名（数值只在本垫片内部使用） */
const SamplingFilter = Object.freeze({
    Nearest: 0,
    Triangle: 1,
    CatmullRom: 2,
    Gaussian: 3,
    Lanczos3: 4,
});

/* -------------------------------------------------------------------------- */
/* 重采样核                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 各核的半径与核函数（x 为以"源像素"为单位、已按缩放比归一化的距离）。
 * 非 Lanczos3 的核都按标准窗口实现，成本与 Lanczos3 同阶（都是可分离卷积、定点窗口）。
 */
const KERNELS = {
    [SamplingFilter.Nearest]: null, // 单独快路径
    [SamplingFilter.Triangle]: {
        radius: 1,
        fn: (x) => {
            const ax = x < 0 ? -x : x;
            return ax < 1 ? 1 - ax : 0;
        },
    },
    [SamplingFilter.CatmullRom]: {
        radius: 2,
        // Catmull-Rom（B=0, C=0.5）
        fn: (x) => {
            const ax = x < 0 ? -x : x;
            if (ax < 1) return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1;
            if (ax < 2) return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4 * ax + 2;
            return 0;
        },
    },
    [SamplingFilter.Gaussian]: {
        radius: 2,
        // sigma=0.5（与 Rust image crate 的 Gaussian 同参数），窗口截断在 4σ
        fn: (x) => Math.exp(-(x * x) / (2 * 0.5 * 0.5)),
    },
    [SamplingFilter.Lanczos3]: {
        radius: 3,
        fn: (x) => {
            const ax = x < 0 ? -x : x;
            if (ax < 1e-8) return 1;
            if (ax >= 3) return 0;
            const px = Math.PI * ax;
            return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
        },
    },
};

/** 核表是否认识该 enum 值（Nearest 的核为 null，必须用 ownProperty 判定） */
function isKnownFilter(filter) {
    return Object.prototype.hasOwnProperty.call(KERNELS, filter);
}

/**
 * 预计算一维权重表。下采样时按 scale 展宽核窗口（避免混叠）；边界用 clamp
 * （窗口截到 [0, size-1] 后重新归一化，等价于边缘复制）。
 * @returns {{offsets: Int32Array, indices: Int32Array, weights: Float32Array}}
 */
function buildWeights(srcSize, dstSize, filter) {
    const kernel = isKnownFilter(filter) ? KERNELS[filter] : KERNELS[SamplingFilter.Lanczos3];
    const scale = srcSize / dstSize;
    const filterScale = scale > 1 ? scale : 1;
    const radius = kernel.radius * filterScale;
    const offsets = new Int32Array(dstSize + 1);
    const idxChunks = [];
    const wChunks = [];
    let total = 0;
    for (let i = 0; i < dstSize; i++) {
        const center = (i + 0.5) * scale - 0.5;
        let left = Math.ceil(center - radius);
        let right = Math.floor(center + radius);
        if (left < 0) left = 0;
        if (right > srcSize - 1) right = srcSize - 1;
        const idx = [];
        const wts = [];
        let sum = 0;
        for (let j = left; j <= right; j++) {
            const w = kernel.fn((j - center) / filterScale);
            if (w === 0) continue;
            idx.push(j);
            wts.push(w);
            sum += w;
        }
        if (sum === 0) {
            // 退化保护：最近像素
            const j = Math.min(srcSize - 1, Math.max(0, Math.round(center)));
            idx.push(j);
            wts.push(1);
            sum = 1;
        }
        const inv = 1 / sum;
        for (let k = 0; k < wts.length; k++) wts[k] *= inv;
        idxChunks.push(idx);
        wChunks.push(wts);
        offsets[i] = total;
        total += wts.length;
    }
    offsets[dstSize] = total;
    const indices = new Int32Array(total);
    const weights = new Float32Array(total);
    let p = 0;
    for (let i = 0; i < dstSize; i++) {
        const idx = idxChunks[i];
        const wts = wChunks[i];
        for (let k = 0; k < wts.length; k++) {
            indices[p] = idx[k];
            weights[p] = wts[k];
            p++;
        }
    }
    return { offsets, indices, weights };
}

/** 最近邻（整条快路径，独立实现，避免核函数开销） */
function resampleNearest(src, srcW, srcH, dstW, dstH) {
    const out = new Uint8Array(dstW * dstH * 4);
    const xMap = new Int32Array(dstW);
    const sx = srcW / dstW;
    for (let x = 0; x < dstW; x++) {
        let sx0 = Math.floor((x + 0.5) * sx);
        if (sx0 > srcW - 1) sx0 = srcW - 1;
        if (sx0 < 0) sx0 = 0;
        xMap[x] = sx0 * 4;
    }
    const sy = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
        let sy0 = Math.floor((y + 0.5) * sy);
        if (sy0 > srcH - 1) sy0 = srcH - 1;
        if (sy0 < 0) sy0 = 0;
        const rowIn = sy0 * srcW * 4;
        const rowOut = y * dstW * 4;
        for (let x = 0; x < dstW; x++) {
            const p = rowIn + xMap[x];
            const o = rowOut + x * 4;
            out[o] = src[p];
            out[o + 1] = src[p + 1];
            out[o + 2] = src[p + 2];
            out[o + 3] = src[p + 3];
        }
    }
    return out;
}

/** 水平卷积：src(srcW×srcH) → dst(dstW×srcH) */
function passHorizontal(src, srcW, srcH, dstW, w) {
    const dst = new Uint8ClampedArray(dstW * srcH * 4);
    const { offsets, indices, weights } = w;
    for (let y = 0; y < srcH; y++) {
        const rowIn = y * srcW * 4;
        const rowOut = y * dstW * 4;
        for (let i = 0; i < dstW; i++) {
            const start = offsets[i];
            const end = offsets[i + 1];
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = start; k < end; k++) {
                const wt = weights[k];
                const p = rowIn + indices[k] * 4;
                r += src[p] * wt;
                g += src[p + 1] * wt;
                b += src[p + 2] * wt;
                a += src[p + 3] * wt;
            }
            const o = rowOut + i * 4;
            dst[o] = r;
            dst[o + 1] = g;
            dst[o + 2] = b;
            dst[o + 3] = a;
        }
    }
    return dst;
}

/**
 * 垂直卷积：src(w×srcH) → dst(w×dstH)。
 * 按"核 tap 外层、行内顺序累加"实现：读连续、索引乘法只在 tap 级做一次，
 * 解释器（--jitless）下明显快于"按像素反查 tap"。
 */
function passVertical(src, w, srcH, dstH, v) {
    const dst = new Uint8ClampedArray(w * dstH * 4);
    const { offsets, indices, weights } = v;
    const rowBytes = w * 4;
    const acc = new Float32Array(rowBytes);
    for (let y = 0; y < dstH; y++) {
        const start = offsets[y];
        const end = offsets[y + 1];
        acc.fill(0);
        for (let k = start; k < end; k++) {
            const wt = weights[k];
            const srcOff = indices[k] * rowBytes;
            for (let i = 0; i < rowBytes; i++) {
                acc[i] += src[srcOff + i] * wt;
            }
        }
        const rowOut = y * rowBytes;
        for (let i = 0; i < rowBytes; i++) {
            dst[rowOut + i] = acc[i];
        }
    }
    return dst;
}

/**
 * 可分离卷积重采样（RGBA 直通，alpha 与颜色一起重采样 —— 与 photon 的 Lanczos3 行为一致，
 * 不做预乘）。
 */
function resample(src, srcW, srcH, dstW, dstH, filter) {
    const effective = isKnownFilter(filter) ? filter : SamplingFilter.Lanczos3;
    if (effective === SamplingFilter.Nearest) {
        return resampleNearest(src, srcW, srcH, dstW, dstH);
    }
    const wx = buildWeights(srcW, dstW, effective);
    const wv = buildWeights(srcH, dstH, effective);
    // 先做"中间图更小"的那一趟，省内存
    if (dstW * srcH <= srcW * dstH) {
        return passVertical(passHorizontal(src, srcW, srcH, dstW, wx), dstW, srcH, dstH, wv);
    }
    return passHorizontal(passVertical(src, srcW, srcH, dstH, wv), srcW, dstH, dstW, wx);
}

/* -------------------------------------------------------------------------- */
/* PhotonImage                                                                 */
/* -------------------------------------------------------------------------- */

class PhotonImage {
    /**
     * `new PhotonImage(rawRGBA, width, height)` —— 直接用像素构造（上游 exif-orientation.js:121）。
     * 像素按引用持有（不拷贝）；长度必须 = width*height*4。
     */
    constructor(rawRGBA, width, height) {
        const w = width | 0;
        const h = height | 0;
        if (!(rawRGBA instanceof Uint8Array) && !ArrayBuffer.isView(rawRGBA)) {
            throw new Error(`${LOG_PREFIX} PhotonImage 构造需要 RGBA 像素（Uint8Array），收到 ${typeof rawRGBA}`);
        }
        if (w <= 0 || h <= 0) {
            throw new Error(`${LOG_PREFIX} PhotonImage 构造需要正数宽高，收到 ${width}x${height}`);
        }
        const expected = w * h * 4;
        if (rawRGBA.length !== expected) {
            throw new Error(
                `${LOG_PREFIX} PhotonImage 像素长度不匹配：需要 ${expected} 字节（w*h*4），实际 ${rawRGBA.length}`,
            );
        }
        this._rgba = rawRGBA;
        this._bytes = null;
        this._width = w;
        this._height = h;
        this._format = 'raw';
        this._freed = false;
        this._source = null;
    }

    /** 内部：从编码字节构造（惰性，不解析像素） */
    static _fromEncoded(bytes, info, source) {
        const img = Object.create(PhotonImage.prototype);
        img._rgba = null;
        img._bytes = bytes;
        img._width = info.width;
        img._height = info.height;
        img._format = info.format;
        img._freed = false;
        /** 诊断用来源标记（selftest 断言"没解码"时用不到，这里只留痕） */
        img._source = source || null;
        return img;
    }

    /**
     * 上游主入口：只解析文件头拿宽高，**不解码像素**。
     * 无法解析尺寸时抛明确错误（上游 catch 后转成用户可见提示）。
     */
    static new_from_byteslice(bytes) {
        if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) {
            throw new Error(`${LOG_PREFIX} new_from_byteslice 需要 Uint8Array/Buffer/ArrayBuffer`);
        }
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
        const info = codec.sniff(u8); // 仅头部；GIF/WebP 也能取宽高
        log(`new_from_byteslice：${info.format} ${info.width}x${info.height}（仅解析头部，未解码）`);
        return PhotonImage._fromEncoded(u8, info, 'byteslice');
    }

    /** 惰性解码：确定需要像素时才解 */
    _ensurePixels() {
        if (this._rgba) return this._rgba;
        if (this._freed || !this._bytes) {
            throw new Error(
                `${LOG_PREFIX} 图像已 free()，无法再取像素（上游不应在 free 后使用；请重新 new_from_byteslice）`,
            );
        }
        const decoded = codec.decodeToRGBA(this._bytes);
        if (decoded.width !== this._width || decoded.height !== this._height) {
            log(`头部宽高 ${this._width}x${this._height} 与解码结果 ${decoded.width}x${decoded.height} 不一致，改用解码结果`);
        }
        this._rgba = decoded.data;
        this._width = decoded.width;
        this._height = decoded.height;
        return this._rgba;
    }

    get_width() {
        return this._width;
    }

    get_height() {
        return this._height;
    }

    /** RGBA / Uint8Array / 长度 = w*h*4（按引用返回，不拷贝） */
    get_raw_pixels() {
        const px = this._ensurePixels();
        if (!(px instanceof Uint8Array) || px.length !== this._width * this._height * 4) {
            throw new Error(`${LOG_PREFIX} get_raw_pixels 内部错误：像素形状异常`);
        }
        return px;
    }

    /**
     * PNG 字节。若源本身就是未被动过的 PNG，直接返回原始字节（零解码零编码）——
     * 上游 image-convert 的"转 PNG"路径因此几乎免费。
     */
    get_bytes() {
        if (!this._rgba && !this._freed && this._format === 'png' && this._bytes) {
            log('get_bytes：源已是 PNG 且未修改，直接返回原始字节');
            return this._bytes;
        }
        const px = this._ensurePixels();
        return codec.encodePNG(px, this._width, this._height);
    }

    /** JPEG 字节（quality 缺省 80，与上游 DEFAULT_OPTIONS.jpegQuality 一致） */
    get_bytes_jpeg(quality) {
        const px = this._ensurePixels();
        return codec.encodeJPEG(px, this._width, this._height, quality === undefined ? 80 : quality);
    }

    /** 释放像素与源字节（幂等） */
    free() {
        this._rgba = null;
        this._bytes = null;
        this._freed = true;
        this._source = null;
    }
}

/* -------------------------------------------------------------------------- */
/* 顶层函数（上游按 photon.resize / photon.fliph / photon.flipv 调用）           */
/* -------------------------------------------------------------------------- */

function assertImage(image, api) {
    if (!image || typeof image.get_width !== 'function' || typeof image.get_height !== 'function') {
        throw new Error(`${LOG_PREFIX} ${api} 需要 PhotonImage`);
    }
}

/**
 * 缩放/重采样，返回**新的** PhotonImage（源图不受影响，上游会复用源图多轮）。
 * 目标尺寸与源尺寸相同时走整块复制快路径（上游"仅体积超限"时就是这种情况）。
 */
function resize(image, width, height, filter) {
    assertImage(image, 'resize');
    const dw = Math.max(1, Math.round(width));
    const dh = Math.max(1, Math.round(height));
    const src = image.get_raw_pixels();
    const sw = image.get_width();
    const sh = image.get_height();
    if (dw === sw && dh === sh) {
        log(`resize ${sw}x${sh} → 同尺寸，走复制快路径`);
        return new PhotonImage(new Uint8Array(src), dw, dh);
    }
    const t0 = Date.now();
    const out = resample(src, sw, sh, dw, dh, filter);
    const ms = Date.now() - t0;
    if (DEBUG) {
        log(`resize ${sw}x${sh} → ${dw}x${dh}（filter=${filter}）耗时 ${ms} ms`);
    } else if (ms > 2000) {
        console.error(`${LOG_PREFIX} resize ${sw}x${sh} → ${dw}x${dh} 耗时 ${ms} ms（--jitless 慢）`);
    }
    // 两趟卷积用 Uint8ClampedArray 做中间/输出（写入即自动钳位取整）；这里换成
    // Uint8Array 视图（共享同一 buffer，零拷贝），因为上游按 Uint8Array 判类型。
    const out8 =
        out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    return new PhotonImage(out8, dw, dh);
}

/** 水平翻转（**原地**改像素，返回 undefined —— 与上游用例一致） */
function fliph(image) {
    assertImage(image, 'fliph');
    const px = image.get_raw_pixels();
    const w = image.get_width();
    const h = image.get_height();
    const half = w >> 1;
    for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < half; x++) {
            const a = row + x * 4;
            const b = row + (w - 1 - x) * 4;
            for (let c = 0; c < 4; c++) {
                const t = px[a + c];
                px[a + c] = px[b + c];
                px[b + c] = t;
            }
        }
    }
}

/** 垂直翻转（**原地**改像素） */
function flipv(image) {
    assertImage(image, 'flipv');
    const px = image.get_raw_pixels();
    const w = image.get_width();
    const h = image.get_height();
    const rowBytes = w * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < (h >> 1); y++) {
        const top = y * rowBytes;
        const bottom = (h - 1 - y) * rowBytes;
        tmp.set(px.subarray(top, top + rowBytes));
        px.copyWithin(top, bottom, bottom + rowBytes);
        px.set(tmp, bottom);
    }
}

module.exports = {
    PhotonImage,
    resize,
    fliph,
    flipv,
    SamplingFilter,
    // 诊断/selftest 用（不属上游面）
    __codecStats: codec.getStats,
    __resetCodecStats: codec.resetStats,
    __sniff: codec.sniff,
};
