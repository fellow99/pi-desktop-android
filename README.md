[中文](./README_zh.md) | English

---

# Pi Desktop · Android Edition (`pi-desktop-android`)

> **Positioning: Android Edition** — the Android member of the Pi Desktop family.
> It ships **no bundled browser kernel and no Electron/Chromium**: the app hosts an **in-process
> Node.js runtime** (aosp-node-bridge + a provisioned `libnode.so`) which serves the upstream
> **Pi Web** locally, and renders the UI with the **system WebView** pointed at that local service.
> The functional target is parity with [`pi-desktop-ark`](../pi-desktop-ark) (the HarmonyOS pure-runtime
> edition), plus Android-specific increments (a foreground service, an in-process pnpm extension,
> and a Storage Access Framework bridge).

| Item | Value |
| --- | --- |
| Edition | **Android Edition** (`pi-desktop-android`) |
| Display name / application ID | **Pi Desktop** / `org.fellow99.pi.PiDesktopAndroid` (finalized 2026-10-24; the display name matches the `pi-desktop` / `…Ark` brand — only the package name carries "Android") |
| Version / versionCode | **`0.1.0` / `1`** (pre-release; Phase 0 device verification complete) |
| Upstream baseline | `pi` **v1.2.0** + `pi-web` **v0.12.1** (six idempotent, reversible patches under `patches/v0.12.1/`) |
| Backend | `io.github.fellow99:node-bridge` **0.2.0** (JNI direct-call host bridge) + a **provisioned** aosp-node-runtime engine `libnode.so` **v24.22.1** (`--with-intl=small-icu`; see *Engine note* below), in-process via `dlopen` + `node::Start` |
| Frontend | System WebView loading `http://127.0.0.1:<random-port>/` (same-origin HTTP + SSE; loopback is a secure context) |
| ABI | **`arm64-v8a` only** (the engine ships a single ABI) |
| minSdk / targetSdk / compileSdk | **24** / **36** / **36** |
| Current status | **Level-0 verification passed on a real device** (Xiaomi M2105K81C, Android 11, A1–A8 all ✅); simulator is limited to lightweight probes because the ARM translation layer SIGSEGVs on the Next.js require graph |
| Planning doc | [`docs/000-工程规划.md`](docs/000-工程规划.md) (v0.2, the source of truth for planning) |

> **Engine note.** The Maven artifact `io.github.fellow99:node-runtime:24.2.0` is built
> `--with-intl=none` (no `Intl` at all, which makes Next 16's compiled output fail at parse time on
> Unicode property escapes). The project therefore provisions **aosp-node-runtime v24.22.1
> (small-ICU)** into `app/src/main/jniLibs/` via `scripts/provision-engine.mjs`, with the SHA-256
> locked in `runtime.lock.json`. The binary is deliberately **not committed**.

---

## What this is

