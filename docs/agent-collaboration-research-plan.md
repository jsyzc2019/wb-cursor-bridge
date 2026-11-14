# 智能体间协作开源生态调研与本仓提升规划

> 日期：2026-11-14　对象：`jsyzc2019/wb-cursor-bridge` @ `main` (`9b60467`, v0.5.1)
> 边界：**本轮仅研究、诊断与规划，0 行代码改动**。所有条目均为待确认的候选工作，不是已实施变更。

---

## 0. 方法与证据口径

检索窗口聚焦 **2026 年新开源或发布重大版本**的项目，同时纳入少量久经考验的成熟项目作可靠性参照——后者不是"近期新闻"，而是用来判断哪些设计已经被大规模验证过（这也是开源选型的基本原则：优先看被无数人踩过的实现，而不是最新最炫的 README）[16]。

| 口径 | 做法 |
| --- | --- |
| 一手证据 | GitHub API 核实仓库真实存在、star、创建/最近 push、许可证；直接读仓库 README、release notes、官方规范页面 |
| 二手证据 | 新闻/博客/论文，仅作背景与线索，性能数字一律标注"作者自报、未见独立复现" |
| 对照证据 | 逐条 grep 本仓 `src/` 确认"已具备 / 真差距"，不靠 README 描述推断 |
| 排除 | 搜索结果里若干 star 数异常的聚合仓库（如 11 万星的 "paperclip"）未列为依据，只作线索 |

**一个重要的甄别结论**：本仓并非"落后于生态"。0.5.0 已按第三方审计做过 v1.0 兼容层（`src/a2a/compat.ts`）、双发现路径、SSE 信封、SSRF 全链路防护。真正的差距集中在**协议协商方式、验证手段、协议面漂移、副作用幂等**四处，而不是"没做 A2A"。规划据此收敛，避免重复造轮子。

---

## 1. 生态格局：三层，各解决不同问题

| 层 | 代表项目 | 关键事实（一手） | 与本仓关系 |
| --- | --- | --- | --- |
| **协议/规范** | [a2aproject/A2A][1] | ★26.5k，2026-11-13 push，Apache-2.0；v1.0.0 于 2026-03-12 发布，20 项 breaking changes；v1.0.1 于 2026-05-28 [2] | 本仓 A2A 面的规范来源 |
| | [a2aproject/a2a-tck][3] | ★59，2026-11-06 push；按 RFC 2119 分 MUST/SHOULD/MAY，产出 JUnit/HTML/JSON 报告 | 可替代自建 PoC 作为合规基线 |
| | [modelcontextprotocol/specification][4] | 2026-07-28 版：stateless 自包含请求、per-request capability negotiation、Tasks/Skills/MCP Apps 扩展 | 本仓 MCP 面的规范来源 |
| | [zed-industries/agent-client-protocol][5] | ★4.6k；**initialize 时协商 `protocolVersion` + capabilities，明确"不能从包版本推断线兼容"** | 直接命中本仓静态版本开关的软肋 |
| **编排/治理** | [google/agentmesh][6] | ★1.2k，2026-04 新建；"默认什么都不可达"，**按服务名而非地址授权**，短期离线可验证凭证 | 本仓按路径白名单授权的对照 |
| | [microsoft/agent-governance-toolkit][7] | ★6.6k，2026-03 新建，MIT；在确定性代码中拦截每次工具调用/委派，映射 OWASP Agentic Top 10 | 本仓"策略集中在 bridge"哲学的同构放大 |
| | [agentgateway/agentgateway][8] | ★6.2k；A2A/MCP 代理，CEL 策略、RBAC、限流、OTel | 出站治理的可选形态 |
| | [cisco-ai-defense/a2a-scanner][9] | ★169；YARA + spec + heuristic 分析 Agent Card（冒充、工具投毒、路由操纵、数据外泄） | 可进 CI 做卡片静态扫描 |
| | [inclusionAI/Avernet][10] | ★602，2026-07 新建；TaskGuard 工作流门 + AgentEvolve 诊断/基准/可回退 Pack 版本 | 本仓 0.5.1 手工"先量后改"的固化形态 |
| **运行时/可靠性** | [langchain-ai/langgraph][11] | ★44.9k；durable execution、HITL interrupts、checkpoint | 崩溃恢复的成熟参照 |
| | [microsoft/Agensh][12] | ★916，2026-10-24 开源，MIT；无中心编排、CLAIM 认领、五类短笔记（含 FAIL 防重复试错） | 思路参照，**架构不照搬** |
| | [kanywst/a2acode][13] | ★12，2026-06；**与本仓几乎同构**：把 ACP coding agent 暴露为 A2A peer，权限请求映射为 `input-required` | 最直接的对标物 |
| | [BuilderIO/agent-native][14] | ★7.7k；一个 `defineAction()` 生成 UI/agent/HTTP/MCP/A2A/CLI 六面，共享校验与权限 | 本仓双面手写漂移的解法 |
| | [parallax-labs/context-harness][15] | ★43，AGPL-3.0；request-key 幂等、独占 lease + heartbeat、reconcile 分支 | 本仓 JobManager 的直接对照 |
| | [temporalio/temporal][16] / [dbos-inc/dbos-transact-py][17] / [restatedev/restate][18] | durable execution 谱系：重集群 → 库内装饰器 → 单二进制 | 明确**不引入**，只取模式 |
| | [sigstore/sigstore-a2a][19] | ★27，2026-11-13 push；CI 期为 Agent Card 签名 + SLSA provenance + Rekor 透明日志 | 卡片供应链完整性的可选增强 |

