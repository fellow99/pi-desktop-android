/* polyfill-webview.js —— 旧版 Android System WebView（Chrome <98）兼容垫片。
 *
 * 为什么需要：部分真机的系统 WebView 停在出厂旧版（实测 Xiaomi M2105K81C / Android 11 =
 * Chrome 94.0.4606.85，且设备只有这一个 WebView 实现、无法切换）。pi-web 的构建目标是
 * chrome 111，业务/依赖里少量 ES2022 API 未被 Next 转译，运行到对应渲染路径时在 React
 * 渲染期抛 TypeError（如 message-display.ts 的 Array.prototype.findLastIndex），未被
 * 错误边界捕获 ⇒ 触发 Next global-error「This page couldn't load」整页崩溃
 * （2026-10-29 真机：回答完成后渲染消息列表即必现）。
 *
 * 注入时机：MainActivity 的 WebViewClient.onPageStarted（页面任何脚本执行之前），
 * 经 evaluateJavascript 同步注入，故对后续所有 chunk 全局生效。
 *
 * 纪律：只补「缺失」的（if 存在绝不覆盖，避免改变新 WebView 行为）；
 *      仅补本工程实测用到的稳定 ES2022 方法，不引第三方 core-js（载荷体积/供给纪律）。
 * 对照（Chrome 94）：Object.hasOwn=93 ✅ / Array.at=92 ✅；findLast(Index)=97、
 * structuredClone=98、AbortSignal.throwIfAborted=103 才有，均在此补齐。
 */
