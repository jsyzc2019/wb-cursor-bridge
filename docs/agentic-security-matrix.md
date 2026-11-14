# OWASP Agentic Top 10 (2026) 可审计映射矩阵 · P4

> 范围：本文件是**自评映射**，不是合规认证。OWASP Agentic Applications Top 10
> （GenAI Security Project，2026）条目名取自公开清单；本仓按单机 loopback 部署
> 模型逐条对账。每个控制点都指向真实代码位置与验证手段，便于第三方复核。
>
> 状态图例：**覆盖** = 已有实现且有测试/CI 断言；**部分** = 有实现但存在已知边界；
> **缺口** = 明确未做（附判定理由）；**不做** = 与部署模型不匹配，评估后判定不投入。

---

## 1. 部署前提（决定了后面绝大多数判定）

| 前提 | 事实 | 依据 |
| --- | --- | --- |
| 控制面 | 单向：客户端 → bridge → Cursor CLI；Cursor 不能反向派活 | 规划 §7；`src/cursor/cli.ts` 无反向通道 |
| 监听 | A2A / admin 默认 `127.0.0.1`；绑 `0.0.0.0` 而无 token 时直接拒绝启动 | `src/config.ts:431`、`src/a2a/server.ts:379`、`src/admin.ts:120` |
| 依赖 | 唯一运行时依赖 `@modelcontextprotocol/sdk`；零新增运行时依赖是架构铁律 | `package.json`；规划 §6.6 |
| 身份 | 单一共享 bearer token，无 per-client 身份、无委派链 | `src/a2a/server.ts:489` |

这几条是刻意的架构选择，不是遗漏：本机单用户场景引入 mTLS / SPIFFE /
透明日志的收益不抵成本（规划 §7）。因此本矩阵对「多机 mesh 治理」类条目
一律判定为**不做**，而不是假装覆盖。

---

## 2. 逐条映射

| # | OWASP 条目 | 状态 | 本仓现有控制（代码位置） | 验证 / 证据 |
| --- | --- | --- | --- | --- |
| ASI01 | Agent Goal Hijack（目标劫持） | **部分** | `argv` 用 `--` 终止选项解析，prompt 只能是数据；model 以 `-` 开头直接拒绝，防止偷渡 `--force` / `--mode`；权限分级 `consult/plan/execute`；workspace root allowlist（`realpathSync.native` 双侧比较） | `src/cursor/cli.ts:64-113`、`src/util/paths.ts:110-114`；`test/unit.test.mjs` / `test/audit-*.test.mjs` |
| ASI02 | Tool Misuse and Exploitation（工具滥用） | **部分** | flag 集合由 `tierArgs()` 固定，仅 `execute` 带 `--force`；spawn 不带 shell（CVE-2024-27980）；写操作限定在 bridge 自建的 detached worktree；`extraArgs` 只来自配置文件，不接受请求注入 | `src/cursor/cli.ts:64-99,156`、`src/util/git.ts:54-70` |
| ASI03 | Identity and Privilege Abuse（身份/权限滥用） | **部分** | 常量时间 token 比较（SHA-256 摘要后 `timingSafeEqual`）；admin 只绑 loopback；per-client 令牌桶限流；未认证 Agent Card 只发布 root 的 basename，不泄漏绝对路径 | `src/a2a/server.ts:82-102,484-513`、`src/admin.ts:10-23,120`、`src/a2a/skills.ts:38-48` |
| ASI04 | Agentic Supply Chain Vulnerabilities（供应链） | **覆盖** | 生产依赖 `npm audit --omit=dev --audit-level=high` 门禁；发布 zip 双平台 rebuild 后逐字节比对可复现；`SHA256SUMS` 与平台 asset digest 双向校验；CI 中的 Python/TCK 工具链不进发布物 | `.github/workflows/ci.yml:35-36,143-154`；Release v0.5.1 校验记录 |
| ASI05 | Unexpected Code Execution（意外代码执行） | **部分** | 无 shell、无 `.cmd/.bat` 隐式解释器；patch 只在受控 worktree 内 `git apply --index`；路径越界 fail-closed；worktree 生命周期由 bridge 独占 | `src/cursor/cli.ts:156`、`src/util/git.ts:102-130`、`src/util/paths.ts` |
| ASI06 | Memory and Context Poisoning（记忆/上下文投毒） | **部分** | 无跨任务共享记忆，每个 job 独立事件环；事件环有「条数 + 字节」双预算淘汰；`maxJobs` / TTL sweeper 限制留存；P2 起 `contextId` 续跑显式校验归属 | `src/store.ts:304-309,578`、`src/runner.ts:769-786`、`src/a2a/server.ts` (contextId 归属) |
| ASI07 | Insecure Inter-Agent Communication（智能体间通信） | **部分 → 本轮补强** | v1.0 版本协商 `A2A-Version` + `VersionNotSupportedError(-32009)`；官方 TCK MUST 门禁；卡片诚实性静态扫描（本轮 P4）；push target SSRF 全地址 DNS 解析 + `redirect:'manual'` + allowlist；v1.0 push 未实现时卡片如实声明 `false` | `src/a2a/v1.ts`、`scripts/tck.mjs`、`scripts/scan-card.mjs`、`src/util/net.ts`、`src/a2a/server.ts:1060-1085`、`src/a2a/watch.ts:189` |
| ASI08 | Cascading Failures（级联失败） | **覆盖** | `maxConcurrency` / `maxLiveJobs` 双上限；`timeoutSec` 钳制；rate limit；P3 的 `requestKey` 去重、原子 checkpoint、lease、side-effect markers、owner-liveness recovery；孤儿回收校验 `/proc/<pid>/cmdline` | `src/runner.ts:220-249,769-786`、`src/store.ts:26,230-261`、`src/util/processes.ts`；`test/p3-idempotency.test.mjs` |
| ASI09 | Human-Agent Trust Exploitation（人机信任利用） | **部分** | `input-required` 审批暂停；P2 的 `permissionRequest` artifact 带 resume hint（caller-answered pause，不引入 worker 自主行动）；结构化 `transcript` / `toolCalls` / `cost` artifact 可事后审计；JSONL 轮转日志 | `src/artifacts.ts`、`src/a2a/convert.ts`、`src/logger.ts`；`test/p2-structured.test.mjs` |
| ASI10 | Rogue Agents（失控智能体） | **部分** | 进程树 kill + drain 窗口；`tasks/cancel`；优雅 `shutdown(grace)`；孤儿进程回收；worktree 有界重试清理 | `src/cursor/cli.ts:499-518`、`src/runner.ts:806-814`、`src/util/git.ts:168+`；`test/e2e.test.mjs` |