补充线索（二手，仅背景，不作为设计依据）：Red Hat 的 SPIFFE/SPIRE + Sigstore 双层身份方案、OpenA2A AIP 的 IETF 草案（签名委派、透明日志、能力词表）、Wirken 的哈希链审计日志（2026-11-09 发布）。这些方向与本仓"本机 127.0.0.1 + bearer token"的部署模型距离较远，列入 P4 评估而非直接采纳。

---

## 2. 本仓差距诊断（逐条对照源码）

| # | 维度 | 本仓现状（源码位置） | 生态做法 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 版本协商 | `config.a2aProtocolVersion` **静态开关**，`compat.ts` 按配置整体切换序列化 | A2A v1.0 规范要求客户端每次请求带 `A2A-Version` 头（MUST），服务端按请求版本语义处理，不支持则返回 `VersionNotSupportedError`；ACP 同样强调运行时协商 [5][20] | **真差距**：配置文件切换无法让同一实例同时服务 0.3 与 1.0 客户端 |
| 2 | 事件形状 | `types.ts:164` 定义 `final: boolean`，`watch.ts:111` 终态仍发 `final: true` | v1.0.0 明确 "Remove redundant `final` field from `TaskStatusUpdateEvent`"；规范 4.2.1 字段只剩 taskId/contextId/status/metadata [2][20] | **真差距**：v1.0 模式多发一个已删除字段 |
| 3 | 状态枚举 | `'canceled'` 等小写字符串（`convert.ts:35`） | v1.0 为 ProtoJSON 风格 `TASK_STATE_*`，且含 `AUTH_REQUIRED` / `REJECTED`；`compat.ts` 只映射了 FileContent 与 Card | **真差距**：状态集与枚举格式未做版本映射 |
| 4 | 方法面 | 仅 `message/send`、`tasks/get`、`tasks/cancel`、`message/stream`、`tasks/resubscribe` | v1.0 新增 `tasks/list`（`nextPageToken` 分页）、push config 的 Get/List/Delete/Create CRUD | **真差距**（按需求取舍） |
| 5 | 发现路径 | `agent.json` 与 `agent-card.json` **双路径均已支持**（`server.ts:190`） | TCK 从 `/.well-known/agent-card.json` 取卡，按 `supportedInterfaces` 选 transport [3] | **已具备**，但 `toV1Card` 的 interface 只有 `{protocolVersion,url}`，缺 binding 声明与"首项首选"语义 |
| 6 | 内容类型 | 未见 `application/a2a+json` | v1.0.1 起 HTTP binding 优先该 media type [2][20] | 小差距 |
| 7 | 协议面一致性 | MCP 9 工具（`src/tools.ts`/`index.ts`）与 A2A 5 方法（`src/a2a/server.ts`）**两套手写翻译** | 单 Action 定义生成多面，共享校验/权限/实现 [14] | **真差距（架构性）**：0.5.0 的 SSE 信封曾让 e2e 实证脚本全红，就是漂移的实锤 |
| 8 | 产物语义 | patch/report 落盘、事件 JSONL 审计，A2A 有 artifact-update | 同构项目把 thinking / plan / diff / 成本 / 工具调用 / **权限请求 → `input-required`** 分别映射为独立 artifact 与 status-update [13] | **可提升**：结构化程度与调用方可观测性 |
| 9 | 幂等 | 只有"终态不重复起 follow-up"的保护（`server.ts:710`）与 retry 提示，**无 request-key 去重、无副作用幂等键** | request-key 原子提交、不可变摘要、position/content-hash 幂等键、lease 过期 reconcile **绝不启动第二个 run** [15][21] | **真差距**，且是本仓最值得补的可靠性短板 |
| 10 | 崩溃恢复 | store 持久化 job 状态、input-required 前回放 patch；无 checkpoint 边界 | durable checkpointer 实测：有则 0.01s / 0 次 LLM 调用恢复，无则整轮重跑（平均 5.3 次 LLM 调用）[11][21] | **部分具备**：状态能恢复，但副作用与"恢复到哪一步"没有明确语义 |
| 11 | 审计完整性 | JSONL 事件 + `createHash` 仅用于常量时间比较 | 决策审计、哈希链可离线验篡改、OTel traces [7][8][22] | 可提升（P4） |
| 12 | MCP 依赖 | `@modelcontextprotocol/sdk: ^1.0.0`，stdio | 官方 TS SDK 已 v2，实现 2026-07-28 规范 [4] | **需评估**：升级属破坏性，不能直接跳 |
| 13 | 验证手段 | 自建 36 个 PoC + 21 条反向回归 + 151 测试，全部自写断言 | 官方 TCK 按 MUST/SHOULD/MAY 分级，JUnit 直接进 CI，且显式区分 MANUAL 项与 NOT TESTED [3] | **可升级**：自建断言仍是"我认为规范是这样"，TCK 是"规范方认为规范是这样" |

