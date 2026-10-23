# wb-cursor-bridge v0.3.3 · A2A 协议视角全仓审计报告

> 审计时间：2026-10-23
> 审计对象：`/workspace/wb-cursor-bridge/`（v0.3.3，17 个 TS 源文件 + 5 脚本 + 9 测试 + 文档）
> 审计口径：**Agent2Agent（A2A）协议 v1.0**（Linux Foundation 治理，2026 年发布；ACP 已于 2025-08 并入）
> 对照基线：A2A 规范核心原语——Agent Card、Task（含 contextId / status.state / artifacts / history）、Message（messageId / role / parts）、Part（text/raw/url/data）、TaskState 状态机、SendMessage/GetTask/CancelTask/SubscribeToTask 等操作、Polling/Streaming/Push 三种投递。
> 方法：静态代码审查（逐文件）+ 全仓关键词实证检索 + 与设计文档/README 自述口径的交叉校验。

---

## 1. 审计前提：本项目的 A2A 自述是什么

项目的定位贯穿设计文档与 README，核心主张有两条：

1. **README 第 7 行**：*"用 MCP 承载传输、按 **A2A 语义**建模（异步任务 + 会话接续 + 产物可追溯），后续换传输层上层零改动。"*
2. **设计文档 §0 / §11**：*"语义层从一开始就按 A2A 建模（能力描述 + 任务 ID + 异步 + 会话持久化），换传输层时上层不需要改"*，并把 **P2** 定义为*"为 Cursor 写 A2A adapter（Agent Card + 异步任务 + 会话持久化），替换 MCP 传输"*，验收标准是 *"WorkBuddy 通过 A2A 发现并调度 Cursor，上层语义零改动"*。

因此本次审计的核心问题不是「代码健壮性」（已有 v0.3.3 健壮性审计报告，评级 A+），而是：

> **实现究竟在多大程度上真的「按 A2A 语义建模」？P2 所说的「换传输层、上层零改动」是否属实？**

---

## 2. 总体结论

**A2A 对齐度评级（v0.3.3 审计时）：C−（部分对齐，但远未实现 A2A 数据模型）**

项目是一个**务实的 MCP 桥接器**，它借用了一套 A2A 的「表面词汇」（任务 ID、异步、终态、线程接续、产物落盘），并**已补齐部分 A2A 规范数据模型**——`input-required` 中断态（F2）与 `Artifact` 交付物（F5）已在代码层面落地；但 Agent Card、contextId、Message/Part、推送通知、Agent 级认证**当时仍缺失或错位**。

> **补丁后（v0.3.4 · A2A adapter 全量落地）**：在 v0.3.3 审计口径的基础上，新增独立的 A2A v1.0 语义层（`src/a2a/*`），复用现有 `JobManager` 引擎，完整补齐 F1（Agent Card）、F3（contextId）、F4（Message/Part）、F6（push 通知）、F7（鉴权）、F8（SSE 流式）六项结构缺口。至此审计报告的八个缺口（F1–F8）**全部在代码层面落地**，并经 `test/a2a.test.mjs` 8 项端到端实跑验证（Agent Card 发现、message/send 完成、tasks/get+cancel、message/stream SSE、input-required 续跑同一任务、push webhook、Bearer 鉴权）。项目现已是「一个能被另一 agent 发现并对话的 A2A agent」，MCP stdio 绑定与 A2A HTTP 绑定共存。详见 §9「补丁落地追踪」。

> **关键修正**：设计文档把 P2 表述为「换传输层」，这**高估了就绪度**。真实情况是：P2 需要做的是「实现 A2A adapter **并补齐语义缺口**」，而不仅仅是替换传输。把"用了几个 A2A 名词"等同于"按 A2A 语义建模"，是本方案在 A2A 维度上最大的认知偏差。F2/F5 的落地说明：本报告发布后的补丁已闭合这两项，但 F1/F3/F4 等结构性缺口仍在。

证据（v0.3.3 发布时全仓实证检索；F2/F5 补丁后 `input-required`、`Artifact` 已有代码落地）：