[Pi](https://pi.dev) is a minimal, extensible agent harness; [Pi Web](../pi-web) is its local web UI
(a Next.js app in which **one Node process serves both the SPA and `/api/*`**, and the agent runs in
that process). This project packages that stack into a native Android application shell:

- the system WebView (no bundled Chromium) renders the upstream UI 100% as-is — no frontend fork;
- a Node runtime inside the **app's own process** serves pi-web; the two talk over loopback only;
- the Kotlin shell supplies the things a local Node service cannot do on Android: folder/file
  pickers (SAF), runtime permissions, notifications, a keep-alive foreground service, and external
  link hand-off.

> **Unofficial notice.** This project is not built by the Pi or Pi Web teams, has no affiliation
> with the upstream authors, and is not endorsed by them. Both `Pi` and `Pi Web` are MIT-licensed
> upstream open-source projects; this project is merely a third-party port of their desktop form
> factor to Android.

## Delivered modules

Requirements are organized under `specs/1NN-<name>/` (mirroring the ark numbering):

| Module | Spec directory | Deliverable |
|---|---|---|
| `101-runtime-integration` | [`specs/101-runtime-integration-launch-orchestration/`](specs/101-runtime-integration-launch-orchestration/) | Maven bridge wiring, archive provisioning, launch/readiness/marker state machine |
| `102-payload-pipeline` | [`specs/102-payload-pipeline-assembly-crop/`](specs/102-payload-pipeline-assembly-crop/) | Patch → build → crop → tar.gz payload pipeline (74.5 MiB archive) |
| `103-webview-shell` | [`specs/103-webview-shell-render-pages/`](specs/103-webview-shell-render-pages/) | WebView config, boot/error pages, navigation fence, history clearing, Chrome-94 polyfills |
| `104-host-capabilities` | [`specs/104-host-capabilities-kotlin-impl/`](specs/104-host-capabilities-kotlin-impl/) | Kotlin host bridge: facts, permissions, SAF pickers, notifications, external links, keep-alive, structured `terminal.pty=unsupported` |
| `105-auth` | [`specs/105-auth-loopback-no-password/`](specs/105-auth-loopback-no-password/) | Loopback-only bind + no password (WebView and Node share one process; unlike Electron there is no loopback isolation) |
| `106-tools-extensions` | [`specs/106-tools-extensions-same-name-overrides/`](specs/106-tools-extensions-same-name-overrides/) | Same-name extension overrides (`bash` / `find` / `grep`) |
| `107-compliance` | [`specs/107-compliance-and-security/`](specs/107-compliance-and-security/) | Store-compliance checklist G1–G11 (manifest minimality, 16 KB alignment, debug-only diagnostics, AI-content label, privacy draft) |

The two capability increments beyond ark are tracked in `docs/000-工程规划.md` §10/§11:
**`android-git`** (pure-JS isomorphic-git, single-sourced from `pi-desktop-hos`) and
**`android-pnpm`** (in-process vendored pnpm 9.15.9). Both are assembled into the payload but have
**no on-device end-to-end report archived yet** — treat them as implemented-but-unverified.

## Repository layout

```
pi-desktop-android/
├── app/
│   ├── build.gradle.kts                     # applicationId / ABI arm64-v8a / signing (keystore not committed)
│   └── src/main/
│       ├── AndroidManifest.xml              # 4 permissions; singleTask; dataSync foreground service
│       ├── assets/
│       │   ├── pi-web/pi-web.tar[.gz]       # payload archive (built artifact, not committed)
│       │   └── webview/polyfill-webview.js  # Chrome 94 (old system WebView) ES2022/dvh polyfills
│       ├── java/org/fellow99/pi/PiDesktopAndroid/
│       │   ├── MainActivity.kt              # WebView shell: fence, file chooser, console forwarding, debug switch
│       │   ├── PiApplication.kt
│       │   ├── runtime/                     # PiDesktopRuntime, PayloadArchive, EngineFacts
│       │   ├── host/HostCapabilities.kt     # the host-capability bridge (10 capabilities)
│       │   ├── service/PiForegroundService.kt
│       │   └── payload/PayloadArchive.kt
│       ├── jniLibs/arm64-v8a/               # libnode.so + libc++_shared.so (provisioned, gitignored)
│       └── res/                             # app name = "Pi Desktop", launcher icons
├── payload/                                 # shell overlay copied on top of pi-web at assembly
│   ├── pi-web-launch.js                     # in-process Next boot, readiness marker, jitless layer, materialization
│   ├── env.js                               # the environment contract (PI_* variables)
│   ├── extensions/
│   │   ├── android-exec.js                  # overrides built-in bash: resident mksh + sentinel line
│   │   ├── android-search.js                # overrides find/grep: pure-JS walk, zero rg/fd/child processes
│   │   ├── android-runtime.js · android-workspace-roots.js
│   │   ├── android-saf.js                   # SAF bridge (content://, persistable permissions)
│   │   ├── android-git/                     # 21 git_* tools + git_credentials (isomorphic-git 1.44.2)
│   │   ├── android-pnpm/                    # vendored pnpm 9.15.9, in-process, --ignore-scripts
│   │   └── android-pty/                     # evaluation-only node-pty harness (not productized; see Limitations)
│   ├── skills/android-runtime-capabilities/
│   ├── config/{settings.json,mcp.json}
│   └── jitless/                             # pure-JS compatibility layer, activated only if WebAssembly is absent
├── patches/v0.12.1/                         # six idempotent pi-web patches (0001–0006)
├── scripts/                                 # assemble-payload · crop-rules · provision-engine/pty · devtest · sync
├── docs/                                    # 000 plan · capability inventory · device records · privacy draft
├── specs/                                   # 1NN module specs
├── keystore.properties.sample               # release signing template (keystore.properties is gitignored)
└── build.gradle.kts · settings.gradle.kts · gradle/
```

## Build

Prerequisites: a host Node.js for the payload pipeline, the Android SDK + JDK 17, and an
`arm64-v8a` device or emulator image (x86_64 emulator images run the engine only under the ARM
translation layer, which cannot boot the Next.js server — see *Known limitations*).

```bash
# 0) Engine: provision libnode.so into app/src/main/jniLibs (sha256-lock gated; not in git)
node scripts/provision-engine.mjs --check      # verify a previously provisioned engine
node scripts/provision-engine.mjs             # provision from the locked aosp-node-runtime build

# 1) Assemble the payload on the host (dry run, then apply)
node scripts/assemble-payload.mjs              # report patches / crop stats / sizes
node scripts/assemble-payload.mjs --apply      # -> app/src/main/assets/pi-web/pi-web.tar.gz + .version

# 2) Build the APK
./gradlew :app:assembleDebug                   # or :app:assembleRelease
# Release signing: copy keystore.properties.sample to keystore.properties and fill it in;
# without it the release APK is produced unsigned. Debug builds are signed with the debug key.
```

Output: `app/build/outputs/apk/debug/app-debug.apk` (~181 MB: engine 81.5 MB + payload 74.5 MiB).

## Install and run

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n org.fellow99.pi.PiDesktopAndroid/.MainActivity
```

- First launch unpacks the payload (≈18 s measured for an 85 MB / 27k-file archive on the
  emulator; a SHA-256 marker makes every subsequent launch skip unpacking) and boots the in-process
  server; the boot page reports progress, and the WebView switches to the service once the HTTP
  readiness probe succeeds.
- The server binds `127.0.0.1` on a **random port** (fixed ports caused hard EADDRINUSE failures
  during verification) with **no password**; loopback is a secure context (`crypto.subtle`
  available), and `network_security_config` permits cleartext only for loopback.

Device verification so far (see [`docs/002-真机验证记录.md`](docs/002-真机验证记录.md)):

- **Real device** Xiaomi M2105K81C (Android 11, arm64): A1–A8 (cold start, payload unpack, runtime
  boot, host bridge, model/SSE conversation, image view, layout, file upload) all ✅, including
  fixes for the device's factory WebView (**Chrome 94**): ES2022 + dynamic-viewport polyfills,
  `<input type=file>` wiring, and full-height layout.
- **x86_64 emulator** (berberis ARM translation): lightweight probes pass (JIT/WASM, Intl, SSE
  data plane, spawn semantics, host bridge, 18 s unpack); the Next.js require graph deterministically
  SIGSEGVs under translation in all tested JIT/jitless/memory configurations — a host-environment
  limitation, not an app defect. Emulator coverage is therefore limited to probes and diagnostics.

## Capability boundaries (known limitations)

| Capability | Status | Note |
|---|---|---|
| Main UI (Pi Web), streaming SSE conversations, model/provider settings | ✅ on device | Same-origin local service; API keys stay in the app's internal storage |
| File read / write / edit / list | ✅ | Pure Node.js inside the app process |
| Command execution (the `bash` tool) | ✅ on device | Replaced under the same name by `android-exec.js`: one resident non-PTY `/system/bin/sh` (mksh) + a random sentinel line; completion is judged from stdout alone, never from `exit`/`close` events |
| File lookup / content search (`find` / `grep`) | ✅ on device | Replaced by `android-search.js`: pure-JS walk, zero `fd`/`rg`, zero child processes; 512 KiB per-file cap |
| Git operations | 🔧 implemented, device verification pending | `android-git` ships 21 `git_*` tools + `git_credentials` via pure-JS isomorphic-git 1.44.2 (no system git binary needed). Out of scope: `rebase`, `blame`, SSH remotes, SHA-256 repositories |
| Package management (pnpm) | 🔧 implemented, device verification pending | `android-pnpm` runs vendored pnpm 9.15.9 **in-process**; lifecycle scripts are always disabled (`--ignore-scripts`), write operations are refused structurally when offline, and projects must lie inside declared workspace roots |
| Terminal panel / PTY | ❌ not in v1 (deferred decision) | Patch 0001 + the host bridge expose a structured `terminal.pty = unsupported`. `payload/extensions/android-pty/` is an **evaluation-only** harness (`/pty-test`); its native piece is deliberately not provisioned into `jniLibs` yet, so its self-check fails structurally without affecting the product |
| Code-mode (QuickJS sandbox) | ⬜ not yet verified | Android runs **JIT by default** (no HarmonyOS-style W^X ACL gate) and WebAssembly validates on the probes, so code-mode is expected to work; it is simply not verified end-to-end yet. The `jitless/` layer is a fallback installed only when `WebAssembly` is missing |
| MCP stdio servers | ⚠️ transport only | The spawn event-ordering blocker that existed on HarmonyOS is moot under Android (`exit`/`close` are delivered), but no real MCP server has been attached yet; shipped `mcp.json` is empty |
| Workspace / user files | ✅ app-specific external storage (no permission) + SAF | The mainline workspace lives under `Android/data/<pkg>/files/workspace`; additional trees are added via the Storage Access Framework (`content://` URIs with persisted permissions), which are not POSIX paths and are exposed through the `android-saf` bridge |
| Notifications | 🔧 bridge implemented | `notify.show` goes through a notification channel; on Android 13+ it requests `POST_NOTIFICATIONS` at runtime and reports denials structurally |
| Background residency | ✅ implemented (device-verified start/stop) | `runtime.keepAlive` drives a `dataSync` foreground service with a permanent notification |
| External links | ✅ | Only main-frame non-local navigations leave the app, via `ACTION_VIEW` to the system browser; `window.open` is captured, subframes pass through |
| Auto-update / tray | ❌ / ➖ | No updater in v1 (sideload / domestic-channel APK first, Google Play later); tray is desktop-only |
| `codemode` classifier WASM, image processing | ✅/🔧 | JIT+WASM available on the default engine; image resize uses the same pure-JS photon shim strategy as ark inside the jitless fallback layer |

See [`skills/android-runtime-capabilities/SKILL.md`](payload/skills/android-runtime-capabilities/SKILL.md)
(the capability digest presented to the model) and the authoritative as-built inventory
[`docs/安卓环境能力清单-0.12.1.md`](docs/安卓环境能力清单-0.12.1.md).

## Patches to upstream pi-web

Six idempotent, reversible patches (auto-applied during payload assembly; the pi-web working tree
is restored to pristine afterwards):

| Patch | Purpose |
|---|---|
| `0001-terminal-capability-unsupported` | Surface the missing PTY as a structured capability flag instead of a native-module load error |
| `0002-cwd-sandbox-root-from-android-roots` | Resolve the working directory / browser roots from `PI_ANDROID_ROOTS` |
| `0003-cwd-adb-path-alias-normalize` | Normalize adb/host-style path aliases to sandbox-relative paths |
| `0004-session-export-runtime-identity-guard` | Route session export through the in-process fallback when the runtime identity (`app_process`) cannot spawn Node |
| `0005-directory-picker-contract` | Workspace-root tabs + the directory-picker contract fed by host roots (no hardcoded paths in the UI) |
| `0006-directory-picker-permission-flow` | Split `EACCES`/`EPERM` from `ENOENT` → HTTP 403 + `canRequest`; `POST /api/host/perm` drives the system permission dialog |

## Privacy and compliance

- The app collects **no accounts, runs no tracking/analytics/crash-SDK, and does no server-side
  relay**: your API keys (internal storage, `0600`), sessions, and files leave the device only in
  the model-provider requests you configure. Draft (for channel review):
  [`docs/隐私政策与AI标识-G8G9.md`](docs/隐私政策与AI标识-G8G9.md).
- The "AI-generated content" label is permanently shown at the bottom of the UI.
- The manifest requests four permissions only (`INTERNET`, `ACCESS_NETWORK_STATE`,
  `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`); WebView remote
  debugging is enabled in **debug builds only**.

## Documentation

| Document | Contents |
|---|---|
| [`docs/000-工程规划.md`](docs/000-工程规划.md) | Engineering plan, decisions, capability matrix, phases (planning source of truth, v0.2) |
| [`docs/安卓环境能力清单-0.12.1.md`](docs/安卓环境能力清单-0.12.1.md) | **Authoritative as-built capability inventory** vs. ark, with evidence and root-cause layers |
| [`docs/002-真机验证记录.md`](docs/002-真机验证记录.md) | Phase 0 probe records, emulator translation-layer findings, real-device A1–A8 evidence |
| [`docs/隐私政策与AI标识-G8G9.md`](docs/隐私政策与AI标识-G8G9.md) | Privacy-policy and AI-labeling draft for store submission |
| [`specs/`](specs/) | Module specs (`101`–`107`), architecture, constitution, overall test cases |

## License

MIT (see [`LICENSE`](LICENSE)). Upstream `Pi` and `Pi Web` are MIT-licensed; vendored components
keep their own licenses (`payload/extensions/android-pnpm/vendor/pnpm.LICENSE`, etc.).