**已具备、不要重复做的**：路径白名单 realpath 双侧比较、worktree 隔离 fail closed、SSRF 全地址解析 + 连接钉 IP、常量时间比较、每客户端限流、`contextId`（`convert.ts:158` 带 fallback）、`agent-card.json` 兼容路径、SSE 信封、Windows EBUSY 有界重试。生态里这些恰好是不少新项目仍在补的课。

---

## 3. 可借鉴经验（按主题，含落点与代价）

### A. 用运行时协商替代静态版本开关

v1.0 规范第 6 节明确：客户端 MUST 每次请求带 `A2A-Version`（也可作请求参数），服务端 MUST 按请求版本语义处理，接口不支持则 `VersionNotSupportedError` [20]。本仓现在是"一个实例配一个版本"，意味着混合生态里必须开两个端口。改为按请求协商后，同一 `JobManager` 可同时服务 0.3 与 1.0 调用方，`compat.ts` 从"全局开关"降级为"序列化边界"，职责反而更清晰。

**落点**：`src/a2a/server.ts`（头/参数解析 + 错误码）、`src/a2a/compat.ts`（按请求版本调用）、`src/a2a/card.ts`（`supportedInterfaces` 补 binding 与首选顺序）。
**代价**：低。不动引擎，只改边界。

### B. 官方 TCK 作为合规基线，自建 PoC 退居"差异用例"

TCK 把要求按 RFC 2119 分级：MUST 硬失败、SHOULD 记 xfail 不阻断、MAY 未声明能力则跳过；每次运行产出 JUnit/XML/HTML，且诚实标注 MANUAL 项（签名卡片验证、租户传播）与 NOT TESTED（含 SUT 不可达会拉低分数，不算 pass）[3]。这套"分级 + 可机读报告 + 不把未测当通过"的方法论，比本仓"36 个 PoC 全绿"更能回答"到底合规到什么程度"。

