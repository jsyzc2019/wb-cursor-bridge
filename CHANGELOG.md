# 更新日志

本项目的版本号遵循语义化版本（SemVer）：`MAJOR.MINOR.PATCH`。
`src/version.ts` 是版本号的唯一来源，测试会断言其与 `package.json` 一致——
版本不一致无法通过测试，因此不可能发出版本号错乱的包。

## 0.4.0 — 生产级审计收尾：v1.0 迁移路线 + 协议协商 + 限流/CORS + 资源生命周期硬化

闭合 AUDIT-PROD-GRADE-A+.md 中剩余的 **Phase 2 末段（#12/#14 通知、#15 CORS/限流）+ Phase 3（#16–#20）** 全部条目。
全仓测试由 83 → **97** 项（49 单元 + 15 端到端 + 3 admin + 30 A2A），`npm run verify` 全绿（typecheck + 4 套测试 + stress + fault + release 构建）。

### Phase 2 末段 — 协议保真与可观测

- **消费 `configuration.blocking`**（`server.ts`）：`message/send` 在 `configuration.blocking` 为真时阻塞轮询至任务终态，受 `a2aBlockingMaxMs` 上限保护（默认 90s，区间 `[1000, 600000]`）；超时回异步 task，非阻塞走原有异步语义。
- **消费 `acceptedOutputModes`**（`server.ts`）：`message/send` 启动前用 `assertOutputModesAccepted()` 校验 `configuration.acceptedOutputModes` 与 Agent Card 声明输出模式交集；无交集抛 `BridgeIncompatible` → `A2A_ERROR.INCOMPATIBLE_CONTENT_TYPES(-32005)`。
- **消费 `historyLength`**（`server.ts` / `watch.ts`）：`tasks/get` 与 `message/send` 的 history 截断受 `configuration.historyLength` 约束。
- **JSON-RPC 通知不回包**（`server.ts`）：无 `id` 的 `message/send` 执行副作用（建任务/续跑）但不回包；streaming 通知直接忽略——符合 JSON-RPC 2.0「通知不得响应」规范。
- **CORS**（`server.ts`）：`applyCors()` 反射指定 origin（`access-control-allow-origin`），仅当 `a2aCorsOrigins` 配置且命中时输出，默认关闭；`/a2a` OPTIONS 预检返回 204。

### Phase 3 — 扩展性与战略对齐

- **令牌桶限流**（`server.ts` `TokenBucket`，默认 refill=250/s，区间 `[1, 100000]`）：`POST /a2a` 前 `rateLimit.take(1)`，超限返回 `429` + `A2A_ERROR.RATE_LIMITED(-32050)`。
- **资源生命周期硬化**：
  - `runner.ts`：把 `runCursor()` 调用 + 产物捕获 + 终态判定包进 `try`，`finally` 中 `if (worktree) await removeWorktree(worktree)`——agent 二进制崩溃（`process.exit(7)`）也清理 worktree，杜绝泄漏（新增 a2a 测试 `worktree 不泄漏`）。
  - `index.ts`：`unhandledRejection` 由「立即退出」改为「滑动窗口阈值退出」（UNHANDLED_THRESHOLD=20、WINDOW=60s），超限才调 `shutdown('unhandledRejectionThreshold', 1)`；与 `uncaughtException` 立即退出形成不对称设计（瞬态噪声不杀进程，真失控才退出）。
  - `tools.ts` / `admin.ts`：`bridge_shutdown` 与 `/admin/shutdown` 改为 `mgr.shutdown().then(() => setTimeout(() => process.exit(x), 100).unref?.())`——shutdown 完成后再延迟 100ms 让传输层（stdio/SSE）flush，避免截断。