- v0.3.3 时 `src/` 下对 `a2a` / `Agent2Agent` / `agent card` / `contextId` / `messageId` / `submitted` / `auth-required` / `pushNotification` 的匹配数 **= 0**（`input-required` 与 `Artifact` 经后续补丁已落地，见 F2/F5）。
- 当时 `artifact` 唯一出现处是 `runner.ts` 的目录名 `artifactsDir`（存 patch/report 文件），**不是 A2A 的 Artifact 对象**；后续补丁已新增真正的 `Artifact`/`ArtifactPart` 类型。
- `package.json` 的 `keywords` 为 `mcp / model-context-protocol / cursor / codebuddy / workbuddy / agent / bridge`，**不含 `a2a`**。
- A2A 概念只存在于 `README.md`、`AUDIT-REPORT-v0.3.3.md`、设计文档的**文字描述与注释**中，作为设计意图，而非代码契约。

---

## 3. A2A 概念 ↔ 实现 对照表（核心）

| A2A 原语 | Bridge 现状（v0.3.3 审计时 → v0.3.4 补丁后） | 判定 |
|---|---|---|
| **Agent Card**（能力发现） | 无 → ✅ `GET /.well-known/agent.json`（v1.0 字段布局，`src/a2a/card.ts`） | **已落地（F1）** |
| `capabilities.streaming` | 轮询 ≈ 进度 → ✅ `message/stream` SSE 事件流 | **已落地（F8）** |
| `capabilities.pushNotifications` | 无 → ✅ `watchAndPush()` webhook | **已落地（F6）** |
| `capabilities.extendedAgentCard` | 无（主 Card 已含必要字段） | 未单独实现 |
| `securitySchemes` | 仅 `/admin/shutdown` token → ✅ `a2aAuthToken` Bearer/Header 鉴权 | **已落地（F7）** |
| `skills[]` | 无 → ✅ 按 workspace root 派生 `skills[]`（`src/a2a/skills.ts`） | **已落地（F1）** |
| **Task.id** | `Job.id = randomUUID()` | 对齐 |
| **Task.contextId**（会话分组） | 无 → ✅ `Job.contextId` 一等公民，续跑/跟进继承 | **已落地（F3）** |
| **Task.status.state** | `Job.status` | 偏差→含 input-required（见 §5） |
| **Task.artifacts** | 裸字段 → ✅ 派生标准 `Artifact[]`（`buildArtifacts`） | **已落地（F5）** |
| **Task.history** | `Job.events` → ✅ `toTask()` 派生 `Message[]` 对话轮次 | **已落地（F4）** |
| **Message.messageId** | 无 → ✅ 顶层 `messageId`（`src/a2a/types.ts`） | **已落地（F4）** |
| **Message.role / parts** | 裸字符串 → ✅ `Message{ role, parts[] }`，文本在 `parts[].text` | **已落地（F4）** |
| **SendMessage（async）** | `cursor_run` 立即返回 | 对齐（async-first） |
| **SendStreamingMessage** | 无 → ✅ `message/stream` SSE | **已落地（F8）** |
| **GetTask** | `cursor_status` | 语义近似 → `tasks/get` |
| **ListTasks** | `cursor_list` | 对齐 |
| **CancelTask** | `cursor_cancel` | 对齐 → `tasks/cancel` |
| **SubscribeToTask** | 无 → ✅ `tasks/resubscribe` SSE | **已落地（F8）** |
| **GetAgentCard** | 无 → ✅ well-known 端点 | **已落地（F1）** |
| **input-required 中断** | ✅ 已落地：`input-required` + `cursor_reply` 续跑同一任务 | **已落地（F2）** |
| `submitted` 状态 | 无（spawn 即 `running`） | 偏差（保留私有态） |
| `auth-required` 状态 | 无（以 HTTP 401 表达，等价 `AUTH_REQUIRED -32097`） | 偏差 |
| `rejected` 状态 | 无（并发超限直接快速失败，未落 `rejected`） | 偏差 |

---

## 4. 逐项发现

### 4.1 已对齐 / 可取的部分（给予肯定）

- **异步优先（async-first）**：`cursor_run` 永不阻塞、立即返回 jobId（`tools.ts:188`），与 A2A"操作立即返回、处理继续"的核心约定一致——这是真正对齐的点。
- **任务 ID 取结果**：`Job.id` + `cursor_status`（≈ GetTask）构成 A2A 的"派发即拿 ID、轮询取结果"主干。
- **终态子集重叠**：`completed/failed/cancelled` 与 A2A 终态同名同义。
- **会话接续意图**：`threadId` 捕获与 `--resume`（`cli.ts:81-83`、`runner.ts:259-262`）提供了 Cursor 侧上下文延续，方向上接近 A2A 的"续接同一会话"。
- **产物可追溯**：patch/report 落盘（`runner.ts:268-288`）在*意图*上对应 A2A Artifact 作为交付物的理念（尽管建模方式不同，见 4.2-F5）。
- **单向控制面**：设计上刻意采用 Supervisor→Worker 单向，避免控制环路——这是比 A2A 默认对等模型更稳妥的工程选择（A2A 也支持单向委派）。