(function () {
  "use strict";

  // ── Array.prototype.findLast / findLastIndex（Chrome 97+，ES2023）──────────────
  // 规范等价实现：从末尾向首枚举 own index，跳过空洞（HasProperty 判定）。
  function installArrayLast(name, returnIndex) {
    if (typeof Array.prototype[name] === "function") return;
    Object.defineProperty(Array.prototype, name, {
      configurable: true,
      writable: true,
      value: function (predicate /*, thisArg */) {
        if (this == null) throw new TypeError("Array.prototype." + name + " called on null/undefined");
        if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
        var o = Object(this);
        var len = o.length >>> 0;
        var thisArg = arguments.length > 1 ? arguments[1] : undefined;
        for (var k = len - 1; k >= 0; k--) {
          if (k in o) {
            var value = o[k];
            if (predicate.call(thisArg, value, k, o)) return returnIndex ? k : value;
          }
        }
        return returnIndex ? -1 : undefined;
      },
    });
  }
  installArrayLast("findLast", false);
  installArrayLast("findLastIndex", true);

  // ── TypedArray 同名方法（Chrome 97+）：同形补齐，覆盖可能的二进制路径 ──────────
  if (typeof Uint8Array === "function") {
    [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
     Int32Array, Uint32Array, Float32Array, Float64Array].forEach(function (TA) {
      if (!TA || typeof TA.prototype.findLast === "function") return;
      Object.defineProperty(TA.prototype, "findLast", {
        configurable: true, writable: true,
        value: Array.prototype.findLast,
      });
      Object.defineProperty(TA.prototype, "findLastIndex", {
        configurable: true, writable: true,
        value: Array.prototype.findLastIndex,
      });
    });
  }

  // ── AbortSignal.prototype.throwIfAborted（Chrome 103+）────────────────────
  // pi-web 客户端 page chunk 在 fetch 后调用 `signal?.throwIfAborted()`；Chrome 94
  // 无此方法 ⇒ 首页模型目录拉取抛 TypeError，UI 显「模型错误 e?.throwIfAborted is
  // not a function」且选择器显 No models（curl 同接口正常，可证明是浏览器端缺失）。
  // WHATWG 规范等价：aborted 时抛 name=AbortError 的 DOMException。服务端 Node
  // 垫片（pi-web-launch.js）与之同名但各自注入。
  if (typeof AbortSignal !== "undefined"
      && typeof AbortSignal.prototype.throwIfAborted !== "function") {
    Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
      configurable: true,
      writable: true,
      value: function throwIfAborted() {
        if (this != null && this.aborted) {
          var err = new DOMException("The operation was aborted.", "AbortError");
          err.code = 20;
          throw err;
        }
      },
    });
  }

  // ── AbortSignal.timeout（Chrome 103+，静态方法）────────────────────────────
  // pi-web 客户端终端通道用 fetch(url,{signal: AbortSignal.timeout(15000)})；Chrome 94
  // 无此静态方法 ⇒ 打开终端报「AbortSignal.timeout is not a function」。
  // 规范等价：返回一个 ms 后自动 abort（reason 为 TimeoutError）的 signal。
  if (typeof AbortSignal !== "undefined"
      && typeof AbortSignal.timeout !== "function") {
    AbortSignal.timeout = function timeout(ms) {
      var controller = new AbortController();
      var signal = controller.signal;
      var id = setTimeout(function () {
        // 优先用原生 timeout reason（新版 WebView 可能有 timeout 但静态方法缺，几乎不会）；
        // 否则按规范构造 name=TimeoutError 的 DOMException。
        var reason;
        try {
          reason = new DOMException("The operation timed out.", "TimeoutError");
        } catch (_) {
          reason = new Error("The operation timed out.");
          reason.name = "TimeoutError";
        }
        controller.abort(reason);
      }, ms);
      // 允许进程退出/页面卸载时不被定时器挂住（Node 语义；浏览器 unref 不存在则忽略）
      try { if (typeof id.unref === "function") id.unref(); } catch (_) {}
      return signal;
    };
  }

  // ── structuredClone（Chrome 98+）：结构化克隆的常用子集（JSON 可表达类型）──────
  // pi-web 载荷内用法为普通对象/数组/原始值的深拷贝；JSON 通道无法表达
  // Date/Map/Set/ArrayBuffer，这里实现一个支持这些类型的递归克隆，函数/DOM 节点等
  // 不可结构化克隆的类型按规范抛 DataCloneError。
  if (typeof globalThis.structuredClone !== "function") {
    function clone(value, seen) {
      // 原始值与函数外的 null
      if (value === null || typeof value !== "object") {
        if (typeof value === "function") {
          throw new DOMException("The object could not be cloned.", "DataCloneError");
        }
        return value;
      }
      if (seen.has(value)) throw new DOMException("An object could not be cloned (cycle).", "DataCloneError");

      // 内建类型
      if (value instanceof Date) return new Date(value.getTime());
      if (value instanceof RegExp) return new RegExp(value.source, value.flags);
      if (value instanceof ArrayBuffer) {
        var copy = value.slice(0);
        seen.set(value, copy);
        return copy;
      }
      if (typeof ArrayBuffer === "function" && ArrayBuffer.isView(value)) {
        // TypedArray / DataView
        var bufferCopy = clone(value.buffer, seen);
        if (value instanceof DataView) {
          return new DataView(bufferCopy, value.byteOffset, value.byteLength);
        }
        return new value.constructor(bufferCopy, value.byteOffset, value.length);
      }
      if (value instanceof Map) {
        var mapCopy = new Map();
        seen.set(value, mapCopy);
        value.forEach(function (v, k) { mapCopy.set(clone(k, seen), clone(v, seen)); });
        return mapCopy;
      }
      if (value instanceof Set) {
        var setCopy = new Set();
        seen.set(value, setCopy);
        value.forEach(function (v) { setCopy.add(clone(v, seen)); });
        return setCopy;
      }

      // 普通对象 / 数组（含类数组）
      seen.set(value, undefined);
      var isArray = Array.isArray(value);
      var target = isArray ? new Array(value.length) : {};
      seen.set(value, target);
      var keys = isArray ? value.map(function (_, i) { return i; }) : Object.keys(value);
      keys.forEach(function (key) {
        target[key] = clone(value[key], seen);
      });
      return target;
    }
    globalThis.structuredClone = function structuredClone(value /*, options */) {
      return clone(value, new Map());
    };
  }

  // ── 动态视口单位 dvh（Chrome 108+）兼容 ────────────────────────────────────
  // pi-web 主布局用 height:var(--app-viewport-height, 100dvh)。Chrome 94 不认识 dvh，
  // 整条声明被丢弃 ⇒ html/body/侧栏/右栏高度塌陷，表现为「侧栏底部工具栏不贴底、
  // 内容不充满」（设置弹窗用固定布局所以几乎满屏，形成反差）。
  // 策略：特性检测，不支持 dvh 才激活——
  //   1) 给 --app-viewport-height 设为实时 innerHeight(px)（主布局全部走该变量）；
  //   2) 注入高优先级样式，把硬编码 dvh 的少数选择器换算成 px（1dvh=1%视口高）；
  //   3) resize / 旋转重新同步。支持 dvh 的新内核绝不执行，保持上游原生行为。
  (function installDvhPolyfill() {
    var probe = document.createElement("div");
    probe.style.width = "100dvh";
    // 不支持 dvh 时赋值后 width 被清空
    if (probe.style.width) return;

    function inject() {
      var h = window.innerHeight;
      var style = document.getElementById("__pi_dvh_overrides__");
      if (!style) {
        style = document.createElement("style");
        style.id = "__pi_dvh_overrides__";
        (document.head || document.documentElement).appendChild(style);
      }
      // 直接以 px !important 固定主布局高度：上游 React 在键盘关闭时会 removeProperty
      // (--app-viewport-height)，改 CSS 变量会被它清掉；这里写独立规则它不会触碰。
      style.textContent =
        "html,body{height:" + h + "px !important;}" +
        ".sidebar-container,.right-panel-container,.sidebar-sheet-layer{height:" + h + "px !important;}" +
        ".sidebar-sheet{max-height:calc(" + h + "px - 48px) !important;}" +
        ".sidebar-menu{max-height:min(calc(" + h + "px - 16px),480px) !important;}" +
        // 硬编码 dvh 的少数弹窗（% 以包含块高度解析，近似等价）
        ".config-panel-root.is-modal > .config-panel-surface { height: calc(100% - 16px) !important; }" +
        ".settings-dialog-surface { max-height: calc(100% - 16px) !important; height: calc(100% - 12px) !important; }" +
        ".mcp-config-notices { max-height: 30% !important; }" +
        ".image-preview-dialog, .mermaid-zoom-dialog { height: 100% !important; }" +
        ".extension-widget-panels, .extension-status-line { max-height: min(144px, 18%) !important; }" +
        ".mermaid-preview-button { max-height: min(600px, 60%) !important; }";
    }

    window.addEventListener("resize", function () { requestAnimationFrame(inject); }, { passive: true });
    window.addEventListener("orientationchange", function () { setTimeout(inject, 200); }, { passive: true });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
      inject();
    }
    // 上游 React 挂载后可能改根变量；多次重同步，但不与它争同一个变量（走独立 !important 规则）
    [100, 300, 800, 1500].forEach(function (ms) { setTimeout(inject, ms); });
  })();
})();
