# P5 决策报告：MCP SDK v2 / 2026-07-28 / Tasks 扩展

> **结论：本版本（0.6.0）不升级。** 维持 `@modelcontextprotocol/sdk`，不改
> `package.json` 依赖、不改 `src/index.ts`、不改 `scripts/install.ps1`。
> 本报告 + 小范围 PoC 是规划 §4 P5 要求的全部交付；升级与否留待触发条件成立。
>
> 核实日期：2026-11-14。一手来源为 MCP 官方 blog / 规范 / SEP；二手来源仅作
> 佐证，不作为设计依据（规划 §7）。

---

## 1. 决策摘要

| 问题 | 结论 |
| --- | --- |
| 是否升级到 TS SDK v2（2026-07-28 wire） | **否**。破坏性变更面大，收益主要是减少私有协议面，而本仓主协议面是 A2A |
| 是否对齐 `io.modelcontextprotocol/tasks` 扩展 | **否（本版本）**。语义高度吻合但非无损，且需先切到 2026-07-28 wire |
| 是否引入新运行时依赖 | **否**。PoC 零依赖，不改 `package.json` |
| 是否需要现在动 `install.ps1` | **否**。核对后该脚本不含 SDK 引用（见 §3 修正） |
| 何时重新评估 | 见 §7 的三个触发条件与 v1.x 安全窗口 |

---

## 2. 核实到的上游事实