**落点**：新增 `scripts/tck.mjs` 包装；CI 的 **linux job** 跑 `run_tck.py --sut-host ... --transport jsonrpc --level must`，windows job 不跑（本仓目标是 win-x64，但 Python/uv 工具链不应塞进 Windows 发布路径）。
**代价**：CI 引入 Python 依赖，但只在 linux job，不影响单文件 bundle 与离线构建。
**注意**：TCK 按卡片 `supportedInterfaces` 建客户端，所以 A 项的 binding 声明必须先做，否则 TCK 无法正确选 transport。

### C. 单 Action 层收敛 MCP / A2A 双实现

`agent-native` 的做法是一个 `defineAction({schema, run})` 生成 UI / agent / HTTP / MCP / A2A / CLI 六个面，"共享同一套验证、权限和实现" [14]。本仓目前 MCP 9 工具与 A2A 5 方法各自手写参数校验与状态翻译，0.5.0 就出现过"A2A 加了 SSE 信封，e2e 实证脚本仍读 `e.kind` 导致 finals=0"的漂移事故。抽一层 Action 定义，让两个适配器从同一 schema 生成，可把这类事故变成编译期/属性测试可检出的问题。

**落点**：新建 `src/actions/`（Action 类型 + 注册表），`src/index.ts`（MCP adapter）、`src/a2a/server.ts`（A2A adapter）改为调用注册表；加"同一 action 双面结果一致"的属性用例。
**代价**：中。动核心路径，建议排在 P0 之后，用 TCK 与 151 测试兜底。

### D. 结构化产物与审批作为协议一等公民

同构项目 `a2acode` 的映射表很值得抄思路：文本 → 流 artifact、推理 → 独立 `thinking` artifact（永不混进答案）、工具调用 → `working` status、文件 diff → 具名 artifact、**权限请求 → `input-required` 暂停由调用方回答**、运行结果带 cost/turns/usage、session id → `contextId` [13]。本仓已有 patch/report/事件流，缺的是把这些按语义拆开暴露，以及把"worker 请求授权"显式建模为 `input-required`（当前 `input-required` 只用于 Cursor 追问）。

这不违反本仓铁律：审批由调用方回答，worker 依旧不能反向派活，单向控制面不变。

**落点**：`src/cursor/cli.ts` 事件分类、`src/a2a/convert.ts` artifact 构造、`src/artifacts.ts` 产物命名。
**代价**：中低，主要是序列化层。

### E. 幂等、checkpoint 与"绝不因租约过期起第二个 run"

`context-harness` DESIGN-0018 给出了可直接对照的工程细则：workspace 级 request key 原子提交、不可变请求/身份摘要、独占 claim + opaque token + heartbeat、reconcile 时区分 `no run / terminal / resumable / uncertain effect`，并明确 **"never start a second run solely because a lease expired"** [15]。第三方 34 次实测也显示：没有 durable checkpointer 的框架，"恢复"其实是整轮重跑并重复消耗 LLM 调用；幂等键（position key / content hash）能阻止重复副作用 [21]。

本仓 `runner.ts` 有 `maxLiveJobs` + TTL sweeper + `reclaimOrphan`，`store.ts` 有双预算淘汰，但**没有 client-supplied request key，也没有对 push notification POST / patch 导出 / git apply 的幂等标记**。一旦上层重试或桥重启回收孤儿任务，理论上存在重复执行的窗口。

**落点**：`src/store.ts`（request key 唯一索引 + 原子接受）、`src/runner.ts`（claim/lease/reconcile 状态机，把 `reclaimOrphan` 的判定改为读持久化 run 事实）、`src/a2a/watch.ts`（push POST 带幂等键）。
**代价**：中高。store 是文件型而非事务库，"原子提交 + 唯一约束"需要单写者语义，要先做设计评审。**不引入 Temporal/Restate 这类外部服务**——本仓的硬约束是零运行时依赖、单文件 bundle、离线可构建。

### F. 治理：从"散落的 if"到"可审计的策略决策"

