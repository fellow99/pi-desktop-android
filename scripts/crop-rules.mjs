/**
 * crop-rules.mjs —— 载荷裁剪规则（**数据**，不是过程）。
 *
 * 从 pi-desktop-ark 的同名文件移植（数据 + 纯匹配函数，不做 IO），Android 差异只有一处：
 *   KEEP_PATH_MARKERS 的平台保留子串：ark 是 ['linux-arm64','arm64','ohos']，本工程目标是
 *   arm64-v8a ⇒ 保留 'arm64'（同时误判 darwin-arm64 等子串，与 ark 同一口径的保守选择）
 *   并追加 'android'。
 *
 * 依据两条线：
 *   ① docs/000-工程规划.md §7.2（体积与裁剪表）；
 *   ② 已跑通的 pi-desktop-hos / pi-desktop-ark 实现（prepare-next.mjs 的保留口径）。
 *
 * ⚠️ 纪律：规则只描述「删什么」。凡未在本工程复核的照旧标 ⬜，脚本不会偷偷升级成「已验证」。
 */

/** 运行期要保留的平台标记（子串启发式；精确目录族由 node-pty 规则单独枚举）。 */
export const KEEP_PATH_MARKERS = Object.freeze(['linux-arm64', 'arm64', 'android']);

/** 平台原生件判定：`*.node` */
export const NATIVE_EXT = /\.node$/i;

/** 纯 JS 依赖（platform-native 规则必须跳过：删父目录会连带删掉 JS 入口）。 */
export const PURE_JS_PREFIXES = Object.freeze([
  'node_modules/undici/',
  'node_modules/web-push/',
  'node_modules/@earendil-works/'
]);

/** @typedef {{id:string, kind:string, pattern:string, keep:string[], keepPathMarkers?:string[], skipPrefixes?:string[], expectOverlapWith?:string[], reason:string, expectedFiles:number, expectedSavingBytes:number, evidence:string, planRef:string, prepareRef:string, safeByDefault:boolean}} CropRule */