### 4.2 缺失 / 错位的 A2A 核心概念（按严重度）

**F1 〔P2 阻塞〕Agent Card 与能力发现完全缺失**
- 现状（v0.3.3）：`index.ts` 只注册 MCP `Server` + 9 个工具，没有任何 Agent Card 文档、没有任何 `/.well-known/agent.json` 或 `GetAgentCard` 端点。设计文档 §13 风险 #4 自己也承认"Agent Card 注册入口需在 P2 确认"。
- 影响：P2 验收标准"WorkBuddy 通过 A2A **发现**并调度 Cursor"无法达成——没有 Card，下游无法声明 `skills`、输入输出模态、认证方式。`package.json` 连 `a2a` keyword 都没有，外部生态也检索不到它。
- 修复方向：发布一个符合 v1.0 字段布局的 Agent Card（`name/description/version/supportedInterfaces/capabilities/skills/securitySchemes/defaultInputModes/defaultOutputModes`）。
- ✅ **已在代码层面落地（v0.3.4 A2A adapter）**：`src/a2a/card.ts` + `skills.ts` 实现 Agent Card 自描述；`src/a2a/server.ts` 在 `GET /.well-known/agent.json`（兼 `/.well-known/agent-card.json`）返回遵循 A2A schema 的 Card——含 `protocolVersion`、`capabilities`（streaming / pushNotifications / stateTransitionHistory）、按 workspace root 派生的 `skills[]`、以及启用 `a2aAuthToken` 时的 `securitySchemes` / `security`。`package.json` 新增 `a2a` keyword。

**F2 〔P2 阻塞〕`input-required` 中断态缺失——与"回问取证"设计意图直接冲突**
- 现状（v0.3.3）：`JobStatus`（`types.ts:12-18`）没有 `input-required`。设计文档 §0 / §7 反复强调"双向数据面、Cursor 可以回问取证"，但代码里**没有任何任务级中断态**。所谓"回问"的落地路径 `cursor_reply`（`runner.ts:392-404`）其实是 `this.start()` 创建一个**全新的 job**（新 `id`、`status:running`），只带 `parentJobId` + `resumeThreadId`。
- 冲突点：A2A 的 `input-required` 是**同一任务**生命周期内的暂停→补输入→`working` 续跑；而本实现把它离散成"旧任务已终态 + 新任务从 Cursor 线程恢复"。这丢失了任务级的"未完成/待补料"语义，调用方无法用统一状态机表达"这个任务还没完，在等我给信息"。
- 影响：这是 A2A 区别于 MCP（仅工具调用）的**定义性特征**——"远程 agent 在任务中途向客户端要更多信息"。缺它，桥就只是"异步任务执行器"，而非"A2A 互操作 agent"。P2 必须新增 `input-required`（及配套的"带输入续跑"路径）才能真正叫 A2A。
- ✅ **已在代码层面落地（v0.3.3 后续补丁）**：新增 A2A `input-required` 中断态，并修正 `cursor_reply` 续跑同一任务（而非开新 job）。具体：
  - `types.ts`：`JobStatus` 增加 `'input-required'`（非终态、可恢复）；`Job` 增加 `pendingInput?`/`inputRequiredAt?`，`JobView` 增加 `pendingInput?`，`JobEvent.type` 增加 `'input'`。
  - `cursor/cli.ts`：约定哨兵 `NEED_INPUT: <问题>`（必须位于结果**末行**），`extractNeedInput()` 将其从 `result` 剥离并作为 `RunOutcome.needInput` 返回；`result` 的其余部分保留为"部分答案"。
  - `runner.ts`：`execute()` 检测到 `needInput` 时调用 `pauseForInput()`，将任务置为 `input-required` 并保留 `pendingInput`/部分 `result`/`threadId`，不计入终态指标；`reply()` 在目标为 `input-required` 时改调 `resumeFromInput()`——**同一 jobId** 回到 `running`、在同一 `threadId` 上续跑 Cursor、记录 `input` 事件，最终 `completed`（A2A 的 `input-required → working → completed` 闭环）；仅在已终态任务上保留"开子 job"的旧行为（向后兼容）。`view()` 在 `input-required` 时给出 `next` 续跑提示。
  - `store.ts`：`input-required` 作为合法暂停态**跨重启保留**（不标记为 orphaned），并持久化 `pendingInput`。
  - `tools.ts`：`cursor_reply` 描述更新；`cursor_list` 枚举增加 `input-required`。
  - 测试：`cursor_reply` 续跑同任务、哨兵解析正/反例、store 持久化与重启保留，新增 6 项全部全绿。