微软 AGT 的表述与本仓设计哲学几乎逐字相同：*"在确定性应用代码里、在模型意图到达网络之前拦截每次工具调用/消息发送/委派"*，被拒绝的动作"不是不太可能发生，而是结构上不可能" [7]。差别在于它把策略外置为可版本化规则、记录每次 allow/deny 的决策审计、并映射到 OWASP Agentic Top 10 形成可审计矩阵。

另两条轻量可取的：`agentmesh` 的**按能力名而非地址授权**（本仓是路径白名单，属地址级）[6]；`a2a-scanner` 的 Agent Card 静态扫描（YARA + spec 校验，查冒充、工具投毒、路由操纵）[9] 可进 CI。

`agentgateway` 的 CEL/RBAC/OTel 与 `sigstore-a2a` 的构建期卡片签名 [8][19] 属于"如果本仓要跑成多机 mesh 才需要"，当前单机 127.0.0.1 部署下收益有限，列 P4 评估。

**落点**：`src/config.ts`/`src/util/paths.ts` 之上抽策略层、CI 加卡片扫描、审计日志加决策字段。
**代价**：低到中，但容易过度设计，建议只做"映射矩阵 + 决策日志 + 卡片扫描"三件，不建策略引擎框架。

### G. 观测与验证回路的固化

`Avernet` 的 AgentEvolve（诊断 → 可重复 Bench → 目标驱动优化，且每个 Pack 版本可回退）[10] 与本仓 0.5.1 手工做过的事（量基准 → 发现自我纠错 → 改 → 再测）是同一回路，差别是它把回路固化成产物。本仓可把 `scripts/verify.mjs` 的 8 阶段耗时、测试计数、双平台 CI 结论沉淀为可对比的基线快照，避免下次优化又靠印象。哈希链审计（Wirken 思路）属可选增强。

---

## 4. 工作规划（分阶段，均未开工）

优先级按「收益确定性 × 改动风险 × 是否依赖前序」排定。所有阶段在 `main` 上开独立 feature 分支，沿用现有 PR + 双平台 CI 流程。

### P0　协议合规基线（建议先做）

| 项 | 内容 |
| --- | --- |
| 目标 | A2A 面通过官方 TCK 的 JSON-RPC MUST 子集；0.3 / 1.0 客户端可同时接入 |
| 改动范围 | `src/a2a/server.ts`、`compat.ts`、`types.ts`、`watch.ts`、`card.ts`；新增 `scripts/tck.mjs`；`.github/workflows/ci.yml` linux job |
| 具体动作 | ① `A2A-Version` 头/参数解析 + `VersionNotSupportedError`；② v1.0 移除 `final`、状态映射 `TASK_STATE_*` 并补 `auth-required`/`rejected`；③ `supportedInterfaces` 带 binding 且首项首选；④ `application/a2a+json`；⑤ `tasks/list` 与 push config CRUD；⑥ CI 接 TCK |
| 验收 | `npm run verify` 8 阶段全绿；151 测试不退化；TCK `--level must` 0 failure、JUnit 上传；新增 0.3 与 1.0 双版本并发回归用例；MANUAL 项书面列出而非算通过 |
| 明确不做 | gRPC / HTTP+JSON binding（本仓定位本机 JSON-RPC）、多租户 `tenant`（无场景）、Agent Card 签名（P4 评估） |
| 风险 | TCK 依赖 Python/uv，仅放 linux job；若 TCK 对 `agent-card.json` 的 schema 严格校验暴露旧字段，按报告逐条修，不放宽断言 |

### P1　单 Action 层收敛协议漂移

| 项 | 内容 |
| --- | --- |
| 目标 | MCP 与 A2A 从同一份 Action 定义生成，消除双面手写漂移 |
| 改动范围 | 新增 `src/actions/`，改 `src/index.ts`、`src/a2a/server.ts`、`src/tools.ts` |
| 验收 | 同一 action 经 MCP / A2A 调用结果一致（属性用例）；新增一个 action 只改一处；P0 的 TCK 与 151 测试全绿 |
| 依赖 | P0（有 TCK 兜底才敢动核心路径） |
| 风险 | 中。需保留现有工具名/参数签名，避免破坏 MCP 客户端配置 |

### P2　结构化产物与审批一等公民