/** @type {CropRule[]} */
export const CROP_RULES = [
  {
    id: 'next-nft-json',
    kind: 'glob',
    pattern: '.next/**/*.nft.json',
    keep: [],
    reason:
      'Next 的 output-file-trace 清单（内含构建宿主的绝对路径，设备上无意义）。'
      + 'ark 实测 76 文件 348MB，是裁剪最大头；运行期是否读它已在 ark 真机验证可删（🔶），本工程随包自证。',
    expectedFiles: 76,
    expectedSavingBytes: 348096301,
    evidence: '✅ ark 实测（348,096,301 B）/ 🔶 沿用 ark 真机结论，本工程 O4/E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs next-nft-json',
    safeByDefault: true
  },
  {
    id: 'next-swc-win32',
    kind: 'glob',
    pattern: 'node_modules/@next/*win32*/**',
    keep: [],
    expectOverlapWith: ['next-swc-native', 'platform-native'],
    reason:
      '宿主 Windows 平台的 SWC 原生二进制（~106MB）。设备 arm64 永远加载不了。'
      + '⚠️ 实测教训（ark）：删掉后 `next start` 会联网补装 34MB ⇒ 裁剪必须在打包期对副本做。'
      + '端上 SWC 只走 WASM 版 ⇒ 前提：node_modules/next/wasm/@next/swc-wasm-nodejs/ 在位（下一条 keep）。',
    expectedFiles: 3,
    expectedSavingBytes: 106191877,
    evidence: '✅ ark 实测（106,191,877 B）/ ⬜ 本工程 WASM SWC 在 E2E 复核（O2 关联）',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs next-swc-win32',
    safeByDefault: true
  },
  {
    id: 'next-swc-native',
    kind: 'glob',
    pattern: 'node_modules/@next/swc-*/**',
    keep: ['node_modules/next/wasm/**'],
    expectOverlapWith: ['next-swc-win32', 'platform-native'],
    reason:
      '`@next/swc-*` 按平台编译的原生 SWC。⚠️ 只裁 `@next/swc-*`，不裁整个 `@next/`：'
      + '`@next/env` 是纯 JS 运行时模块（ark 实测删了 ⇒ Cannot find module ⇒ 起不来）。',
    expectedFiles: -1,
    expectedSavingBytes: -1,
    evidence: '🔶 沿用 ark 实测口径 / ✅ 真机教训（@next/env）',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs next-swc-native',
    safeByDefault: true
  },
  {
    id: 'img-sharp',
    kind: 'glob',
    pattern: 'node_modules/@img/**',
    keep: [],
    expectOverlapWith: ['platform-native'],
    reason:
      'sharp 及其平台件（服务端图片优化）：依赖 images.unoptimized=true（上游产物决定）。'
      + '⚠️ 下一次 next build 会把 @img/sharp-* 装回源目录 ⇒ 只能打包期对副本裁。',
    expectedFiles: 20,
    expectedSavingBytes: 28767609,
    evidence: '✅ ark 实测（28,767,609 B）/ ⬜ 本工程图片链路 E2E 复核（看图对话）',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs img-sharp',
    safeByDefault: false
  },
  {
    id: 'tailwind-oxide',
    kind: 'glob',
    pattern: 'node_modules/@tailwindcss/oxide*/**',
    keep: [],
    expectOverlapWith: ['platform-native'],
    reason:
      'Tailwind v4 原生扫描器只在构建期使用；运行期只发预构建 CSS。' +
      'ark 口径：本机 pi-dist 不含该目录（0 命中也算证据）。',
    expectedFiles: 0,
    expectedSavingBytes: 0,
    evidence: '🔶 ark 口径沿用（0 命中可见）',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs tailwind-oxide',
    safeByDefault: true
  },
  {
    id: 'node-pty-prebuilds',
    kind: 'glob',
    pattern: 'node_modules/node-pty/prebuilds/*/**',
    keep: [],
    expectOverlapWith: ['node-pty'],
    reason:
      'node-pty 按平台预编译件。设备 arm64 Android（PTY 暂缓，规划 §8 #16）——一个都加载不了。'
      + '⚠️ 刻意不用 KEEP_PATH_MARKERS：子串启发式会把 darwin-arm64/win32-arm64 误判为可用。',
    expectedFiles: 10,
    expectedSavingBytes: 23232544,
    evidence: '✅ ark 实测（23,232,544 B）/ ✅ 本工程 PTY 暂缓（用户决策 2026-10-24）',
    planRef: 'docs/000-工程规划.md §7.2 · §8 #16',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs node-pty-prebuilds',
    safeByDefault: true
  },
  {
    id: 'node-pty',
    kind: 'glob',
    pattern: 'node_modules/node-pty/**',
    keep: [],
    expectOverlapWith: ['node-pty-prebuilds'],
    reason:
      'PTY 本平台暂缓（补丁 0001 结构化 unsupported）⇒ 整包裁掉最干净（prebuilds 由前一条先计数）。',
    expectedFiles: 33,
    expectedSavingBytes: 3699358,
    evidence: '✅ ark 实测 / ✅ 本工程 PTY 暂缓',
    planRef: 'docs/000-工程规划.md §7.2 · §8 #16',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs node-pty',
    safeByDefault: true
  },
  {
    id: 'nm-sourcemaps',
    kind: 'glob',
    pattern: 'node_modules/**/*.map',
    keep: [],
    reason:
      'Source map（.js.map/.mjs.map/.css.map）：V8 栈回溯美化用的离线符号表，运行期从不读取。'
      + '本工程 stage 实测 7,792 文件 205,990,055 B——是文件数/体积裁剪的最大头（能力清单 §F P1-1）。',
    expectedFiles: 7792,
    expectedSavingBytes: 205990055,
    evidence: '✅ 本机 stage 实测（2026-10-28 基线 51,551 文件/558.8MB）/ ⬜ E2E 复核（引擎引导用例）',
    planRef: 'docs/000-工程规划.md §7.2 · docs/安卓环境能力清单-0.12.1.md §F 第1级 #1',
    prepareRef: '本工程新增（ark 无此规则，其产物谱系不同）',
    safeByDefault: false
  },
  {
    id: 'nm-dts',
    kind: 'glob',
    pattern: 'node_modules/**/*.d.ts',
    keep: [],
    reason:
      'TypeScript 声明文件：编辑器/类型检查用，Node 运行期永不加载。'
      + 'stage 实测 9,354 文件 33,638,639 B。',
    expectedFiles: 9354,
    expectedSavingBytes: 33638639,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2 · docs/安卓环境能力清单-0.12.1.md §F 第1级 #1',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-dmts',
    kind: 'glob',
    pattern: 'node_modules/**/*.d.mts',
    keep: [],
    reason: '同 nm-dts（ESM 声明）：stage 实测 1,888 文件 6,509,221 B。',
    expectedFiles: 1888,
    expectedSavingBytes: 6509221,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-dcts',
    kind: 'glob',
    pattern: 'node_modules/**/*.d.cts',
    keep: [],
    reason: '同 nm-dts（CJS 声明）：stage 实测 161 文件 738,920 B。',
    expectedFiles: 161,
    expectedSavingBytes: 738920,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-js-flow',
    kind: 'glob',
    pattern: 'node_modules/**/*.js.flow',
    keep: [],
    reason: 'Flow 类型定义：运行期不读取。stage 实测 37 文件 1,160,528 B。',
    expectedFiles: 37,
    expectedSavingBytes: 1160528,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-docs-md',
    kind: 'glob',
    pattern: 'node_modules/**/*.md',
    keep: ['node_modules/**/LICENSE*', 'node_modules/**/LICENCE*', 'node_modules/**/COPYING*', 'node_modules/**/NOTICE*'],
    reason:
      'Markdown 文档（README/CHANGELOG/发布说明等）：运行期不读取；**保留许可类 .md**'
      + '（LICENSE.md 等，合规）。stage 实测 1,745 文件 13,981,068 B（其中许可类 29 文件保留）。',
    expectedFiles: 1716,
    expectedSavingBytes: 13934354,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核（pi 技能 .md 走 payload/skills，不在 node_modules，不受影响）',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-readme-nomd',
    kind: 'glob',
    pattern: 'node_modules/**/README*',
    keep: [],
    reason: '无扩展名/非 .md 的 README（.rst/.txt/裸名）：与 nm-docs-md 同理。stage 实测族 807 文件 5,874,113 B（含 .md 重叠，归属以本规则先命中计）。',
    expectedFiles: 807,
    expectedSavingBytes: 5874113,
    evidence: '✅ 本机 stage 实测（族口径）/ ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-changelog-nomd',
    kind: 'glob',
    pattern: 'node_modules/**/CHANGELOG*',
    keep: [],
    reason: 'CHANGELOG 族（任意扩展）：发布历史，运行期无用。stage 实测族 163 文件 3,238,713 B。',
    expectedFiles: 163,
    expectedSavingBytes: 3238713,
    evidence: '✅ 本机 stage 实测（族口径）/ ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-tests-dir',
    kind: 'glob',
    pattern: 'node_modules/**/__tests__/**',
    keep: [],
    reason: '包内测试目录：运行期从不 import。stage 实测 151 文件 622,373 B。'
      + '刻意**不**裁裸 `test/`（个别包把运行期数据放那里，保守起见不碰）。',
    expectedFiles: 151,
    expectedSavingBytes: 622373,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'nm-mocks-dir',
    kind: 'glob',
    pattern: 'node_modules/**/__mocks__/**',
    keep: [],
    reason: '测试 mock 目录：同上。stage 实测 21 文件 14,365 B。',
    expectedFiles: 21,
    expectedSavingBytes: 14365,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'next-build-trace',
    kind: 'glob',
    pattern: '.next/trace',
    keep: [],
    reason: 'Next 构建期性能 trace（单文件）：设备上无意义。stage 实测 1 文件 431,942 B。',
    expectedFiles: 1,
    expectedSavingBytes: 431942,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: true
  },
  {
    id: 'next-types-dir',
    kind: 'glob',
    pattern: '.next/types/**',
    keep: [],
    reason:
      'Next 生成的路由 TS 类型（next typecheck/IDE 用）。载荷不含 tsconfig（assemble 只复制'
      + ' package.json/next.config.ts/public/.next），prod server 不加载。stage 实测 74 文件 645,993 B。',
    expectedFiles: 74,
    expectedSavingBytes: 645993,
    evidence: '✅ 本机 stage 实测 / ⬜ E2E 复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: '本工程新增',
    safeByDefault: false
  },
  {
    id: 'platform-native',
    kind: 'glob',
    pattern: 'node_modules/**/*.node',
    keep: [],
    keepPathMarkers: KEEP_PATH_MARKERS,
    skipPrefixes: PURE_JS_PREFIXES,
    expectOverlapWith: ['next-swc-win32', 'next-swc-native', 'img-sharp', 'tailwind-oxide'],
    reason:
      '通用兜底：任何 `*.node` 原生件，除非命中平台标记（arm64/android/linux-arm64）或落在纯 JS 包里。',
    expectedFiles: -1,
    expectedSavingBytes: -1,
    evidence: '🔶 判据沿用 ark/dsh / ⬜ 新增平台件待复核',
    planRef: 'docs/000-工程规划.md §7.2',
    prepareRef: 'pi-desktop-ark/scripts/crop-rules.mjs platform-native',
    safeByDefault: false
  }
];