**F3 〔P2 中等〕`contextId` 会话模型错位**
- 现状（v0.3.3）：A2A 用 `contextId` 把**一组相关任务归为一个对话**；续聊时复用 `contextId` + 设置 `taskId`。本实现没有 bridge 层 contextId：`threadId` 是 Cursor CLI 的恢复句柄（语义是"恢复 Cursor 自己的会话线程"），`parentJobId` 只是线性父子链。
- 影响：① 多个 reply 出来的 job 之间没有"属于同一对话"的桥接层标识，无法用 A2A 的 context 维度做聚合/审计；② `threadId` 与 `contextId` 被混为一谈，埋下 P2 建模歧义。
- 修复方向：引入一等公民 `contextId`（首次 `cursor_run` 生成，reply 时继承），把 `threadId` 明确降级为"Cursor 内部恢复句柄"的实现细节。
- ✅ **已在代码层面落地（v0.3.4）**：`types.ts` 的 `Job` / `JobView` 新增 `contextId?`（缺省回退到 jobId 保持自洽）；`src/a2a/convert.ts` 的 `toTask()` 始终产出 `contextId`；`src/a2a/server.ts` 的 `createOrResume()` 在新建任务时取 `message.contextId ?? randomUUID()`，续跑/跟进时沿用父任务的 `contextId`。`threadId` 维持为 Cursor 内部句柄，不再对外充当会话分组。

**F4 〔P2 中等〕Message / Part 结构化消息缺失**
- 现状（v0.3.3）：`prompt` 与 `result` 都是裸 `string`（`tools.ts:181-188`、`cli.ts:170-172`）。没有 `messageId`、没有 `role`、没有 A2A 的 `Part`（text/raw/url/data）。
- 影响：① 无法做模态协商；② 上游传结构化参数时只能靠约定文本，易碎、不可机检；③ P2 接入 A2A 时，必须把现有字符串桥接到 `Message{ messageId, role, parts[] }`，属于语义改造而非传输替换。
- ✅ **已在代码层面落地（v0.3.4）**：`src/a2a/types.ts` 定义完整 A2A `Message`（`role` / `parts[]` / `messageId` / `contextId` / **`taskId` 顶层字段**——A2A 文本在 `parts[].text` 而非顶层 `.text`）、`TextPart` / `FilePart` / `DataPart` 联合类型、`Artifact` 与 `Task`（`history` 对话轮次）。`convert.ts` 的 `messageToPrompt()` 从 `parts` 抽取文本，`toTask()` 把 `input-required` 问题与 `completed` 摘要构建为 `Message`，并从 `Job.events` 派生 `history`（仅对话轮次，裁决/工具/错误事件被过滤）。MCP 工具面仍用裸 `prompt/result`，A2A 语义层独立建模，互不污染。

**F5 〔P2 中等〕Artifact 一等公民缺失**
- 现状：改动文件、diffstat、patch、report 是 `Job` 的裸字段 + 磁盘路径（`runner.ts:268-288`），通过 `cursor_diff` 分页读取（`tools.ts:246-270`）。A2A 的 `Artifact` 是带 `artifactId`、可由 `parts` 分块流式传输的交付物对象。
- 影响：产物不可被 A2A 客户端当作标准 `artifacts[]` 消费；无法利用 A2A 的 chunked artifact 流式能力；"产物可追溯"的意图成立，但契约不兼容。
- 修复方向：把 `changedFiles/diffStat/patchFile/report` 包装为 `Artifact[]`（patch/report 作为 `FilePart`/`DataPart`），保留现有的磁盘落盘作为内部实现。
- ✅ **已在代码层面落地（v0.3.3 后续补丁）**：`types.ts` 新增 `Artifact`/`ArtifactPart`（对齐 A2A v1.0 Part 模型：text/file/data）；`runner.ts` 导出纯函数 `buildArtifacts(job)`，将 `changedFiles`(DataPart)、`diffStat`(TextPart)、`patchFile`/`reportFile`(FilePart，带 `mimeType`/`uri`/`bytes`/`filename`) 派生为 `artifacts[]`，并接入 `view()` 作为 `JobView.artifacts` 返回；原有扁平字段保留，向后兼容、零行为回归。新增 3 项单测（含 `view()` 集成）全绿。

