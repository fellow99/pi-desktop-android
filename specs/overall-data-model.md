# overall-data-model.md — 数据模型

> 本工程的数据落点与生命周期。全部在**应用沙箱**内；外存仅 app-specific 目录（宪法 C8）。

## 目录模型（设备上）

```
/data/user/0/org.fellow99.pi.PiDesktopAndroid/          # 应用沙箱（UID 隔离）
├── files/
│   ├── node-bridge/                                     # 库 HOME（库契约）
│   │   ├── node_bridge.log                              # 库日志（fd1/2 管道回读）
│   │   ├── node_bridge.log.crash.json                   # 崩溃记录（lastCrash()）
│   │   ├── tmp/                                         # TMPDIR（库管）
│   │   └── payload/                                     # payloadRoot（载荷根，可写）
│   │       ├── bootstrap.js / host.js / selfcheck.js     # 库内建载荷（materializeBuiltinPayload）
│   │       ├── .ready-<sha12>                           # 解包幂等 marker（PayloadArchive）
│   │       ├── pi-web/                                  # 主载荷（组装产物解包落点）
│   │       │   ├── package.json / next.config.ts / public/ / .next/ / node_modules/
│   │       │   ├── pi-web-launch.js / env.js / jitless/ / config/ / extensions/ / skills/
│   │       │   └── …
│   │       └── pi-web.ready.json                        # 就绪 marker（真实端口；launch 脚本写）
│   ├── pi-agent/                                        # PI_CODING_AGENT_DIR（pi 数据/扩展/凭据根）
│   │   ├── auth.json                                    # 模型凭据（0600；API Key 只落这里）
│   │   ├── sessions/                                    # 会话 JSONL（持久化）
│   │   ├── extensions/                                  # 随包扩展物化落点（launch 脚本复制）
│   │   └── skills/                                      # 随包技能物化落点
│   └── host-log/host.log                                # 宿主能力调用留痕（log.hilog）
├── cache/payload-incoming/pi-web.tar.gz                 # 解包前暂存（PayloadArchive 输入）
└── shared_prefs/ · cache/                               # 系统标准目录（壳未用）

/storage/emulated/0/Android/data/org.fellow99.pi.PiDesktopAndroid/files/
└── workspace/                                           # 默认工作区根（PI_ANDROID_ROOTS sandbox；免权限、用户可见）
```

## 关键数据项

| 数据 | 生成者 | 生命周期 | 说明 |
|---|---|---|---|
| `pi-web.ready.json` | pi-web-launch | 每次启动覆盖 | `{ok,hostname,port,url,pid,node,elapsedMs}`；宿主读它拿端口（不猜） |
| `.ready-<sha12>` | PayloadArchive | 首启解包后常驻 | 归档 SHA-256 前 12 位；命中即跳过解包（幂等） |
| 会话 JSONL | pi agent | 用户删除前持久 | 重启应用后会话仍在（Phase 1 出口判据） |
| `auth.json` | pi-web API/UI | 持久（0600） | **唯一**允许出现 API Key 的位置（宪法 C9） |
| `config/settings.json` | 随包 | 只读默认 | `shellPath=/system/bin/sh`、defaultTools、defaultProjectTrust=ask |
| `config/mcp.json` | 随包 | 只读默认 | MCP 服务器清单（空） |
| 宿主日志 | HostCapabilities/log.hilog | 追加 | 能力调用审计（不含敏感值） |

## 载荷归档格式（Kotlin 解包器 ↔ Node 组装器的契约）

- 512B ustar 头：`name(100)` + `prefix(155)`；类型 `0`（文件）/`5`（目录）/`L`（GNU 长名）；
- `mtime=0`、条目排序、gzip level 9、结尾 1024 全零块 —— 同输入 ⇒ 同 SHA-256（幂等键稳定）；
- 条目根 = `pi-web/`；解包目标 = `payloadRoot`（即 `pi-web/**` 落到 `<filesDir>/node-bridge/payload/pi-web/**`）。