| 项 | 内容 |
| --- | --- |
| 目标 | thinking / plan / diff / cost / tool-call / permission-request 分别落到 artifact / status / `input-required`；`contextId` 续跑显式化 |
| 改动范围 | `src/cursor/cli.ts`、`src/a2a/convert.ts`、`src/artifacts.ts` |
| 验收 | 一次 `execute` 任务的 A2A 流可分别取到 diff artifact、成本字段、审批暂停并可续跑；不引入 worker 反向派活 |
| 依赖 | P1（产物定义随 Action 层走更自然） |

### P3　可靠性与幂等（本仓最值得补的短板）

| 项 | 内容 |
| --- | --- |
| 目标 | client request key 去重、副作用幂等键、checkpoint 边界、lease/reconcile 不产生第二个 run |
| 改动范围 | `src/store.ts`、`src/runner.ts`、`src/a2a/watch.ts`；新增 crash 注入测试 |
| 验收 | SIGKILL 注入在「已受理 / 执行中 / 等待审批 / patch 导出中 / push 发送中」五个点，恢复后：无重复 spawn、无重复 push、无重复 patch 回放；同一 requestKey 重复提交只跑一次；lease 过期不启动第二 run；恢复不重放已提交步骤 |
| 前置 | 先出一份 store 单写者/原子提交的设计说明再动码 |
| 风险 | 中高。文件型 store 的原子性需要谨慎，避免为了幂等引入 SQLite 之外的重依赖 |

### P4　治理与信任（评估先行，部分可能判定不做）

- 把现有安全控制映射到 OWASP Agentic Top 10，形成可审计矩阵（低成本，建议做）
- Agent Card 静态扫描进 CI（`a2a-scanner`，低成本，建议做）
- 策略决策日志 + 按能力名授权（中成本）
- 哈希链审计、委派 token（TTL/链深度）、构建期卡片签名 + 透明日志（**高成本，单机部署收益低，倾向不做**）

### P5　MCP 2026-07-28 / SDK v2（评估项，可能只出报告）

本仓 `@modelcontextprotocol/sdk` 停在 `^1.0.0`，官方 TS SDK 已 v2 [4]。同时 MCP 的 **Tasks 扩展**（异步长任务、轮询、mid-flight input、durable handles）与本仓 `cursor_run`（立即返回 jobId）/ `cursor_status`（轮询）/ `cursor_reply`（追问）几乎是同一套语义——值得评估把自定义工具语义对齐官方扩展，减少私有协议面。

但 v2 升级是破坏性的，且本仓目标是 win-x64 单文件离线包，**先出迁移决策报告 + 小范围 PoC，不直接升级**。

---

## 5. 优先级矩阵

| 阶段 | 收益 | 改动风险 | 依赖 | 建议 |
| --- | --- | --- | --- | --- |
| P0 合规基线 | 高（可验证、对外可声明） | 低 | — | **立即排期** |
| P1 单 Action 层 | 高（消除一类事故） | 中 | P0 | 排期 |
| P2 结构化产物 | 中高（互操作体验） | 中低 | P1 | 排期 |
| P3 幂等/恢复 | 高（数据正确性） | 中高 | 设计评审 | 排期，但先设计 |
| P4 治理 | 中 | 低～高 | — | 只做前两项 |
| P5 MCP v2 | 不确定 | 高 | 上游 | **仅评估** |

---

## 6. 验收与度量（避免"感觉变好了"）

1. **合规可量化**：TCK MUST 通过率、MANUAL 项清单、NOT TESTED 归零；不再只用"自建 PoC 全绿"作为合规声明。
2. **回归不可退化**：`npm run verify` 8 阶段全绿 + 151 测试 + stress/fault/e2e 实证，双平台 CI（linux / windows）。
3. **漂移可检出**：P1 后新增"双面一致性"属性用例；任何协议面改动必须同时过 MCP 与 A2A 断言。
4. **可靠性可注入**：P3 用 crash 注入而非等时间断言（沿用 0.5.1 已验证的"等条件不等时间"原则）。
5. **性能有基线**：把 `verify` 8 阶段耗时、测试计数固化为基线快照，改动前后可比。
6. **零新增运行时依赖**：不破坏单文件 bundle、离线构建、win-x64 目标。CI 里的 Python 工具链不算发布依赖。

