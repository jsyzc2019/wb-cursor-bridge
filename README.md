# wb-cursor-bridge

把 **Cursor CLI** 包装成一个受治理的 MCP 子代理，让 **WorkBuddy**（主）调度它执行代码任务。

- **WorkBuddy 是唯一的控制面**（Supervisor），Cursor 是无状态、可替换的执行器（Worker）。
- **单向控制面 + 双向数据面**：Cursor 可以回问取证，但不能反向派活，杜绝控制环路。
- 用 MCP 承载传输、按 **A2A 语义**建模（异步任务 + 会话接续 + 产物可追溯），后续换传输层上层零改动。
- 另起一个 **A2A v1.0 HTTP 服务面**（`/.well-known/agent.json` + JSON-RPC 2.0），让另一个 agent 能直接发现并调度它。

目标平台：**win-x64**（同时可在 macOS / Linux 运行）。

---

## 一键安装（Windows）

1. 解压 `wb-cursor-bridge-v<version>-win-x64.zip`（例如 `wb-cursor-bridge-v0.4.0-win-x64.zip`）
2. 在解压目录执行：

```powershell
# 交互式（会提示输入仓库路径）
powershell -ExecutionPolicy Bypass -File install.ps1

# 或一次性给全参数
powershell -ExecutionPolicy Bypass -File install.ps1 `
  -WorkspaceRoots "C:\src\api;C:\src\web" `
  -MaxConcurrency 4 -TimeoutSec 900
```

安装器会：

| 步骤 | 行为 |
|---|---|
| 校验 | 工作区根目录存在；拒绝非法路径 |
| 运行时 | 复用 PATH 上的 Node 18+；没有则用 `-BundleNode` 下载私有运行时 |
| Cursor | 自动探测 `agent.exe`，探测不到只告警不失败 |
| 配置 | 写入 `%LOCALAPPDATA%\wb-cursor-bridge\config.json` |
| 注册 | 同时注册到 WorkBuddy/CodeBuddy（`~/.codebuddy/.mcp.json`）与 Cursor（`~/.cursor/mcp.json`），**保留原有条目并自动备份** |
| 自检 | 启动一次 bridge 并输出健康报告 |

常用参数：`-BundleNode`、`-SkipMcp`、`-Force`、`-AdminPort 7801`、`-CursorBin <path>`、`-NodeVersion v22.12.0`、`-AdminShutdownToken <token>`、`-NodeMirror <url>`、`-NodeOfflinePackage <zip>`。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1          # 保留日志与审计
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   # 一并清除状态
```

> **为什么 MCP 入口指向 `node.exe` 而不是 `launcher.cmd`**：MCP 客户端用 `child_process.spawn`
> 启动 server，而 Node 在不经过 shell 时拒绝执行 `.cmd/.bat`。`launcher.cmd` 保留给人工排障。

---

## 工具（9 个）

| 工具 | 用途 |
|---|---|
| `cursor_run` | 派发任务，**立即返回 jobId，永不阻塞** |
| `cursor_status` | 轮询；`since` 增量取事件，`waitSeconds` 最多阻塞 55s |
| `cursor_reply` | 追问；通过 `threadId` 接续 Cursor 侧上下文 |
| `cursor_cancel` | 取消并杀掉整个进程树 |
| `cursor_list` | 列出近期任务与状态 |
| `cursor_diff` | 查看 `execute` 任务的改动文件、diffstat、分页 patch |
| `bridge_health` | 预检：二进制、白名单、状态目录、并发、指标 |
| `bridge_stats` | 成功率 / 耗时 / tier 分布 |
| `bridge_shutdown` | 取消在途任务、落盘、退出 |

### 权限分档

| tier | Cursor 参数 | 能力 | 隔离 |
|---|---|---|---|
| `consult` | `--mode ask` | 只读问答 | 无 |
| `plan` | `--mode plan` | 只读规划 | 无 |
| `execute` | `--force` | 可写 | **bridge 托管的 git worktree** |

调用方只选档位，永远不传 CLI flag —— 权限策略集中在 bridge，不会被上层 prompt 绕过。

---

## 工作原理

```
WorkBuddy ──MCP(stdio)──▶ wb-cursor-bridge ──spawn──▶ agent -p --output-format stream-json
                              │                              │
                              ├─ 路径白名单                   └─ git worktree（execute 档）
                              ├─ 超时 / 并发 / 进程组终止
                              ├─ 事件 JSONL 审计
                              └─ patch / report 产物落盘
