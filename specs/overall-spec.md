# overall-spec.md — 整体规格

> 需求 000-scaffold（工程搭建）+ Phase 0/1 交付的整体规格。验收一律写成「能观测到 X」（宪法 C10）。
> 证据标记：✅ 实测 · 🔶 沿用 · ⬜ 待验证 · ⚠️ 冲突/风险。

## S1 工程脚手架

| # | 需求 | 验收（观测判据） | as-built |
|---|---|---|---|
| S1-1 | Gradle/Kotlin 工程骨架 | `gradlew :app:assembleDebug` exit 0，产出 `app-debug.apk` | ✅（35 tasks BUILD SUCCESSFUL） |
| S1-2 | 双 AAR 运行时接入 | APK `unzip -l` 含 `lib/arm64-v8a/libnode.so`(84,128,040B) + `libnode_bridge.so` + `libnode_host_client.so` | ✅（脚手架提交时断言） |
| S1-3 | 身份定稿 | namespace/applicationId=`org.fellow99.pi.PiDesktopAndroid`，应用名 Pi Desktop | ✅ |
| S1-4 | loopback 明文放行 | `network_security_config.xml` 仅 127.0.0.1/localhost cleartext | ✅（O3 实测页面可加载） |
| S1-5 | 最小权限面 | Manifest 仅 INTERNET+ACCESS_NETWORK_STATE；无 G7 禁申请权限 | ✅ |

## S2 探针（未明确判断 → 实测 → 清理）

| # | 判定 | 结论 | 证据 |
|---|---|---|---|
| S2-1 O1 | JIT/WASM | ✅ likely-jit（115.6ms/2e6）+ wasm ok | `docs/evidence/jit.json` |
| S2-2 O2 | Intl 缺失影响 | ⚠️ 构造器全缺；属性转义编译期抛错；normalize/locale 退化 | `docs/evidence/intl.json` |
| S2-3 O3 | WebView 数据面 | ✅ cleartext/secure-context/localStorage/SSE/fetch 全绿 | `docs/evidence/o3.json` + 截图 |
| S2-4 O4 | 解包耗时/幂等 | ✅ 18.0s 冷解（27,179 文件/375MB），marker 0ms 跳过 | o4-report.json（run-as 读回） |
| S2-5 O5 | spawn sh 语义 | ✅ 三事件+哨兵行+嵌套 | `docs/evidence/spawn.json` |
| S2-6 O7 | execPath | ✅ app_process64 ⇒ 补丁 0004 自动进程内回退 | `docs/evidence/basic.json` |
| S2-7 | 探针清理 | 验收时 app/payload 源码 grep 无探针残留（结论文档保留） | ✅（cleanup 提交 ccb8923） |

## S3 规范文档体系

| # | 需求 | 验收 | as-built |
|---|---|---|---|
| S3-1 | specs/ 十根文档 | README/SPECS_CHECKLIST/STRUCTURE/TECH/ARCHITECTURE/constitution/overall-spec/plan/data-model/test-cases 存在；无 API.md、overall-api.md | ✅（STRUCTURE 随最终目录核对） |
| S3-2 | 模块目录 | `NNN-<模块>-<二级模块>/` × 7（101–107），各含 spec.md+plan.md | ✅ |
| S3-3 | STRUCTURE 一致性 | STRUCTURE.md 与实际目录抽查一致 | ✅（生成后核对） |

## S4 Phase 1 端到端链路

| # | 需求 | 验收 | as-built |
|---|---|---|---|
| S4-1 | 载荷组装 | `node scripts/assemble-payload.mjs --apply` 产出 assets tar.gz+version；6 条补丁标记进编译产物；pi-web 收尾 pristine | ✅（本轮构建） |
| S4-2 | Kotlin 壳 | 装机启动 → 加载页阶段文本 → WebView 渲染 Pi Web UI 首屏 | ✅（模拟器截图+`/api/web-auth` 200） |
| S4-3 | 就绪判定 | marker 端口 + web-auth 200 才 Ready | ✅（PiDesktopRuntime 实现） |
| S4-4 | 基础功能 | 配 DeepSeek Key（deepseek-flash）+ 建工作区 + 一轮对话 + 一次看图分析 | ✅（E2E 见 `docs/002` §E2E） |
| S4-5 | 会话持久化 | 重启应用后会话仍在 | ✅（E2E 重启核对） |

## S5 纪律

| # | 需求 | 验收 | as-built |
|---|---|---|---|
| S5-1 | 敏感信息 | 全仓 grep 无真实 Key/密码/凭证 | ✅（扫描记录见 107 模块） |
| S5-2 | 提交纪律 | 分阶段提交，注释=Conventional 标题+变更列表，无 AI 署名 | ✅（git log 可核） |
| S5-3 | 评审 | requesting-code-review 发起 + receiving-code-review 处理 | ✅（评审记录） |