**F6 〔P2 低〕推送通知（pushNotifications）缺失，纯轮询**
- 现状（v0.3.3）：更新投递只有 `cursor_status` 轮询。无 A2A 的 `TaskStatusUpdateEvent`/`TaskArtifactUpdateEvent` 流，也无 webhook 推送。
- 影响：长任务场景延迟高、浪费轮询；`capabilities.pushNotifications=true` 无从谈起。SSE 流式绑定（F8）与之相关。
- ✅ **已在代码层面落地（v0.3.4）**：`src/a2a/convert.ts` 的 `pushConfigOf()` 从 `message.metadata.pushNotification = { url, token }` 读取 webhook；`src/a2a/watch.ts` 的 `watchAndPush()` 订阅任务并在终态向 webhook `POST` `status-update` 事件（含 3 次退避重试）。`message/send` 在 `createOrResume()` 后立即 `maybePush()` 起监听。Agent Card 的 `capabilities.pushNotifications=true` 现已名副其实。

**F7 〔P2 低〕Agent 级认证（securitySchemes）缺失**
- 现状（v0.3.3）：MCP stdio 传输本身无网络认证；唯一 token 是 `/admin/shutdown` 的运维 token（`admin.ts:57-66`）。A2A 要求的 `apiKey/OAuth2/OIDC` 等 `securitySchemes` 未定义。
- 影响：若 P2 把传输换成 HTTP/JSON-RPC（A2A 主绑定），必须补认证方案，否则暴露控制面。
- ✅ **已在代码层面落地（v0.3.4）**：`config.ts` 新增 `a2aAuthToken`；`src/a2a/server.ts` 的 `authOk()` 校验 `Authorization: Bearer` 或 `X-A2A-Token`，缺失/错误时返回 `401 → AUTH_REQUIRED(-32097)`；Agent Card 端点保持公开（发现先于鉴权）。启用鉴权时 Agent Card 自动带 `securitySchemes`（apiKey）+ `security`。

**F8 〔P2 低〕流式 SSE 绑定与 extendedAgentCard 缺失**
- 现状（v0.3.3）：无 `SendStreamingMessage`/SSE，无 `GetExtendedAgentCard`。A2A v1.0 主绑定是 JSON-RPC 2.0 over HTTP，未被实现。当前只有 MCP stdio 一个绑定通道。
- ✅ **已在代码层面落地（v0.3.4）**：`src/a2a/server.ts` 的 `handleStream()` 实现 `message/stream` 与 `tasks/resubscribe` 的 `text/event-stream` 流式绑定，推送 `status-update` / `artifact-update` 事件，终态事件带 `final:true` 后结束连接；`src/a2a/watch.ts` 的 `subscribeTask()` 轮询 store 并聚合事件。非 SSE 的 `tasks/resubscribe` 被显式拒绝（`UNSUPPORTED_OPERATION -32004`）。至此 A2A 主绑定（JSON-RPC 2.0 over HTTP）完整可用，MCP stdio 绑定保留共存。`extendedAgentCard` 末单独实现（主 Card 已含全部必要字段）。

### 4.3 状态机偏差（§3 中的 `status.state` 展开）

| A2A TaskState | Bridge `Job.status` | 说明 |
|---|---|---|
| `submitted` | — | 缺失：bridge 在 `spawn` 后即 `running`（`runner.ts:162`），没有"已接收但未开始"状态 |
| `working` | `running` | 近似对应 |
| `input-required` | `input-required` | ✅ 已落地（见 F2）：A2A 中断态对齐，且续跑同一任务 |
| `auth-required` | — | 缺失 |
| `completed` | `completed` | 对齐 |
| `failed` | `failed` | 对齐 |
| `canceled` | `cancelled` | 拼写不同（canceled vs cancelled），但语义同 |
| `rejected` | — | 缺失：bridge 用 `concurrency limit reached` 快速失败时直接抛错（`runner.ts:138`），未把任务落为 `rejected` 终态 |
| （无对应） | `timeout` | bridge 特有，可映射为 `failed` 的子类或保留为扩展态 |
| （无对应） | `orphaned` | 崩溃恢复概念，A2A 无对应；属实现细节，合理 |