```

`execute` 任务完成后，bridge 会先把改动导出为 patch 与 report，再删除 worktree —— 你的检出目录始终不被污染。

---

## A2A 互操作（Agent2Agent v1.0）

除了 MCP 控制面，bridge 还能以一个**合规的 A2A agent** 身份被另一个 agent 发现并对话——
复用同一套 `JobManager` 引擎，只是把 A2A 请求翻译成引擎调用、把引擎状态翻译成 A2A 响应。
设置 `CURSOR_BRIDGE_A2A_PORT` 为非 0 即可启用（沿用 `adminPort` 的"0 = 关闭"约定）。

### 发现

```bash
curl http://127.0.0.1:<a2aPort>/.well-known/agent.json
```

返回遵循 A2A schema 的 Agent Card：`protocolVersion`、`capabilities`（streaming /
pushNotifications / stateTransitionHistory）、按 workspace root 派生的 `skills[]`、
以及启用鉴权时的 `securitySchemes` / `security`。

### 端点与方法

- **JSON-RPC 2.0** 全部 `POST /a2a`：
  - `message/send`：派发任务（带 `message.taskId` 时续跑既有 `input-required` 任务，闭环同一任务 id）
  - `tasks/get`：支持 `historyLength` 取对话历史
  - `tasks/cancel`：仅 `submitted` / `working` / `input-required` 可取消，终态返回 `TASK_NOT_CANCELABLE(-32002)`
  - `message/stream` / `tasks/resubscribe`：以 `text/event-stream` 推送 `status-update` / `artifact-update`，终态带 `final`
- **错误码**：`TASK_NOT_FOUND(-32001)` / `INVALID_PARAMS` / `TASK_NOT_CANCELABLE(-32002)` /
  `METHOD_NOT_FOUND(-32601)` / `UNSUPPORTED_OPERATION(-32004)` / `AUTH_REQUIRED(-32097)`

### 关键语义约定

> **A2A 文本在 `parts[].text`，不在顶层 `.text`；`taskId` 是 Message 的顶层字段**（不在 metadata）。
> 续跑/跟进沿用父任务的 `contextId`；产物以标准 `Artifact[]` 暴露，input-required 中断态保留在同一任务 id 上。

### 推送通知（可选）

在 `message/send` 的 `message.metadata.pushNotification` 带上 `{ "url": "<webhook>", "token": "..." }`，
任务终态时 bridge 会向该 webhook `POST` 一个 `status-update` 事件（含 3 次重试）。

### 鉴权（可选）

设置 `CURSOR_BRIDGE_A2A_AUTH_TOKEN` 后，所有 `POST /a2a` 必须携带 `Authorization: Bearer <token>`
或 header `X-A2A-Token: <token>`，否则返回 `401 AUTH_REQUIRED(-32097)`。Agent Card 端点保持公开。

### A2A v1.0 迁移路线（可选，默认 v0.3.0）

bridge 已内置 v1.0 序列化边界（`src/a2a/compat.ts`），通过 `CURSOR_BRIDGE_A2A_PROTOCOL_VERSION=1.0` 启用，无需改代码：

- **v0.3.0（默认）**：零回归，沿用既有 Agent Card / Task 形状。
- **v1.0**：Agent Card 的 `protocolVersion` 移入 `supportedInterfaces['a2a/v1.0']`，顶层新增 `extensions: []`；Task/Artifact 的 `FileContent` 字段重映射（`name→filename`、`mimeType→mediaType`、`uri→url`、`bytes_inline→raw`）。`message/send` / `tasks/get` / `tasks/cancel` / `message/stream` 方法名与 JSON-RPC 信封不变。

> v1.0 与 v0.3.0 走同一套引擎与同一端口，仅序列化形状不同；建议先在受控环境用下方最小客户端验证 Card/Task 形状后，再对全网客户端切版本。

**最小 v1.0 客户端示例**（fetch + JSON-RPC）：

```bash
# 1) 取 v1.0 Agent Card（注意 protocolVersion 已不在顶层，改看 supportedInterfaces）
curl -s http://127.0.0.1:<a2aPort>/.well-known/agent.json | jq '{supportedInterfaces, extensions, name}'