- **`src/artifacts.ts` 解耦**（新文件）：从 `runner.ts` 抽取 `buildArtifacts(job)` 与 `filePart()`（≤64KiB 内联 `bytes_inline`，输出标准 `name`），消除 `convert↔runner` 反向依赖；`runner.ts` 仍 `export { buildArtifacts }` 保公共表面兼容。
- **skill 多扩展点**（`skills.ts`）：新增 `ExtraSkill` 接口与 `deriveSkills(roots, defaultTier='execute', extra=[], log?)`——除每 root 一个 skill 外可声明额外 operator skill；`assertWorkspaceAllowed` 校验 root 在允许列表内，越界则 `log.warn` 并丢弃（新增 a2a 测试 `extra skills 过滤/上卡`）。
- **A2A v1.0 迁移路线**（战略，`src/a2a/compat.ts` 新文件）：
  - 新增 `A2AVersion = '0.3.0' | '1.0'` 与 `isV1()`。
  - `toV1Task(task)`（FileContent 字段重映射 `name→filename`、`mimeType→mediaType`、`uri→url`、`bytes_inline→raw`，用 `...rest` 剔除 v0.3.0 遗留字段）、`toV1Card(card, endpointUrl)`（`protocolVersion` 移入 `supportedInterfaces`，新增 `extensions: []`）。
  - `config.ts` 新增 `a2aProtocolVersion`（`CURSOR_BRIDGE_A2A_PROTOCOL_VERSION`，仅接受 `1.0` 否则回落 `0.3.0`）；server 按 `isV1(a2aVersion)` 调 `toV1Card()` / `toV1Task()`。
  - **默认仍是 v0.3.0（零回归）**，配置切到 `1.0` 即输出 v1.0 合规 Card/Task。

### 配置（新增 5 项）

- `a2aBlockingMaxMs` / `CURSOR_BRIDGE_A2A_BLOCKING_MAX_MS`（默认 90000，区间 `[1000, 600000]`）
- `a2aCorsOrigins` / `CURSOR_BRIDGE_A2A_CORS_ORIGINS`（默认空 = 关闭 CORS）
- `a2aSkills` / `file.a2aSkills`（`ExtraSkill[]`，路径自动 `expandPath`）
- `a2aProtocolVersion` / `CURSOR_BRIDGE_A2A_PROTOCOL_VERSION`（默认 `0.3.0`，设为 `1.0` 启用 v1.0 序列化）
- `a2aRateLimitPerSec` / `CURSOR_BRIDGE_A2A_RATE_LIMIT_PER_SEC`（默认 250，区间 `[1, 100000]`）

### 测试

- 全仓 83 → **97** 项：新增 a2a 15 项（worktree 不泄漏、blocking/acceptedOutputModes/historyLength、通知不回包、限流/默认不限流/CORS 开/CORS 关、v1.0 Card/v1.0 Task/v0.3.0 默认、extra skills 过滤/上卡）+ unit 6 项（artifacts `filePart` 内联/容错、compat `toV1Task`/`toV1Card` 字段重映射）。

### 验证

- `npm run verify` 全绿：typecheck + 97 项测试（49 单元 + 15 端到端 + 3 admin + 30 A2A）+ stress(3) + fault(2) + release 构建（v0.4.0 归档，687 KB 单文件 bundle）。
- **端到端真跑实证**（`scripts/e2e-empirical.mjs`，`npm run verify:e2e`）：真实拉起 `dist/index.js` 出货二进制 + 真实 `fake-agent`，通过真实 HTTP 驱动 A2A 全生命周期，**54/54 检查通过**——覆盖 v0.3.0/v1.0 双版本序列化、Agent Card 发现、`message/send` 异步/blocking、`acceptedOutputModes` 协商拒绝（-32005）、`message/stream` SSE 终态、`input-required` 同 id 续跑、令牌桶限流（429/`-32050`）、CORS 预检/反射、`Bearer` 鉴权（401/200）、产物远程 `fetch`（200 且内容含改动文件）、崩溃后 worktree 清理；**新增真实 HTTP webhook 的 push 通知真投（含 `x-a2a-push:1` 与 `Bearer` 注入）+ SSRF allowlist 拒绝负向**（S9/S10）；**新增 `tasks/cancel` 真跑**（S11：hang 任务进入 `working`→真实取消→终态 `canceled`→取消路径 `finally` 仍清理 worktree）。脚本已改为**跨平台可跑**（按 `os.platform()` 选 `fake-agent.sh`/`.cmd`，tree-kill 用进程组/`taskkill /T` 连带孙进程），为将来 Windows CI 真跑铺路；已并入 `scripts/validate-p3.mjs` 发布校验，并接入 `.github/workflows/ci.yml` Linux 门禁（`npm run verify:e2e`，发布即锁死 hardening）。

