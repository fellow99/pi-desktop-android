// android-pty — pi-agent 扩展（Phase 4 路线 A：node-pty android-arm64 原生件）
//
// ⚠️ 本扩展是 **评估/验证面**，不是产品终端：terminal.pty 能力仍为结构化 unsupported
// （规划 §8 #16 暂缓决策未撤销）；本扩展让「复活路线 A 的原生件」能被装载自检与
// /pty-test 命令人工验证（真机交接窗口即可测），复活与否仍交用户决策。
//
// vendored：vendor/node-pty = node-pty@1.1.0 npm 包（lib/ 预编译 JS）+ build/Release/pty.node
// （本工程 NDK r28c 交叉编译，sha256 锁见 vendor/pty.node.lock.json；规划 §10 单源纪律同样适用——
//  node-pty 源码未改动，只有构建产物）。
//
// 加载失败（ABI/符号/SELinux）都按宪法 A6 结构化如实上报，绝不静默降级。
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "vendor", "node-pty");

function loadPty() {
  if (!existsSync(join(VENDOR, "build", "Release", "pty.node"))) {
    throw new Error("vendored pty.node 缺失（载荷不完整？）：" + VENDOR);
  }
  const req = createRequire(join(VENDOR, "package.json"));
  return req(VENDOR); // node-pty main = lib/index.js → utils.loadNative(build/Release/pty.node)
}

export default function register(pi) {
  pi.registerCommand("pty-test", {
    description: "装载 vendored node-pty 并在真 PTY 里跑一次 sh 回显（路线 A 验证）",
    handler: async (_args, ctx) => {
      let report;
      try {
        const pty = loadPty();
        const result = await new Promise((resolve) => {
          let out = "";
          const term = pty.spawn("/system/bin/sh", ["-c", "echo PTY_ROUNDTRIP_OK; id; tty"], {
            name: "xterm-color",
            cwd: ctx.cwd || process.cwd(),
            env: process.env,
          });
          const timer = setTimeout(() => {
            try { term.kill(); } catch { /* 已退 */ }
            resolve({ out, timedOut: true });
          }, 10_000);
          term.onData((data) => {
            out += data;
            if (out.includes("PTY_ROUNDTRIP_OK")) {
              clearTimeout(timer);
              setTimeout(() => { try { term.kill(); } catch { /* 已退 */ } resolve({ out, timedOut: false }); }, 300);
            }
          });
        });
        const ok = result.out.includes("PTY_ROUNDTRIP_OK");
        report = (ok ? "✓ PTY 回程成功" : "⚠ 未捕获回显") + "（" + (result.timedOut ? "10s 超时" : "完成") + "）\n" +
          "---- pty 输出 ----\n" + result.out.slice(0, 600);
      } catch (err) {
        report = "✗ pty.node 装载/执行失败：" + ((err && err.message) || err) +
          "\n（ABI/符号/SELinux 归因见 pi-web.ptynode-selftest.json 与 docs/002 O6 节）";
      }
      if (ctx.hasUI) ctx.ui.notify(report, report.startsWith("✓") ? "info" : "warning");
      else console.log(report);
    },
  });
}