# 2) 派发任务（阻塞等待终态；v1.0 同样用顶层 taskId + parts[].text）
curl -s -X POST http://127.0.0.1:<a2aPort>/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
        "message":{"role":"user","parts":[{"text":"在 demo 仓库加一个 hello 函数"}],
                   "messageId":"m1"},
        "configuration":{"blocking":true,"acceptedOutputModes":["text/plain"]}}}'

# 3) 取回 Task，校验 v1.0 FileContent 形状（filename/mediaType/url/raw）
curl -s -X POST http://127.0.0.1:<a2aPort>/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>","historyLength":10}}' \
  | jq '.result.artifacts[]?.parts[]? | select(.file) | .file | {filename, mediaType, url}'
```

---

## 配置

`%LOCALAPPDATA%\wb-cursor-bridge\config.json`（也可用同名环境变量覆盖）：

| 键 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `cursorBin` / `CURSOR_BIN` | `agent.exe` | Cursor CLI 路径 |
| `workspaceRoots` / `CURSOR_BRIDGE_WORKSPACE_ROOTS` | 空 | 允许的仓库根，`;` 分隔；为空则**所有任务被拒** |
| `stateDir` / `CURSOR_BRIDGE_STATE_DIR` | `%LOCALAPPDATA%\wb-cursor-bridge` | 索引、日志、产物 |
| `defaultTimeoutSec` / `CURSOR_BRIDGE_TIMEOUT_SEC` | `900` | 单任务墙钟上限 |
| `maxConcurrency` / `CURSOR_BRIDGE_MAX_CONCURRENCY` | `4` | 超限快速失败 |
| `adminPort` / `CURSOR_BRIDGE_ADMIN_PORT` | `0`（关闭） | 开启后提供 `/healthz` `/stats` `/jobs`（仅监听 127.0.0.1） |
| `adminShutdownToken` / `CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN` | 空 | 设置后 `/admin/shutdown` 需携带 token |
| `eventLogDir` / `CURSOR_BRIDGE_EVENT_LOG_DIR` | 空 | 设置后每个 job 的事件会异步追加到 `<dir>/<jobId>/events.jsonl` |
| `persistEvents` / `CURSOR_BRIDGE_PERSIST_EVENTS` | `0` | 设为 `1` 时自动使用 `<stateDir>/events` |
| `logLevel` / `CURSOR_BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `a2aPort` / `CURSOR_BRIDGE_A2A_PORT` | `0`（关闭） | 设为非 0 后暴露 A2A HTTP 服务面（Agent Card + JSON-RPC） |
| `a2aHost` / `CURSOR_BRIDGE_A2A_HOST` | `127.0.0.1` | 监听地址；设 `0.0.0.0` 对外暴露（需配合 `a2aAuthToken`） |
| `a2aAuthToken` / `CURSOR_BRIDGE_A2A_AUTH_TOKEN` | 空 | 设置后 A2A 端点（含 `/healthz` `/metrics` `/version` / 产物下载）需 `Authorization: Bearer` 或 `X-A2A-Token`，否则 401；未设置则控制面仅限本机 |
| `a2aPublicUrl` / `CURSOR_BRIDGE_A2A_PUBLIC_URL` | 空 | 对外可达地址，用于 Agent Card 中的 `url`（反向代理 / 容器场景） |
| `a2aPushUrlAllowlist` / `CURSOR_BRIDGE_A2A_PUSH_ALLOWLIST` | 空 | 逗号分隔的受信 webhook 主机白名单；开启 push 且目标为私有/loopback 时必须命中此项（SSRF 防护逃逸口） |
| `a2aProtocolVersion` / `CURSOR_BRIDGE_A2A_PROTOCOL_VERSION` | `0.3.0` | A2A 协议版本；设为 `1.0` 即输出 v1.0 合规的 Agent Card 与 Task（FileContent 字段重映射 `name→filename`/`mimeType→mediaType`/`uri→url`/`bytes_inline→raw`、`protocolVersion` 移入 `supportedInterfaces`、新增 `extensions[]`）。默认 `0.3.0` 保持零回归 |
| `a2aBlockingMaxMs` / `CURSOR_BRIDGE_A2A_BLOCKING_MAX_MS` | `90000` | `message/send` 在 `configuration.blocking` 为真时阻塞等待任务终态的上限（ms），区间 `[1000, 600000]`；超时回异步 task |
| `a2aRateLimitPerSec` / `CURSOR_BRIDGE_A2A_RATE_LIMIT_PER_SEC` | `250` | `POST /a2a` 令牌桶限流速率（请求/秒），区间 `[1, 100000]`；超限返回 `429 RATE_LIMITED(-32050)` |
| `a2aCorsOrigins` / `CURSOR_BRIDGE_A2A_CORS_ORIGINS` | 空 | 逗号分隔的允许跨域 origin 列表；命中时反射 `Access-Control-Allow-Origin`，默认关闭（不输出任何 CORS 头） |
| `a2aSkills` / `file.a2aSkills` | 空 | 额外 skill 声明（`ExtraSkill[]`：`{ id, name, root, description?, tags?, tier? }`），`root` 自动 `expandPath` 且须落在 `workspaceRoots` 内，越界被 `log.warn` 丢弃 |