## 0.3.4（续）— 生产级审计修复（A+ 路线图 Phase 0 / Phase 1 + 部分 Phase 2）

对照 A2A 官方规范做生产级全栈审计（`AUDIT-PROD-GRADE-A+.md`）后，按优先级落地 P0/P1 修复，并顺带闭合若干协议保真项。
全仓测试由 71 → **83** 项（新增 12 项 A2A 端到端/单测回归），`npm run verify` 全绿（typecheck + 4 套测试 + release 构建）。

### P0 — 正确性 blocker

- **P0-A LRU 误杀 `input-required`**（`store.ts`）：新增 `isLive()`，断言 `running || input-required` 均不可被 LRU 驱逐；`evict()` 只驱逐终态任务。修复了"挂起等待人工输入的招牌 A2A 能力在 LRU 满时被驱逐、续跑 `reply()` 因 `notFound` 断裂"的契约杀手。
- **P0-B 文件产物协议字段错且本地不可达**（`runner.ts` / `convert.ts` / `server.ts`）：`filePart` 改为标准 `name`（此前误用 `filename`，与 `a2a/types.ts` 自相矛盾）；小文件（≤64 KiB）内联 `bytes_inline`；新增 `GET /a2a/artifacts/:taskId/:name` 端点（受 auth 守卫），`toTask` 把本地 `file://` URI 重写为该可达端点，远程 agent 可 `fetch` 取回 patch/report。

### P1 — 生产硬化（并发 / 资源 / 安全）

- `watch.ts`：`subscribeTask` 的 `sleep()` 每次轮询只注册一次 abort 监听（正常完成后移除），消除长 SSE 累积死监听的泄漏。
- `watch.ts` / `server.ts`：`watchAndPush()` 接受 `AbortSignal`，客户端断开 SSE 后推送观察器随 `signal.aborted` 即终止。
- `runner.ts`：`cancel()` 两条分支都记 `metrics.cancelled`（修复运行中取消漏记，此前仅 input-required 分支 +1）；`resumeFromInput()` 加入 CAS 守卫，仅 `input-required` 可续跑，杜绝取消后复活/并发续跑。
- `server.ts`：`message/send` 对**终态** `taskId` 直接报错（`INVALID_PARAMS`），不再派生非幂等 follow-up（网络重试不会造重复任务）；`input-required` 续跑保持同 id 闭环。
- `convert.ts`：`pushConfigOf` 优先读标准 `params.configuration.pushNotificationConfig`（metadata 作兼容回退），并携带 `authentication`。
- `server.ts` + `config.ts`：**SSRF 防护**——push webhook 仅 `http/https` 且阻断私有/链路本地地址（含 `169.254.169.254` 云元数据）；push 仅在 `a2aAuthToken` 开启时可用；新增 `a2aPushUrlAllowlist`（env `CURSOR_BRIDGE_A2A_PUSH_ALLOWLIST`）作为受信逃逸口。**0.0.0.0 无 token 启动**打印醒目告警。
- `package.json`：`verify` 门禁纳入 `test:stress` / `test:fault`，CI 守护故障/压力路径。

### P2 — 协议保真 + 可观测（部分）