/** glob → 正则源（`**` 跨段 / `*`、`?` 段内；刻意不支持 `{a,b}` 与 `[0-9]`）。 */
export function globToRegExpSource(pattern) {
  const segments = String(pattern).split('/');
  let source = '^';
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      source += isLast ? '.*' : '(?:[^/]+/)*';
      return;
    }
    let part = '';
    for (const char of segment) {
      if (char === '*') part += '[^/]*';
      else if (char === '?') part += '[^/]';
      else part += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += part;
    if (!isLast) source += '/';
  });
  return source + '$';
}

/** @param {string} pattern */
export function globToRegExp(pattern) {
  return new RegExp(globToRegExpSource(pattern));
}

/** 单看 pattern 是否命中（不含白名单判定；「保留」要单独可见）。 */
export function patternHits(pattern, relPath) {
  return globToRegExp(pattern).test(relPath);
}

function ruleDirectoryPrefix(rule) {
  const suffix = '/**';
  return rule.pattern.endsWith(suffix) ? rule.pattern.slice(0, -suffix.length) : null;
}

function hasKeepMarker(relPath, markers) {
  if (!markers || markers.length === 0) return false;
  const lower = String(relPath).toLowerCase();
  return markers.some((marker) => lower.includes(String(marker).toLowerCase()));
}