---

## 安全模型

- **工作区白名单**：路径需同时通过字面与 realpath 双重校验；拒绝 `..` 越界、符号链接逃逸、NUL 字节、DOS 保留设备名、8.3 短名。
- **进程隔离**：`execute` 永远在独立 git worktree 内执行；Windows 上用 `taskkill /T /F` 杀整棵进程树，POSIX 上杀进程组。
- **资源上限**：超时强杀、并发上限、结果体积上限、事件环形缓冲、job LRU。
- **审计**：任务索引与产物原子落盘；可选开启事件 JSONL 持久化（`CURSOR_BRIDGE_PERSIST_EVENTS=1`）以满足强审计需求。崩溃后重启会把遗留 `running` 任务标记为 `orphaned`。
- **stdout 洁癖**：任何 `console.log` 都被重定向到 stderr，避免污染 JSON-RPC 流。

> `bridge_stats` 中的 `totalDurationMs` 是进程内运行时计数，长期运行后可能丢失整数精度；需要长期精确统计时请外部系统定期拉取 `/stats` 后重启 bridge。

> ⚠️ MCP server 不受调用方沙箱与审批策略约束 —— **bridge 本身就是策略边界**。
> 白名单、worktree、超时、并发、审计必须全部保留，不要为了方便关掉。