| 事实 | 来源 | 级别 |
| --- | --- | --- |
| MCP 2026-07-28 规范转为 stateless：移除 `initialize` 握手与协议级 session，改 `server/discover`；引入 MRTR（`InputRequiredResult`）、`Mcp-Method` / `Mcp-Name` 头、标准错误码（缺资源由 `-32002` 改 `-32602`）、`ttlMs` / `cacheScope` | [MCP 官方 blog：SDK betas for 2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/) | 一手 |
| TS SDK **v2.0.0 GA 2026-07-27**：单体 `@modelcontextprotocol/sdk` 拆为 9 个 scoped packages（core / client / server / server-legacy / node / express / fastify / hono / codemod）；ESM-only；Node 20+；工具 schema 改用 Standard Schema（Zod v4 等） | 同上官方 blog；[拆包清单与 2.0.0 release notes 摘要](https://mcp-news.com/news/typescript-sdk-splits-into-nine-scoped-packages) | 一手 + 二手佐证 |
| v2 是**独立 major 的破坏性升级**，与 7/28 规范发布日解耦；升级 TS SDK 本身不改变 HTTP wire（需显式接 transport）；v1.x 继续发布 bugfix / 安全更新**至少 6 个月**；1.30.0 与 2.0.0 同日发布，保持 1.x 维护线 | [MCP 官方 blog](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/) | 一手 |
| **SEP-2663 Tasks Extension 已 Final**（创建 2026-04-27，Agents Working Group，扩展标识 `io.modelcontextprotocol/tasks`）：把 2025-11-25 的实验性 tasks 从核心移出为扩展；方法 `tasks/get` / `tasks/update` / `tasks/cancel`；`resultType:"task"` 判别；状态 `working / input_required / completed / cancelled / failed`；`inputRequests` 承载 mid-flight 输入；**因 sessionless 移除了 `tasks/list`**；未协商能力的客户端返回 `-32021` | [SEP-2663 原文](https://modelcontextprotocol.io/seps/2663-tasks-extension)、[Tasks 扩展规范](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)、[官方概览](https://modelcontextprotocol.io/extensions/tasks/overview) | 一手 |
| Task 创建是 **server-directed**：客户端只在 per-request `_meta` 声明扩展能力，服务器逐请求决定是否返回 `CreateTaskResult`；服务端 MUST 在 task 持久化之后才能返回该结果 | 同上 SEP-2663 / 规范 | 一手 |
| 第三方迁移实例显示 v2 迁移涉及 import 路径、`zod/v4` schema、`InMemoryTransport` 测试接线、以及 `server-legacy` 兼容面 | [assistant-ui PR #5316](https://github.com/assistant-ui/assistant-ui/pull/5316)、[无状态迁移实务](https://mcp360.ai/blog/migrating-to-stateless-mcp) | 二手（仅佐证） |

> 数字口径说明：本仓 `package-lock.json` 实际锁定 `@modelcontextprotocol/sdk@1.32.1`
> （`package.json` 声明 `^1.0.0`）。上游资料提到的 1.30.0 是 v2 GA 同日的
> legacy-line 发布；1.32.1 应为其后的维护补丁，具体 EOL 需以 SDK changelog
> 复核，本报告不据此推断「已停止安全支持」。

---

## 3. 本仓现状盘点（核对后）

| 项 | 事实 | 位置 |
| --- | --- | --- |
| 运行时依赖 | 仅 `@modelcontextprotocol/sdk@^1.0.0`（锁 1.32.1）；dev 依赖 7 个 | `package.json`、`package-lock.json` |
| MCP 接线 | v1 单体导入：`sdk/server/index.js`、`sdk/server/stdio.js`、`sdk/types.js`；`Server` + `CallToolRequestSchema` / `ListToolsRequestSchema` | `src/index.ts:10-15` |
| 工具面 | P1 后 9 个工具从单一 Action registry 生成，MCP 与 A2A 同源 | `src/actions/registry.ts`、`src/tools.ts` |
| 异步语义 | `cursor_run` 立即返回 jobId；`cursor_status` 轮询；`cursor_reply` 追问；`cursor_cancel` 取消 | `src/actions/registry.ts` |
| 状态 | `running / input-required / completed / failed / cancelled` | `src/types.ts` |
| 持久化 | P3：任务在返回 jobId 前已持久化；`requestKey` 去重、原子 checkpoint、lease、side-effect markers、owner-liveness recovery | `src/store.ts`、`src/runner.ts` |
| 发布形态 | esbuild 把整个 server 打成单个 `lib/index.mjs`，目标机**无需 node_modules**；zip 需双平台可复现 | `scripts/build-release.mjs` |
| 安装脚本 | `install.ps1` 只处理离线 Node 包、MCP 客户端注册与目录，**不含任何 SDK 引用** | `scripts/install.ps1:224-232` |

**对规划 §8 决策点 3 的修正**：原规划推测 v2 评估「可能影响 `install.ps1` 与 MCP
客户端注册方式」。核对后 `install.ps1` 不 import SDK，耦合点实际在
`src/index.ts` 的 v1 导入路径与 `scripts/build-release.mjs` 的 esbuild 打包输入。
因此升级不必然改动安装脚本，但**必然**要重新验证单文件 win-x64 离线包的
可复现性与体积。

---

## 4. 语义映射（PoC 实测）

`scripts/poc-mcp-tasks.mjs` 是零依赖评估脚本，**不 import SDK、不改生产代码**，
把 4 个核心工具映射到 Tasks 扩展并断言映射是否无损：

| 本仓工具 | Tasks 等价 | 无损 | 说明 |
| --- | --- | --- | --- |
| `cursor_run` | `tools/call` → `CreateTaskResult`（`resultType:"task"`） | ✅ | `JobManager.start()` 在返回 jobId 前已持久化，满足 SEP「durable before respond」；P3 `requestKey` 去重强于规范下限 |
| `cursor_status` | `tasks/get { taskId }` | ❌ | 本仓 `JobView` 带 events / artifacts / cost；Tasks `GetTaskResult` 只有状态与终态 result，中间产物需另开 resource/tool |
| `cursor_reply` | `tasks/update`（履行 `inputRequests`） | ❌ | 语义同为 pause/resume，但 `tasks/update` 的确切 wire shape 由 ext-tasks / MRTR 定义，PoC 不臆造字段 |
| `cursor_cancel` | `tasks/cancel { taskId }` | ✅ | 双方都是协作式取消；本仓已有进程树 kill |

PoC 的 7 项断言全部通过，并**显式声明 2 个缺口**（不把「语义相近」写成「可直接替换」）：

```text
[poc-mcp-tasks] 7/7 alignment checks passed; 2 declared gaps
```

复现：

```bash
npm run poc:mcp-tasks
```

---

## 5. 升级成本清单（破坏性变更逐项）

| # | 变更点 | 影响本仓 |
| --- | --- | --- |
| 1 | 单体包 → 9 个 scoped packages | `src/index.ts` 全部 import 路径重写；`package.json` 依赖从 1 个变多个 |
| 2 | ESM-only / Node 20+ | 本仓已 ESM、CI Node 22，影响小；但离线 Node 包版本需复核 |
| 3 | `Server` + `CallToolRequestSchema` → `McpServer.registerTool` + Standard Schema | `src/index.ts` 与 `src/tools.ts` 的 schema 生成路径重写；9 个 Action 的 `JsonObjectSchema` 需适配 Zod v4 / Valibot |
| 4 | 2026-07-28 wire：`server/discover`、移除 session、`Mcp-Method` / `Mcp-Name` 头 | stdio transport 影响有限，但任何 HTTP 化部署与网关都要改；现有 MCP 客户端配置需重新验证 |
| 5 | 错误码 `-32002` → `-32602` | 本仓错误映射与测试断言需复核 |
| 6 | `tasks` 从核心移到扩展，需显式协商能力 | 现有 `cursor_*` 工具不受影响；只有想对齐 Tasks 才需新增协商与 `CreateTaskResult` 分支 |
| 7 | esbuild 单文件 bundle 输入变化 | 必须重跑 `build:release` 的双平台可复现性比对、`SHA256SUMS` 与 zip 体积基线 |
| 8 | 双平台 CI | linux / windows 的 `npm ci`、`npm test`、`verify` 全链路需重新验证 |

对照收益：主要是「减少私有异步协议面」。但本仓 P1 已把 MCP 与 A2A 收敛到同一
Action registry，工具名与参数签名对现有客户端稳定；A2A 面（v1.0 + TCK）才是对外
主协议面。因此收益不足以抵消上述 8 项成本与发布风险。

---

## 6. 风险判断

- **客户端兼容**：现有 Cursor / Claude MCP 配置指向一个 stdio server，工具名固定。
  升级 v2 若同时切到 2026-07-28 wire，老客户端存在连不上的风险；上游虽提供
  `server-legacy` 兼容面，但那又引入第二个包，与「零新增运行时依赖」冲突。
- **发布物风险**：单文件 win-x64 离线包是本仓的核心交付形态，v2 拆包后的
  bundle 结果未经本仓验证，不能在发版前夜引入。
- **时间窗口**：按上游「v2 后 v1.x 至少 6 个月安全更新」的承诺，窗口约至
  2027-01-27。这给出明确的重评时间点，而不是无限期搁置。
- **不做「为了新而升级」**：规划 §7 明确此原则，本决策遵循。

---

## 7. 决策与重新评估触发条件

**决策**：0.6.0 保持 v1.x；记录本报告与 PoC，不立项升级。

出现以下任一条件时重新评估（建议单独立项，不影响当前发版）：

1. 上游 v1.x 安全支持窗口结束（约 2027-01-27 之后需复核 changelog），或出现
   影响本仓的 v1.x 安全公告而 v2 已修复。
2. 主流 MCP 客户端（Cursor / Claude Desktop 等）默认要求 2026-07-28 wire，
   且不再回退到 `initialize` 握手。
3. TS SDK v2 出现明确 LTS，codemod 覆盖 stdio server 场景，且本仓完成一次
   「单文件 bundle 可复现 + 双平台 CI + 现有客户端配置」的预研验证。

若届时决定对齐 Tasks 扩展，§4 的 2 个缺口必须先有方案：
中间产物（events / artifacts / cost）如何暴露，以及 `tasks/update` 的
mid-flight input 如何与 P2 的 `permissionRequest` / `input-required` 对齐。

---

## 8. 本轮明确未改动

```text
package.json 的 dependencies        —— 仍为 "@modelcontextprotocol/sdk": "^1.0.0"
package-lock.json                   —— 仍锁 1.32.1
src/index.ts / src/tools.ts         —— 仍为 v1 单体 SDK 接线
scripts/install.ps1                 —— 未改
scripts/build-release.mjs           —— 未改
```

新增仅为评估产物：`docs/p5-mcp-sdk-v2-decision.md`、
`scripts/poc-mcp-tasks.mjs`、`npm run poc:mcp-tasks` 脚本入口。

---

## 9. 与规划文档的对账

| 规划 §4 P5 / §5 / §8 | 本轮结果 |
| --- | --- |
| 「先出迁移决策报告 + 小范围 PoC，不直接升级」 | 已出报告 + 零依赖 PoC，未升级 |
| 优先级矩阵「P5 仅评估」 | 遵守；未改生产代码 |
| 决策点 3「可能影响 install.ps1」 | 核对后修正：`install.ps1` 无 SDK 耦合，真实耦合在 `src/index.ts` 与 `build-release.mjs` |
| §6.6「零新增运行时依赖」 | PoC 零依赖，`package.json` 未变 |