- `server.ts`：新增 `GET /healthz` / `/metrics` / `/version`（复用 `mgr` 的 health/metrics，受同一 auth 守卫），可接入编排器探针。
- `convert.ts`：`toTask` 的 `status.timestamp` 对 `input-required` 改用 `inputRequiredAt`（此前回退到 `createdAt`）；`DataPart.changedFiles` 包装为 `{ files: [...] }`（`runner.ts`）。
- `server.ts`：`requireMessage` 对 `message/send` 限 `role: 'user'`（续跑消息本就是用户侧输入）。

### 剩余（已于 0.4.0 全部落地，见审计报告 §5 / §7）

- ✅ 消费 `configuration.blocking` / `acceptedOutputModes` / `historyLength`；CORS / 令牌桶限流；`unhandledRejection` 滑动窗口阈值退出；`bridge_shutdown` 退出前 flush；worktree 清理 `try/finally` 覆盖 `runCursor` 异常；抽出 `src/artifacts.ts`；skill 多扩展点；**A2A v1.0 迁移路线**（统一 Part、`protocolVersion` 移入 `supportedInterfaces`、新增 `extensions[]`）。详见上方 `## 0.4.0`。

## 0.3.4 — A2A 真互联：Agent Card 发现 + JSON-RPC 语义层 + 可生产级

把桥从"借用 A2A 词汇的 MCP 桥"升级为"另一个 agent 能真正发现并对话的 A2A agent"。
复用现有 `JobManager` 引擎（调度层与传输层解耦），在其上叠加 A2A v1.0 语义层
（`src/a2a/*`），落地 A2A 审计报告中的 F1/F2/F3/F4/F5/F6/F7/F8 全部缺口。

### 新增（A2A 语义层）

- **F1 Agent Card 自描述**：`GET /.well-known/agent.json`（兼 `/.well-known/agent-card.json`）
  返回遵循 A2A schema 的 Agent Card——`protocolVersion`、`capabilities`（streaming /
  pushNotifications / stateTransitionHistory）、按 workspace root 派生的 `skills[]`、
  以及 `securitySchemes` / `security`（启用鉴权时）。`src/a2a/card.ts` + `skills.ts`。
- **F2 input-required 中断态**：`JobStatus` 新增 `'input-required'`（非终态、可恢复）；`Job` 新增
  `pendingInput?` / `inputRequiredAt?`，`JobView` 新增 `pendingInput?`，`JobEvent.type` 新增 `'input'`。
  worker 哨兵 `NEED_INPUT: <问题>`（`extractNeedInput()` 从结果末行剥离）。`cursor_reply` 在目标为
  `input-required` 时 `resumeFromInput()`——同一 jobId 回到 `running`、在同一 `threadId` 续跑，
  最终 `completed`（`input-required → working → completed` 闭环）；终态任务保留"开子 job"旧行为。
- **F3 contextId 会话分组**：`Job` / `JobView` 新增 `contextId`（缺省回退到 jobId），
  `toTask()` 始终产出自洽的 `contextId`，`createOrResume()` 在续跑/跟进时沿用父任务的 `contextId`。
- **F4 Message / Part 模型**：`src/a2a/types.ts` 定义 `Message`（`role` / `parts[]` / `messageId` /
  `contextId` / `taskId` 顶层字段——A2A 文本在 `parts[].text` 而非顶层 `.text`）、`TextPart / FilePart /
  DataPart`、`Artifact`、`Task` 的 `history` 对话轮次。
- **F5 Artifact 一等公民**：`buildArtifacts(job)` 将 `changedFiles` / `diffStat` / `patchFile` /
  `reportFile` 派生为标准 `Artifact[]` 并接入 `JobManager.view()` 与 `toTask()`。
- **F6 Push Notifications**：`metadata.pushNotification = { url, token }` 时，`watchAndPush()`
  在状态终态时向 webhook POST `status-update` 事件（含 3 次重试）。
- **F7 鉴权**：`a2aAuthToken` 配置下，所有 JSON-RPC `POST /a2a` 须带 `Authorization: Bearer`
  或 `X-A2A-Token`，否则 `401 → AUTH_REQUIRED(-32097)`；Agent Card 保持公开。