---

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 97 项：49 单元 + 15 端到端 + 3 admin HTTP + 30 A2A
npm run test:stress      # 压力：高并发 / 反复 cancel-reply / hang 超时
npm run test:fault       # 故障：磁盘/权限异常的优雅降级
npm run verify           # 门禁：typecheck + npm test + stress + fault + release 构建
npm run test:a2a         # 仅跑 A2A 互操作 30 项（Agent Card / message/send / tasks/get / cancel / stream / push / auth / blocking / 协商 / 限流 / CORS / v1.0 / skills）
npm run verify:e2e       # 端到端真跑实证：真实 dist 二进制 + fake-agent，54 项（v0.3.0/v1.0/鉴权/限流/CORS/产物可达/input-required 续跑/push 真投 + SSRF 拒绝/tasks/cancel 真实取消与清理/崩溃清理…），已纳入 Linux CI 门禁（脚本已跨平台可跑，Windows CI 待验证后启用）
npm run build            # 编译到 dist/
npm run build:release    # 产出 release/wb-cursor-bridge-v<version>-win-x64.zip
npm run verify           # 上述全流程（不含 stress/fault）
```

端到端测试用一个模拟 `agent` 二进制（`test/fake-agent.mjs`）讲同一种 stream-json 协议，因此**无需 Cursor 账号或网络**即可验证全链路。真实 Cursor CLI 集成见下文。

PowerShell 脚本测试（安装器会重写用户配置，值得单独跑）：

```bash
pwsh -File test/mcp-config.test.ps1
```

### 目录结构

```
src/
  index.ts          入口：协议装配、stdout 保护、优雅关闭
  config.ts         配置解析与校验
  tools.ts          9 个 MCP 工具的定义与分发
  runner.ts         任务调度、worktree 托管、指标、input-required 续跑
  store.ts          任务仓库：持久化、LRU、崩溃恢复
  a2a/              A2A v1.0 语义层：types / convert / card / skills / watch / server
  logger.ts         分级日志 + JSONL 轮转（按写入次数触发 stat）
  admin.ts          可选 HTTP 运维端点（shutdown 支持 token）
  version.ts        版本号唯一来源（测试断言与 package.json 一致）
  cursor/
    cli.ts          Cursor 调用、进程管理、结果装配
    parse.ts        stream-json 解析（容错）
  util/
    paths.ts        Windows 感知的路径白名单
    processes.ts    跨平台进程树终止
    git.ts          worktree 生命周期与产物抓取
    ndjson.ts       增量 JSON 行读取
scripts/
  build-release.mjs 单文件打包 + ZIP（自实现 zip writer，零依赖）
  install.ps1       一键安装
  uninstall.ps1     卸载
  lib/              安装器共享库（MCP 配置合并）
```

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `cursor binary not found` | `bridge_health` 会指出探测路径；用 `-CursorBin` 或 `CURSOR_BIN` 指定 |
| `outside every configured root` | 任务路径不在白名单内，检查 `workspaceRoots` |
| `concurrency limit reached` | 调高 `maxConcurrency`，或等在途任务结束 |
| 任务一直 `running` | 用 `cursor_cancel`；默认 900s 会自动超时 |
| 启动即退出码 2 | 配置非法，看 `%LOCALAPPDATA%\wb-cursor-bridge\bridge.log` |
| MCP 工具没出现 | 确认配置写在 `~/.codebuddy/.mcp.json` / `~/.cursor/mcp.json`，并重启客户端 |
| 想看实时状态 | 设 `adminPort`，访问 `http://127.0.0.1:<port>/healthz` |
| shutdown 端点 401 | 设置了 `adminShutdownToken`，请求需带 header `X-Shutdown-Token: <token>` 或 query `?token=<token>` |
| A2A 端点 401 | 设置了 `a2aAuthToken`，`POST /a2a`、`/healthz`、`/metrics`、`/version`、产物下载均需 `Authorization: Bearer <token>` 或 `X-A2A-Token: <token>`；Agent Card 端点无需鉴权 |
| A2A 控制面暴露告警 | 把 `a2aHost` 设为 `0.0.0.0` 却未设 `a2aAuthToken`，启动会打印告警——控制面将对全网可达，务必同时设置 token |
| push 通知没生效 | 开启 push 必须设置 `a2aAuthToken`；webhook 目标为私有/loopback 时需把主机加入 `a2aPushUrlAllowlist`（SSRF 防护） |

---

## 版本历史