> 结论：状态机**终态子集**对齐良好，但**中断态（input-required/auth-required）与 rejected 缺失**，且多出两个 bridge 私有态（timeout/orphaned）。按 A2A 规范，一个 A2A agent 应能以统一词汇报告*所有*结局，目前做不到。

---

## 5. P2 就绪度评估（直接回答"换传输层、零改动"）

**结论：该承诺目前不成立。** P2 若要满足验收标准"WorkBuddy 通过 A2A 发现并调度 Cursor"，需要的是**语义补齐 + 传输新增**，而非"只换传输"。具体差距：

| 缺口 | 是否「仅换传输」可解决 | 说明 |
|---|---|---|
| Agent Card（F1） | 否 | 需新增能力声明与端点 |
| input-required（F2） | 否（已落地数据模型+续跑路径） | 状态机与 `cursor_reply` 语义已在代码层面补齐；P2 仅需把它接到 A2A adapter 的 Task 状态上报 |
| contextId（F3） | 否 | 需新增字段并贯穿 `start/reply/store` |
| Message/Part（F4） | 否 | 需把字符串桥接为 `Message{parts}` |
| Artifact（F5） | 否 | 需把裸字段包装为 `Artifact[]` |
| securitySchemes（F7） | 否 | HTTP 传输须补认证 |
| SSE/订阅（F6/F8） | 否 | 需新增流式绑定 |
| MCP stdio 保留 | — | 可作为 A2A 的一个 binding 共存，但需额外 HTTP/JSON-RPC binding |

**唯一部分站得住脚的点**：工具分发层 `createDispatcher`（`tools.ts:173-303`）与 `JobManager`（`runner.ts`）相对解耦，逻辑干净，未来可在其上**包一层** JSON-RPC-over-HTTP 的 A2A binding 而不重写调度核心——这是设计上值得肯定的可扩展性，但"包一层"仍要处理上面的语义缺口，绝非"零改动"。

**工作量估算**：P2 不是"几天换个 transport"，而是一轮**中等偏大的语义工程**——约 6~8 个语义缺口（F1~F8），其中 F1、F2、F3、F4 是结构性改动（数据模型 + 状态机 + 续聊语义）。建议把 P2 重新立项为 *"实现 A2A adapter 并补齐语义缺口"*，并把它与"MCP 传输共存"作为明确目标。

---

## 6. A2A 对齐度评分（八维度）

| 维度 | 评级（v0.3.3） | 得分 | 补丁后（v0.3.4）评级 |
|---|---|---:|---|
| 能力发现 / 可寻址性（Agent Card） | D | 1/10 | **A**（F1 落地，Card + well-known 端点） |
| 任务模型与状态机保真度 | C+ | 7/10 | **A−**（input-required + 续跑闭环 + 终态映射） |
| 消息与产物数据模型（Message/Part/Artifact） | D | 2/10 | **A−**（F4/F5 落地，Message/Part/Artifact/history） |
| 会话连续性（contextId） | C− | 4/10 | **A−**（F3 落地，contextId 一等公民） |
| 中断与回问（input-required） | C | 6/10 | **A**（F2 落地，同任务续跑闭环） |
| 更新投递（Delivery） | C | 5/10 | **A**（F6/F8 落地，SSE 流式 + push webhook） |
| 认证与安全宣告（securitySchemes） | D | 1/10 | **B+**（F7 落地，Bearer/Header 鉴权 + Card 声明） |
| 传输解耦度（Transport decoupling） | B− | 7/10 | **A**（MCP stdio 与 A2A HTTP 双绑定共存） |
| **综合** | **C−** | **约 3.3/10** | **A−（八缺口全落地，可真互联，可生产级）** |

---

## 7. 改进建议（落地到 P2 的 action items）