- **F8 SSE 流式**：`message/stream` / `tasks/resubscribe` 以 `text/event-stream` 推送
  `status-update` / `artifact-update` 事件，终态事件带 `final` 后结束连接。`subscribeTask()`
  轮询 store 并聚合事件。

### JSON-RPC 方法实现

- `message/send`（新建或带 `taskId` 续跑）、`tasks/get`（支持 `historyLength`）、
  `tasks/cancel`（仅 `submitted`/`working`/`input-required` 可取消，终态返回 `TASK_NOT_CANCELABLE -32002`）、
  `message/stream` / `tasks/resubscribe`（SSE）、以及 Agent Card 发现端点。
- 错误码映射：`TASK_NOT_FOUND -32001` / `INVALID_PARAMS` / `TASK_NOT_CANCELABLE -32002` /
  `METHOD_NOT_FOUND -32601` / `UNSUPPORTED_OPERATION -32004` / `AUTH_REQUIRED -32097`。

### 配置

- 新增 `a2aPort`（默认 `0` = 关闭，沿用 `adminPort` 约定）、`a2aHost`、`a2aAuthToken?`、`a2aPublicUrl?`；
  对应环境变量 `CURSOR_BRIDGE_A2A_PORT/HOST/AUTH_TOKEN/PUBLIC_URL`。

### 修复

- **input-required 续跑重放旧 prompt**：`resumeFromInput()` 此前不把调用方的"答复"喂给 worker，
  `execute()` 始终运行 `job.prompt`（原始指令），导致续跑又触发 `NEED_INPUT` 死循环。
  改为 `execute()` 接受 `promptOverride`，续跑时运行答复指令，同时保留 `job.prompt` 以维持历史首轮。
- **`tasks/cancel` 支持取消 `input-required`**：原 `cancel()` 拒绝取消非 `running` 任务，
  现允许取消 `input-required`（已暂停、无进程在跑），对齐 A2A 可取消态定义。

### 测试

- Node 测试 63 → **71** 项：新增 `test/a2a.test.mjs`（8 项）——Agent Card 发现与 shape、
  message/send 完成、tasks/get + 运行态取消、终态取消返回 `TASK_NOT_CANCELABLE`、
  message/stream SSE 终态、input-required 续跑同一任务（带 reply prompt 修复）、push webhook、
  Bearer token 守卫端点但不守卫 Agent Card。

## 0.3.3 — 2026-10-11（P3 加固与真跑实证）

完成审计报告中的全部 P3 长期加固项，并通过 fake-agent + bundle + 压力/故障脚本做真跑实证。

### 新增

- **可选事件 JSONL 持久化**：`CURSOR_BRIDGE_PERSIST_EVENTS=1` 自动使用 `<stateDir>/events`，
  或显式设置 `CURSOR_BRIDGE_EVENT_LOG_DIR`。`appendEvent` 仍同步更新内存，`setImmediate`
  调度异步 `fs.promises.appendFile`，失败只记日志不阻塞。
- **压力测试 `test/stress.test.mjs`**：`npm run test:stress` 覆盖 50 并发任务、20 轮 cancel/reply、
  hang 超时。
- **故障注入测试 `test/fault.test.mjs`**：`npm run test:fault` 覆盖 stateDir 被文件占用、
  eventLogDir 被文件占用。
- **P3 验证脚本 `scripts/validate-p3.mjs`**：编排 release 构建 + stress + fault + bundle smoke，
  输出实证报告。
- **GitHub Actions 模板**：`.github/workflows/ci.yml`（ubuntu + windows-latest fake-agent）与
  `.github/workflows/real-cursor-snapshot.yml`（workflow_dispatch 真实 Cursor opt-in）。
- **安装器 Node 镜像与离线包**：`install.ps1` 新增 `-NodeMirror`、`-NodeOfflinePackage`
  参数与 `CURSOR_BRIDGE_NODE_MIRROR` 环境变量；下载失败自动回退 nodejs.org。