---

## 7. 边界与不做项（守护本仓架构铁律）

- **不改变单向控制面**：Cursor 可以回问取证，不能反向派活；借鉴 Agensh 的"FAIL 笔记"/共享发现**只作为跨任务知识复用**，不引入去中心化调度或 worker 自主认领任务 [12]。
- **不引入外部编排服务**：Temporal / Restate / Inngest / DBOS 只取模式（journal、幂等键、checkpoint），不成为依赖 [16][17][18]。
- **不照搬大规模 mesh 治理**：多机身份、mTLS、透明日志、委派链在本机 loopback 场景收益不抵成本。
- **不为了"新"而升级**：MCP SDK v2、gRPC/REST binding、多租户均需先出评估报告。
- **不把二手数字写进设计依据**：Agensh 的 1,024 agents / 49% 相对提升是论文自报、未见独立复现；A2A "150 家组织" 是项目方自报 [23]。
- **本轮 0 代码改动**：以上全部是候选工作，未修改任何 `src/`、`test/`、CI 文件。

---

## 8. 待用户确认的决策点

1. **是否同意 P0 优先**，以及是否接受 CI 的 linux job 引入 Python/uv 跑官方 TCK（Windows job 与发布产物不受影响）。
2. **P1 是否现在做**：它改核心路径，收益是消除漂移，但会扩大改动面；也可以只做 P0 + P3，把 P1 推迟到下一个版本。
3. **P5 的 MCP SDK v2 评估**是否要单独立项（可能影响 `install.ps1` 与 MCP 客户端注册方式）。
4. **分支节奏**：当前 `main` 已是 v0.5.1 且 Release 已发，建议后续改动走新 feature 分支 + PR，不直接推 main。
5. 是否需要把本规划拆成 GitHub Issues（每阶段一个，带验收清单）。

---

## 9. 证据清单

[1]: https://github.com/a2aproject/A2A
[2]: https://github.com/a2aproject/A2A/releases/tag/v1.0.0
[3]: https://github.com/a2aproject/a2a-tck
[4]: https://modelcontextprotocol.io/specification/2026-07-28
[5]: https://github.com/zed-industries/agent-client-protocol
[6]: https://github.com/google/agentmesh
[7]: https://github.com/microsoft/agent-governance-toolkit
[8]: https://github.com/agentgateway/agentgateway
[9]: https://github.com/cisco-ai-defense/a2a-scanner
[10]: https://github.com/inclusionAI/Avernet
[11]: https://github.com/langchain-ai/langgraph
[12]: https://github.com/microsoft/Agensh
[13]: https://github.com/kanywst/a2acode
[14]: https://github.com/BuilderIO/agent-native
[15]: https://github.com/parallax-labs/context-harness/blob/main/docs/design/0018-local-agent-application-foundation-plan.md
[16]: https://github.com/temporalio/temporal
[17]: https://github.com/dbos-inc/dbos-transact-py
[18]: https://github.com/restatedev/restate
[19]: https://github.com/sigstore/sigstore-a2a
[20]: https://a2a-protocol.org/latest/specification/
[21]: https://dev.to/sunnydachs/do-agents-survive-a-crash-and-why-does-an-llm-retry-execute-the-same-side-effect-twice-34-runs-52gd
[22]: https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/compliance/owasp-agentic-top10-architecture.md
[23]: https://www.thirdbrain.tech/KB-AI/ai-agentic-systems/protocols-and-standards/a2a-protocol

> 一手证据：仓库元数据（GitHub API，2026-11-14 抓取）、README、release notes、A2A/MCP 官方规范页面、本仓 `src/` 源码。
> 二手证据（仅背景）：[21] 的 34 次框架实测、[23] 的自报采用数据、Agensh 论文性能数字、Red Hat / OpenA2A AIP / Wirken 的报道。
> 待核实：TCK 在本仓的实际通过率（未跑，需 Python 环境）；MCP SDK v2 的具体 API 破坏面；`a2a-scanner` 规则对本仓卡片的误报率。