/** 单个文件是否被该规则裁掉（先保留、后裁剪）。 */
export function ruleMatchesFile(relPath, rule) {
  if (!globToRegExp(rule.pattern).test(relPath)) return false;
  if (hasKeepMarker(relPath, rule.keepPathMarkers)) return false;
  if (rule.skipPrefixes) {
    for (const prefix of rule.skipPrefixes) {
      if (relPath.startsWith(prefix)) return false;
    }
  }
  for (const keepPattern of rule.keep) {
    if (globToRegExp(keepPattern).test(relPath)) return false;
  }
  return true;
}

/** 单个目录是否被整目录裁掉（命中则不再下钻）。 */
export function ruleMatchesDir(relDir, rule) {
  const prefix = ruleDirectoryPrefix(rule);
  if (prefix === null) return false;
  if (relDir !== prefix) return false;
  if (hasKeepMarker(relDir, rule.keepPathMarkers)) return false;
  if (rule.skipPrefixes) {
    for (const skip of rule.skipPrefixes) {
      if (`${relDir}/`.startsWith(skip)) return false;
    }
  }
  for (const keepPattern of rule.keep) {
    if (globToRegExp(keepPattern).test(relDir)) return false;
  }
  return true;
}

/** 命中任一规则的第一个规则（字节归属唯一化）。 */
export function firstMatchingRule(relPath) {
  for (const rule of CROP_RULES) {
    if (ruleMatchesFile(relPath, rule)) return rule;
  }
  return null;
}

/** 规则自审：白名单/标记/跳过前缀必须真的被 matcher 排除。 */
export function assertKeepSound() {
  const problems = [];
  for (const rule of CROP_RULES) {
    for (const keepPattern of rule.keep) {
      const prefix = ruleDirectoryPrefix(rule);
      if (prefix !== null && keepPattern.startsWith(prefix + '/')) {
        problems.push(
          `${rule.id}: keep "${keepPattern}" 落在规则目录 "${prefix}/" 之内（靠 ruleMatchesFile 的排除生效，请保持该分支存在）`
        );
      }
    }
    for (const marker of rule.keepPathMarkers || []) {
      const sample = `node_modules/demo-${marker}/native.node`;
      if (ruleMatchesFile(sample, rule)) {
        problems.push(`${rule.id}: keepPathMarkers "${marker}" 未生效（${sample} 仍被判为可裁）`);
      }
    }
    for (const prefix of rule.skipPrefixes || []) {
      const sample = `${prefix}dummy.node`;
      if (ruleMatchesFile(sample, rule)) {
        problems.push(`${rule.id}: skipPrefixes "${prefix}" 未生效（${sample} 仍被判为可裁）`);
      }
    }
  }
  return problems;
}

/** 规则清单简表（脚本与文档共用）。 */
export function describeRules() {
  return CROP_RULES.map((r) => `${r.id}: ${r.pattern} ← ${r.planRef}`).join('\n');
}