完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 要点 |
|---|---|
| **0.4.0** | A+ 路线图收尾：消费 `configuration.blocking`/`acceptedOutputModes`/`historyLength`、JSON-RPC 通知不回包、令牌桶限流、CORS、`unhandledRejection` 阈值退出、`bridge_shutdown` flush、worktree `try/finally` 清理、`src/artifacts.ts` 解耦、skill 多扩展点、**A2A v1.0 迁移路线**（`compat.ts` 双版本序列化），97 项测试 |
| **0.3.4** | A2A 真互联：Agent Card 发现 + JSON-RPC 语义层（message/send、tasks/get、tasks/cancel、message/stream SSE、push 通知、Bearer 鉴权）；生产级硬化（LRU 保 input-required、文件产物可寻址、SSRF 防护、资源/并发修复、/healthz /metrics /version），83 项测试 |
| **0.3.3** | P3 加固：可选事件 JSONL 持久化、压力/故障测试、Node 镜像与离线包、Windows CI、metrics 说明 |
| **0.3.2** | P1/P2 风险消除：参数 limit 钳制、kill 结果记录、persist 失败告警、同步 shutdown、构建后 smoke |
| **0.3.1** | 全仓审计修复：安装器升级停不掉旧进程、`-RemovePayload` 崩溃、配置错误不含项名 |
| **0.3.0** | health 缓存、admin shutdown token、`-NodeVersion`、发布物六处标注版本号 |
| **0.2.0** | 首个工程化版本：9 工具、bridge 托管 worktree、win-x64 一键安装 |

---

## 真实 Cursor CLI 集成

仓库默认使用 `test/fake-agent.mjs` 跑测试，不依赖 Cursor 授权。若要在真实 Cursor CLI 上验证：

1. 安装 Cursor CLI 并确认 `agent.exe --help` 可用。
2. 在 Windows PowerShell 执行：

```powershell
$env:CURSOR_BIN = 'C:\Users\<you>\AppData\Local\Programs\cursor\bin\agent.exe'
$env:CURSOR_BRIDGE_WORKSPACE_ROOTS = 'C:\src\demo'
node --test test/e2e.test.mjs
```

3. 或手动触发 `.github/workflows/real-cursor-snapshot.yml`，填写 `cursorBin` 与 `workspaceRoots`。

真实 Cursor 的输出字段可能随版本漂移；遇到解析失败请在 `bridge.log` 中抓取原始行并提 issue。

---

## 文档与报告

本仓库随附以下设计、审计与变更文档，建议按"方案 → 审计 → 变更"的顺序阅读：

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 项目说明、一键安装、工具（9 个）、A2A 服务面、配置表、排障、版本历史 |
| [CHANGELOG.md](CHANGELOG.md) | 语义化版本变更记录（0.2.0 → 0.4.0），版本号来源唯一（`src/version.ts`） |
| [AUDIT-PROD-GRADE-A+.md](AUDIT-PROD-GRADE-A+.md) | **A+ 生产级全栈审计与路线图**：六维审计 + Phase 0–3 落地 + 端到端真跑实证（54/54 检查全绿） |
| [AUDIT-REPORT-A2A-v0.3.3.md](AUDIT-REPORT-A2A-v0.3.3.md) | A2A v0.3.3 专项审计报告（Agent Card / message/send / tasks / stream / push / auth 对照表） |
| [AUDIT-REPORT-v0.3.3.md](AUDIT-REPORT-v0.3.3.md) | v0.3.3 全仓审计报告 |
| [WorkBuddy-Cursor-双智能体互操作方案.md](WorkBuddy-Cursor-双智能体互操作方案.md) | 原始方案设计：双智能体互操作架构、控制面/数据面划分、WorkBuddy↔Cursor 治理边界 |

> 阅读建议：先看**方案**理解架构动机与治理边界，再读 **A+ 审计报告**了解生产级演进路线与真跑实证结论，最后按需在 **CHANGELOG** 回溯细节。

## License

MIT