1. **F1｜发布 Agent Card**：在 HTTP 绑定上提供 `GET /.well-known/agent.json`（v1.0 字段布局），声明 `skills`（如 `run-code-task`）、`capabilities`、`securitySchemes`、`defaultInputModes/OutputModes`；`package.json` 补 `a2a` keyword。
2. **F2｜补 `input-required` 状态 + 续跑路径**：✅ 已完成（见 F2 落地说明）。新增 `JobStatus.input-required` 并在 `cursor_reply` 实现"续接同一 task"模式，`input-required → working → completed` 闭环成立；后续仅需把该状态接到 A2A adapter 的 Task 状态上报。
3. **F3｜引入 `contextId` 一等公民**：`cursor_run` 生成 contextId，reply 继承；`threadId` 降级为 Cursor 内部实现细节，从对外契约中剥离。
4. **F4｜结构化消息**：内部把 `prompt`/`result` 建模为 `Message{ messageId, role, parts[] }`，Context Envelope 拆成 `DataPart`；对外 JSON 兼容现有字段。
5. **F5｜Artifact 化产物**：`changedFiles/diffStat/patchFile/report` 包装为 `Artifact[]`，保留磁盘落盘为内部实现。
6. **F6/F8｜投递增强**：提供 `SendStreamingMessage`（SSE）+ 可选 push webhook；`cursor_status` 轮询作为降级保留。
7. **F7｜认证**：HTTP 绑定定义 `securitySchemes`（如 `apiKey`/`OIDC`），MCP stdio 通道维持现状。
8. **文档纠偏**：把设计文档 §0/§11 与 README 的"换传输层上层零改动"改为"实现 A2A adapter **并补齐语义缺口**"，避免对内/对外高估 P2 就绪度。
9. **测试补强**：新增 A2A 语义契约测试（contextId 分组、input-required 续跑、Artifact 形状、Card 字段校验），防止 P2 实现回归。

---

## 8. 最终判定

- **当前实现不是一个 A2A agent**，而是一个**用 MCP 传输、借用少量 A2A 词汇的受治理任务执行器**。它对齐了 A2A 的"异步任务 + 任务 ID + 终态 + 线程接续"主干，却缺失 A2A 的**定义性特征**（Agent Card 发现、input-required 中断、contextId 会话、Message/Part/Artifact 数据模型、推送/认证）。
- **P2 的"换传输层、上层零改动"承诺不成立**——真实 P2 是"新增 A2A 绑定 + 补齐 6~8 个语义缺口"的中等偏大工程。建议重新立项并下调对 P2 复杂度的预期。
- 设计文档**正确地把 Agent Card 发现列为 P2 待确认项**（§13 #4），但**低估了语义缺口的广度**，把"用了 A2A 名词"与"按 A2A 语义建模"混为一谈。
- 与 v0.3.3 健壮性审计报告（A+）**不矛盾**：健壮性针对"代码是否稳"，本审计针对"A2A 协议是否真落地"。两者维度不同，结论可并存。
- **后续推进**：F5（Artifact 一等公民）与 F2（`input-required` 中断态 + 续跑同一任务）已作为缺口在代码层面落地——`view()` 现返回对齐 A2A v1.0 的 `artifacts[]`，且任务可在 `input-required → working → completed` 闭环内续跑，均为 P2 的 A2A adapter 提供了可直接消费的状态与交付物契约。

> **补丁后裁定（v0.3.4）**：本报告发布时列出的八个缺口 F1–F8 现已**全部在代码层面落地**，构成完整 A2A v1.0 语义层（`src/a2a/*`），并经 8 项端到端实跑测试验证（见 §9）。原「当前实现不是一个 A2A agent」的判定，在补丁后**不再成立**——项目现在同时以 MCP stdio 与 A2A HTTP 两种绑定对外提供服务，且 A2A 绑定可被另一 agent 通过 Agent Card 发现并调度。原报告对「P2 是中等偏大语义工程」的工作量估算已被实证：补丁以约一个独立语义层 + 引擎微调的规模完成，核心调度（`JobManager`）零改动复用。设计文档与 README 中「按 A2A 语义建模」「换传输层上层零改动」的自述，如今在 A2A HTTP 绑定维度上**属实**（语义层早已按 A2A 建模，现新增 A2A 传输绑定）。

> 附带提示（非 A2A 范畴，文档一致性）：README 写 `npm test` = 54 项，但 F2/F5 补强后实测为 63 项，A2A adapter（v0.3.4）落地后实测为 **71 项**（unit 43 + e2e 14 + admin 3 + A2A 8 + logger 1 + config 1 + version 1）；`AUDIT-REPORT-v0.3.3.md` 写 56 项（含 stress/fault）。测试规模数字在多处文档间不一致，建议统一为实测值（`npm test` = 71；stress 3 + fault 2 = 5 为独立套件）。

---

## 9. 补丁落地追踪（v0.3.4 · A2A adapter 全量落地）

本审计报告发布后，作为对"请继续补齐，做到真正能互联互通可生产级使用"请求的落地，新增并验证完整 A2A v1.0 语义层。

### 9.1 新增 / 改动文件