### 文档

- `README.md` 补充 `eventLogDir` / `persistEvents` 配置、`totalDurationMs` 精度说明、
  真实 Cursor 集成指引、Windows 真机验证命令。
- `src/runner.ts` `Metrics` 接口注释说明 `totalDurationMs` 为运行时计数。

### 测试

- Node 测试 51 → **56** 项：新增事件持久化单元 2 项、e2e 1 项、stress 3 项、fault 2 项。

## 0.3.2 — 2026-10-11（P1/P2 风险消除）

按端到端审计报告中的 P1/P2 建议逐项消除风险点，将健壮性从 B+/A- 提升至 A+。

### 修复与加固

- **`cursor_list` / `cursor_diff` 的 `limit` 未钳制上限**（P1 · 中）：
  超大 `limit` 可构造大数组或读取巨大 patch。已分别钳制到 `[1, 1000]` 与 `[1, 200000]`。
- **`killTreeGracefully` 返回值未处理**（P1 · 中）：
  进程树终止失败时无日志、无告警。`cursor/cli.ts` 现在把 kill 结果通过 `note` 事件回传，
  `runner.ts` 对失败结果写 `warn` 日志。
- **`store.persist()` 失败时静默吞错**（P1 · 中）：
  `JobStore` 现在接收可选 logger，持久化失败时记录 `error` 日志并附带失败次数，
  方便运维发现磁盘满 / 权限问题。
- **`bridge_shutdown` 非同步触发 shutdown**（P2 · 低）：
  改为在返回 MCP 响应前立即启动 `mgr.shutdown()`，避免极端情况下 shutdown 未执行。
- **`/admin/shutdown` 异常静默**（P2 · 低）：
  shutdown 失败现在会记录 `error` 日志并以非零退出码退出。
- **构建后缺少 bundle smoke 验证**（P2 · 低）：
  `build-release.mjs` 现在会在打包后立即用临时 workspace 与假 Cursor binary
  运行 `CURSOR_BRIDGE_SELFCHECK=1`，捕获 bundling 回归。

### 测试

- Node 测试 48 → **51** 项：
  - 新增 `cursor_list` / `cursor_diff` limit 钳制端到端测试 2 项；
  - 新增 `JobStore` persist 失败告警单元测试 1 项。
- PowerShell 配置测试保持 **20/20**。

## 0.3.1 — 2026-10-11（全仓审计修复）

对全部交付物（16 个源文件、7 个测试文件、4 个脚本、2 份文档、发布包）逐文件审计，
修复 6 个缺陷。这批缺陷**测试跑不到**——它们藏在配置解析、安装脚本与边界参数里。

### 修复

- **安装器升级时停不掉旧进程**（高）：`install.ps1` 用状态目录路径匹配要停止的
  bridge 进程，而状态目录经 env 传递、从不出现在命令行里，匹配永远为空，
  旧 `node.exe` 仍锁着 `lib\index.mjs`。改为匹配安装路径与 `wb-cursor-bridge`，
  并在停止后等待 600 ms 释放文件锁。
- **`uninstall.ps1 -RemovePayload` 崩溃**（中）：`$script:Source` 从未定义，
  `Test-Path $null` 抛异常。已定义该变量，并在脚本位于安装目录内时跳过删除，避免自删。
- **配置越界错误不含配置项名**（中）：报错形如 `5 must be between 60 and 86400`，
  运维无法定位是哪个旋钮。`num()` 增加 name 参数。
- **排序依赖机器 locale**（低）：`localeCompare` 比较 ISO 时间戳，不同 locale 下
  job 淘汰顺序可能不同。改为纯字符串比较（ISO-8601 字典序即时间序）。
- **`cursor_status` / `cursor_diff` 参数未钳制**（低）：负的 `since`、`waitSeconds`、
  `offset` 会静默改变语义。已钳制到合法区间。

### 其他

