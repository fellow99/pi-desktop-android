// next.config.runtime.js —— 载荷内 next.config.js 的运行期 CommonJS 形态。
//
// 为什么载荷根必须有一个 next.config.js（真机根因，2026-10-29 实测）：
//   裁剪规则删掉了全部 @next/swc-* 原生绑定（无对应 Android 平台包，且省体积）。
//   上游源码的配置文件是 next.config.ts；Next 在「运行期」加载它时会 lazy
//   require('../swc').loadBindings() 现场转译 TS —— 没有原生 SWC 绑定，
//   dlopen 在 app_process64 内嵌宿主里触发原生崩溃：
//     FORTIFY: pthread_mutex_lock called on a destroyed mutex ⇒ SIGSEGV
//   （JS try/catch 接不住；发生在 router-server.initialize → loadConfig）。
//
//   Next 的 CONFIG_FILES 查找顺序为 [next.config.js, next.config.mjs, next.config.ts]，
//   .js 优先于 .ts ⇒ 载荷根放一份等价 CJS 配置，运行期即完全绕开 SWC，不再触碰
//   被裁掉的原生绑定。
//
// 纪律：
//   · 上游 next.config.ts 仍是**构建期唯一权威**（next build --webpack 读它）；
//     本文件只是该 TS 配置的运行期等价 CJS 转写，键必须与之一一对应，改 TS 必同步改这里。
//   · 由 assemble-payload.mjs 在壳资产阶段复制到载荷根并改名 next.config.js
//     （上游工作区不落地，避免污染 next build 的配置选择）。
//   · 不含任何 TS 专有语法；不引入构建期才有的依赖。
"use strict";
const { readFileSync } = require("fs");
const { dirname, join } = require("path");

const configDir = __dirname;
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8"));
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = JSON.parse(readFileSync(piPkgPath, "utf8")).version;
} catch {
  /* package not found, use default */
}

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The loader
// swaps it for an equivalent built at runtime; both bundlers must run it.
const gfmAutolinkEmailLoader = join(configDir, "lib/gfm-autolink-email-loader.cjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: configDir,
  experimental: {
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // `next dev` runs Turbopack and `npm run build` runs webpack. 进程内生产服务
  // （next start 等价路径）不读 turbopack 段，但保留同形规则以免开发态分叉。
  turbopack: {
    rules: {
      "**/mdast-util-gfm-autolink-literal/lib/index.js": { loaders: [gfmAutolinkEmailLoader] },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/,
      loader: gfmAutolinkEmailLoader,
    });
    return config;
  },
  // Node modules keep the syntax they ship unless listed here, and mermaid's
  // lazy diagram chunks are full of class `static {}` blocks (#753).
  transpilePackages: ["mermaid", "@mermaid-js/parser"],
  serverExternalPackages: [
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

module.exports = nextConfig;
