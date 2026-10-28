# L-ENV 证据包 — berberis（arm64→x86_64 翻译层）执行 Next require 图 SIGSEGV

> **用途**：向上游（Android 模拟器 / berberis 翻译层 / aosp-node-bridge）反馈的可移交证据包。
> **工程**：`pi-desktop-android`（as-built 时点 2026-10-28）；整理自 `docs/安卓环境能力清单-0.12.1.md` §E
> 与 `docs/002-真机验证记录.md` E2E 节。原始 tombstone 落盘仅存尾部片段
> （`docs/evidence/tombstone-berberis-next-boot.txt`，重复 backtrace 头行），指纹以本文记录的
> logcat 现场为准；后续复现请全量留存 `/data/tombstones/`。

## 1. 现象

进程内 Node（aosp-node-bridge 0.2.0：`dlopen libnode.so` + `node::Start`，无子进程）在引导
Next.js 16（`require` 数万模块的 require 风暴期，约 16–41 s）时确定性 SIGSEGV：

- 信号：`SIGSEGV`（`SEGV_ACCERR`）
- 栈指纹：`memmove_generic ← libproxy_arm64_to_x86_64（berberis trampoline）`，tid=MainNode
- 崩溃点发生在翻译层执行 guest arm64 代码的内存搬运路径，**非** Node/Next 逻辑自身

## 2. 复现矩阵（全部同一签名 ⇒ 参数无关）

| 引擎 | JIT | jitless | 结果 |
|---|---|---|---|
| node 24.2.0（`--with-intl=none`） | ❌ SEGV（且属性转义先炸） | ❌ SEGV | ~41 s / ~34 s |
| node 24.22.1（`--with-intl=small-icu`） | ❌ SEGV | ❌ SEGV | ~35 s |

附加变量排除：

- 模拟器 RAM 2 GB → 8 GB：无改善（8 GB 反而更早，~16 s）
- x86_64 宿主拒载 arm64 系统镜像（emulator 37.2：`Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host`）⇒ 无「原生 arm64 模拟器」绕行

## 3. 反证排除（为什么判定为宿主缺陷，不是载荷/工程缺陷）

1. **小负载全绿**：同一进程、同一翻译层上，Phase 0 探针套件全部通过——JIT/WASM 热循环、
   Intl 逐项、WebView 数据面、51k 文件解包（18 s）、`/system/bin/sh` spawn 三事件、
   宿主桥 Node→JNI→Kotlin 全链往返（`docs/002` O1–O5/O7，`docs/evidence/*.json`）。
2. **参考工程对照不构成反证**：同模拟器「全通」的 dsh 载荷是**自研 server**
   （`@deepseek-ai/*`，0 个 `next/dist` 文件、241 MB 未压缩），负载形态不同。
3. **失败点与业务代码无关**：崩溃在 require 风暴期（模块编译/链接密集段），无用户代码执行。

## 4. 复现步骤（最小化）

1. 环境：Android Studio AVD `Medium_Phone_API_37.0`（`sdk_gphone64_x86_64`，API 37 预览，
   berberis ARM 翻译），宿主 x86_64 Windows。
2. 安装并启动 `pi-desktop-android` debug APK（载荷 = pi-web/Next 16 生产产物，
   51,551 文件/558.8 MB 解包——旧基线；2026-10-28 裁剪后 30,413/307 MiB）。
3. 观察应用日志：解包 → bootstrap → `pi-web-launch.js` 引导（端口探测/宿主桥 ping 全部成功）
   → `start-server` require 期 ~16–41 s 后进程 SIGSEGV；`/data/tombstones/` 留存指纹（§1）。
4. 对照：把入口换成轻负载脚本（探针）则长期稳定运行 ⇒ 触发条件与 require 规模强相关。

## 5. 期望的上游动作

- berberis：核实 `memmove_generic ← trampoline` 路径在 guest 大体量 JIT 代码 +
  高频模块链接场景下的页权限处理（`SEGV_ACCERR` 指向写只读页/映射越界一类）。
- 模拟器：arm64 系统镜像在 x86_64 宿主的可用性（当前被拒）。

## 6. 本工程的临时边界（不改）

- 模拟器跑 Next 记 **L-ENV 不可用**，不作为本工程任务（能力清单 §F「不可实现/不排期」）；
- 真机（原生 arm64，无翻译层）不在该路径，预期不受影响（待真机矩阵核销）；
- 轻负载探针 + 宿主能力 dryRun 自检（`am start --ez selftest true`）可在模拟器继续用于回归。
