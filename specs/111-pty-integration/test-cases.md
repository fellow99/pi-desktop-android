# 111-pty-integration — test-cases

> 依据：spec.md C1–C6、plan P0–P2。**敏感信息纪律**：模型 API Key 属凭据，**不落盘本文件**——
> 测试时经应用内设置/环境变量运行时注入，测试记录不含密钥明文（见 §末尾「凭据处置」）。

## TC-001: [P0] 依赖三件随包
- **P1 / Build** ｜ 前置：`verify-runtime`/`verify-pty --check` 绿
- 步骤：`./gradlew :app:assembleDebug`；`unzip -l` 检查 APK libs
- 期望：`libnode.so` + `libc++_shared.so` + `libpty_node.so` 三件在 `lib/<abi>/`；size/sha 与 lock 一致
- 状态：PENDING

## TC-002: [P0] 锁门禁
- **P1 / Build** ｜ 前置：P0 文件改完
- 步骤：`node scripts/verify-runtime.mjs`、`node scripts/verify-pty.mjs`
- 期望：退出码 0；3 个 .so 的 SHA-256 = lock；ELF 门禁过（含 pty `DT_NEEDED libnode.so`）
- 状态：PENDING

## TC-003: [P0] 16KB 页对齐
- **P1 / Build** ｜ 步骤：packaging 门禁 / ELF 检查
- 期望：三 .so `PT_LOAD` 16KB 对齐；`useLegacyPackaging=false` 生效
- 状态：PENDING

## TC-004: [P0] node-pty 1.1.0 运行期 JS
- **P1 / Build** ｜ 前置：assemble-overlay
- 步骤：`pi-web-launch.js` 引导期打印 `node-pty` 版本
- 期望：解析为 **1.1.0**（非 pi-web 声明的 1.2.0-beta.15）；`prebuilds/` 不在载荷
- 状态：PENDING

## TC-005: [P1] 启动期常驻加载器
- **P1 / Integration** ｜ 前置：APK 装真机
- 步骤：首启；读 `pi-web.boot-facts.json`
- 期望：`pty.ready=true`；`libpty_node.so` 装载无异常；引擎 Intl 逐项 ✅（26.13.0 复验）
- 状态：PENDING

## TC-006: [P1] 装载失败结构化（负例，可选）
- **P3 / Edge** ｜ 步骤：移除 libpty_node.so 的情形（文本/judge 逻辑审读）
- 期望：capability unsupported + boot-facts 记录；不静默降级成假终端
- 状态：PENDING

## TC-007: [P1] 能力翻转
- **P1 / Functional** ｜ 步骤：`GET /api/terminal`
- 期望：HTTP 200 `{supported:true, platform:"android", …}`；POST 不再 501
- 状态：PENDING

## TC-008: [P1] 最简 PTY bash 工具
- **P1 / Functional** ｜ 步骤：调最简工具跑 `echo ok; tty`；跑 `exit 3`
- 期望：输出含 `ok` + `/dev/pts/N`；`exit 3` 返回 rc=3（onExit 语义）
- 状态：PENDING

## TC-009: [P1] 最简工具超时/围栏
- **P2 / Edge** ｜ 步骤：`sleep 200`（120s 超时）；越界 cwd 访问
- 期望：超时后进程组被 kill、shell 不泄漏；越界被拒
- 状态：PENDING

## TC-010: [P2] 终端面板 E2E（真机）
- **P1 / Integration** ｜ 前置：真机就绪、工作区创建
- 步骤：T1a `tty`→pts/N；T1b echo 回显+颜色；T1c resize→`stty size` 跟随；T1d Ctrl-C 中断前台、shell 存活；T1e `exit` 关闭+清理
- 期望：全部通过，logcat 无异常
- 状态：PENDING

## TC-011: [P2] 核心回归（26.13.0）
- **P1 / Regression** ｜ 前置：模型已配（key 运行时注入）
- 步骤：一次对话「介绍一下你自己」；一次看图分析；git/pnpm 自检复跑
- 期望：对话流式正常、看图识别正确、自检通过
- 状态：PENDING

## TC-012: [P2] 构建与合规
- **P2 / Build** ｜ 步骤：`regression.mjs` + `compliance-check.mjs`
- 期望：四件套基线过（含包体、签名、facts）；G3 native 合规过
- 状态：PENDING

## 凭据处置（敏感信息纪律）
- DeepSeek API Key 等凭据**仅运行时经应用设置注入**（`files/pi-agent/auth.json`，0600），**不写入任何
  spec/plan/tasks/test-cases/tester/Report 文档**；日志/报告若出现密钥痕迹则脱敏后再落盘。
- 测试 URL / 账号 / 口令：本需求无外部登录口令；仅本机 loopback 服务（随机端口、免密）。

## 测试计划执行序
1. P0：TC-001–004（构建/门禁，宿主一键）
2. P1：TC-005–009（装机后引导期 + 能力探针 + 最简工具）
3. P2：TC-010–012（终端面板 + 回归 + 合规）