---

## 3. 已知缺口与判定理由（不粉饰）

按规划 §4 P4「评估先行，部分可能判定不做」的要求，逐项给出结论：

| 缺口 | 涉及条目 | 判定 | 理由 |
| --- | --- | --- | --- |
| 语义级 prompt injection（"忽略之前的指令"） | ASI01 | **接受** | bridge 只能保证「prompt 是数据、不能变成 argv flag」；内容级对抗属于 LLM/worker 层职责，bridge 无法可靠判定 |
| 请求可覆盖 skill 的 `defaultTier`（`metadata.tier`） | ASI01/ASI02 | **已知缺口，本轮不做** | 对应 P4 第三项「按能力名授权」。规划把 P4 限定为「只做前两项」，需单独立项 |
| 单一共享 token，无 TTL / 委派链 / per-client 身份 | ASI03 | **不做** | 单机 loopback + 单操作员场景，引入身份基础设施收益低（规划 §7） |
| 无 TLS、无 Card 签名、无透明日志 | ASI07/ASI04 | **不做（本机）/ 评估（签名）** | 明文仅存在于 loopback；卡片签名属 P4 高成本项，规划已判定「单机部署收益低，倾向不做」 |
| 无哈希链审计日志、无策略决策日志 | ASI06/ASI09 | **不做** | 现有 JSONL + 轮转已满足离线排障；哈希链是为多机取证设计的 |
| `execute` tier 允许 LLM 在 worktree 内写文件 | ASI05 | **设计意图** | worktree 是隔离不是沙箱（无 seccomp）；操作员显式选择 `execute` 即授权写入 |
| 无全局 kill switch / 行为异常检测 | ASI10 | **不做** | 现有 timeout + cancel + 进程树 kill 已覆盖本机失控路径 |
| 无「人在回路」强制审批引擎 | ASI09 | **接受** | `input-required` 由 worker 自报 `needInput`，不是策略引擎强制；升级需引入独立策略层 |

---

## 4. 本轮 P4 实际交付（仅前两项）

1. **可审计矩阵**：本文件，逐条映射到 `src/` 具体位置，缺口与不做项显式列出。
2. **Agent Card 静态扫描进 CI**：
   - `scripts/scan-card.mjs`：零运行时依赖，从 `dist/a2a/card.js` 真实生产构造器
     生成 `agent.json` 与 `agent-card.json`，校验字段集合、v0.3 字段泄漏、
     `supportedInterfaces` / `protocolBinding`、URL scheme/host、重复 binding、
     capability honesty（例如声明 `pushNotifications=true` 却没有 delivery 契约 → error）。
   - `test/card-scan.test.mjs`：12 个用例，其中 10 个用**故意损坏的卡片**验证门禁
     真的会失败，最后一个校验真实生产卡片。
   - `npm run scan:card`（含 build，自包含）；linux / windows 两个 job 均加
     `Agent Card static scan (P4)` step。
   - 未引入外部 `a2a-scanner`：规划 §6.6 的「零新增运行时依赖 / 单文件 win-x64
     离线包」优先于直接采纳工具名。

**扫描器能挡住的 ASI07 具体场景**：卡片误声明 `pushNotifications:true`、
卡片泄漏 `protocolVersion` / `preferredTransport` 导致 v1.0 客户端建错 transport、
`supportedInterfaces` 缺失（TCK `BIND-FIELD-001` 类）、binding 拼错或重复、
把 loopback 之外的通配地址 `0.0.0.0` 发布成公共卡片。

---

## 5. 复核方法

```bash
npm run scan:card        # 打印 JSON report，findings 非空则 exit 1
npm run test:card-scan   # 门禁自身的回归测试
npm test                 # 含上述 12 个用例
npm run verify           # 8 阶段，含 lint / typecheck / 全量测试
npm run test:tck         # 官方 A2A TCK MUST 门禁（另见 docs/p0-a2a-v1-tck-compliance.md）
```

CI 中任何一条 finding 都会让 linux 与 windows job 同时失败，因此卡片漂移无法
静默合入。P4 之后若实现完整 v1.0 push / 多绑定，卡片会随之改变，扫描器的
`BINDINGS` 集合与 honesty 规则是同步更新的强制检查点。

---

## 6. 与其他文档的关系

- `docs/agent-collaboration-research-plan.md` §4 P4 / §5 / §7：本矩阵的范围依据。
- `docs/p0-a2a-v1-tck-compliance.md`：ASI07 的协议合规证据与 MANUAL / NOT TESTED 清单。
- `docs/p3-idempotency-design.md`：ASI08 的设计依据。
- 后续 `docs/p5-mcp-sdk-v2-decision.md`、`docs/a2a-v1-multibinding.md`：本轮后续交付。