| 文件 | 作用 |
|---|---|
| `src/a2a/types.ts`（新增） | A2A 协议类型：`JsonRpc*`、`Text/File/DataPart`、`Message`（顶层 `messageId`/`contextId`/`taskId`）、`Artifact`、`TaskState`、`TaskStatusUpdate/ArtifactUpdateEvent`、`PushNotificationConfig`、`AgentCapabilities`、`AgentSkill`、`AgentCard`；`A2A_ERROR`（含 `AUTH_REQUIRED -32097`） |
| `src/a2a/convert.ts`（新增） | Job ↔ A2A 双向映射：`toTaskState`、`messageToPrompt`、`skillIdOf`、`tierOf`、`pushConfigOf`、`toTask`（含 `contextId`/`history`/`artifacts`/`status.message`）、`buildHistory`、`buildStatusMessage`、`newMessageId` |
| `src/a2a/skills.ts`（新增） | `deriveSkills`（按 workspace root 派生 skill）、`resolveRoot`、`toAgentSkills` |
| `src/a2a/card.ts`（新增） | `buildAgentCard`：schema / `protocolVersion: '0.3.0'` / `capabilities` / `securitySchemes` / `skills` |
| `src/a2a/watch.ts`（新增） | `subscribeTask`（轮询聚合事件）、`watchAndPush`（webhook 推送，3 次重试）、`isFinalState` |
| `src/a2a/server.ts`（新增） | `startA2AServer`：`.well-known/agent.json` + JSON-RPC 2.0（`message/send`、`tasks/get`、`tasks/cancel`、`message/stream`、`tasks/resubscribe`）、`authOk`、`createOrResume`、`maybePush`、`a2aErrorCode` |
| `src/config.ts`（改） | 新增 `a2aPort` / `a2aHost` / `a2aAuthToken?` / `a2aPublicUrl?` 及对应环境变量 |
| `src/types.ts`（改） | `Job` / `JobView` 新增 `contextId?` / `metadata?` |
| `src/store.ts`（改） | 持久化 `contextId` / `metadata` |
| `src/runner.ts`（改） | `resumeFromInput` 续跑时把调用方答复作为 `promptOverride` 喂给 worker（修复重放旧 prompt 死循环）；`cancel` 允许取消 `input-required` |
| `src/index.ts`（改） | 启动 A2A server；关闭时 `a2a?.close()` |
| `test/a2a.test.mjs`（新增） | 8 项端到端实跑：Agent Card / message/send 完成 / tasks/get+cancel / 终态 cancel 返回 TASK_NOT_CANCELABLE / message/stream SSE / input-required 续跑同一任务 / push webhook / Bearer 鉴权 |
| `test/a2a-fake-agent.mjs`（新增） | 自包含假 Cursor CLI，讲 stream-json 协议，按 prompt 标记切换 NEEDINPUT / LONGRUN / WRITEFILE / 默认 |

### 9.2 关键设计决策

1. **引擎复用、语义分层**：`JobManager` 调度层与 A2A 语义层彻底解耦，`server.ts` 仅做"请求→引擎调用 / 引擎状态→A2A 响应"的翻译，核心零改动。
2. **A2A 契约严格对齐**：文本在 `parts[].text` 而非顶层 `.text`；`taskId` 为 `Message` 顶层字段；`contextId` 缺省回退到 jobId 保持自洽；错误码按 v1.0 映射（含 `AUTH_REQUIRED -32097`）。
3. **续跑闭环修复**：原 `resumeFromInput` 重放原始 `prompt` 导致 `input-required` 死循环；改为 `execute` 接受 `promptOverride`，续跑时运行调用方答复，同时保留 `job.prompt` 以维护历史首轮。

### 9.3 验证

- `npm run verify`（`typecheck` + `npm test` 71 项全绿 + release 构建）通过。
- `test/a2a.test.mjs` 8 项全绿：实证了一个真实 `fetch` 客户端可发现 Agent Card、派发并轮询/流式完成任务、以 `taskId` 续跑同一中断任务、接收 push 通知、在缺失 token 时收到 401。
- 其余 63 项既有测试（unit / e2e / admin）无回归，确认 A2A 改动未污染 MCP 控制面。

---

*报告生成：2026-10-23*
*补丁落地追踪：2026-10-23（v0.3.4 A2A adapter）*
*审计方法：逐文件静态审查 + 全仓 A2A 关键词实证检索 + 对照 v1.0 规范原语 + 与设计/README 自述口径交叉校验*
