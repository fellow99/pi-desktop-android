# STRUCTURE.md — 工程目录结构

> 由脚本对实际目录生成并人工核对（2026-10-28）。载荷产物（app/src/main/assets/pi-web/）为 gitignored 构建产物（pi-web.tar.gz + pi-web.version，由 scripts/assemble-payload.mjs 产出），此处展示工程源面。深度截断 10 层。

```
pi-desktop-android/
├── docs/
│   ├── evidence/
│   │   ├── basic.json
│   │   ├── intl.json
│   │   ├── jit.json
│   │   ├── o3.json
│   │   ├── phase0-probe-o3-page.png
│   │   ├── pi-web-boot-applog-emulator.txt
│   │   ├── shell-home-after-native-crash.png
│   │   ├── shell-loading-page.png
│   │   ├── spawn.json
│   │   └── tombstone-berberis-next-boot.txt
│   ├── 000-工程规划.md
│   └── 002-真机验证记录.md
├── patches/
│   └── v0.12.1/
│       ├── 0001-terminal-capability-unsupported.patch
│       ├── 0002-cwd-sandbox-root-from-android-roots.patch
│       ├── 0003-cwd-adb-path-alias-normalize.patch
│       ├── 0004-session-export-runtime-identity-guard.patch
│       ├── 0005-directory-picker-contract.patch
│       └── 0006-directory-picker-permission-flow.patch
├── payload/
│   ├── extensions/
│   │   ├── android-exec.js
│   │   ├── android-runtime.js
│   │   ├── android-search.js
│   │   └── android-workspace-roots.js
│   ├── jitless/
│   │   ├── selftest/
│   │   │   ├── fetch-undici.mjs
│   │   │   ├── photon.mjs
│   │   │   └── run.mjs
│   │   ├── vendor/
│   │   │   ├── VENDOR.json
│   │   │   ├── jpeg-js/
│   │   │   │   ├── lib/
│   │   │   │   │   ├── decoder.js
│   │   │   │   │   └── encoder.js
│   │   │   │   ├── CONTRIBUTING.md
│   │   │   │   ├── index.d.ts
│   │   │   │   ├── index.js
│   │   │   │   ├── LICENSE
│   │   │   │   ├── package.json
│   │   │   │   └── README.md
│   │   │   └── pngjs/
│   │   │       ├── LICENSE
│   │   │       ├── package.json
│   │   │       ├── README.md
│   │   │       ├── lib/
│   │   │       │   ├── bitmapper.js
│   │   │       │   ├── bitpacker.js
│   │   │       │   ├── chunkstream.js
│   │   │       │   ├── constants.js
│   │   │       │   ├── crc.js
│   │   │       │   ├── filter-pack.js
│   │   │       │   ├── filter-parse-async.js
│   │   │       │   ├── filter-parse-sync.js
│   │   │       │   ├── filter-parse.js
│   │   │       │   ├── format-normaliser.js
│   │   │       │   ├── interlace.js
│   │   │       │   ├── packer-async.js
│   │   │       │   ├── packer-sync.js
│   │   │       │   ├── packer.js
│   │   │       │   ├── paeth-predictor.js
│   │   │       │   ├── parser-async.js
│   │   │       │   ├── parser-sync.js
│   │   │       │   ├── parser.js
│   │   │       │   ├── png-sync.js
│   │   │       │   ├── png.js
│   │   │       │   ├── sync-inflate.js
│   │   │       │   └── sync-reader.js
│   │   │       └── CHANGELOG.md
│   │   ├── fetch-shim.js
│   │   ├── http-lazy-undici.js
│   │   ├── image-codec.js
│   │   ├── index.js
│   │   ├── photon-shim.js
│   │   └── undici-shim.js
│   ├── skills/
│   │   └── android-runtime-capabilities/
│   │       └── SKILL.md
│   ├── env.js
│   ├── pi-web-launch.js
│   └── config/
│       ├── mcp.json
│       └── settings.json
├── scripts/
│   ├── assemble-payload.mjs
│   └── crop-rules.mjs
├── specs/
│   ├── ARCHITECTURE.md
│   ├── constitution.md
│   ├── overall-data-model.md
│   ├── overall-plan.md
│   ├── overall-spec.md
│   ├── overall-test-cases.md
│   ├── README.md
│   ├── SPECS_CHECKLIST.md
│   ├── STRUCTURE.md
│   ├── TECH.md
│   ├── 101-runtime-integration-launch-orchestration/
│   │   ├── plan.md
│   │   └── spec.md
│   ├── 102-payload-pipeline-assembly-crop/
│   │   ├── plan.md
│   │   └── spec.md
│   ├── 103-webview-shell-render-pages/
│   │   ├── plan.md
│   │   └── spec.md
│   ├── 104-host-capabilities-kotlin-impl/
│   │   ├── plan.md
│   │   └── spec.md
│   ├── 105-auth-loopback-no-password/
│   │   ├── plan.md
│   │   └── spec.md
│   ├── 106-tools-extensions-same-name-overrides/
│   │   ├── plan.md
│   │   └── spec.md
│   └── 107-compliance-and-security/
│       ├── plan.md
│       └── spec.md
├── build.gradle.kts
├── gradle.properties
├── gradlew
├── gradlew.bat
├── LICENSE
├── README.md
├── settings.gradle.kts
├── app/
│   ├── src/
│   │   └── main/
│   │       ├── assets/
│   │       │   └── pi-web/
│   │       │       ├── pi-web.tar.gz
│   │       │       └── pi-web.version
│   │       ├── java/
│   │       │   └── org/
│   │       │       └── fellow99/
│   │       │           └── pi/
│   │       │               └── PiDesktopAndroid/
│   │       │                   ├── payload/
│   │       │                   │   └── PayloadArchive.kt
│   │       │                   ├── runtime/
│   │       │                   │   └── PiDesktopRuntime.kt
│   │       │                   ├── MainActivity.kt
│   │       │                   └── host/
│   │       │                       └── HostCapabilities.kt
│   │       ├── res/
│   │       │   ├── values/
│   │       │   │   └── strings.xml
│   │       │   └── xml/
│   │       │       └── network_security_config.xml
│   │       └── AndroidManifest.xml
│   └── build.gradle.kts
├── gradle/
│   ├── wrapper/
│   │   ├── gradle-wrapper.jar
│   │   └── gradle-wrapper.properties
│   └── libs.versions.toml
└── .gitignore
```