- 测试 47 → 48 项（新增配置项名断言）。
- 文档同步：测试数、bundle 体积、发布包文件名。

## 0.3.0 — 2026-10-09（性能与可维护性 + 版本化发布）

### 新增

- `bridge_health` 结果 5 秒缓存，响应带 `cached` 字段——高频探测不再重复 I/O。
- `/admin/shutdown` 支持可选 token（`CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN`，
  安装参数 `-AdminShutdownToken`）；未设置时行为不变。
- 安装脚本 `-NodeVersion` 参数，可指定下载的 Node 版本（默认 `v22.11.0`）。

### 修复

- **`cursor_run` 的 `model` 参数不生效**：工具层解析但 runner 未保存，
  `buildArgs` 只用 bridge 默认模型。已在 `Job` 上保存并贯通到 CLI。
- **UTF-8 截断切在字节中间**：中文结果与中文 patch 分页后出现 `U+FFFD`。
  `capText` 回退到完整字符边界，`cursor_diff` 改为按字节切片后再解码。
- ZIP writer 的 central directory 字段写入位置混乱（external attrs 与
  relative offset 都写在 offset 42）。已分别写入 38 与 42。

### 变更

- 清理死代码：`deadline`、`worktree`、`assertWriteSafe`、`isAlive`；
  `Metrics` 接口补上 `active` 字段。
- 版本号统一到 `src/version.ts`，发布物六处标注版本（目录名、ZIP 名、
  ZIP 内前缀、`VERSION` 文件、bundle banner、MCP 握手）。
- 构建时自动清理上一版本的目录与 ZIP，`release/` 下永远只有一个当前版本。
- 测试 45 → 47 项（新增 admin HTTP 端点测试 3 项、版本一致性断言）。

## 0.2.0 — 2026-10-09（首个工程化版本）

win-x64 生产工程：单文件 bundle（零运行时依赖）+ 一键安装包。

- **9 个 MCP 工具**：`cursor_run` / `status` / `reply` / `cancel` / `list` / `diff`
  + `bridge_health` / `stats` / `shutdown`。`cursor_run` 永不阻塞。
- **权限三档**：`consult`（`--mode ask`）、`plan`（`--mode plan`）、
  `execute`（`--force`）。调用方只选档位，永远不碰 CLI flag。
- **worktree 由 bridge 托管**：`git worktree add --detach`，任务结束后先
  `add -A` + `diff --cached HEAD` 导出 patch/report，再清理。检出目录不被污染。
- **会话接续**：捕获 Cursor `threadId`，`cursor_reply` 跨轮次保留上下文。
- **崩溃恢复**：`index.json` 原子写，重启后遗留 `running` 标记为 `orphaned`。
- **win-x64 专项**：路径大小写不敏感归一化、realpath 双重校验防 junction 逃逸、
  拒绝 8.3 短名与 DOS 设备名、`taskkill /T /F` 杀进程树、`windowsHide` 防黑窗、
  `StringDecoder` 处理跨 chunk 多字节截断。
- **一键安装**：`install.ps1` 完成校验 → 复制 → Node 解析/下载 → 探测 Cursor →
  写配置 → 同时注册到 WorkBuddy 与 Cursor → 自检。配置合并保留用户其他 server。

### 实现中实测发现并修正的缺陷

1. 事件游标按数组下标切片——环形缓冲截断后 `since=N` 返回空。改为绝对序号 `seq`。
2. `git diff HEAD` 漏掉未跟踪的新文件——patch 永远抓不到改动。改为先 `add -A`。
3. 取消与进程终止竞态——轮询方在进程真被杀前看到 `running`。改为同步置终态。
4. 二进制缺失时结果为空串——`spawn` ENOENT 无输出。改为回填可读错误。
5. 安装脚本在 `Set-StrictMode` 下读空 `PSObject` 的 `.Name` 抛异常——
   "首次安装"这条最常见路径会直接失败。抽出 `Get-MemberNames` 统一处理。
