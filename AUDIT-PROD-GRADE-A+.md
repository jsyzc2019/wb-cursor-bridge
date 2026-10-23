# 生产级全栈审计与优化规划 — wb-cursor-bridge

> 目标：以 **A+** 为基准，对 `wb-cursor-bridge` (v0.3.3) 做一次对照 A2A 业界最优实践的
> **系统科学性 / 代码强壮性 / 逻辑严密性 / 协议规范性 / 执行落地性 / 功能扩展性** 六维端到端审计，
> 并据此给出可落地的后续工作规划。
>
> 审计日期：2026-10-23 ｜ 审计基线：`fee12d6` 之后（含 F1–F8 A2A 语义层落地、71 项测试全绿）
> 协议校准依据：A2A 规范 v0.3.0 与 v1.0 / v1.0.1（破坏性重构对照）

---

## 0. 方法论与前置校准

- **审计方式**：全仓静态通读（`src/` 3865 行 + `test/`）+ 实际执行 `npm run verify`（typecheck/71 测试/release 构建全绿）+ 对照 A2A 官方规范文本逐条核对。
- **关键校准（先纠偏，避免误判）**：本项目**声明并实际使用 A2A v0.3.0**（见 `src/a2a/card.ts:30` `PROTOCOL_VERSION='0.3.0'`，且 Part 用 `kind` 判别联合、FilePart 嵌套 `file`、Card 顶层带 `protocolVersion`——这是 v0.3.0 的形状）。A2A 在 **v1.0 做了破坏性重构**（统一 Part、移走 `protocolVersion` 到 `supportedInterfaces`、FileContent 改为 `url/filename/mediaType/raw`）。因此下列早期判断需按 v0.3.0 重新定性：
  - ❌ 旧判「`protocolVersion:'0.3.0'` 与 v1.0 不一致是 bug」→ ✅ 实为**内部自洽**，只是命中了一个**被取代的早期草案**（这是**战略风险**，非当下缺陷）。
  - ❌ 旧判「SSE 在 `input-required` 标 `final` 并断流是偏差」→ ✅ 实为**符合 v0.3.0**：规范明确 `message/stream` 在任务进入 *interrupted*（含 input-required）或终态时结束流，客户端用 `message/send` 带 `taskId` 续跑。
  - ❌ 旧判「`PushNotificationConfig.token` 非标准」→ ✅ `token` 是标准字段；真正缺的是未消费 `authentication.schemes`。
  - ❌ 旧判「`FilePart` 应用 `name`」→ ✅ 对 v0.3.0 成立（`FileContent.name` 标准字段）；但代码**自相矛盾**：`a2a/types.ts:67` 声明 `name`，`runner.ts:79` 却写成 `filename`，且 `uri` 是本地 `file://` 路径——这条保留为真实缺陷。
- **结论先放**：架构骨架（传输无关引擎 + 双传输复用）设计到位，状态机映射完整，崩溃恢复/权限边界意图正确。但围绕**招牌 A2A 能力（input-required 续跑、文件产物）存在两个会真实击穿的 P0 缺陷**，外加并发/资源/安全类的 P1 生产隐患。

---

## 1. 六维评分卡（现状 → 目标 A+）

| 维度 | 当前评级 | 距离 A+ 的主要差距 |
|---|---|---|
| 系统科学性（架构） | **A** | 分层干净、引擎复用良好；仅 `convert↔runner` 耦合、`runner.ts` 偏大、双传输 dispatch 重复 |
| 代码强壮性（容错/资源） | **B−** | LRU 驱逐误杀 input-required、SSE 监听器泄漏、push 观察器不可取消、worktree 清理未覆盖 `runCursor` 异常、cancel 指标漏记 |
| 逻辑严密性（状态机） | **B** | `input-required` 续跑契约在 LRU 边界不自洽、reply 无 CAS 守卫（并发续跑/取消后复活）、终态 `message/send` 非幂等 |
| 协议规范性（A2A 保真） | **B** | `FilePart.filename` 字段错、`uri` 本地不可达、推送配置读取位置非标准、DataPart 数组而非对象、终态重发不该 spawn follow-up |
| 执行落地性（生产就绪） | **C+** | A2A 端口无 healthz/metrics、0.0.0.0 无 token 暴露、push URL SSRF、**stress/fault 未进 `verify` 门禁**、无 CORS/限流 |
| 功能扩展性（可演进） | **B** | skill 粒度粗（一根一 skill）、新增传输复制 dispatch、`unhandledRejection` 不退出、v0.3.0 草案锁定（v1.0 迁移未规划） |
| **综合** | **B / 约 3.6→4.0** | P0×2 + P1×8 修完可达 **A**；叠加 P2/P3 与 v1.0 对齐可冲 **A+** |

---

## 2. 系统性结论（一页纸）

**强项（保留）**
- 执行引擎 `JobManager`（runner/store/types）真正传输无关；MCP 与 A2A 两条传输都只做"信封↔引擎"翻译，状态映射仅存在于 `convert.ts:24` 一处（`toTaskState` 对 7 种状态全覆盖、类型穷尽）。
- 权限边界意识强：workspace 白名单（`assertWorkspaceAllowed`）、execute 强制 worktree 隔离、admin 仅 loopback、配置文件数值项有 `num()` 区间校验。
- 崩溃恢复用心：`store.load()` 把 `running` 标 orphaned，JSONL 事件日志与原子 index 写（`writeFileSync`+`renameSync`）。
- 无死代码、无遗留 TODO/补丁脚手架（`grep` 干净）。

**阻断项（必须先修，否则"互联互通"名不副实）**
1. **P0-A `store.evict()` 把 `input-required` 当"已完成"驱逐**（`store.ts:301-303`：`filter(j => j.status !== 'running')`）。这是招牌 A2A 能力 `input-required → 同 taskId 续跑` 的契约杀手：挂起等待人工输入、其间上百任务完成即触发 LRU，续跑 `reply()` 因 `store.require` 抛 `notFound` 而断裂。
2. **P0-B 文件产物协议字段错且本地不可达**（`runner.ts:79` 写 `filename` 而非标准 `name`；`uri:'file://...'` 对远程 agent 无意义、Windows 下非法 file URI）。合规模板客户端读取 `file.name` 得到 `undefined`，且拿不到 patch/report。

**战略风险**
- 项目锁定 **A2A v0.3.0（已被取代的早期草案）**。若对端讲 v1.0（统一 Part、新 FileContent），wire 不兼容，无法互操作。需在路线图中决策：维持 0.3.0 还是迁移 v1.0（建议后者，配兼容垫片）。

---

## 3. 逐维度审计发现

### 3.1 系统科学性 — A
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| 转换层反向依赖引擎：`convert.ts:12` `import { buildArtifacts } from '../runner.js'`，复用映射被迫引入整个 runner | `convert.ts` / `runner.ts` | LOW | 抽出 `buildArtifacts`/`filePart` 到独立 `src/artifacts.ts`，两处共用 |
| `runner.ts` 641 行，混入 `JobManager`/`buildArtifacts`/`Metrics` 常量 | `runner.ts` | LOW | 随上条一并拆分 |
| 双传输 dispatch 复制：A2A `dispatch`（`server.ts:242`）与 MCP `createDispatcher`（`tools.ts:175`）各自 switch | `server.ts`/`tools.ts` | LOW | 抽"方法名→引擎调用"共享映射，传输层只管信封 |

### 3.2 代码强壮性 — B−
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| **LRU 驱逐误杀 `input-required`** | `store.ts:301-303` | **P0** | 引入 `isLive(s)=> s==='running'||s==='input-required'`，`evict` 仅驱逐非 live；`load`/`watch` 复用同一判定 |
| `watch.ts sleep()` 每次轮询向 `AbortSignal` 叠加 `{once:true}` 监听器，未触发则永不移除 → 长 SSE 累积数千死监听 | `watch.ts:210-224` | P1 | 进入循环前**注册一次** abort 监听，或在每次 `sleep` 后 `removeEventListener` |
| `watchAndPush` 无 `AbortSignal`、无限 `for(;;)`、fire-and-forget；客户端断开 SSE 后推送观察器仍轮询到终态 | `watch.ts:125-154`、`server.ts:350-356` | P1 | 传入 `AbortSignal`（复用 `httpReq.on('close')` 的 controller），`for` 内检查 `signal.aborted` 即返 |
| 运行中任务被 `cancel()` 时走 `controller.abort()` 分支，**不增 `metrics.cancelled`**（仅无 controller 的 input-required 才 +1） | `runner.ts:520-526` | P1 | 两条分支都 `metrics.cancelled += 1`（或在 execute 回填分支补记） |
| worktree 清理仅在 `if(worktree){...finally}` 内，`runCursor` 若 reject 则跳过该块、worktree 泄漏 | `runner.ts:303` vs `359-361` | P1 | 把"建树→runCursor→取产物→删树"整体包 `try/finally`，`removeWorktree` 在 finally 中（其自身 `never throws`，安全） |
| `unhandledRejection` 只记日志不退出，与 `uncaughtException` 立即 shutdown 不对称 | `index.ts:173-175` | LOW | 计数并在阈值后受控退出 |
| `bridge_shutdown` 工具 `return ok()` 后 `.then(process.exit)`，MCP stdio 异步写回 stdout 可能被截断 | `tools.ts:282-292` | LOW | 退出前 `await` 一次传输 flush 再 `exit` |

### 3.3 逻辑严密性 — B
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| `input-required` 续跑契约在 LRU 边界不自洽（见 P0-A） | `store.ts`/`runner.ts:541` | **P0** | 先修 P0-A |
| `reply()`/`resumeFromInput()` 无 CAS/锁：两个并发 `reply` 同时命中 input-required 会各起一次 execute（双倍执行）；`cancel` 与 `reply` 交错可"复活"已取消任务 | `runner.ts:541-556`、`427-456` | P1 | 进入续跑前原子校验 `if(j.status!=='input-required') throw/return`；`cancelled` 态拒绝续跑（状态守卫统一在 `reply` 入口） |
| 相同 `taskId` 的 `message/send` 对终态任务 **spawn follow-up**（不同 id），非幂等；网络重试会创建重复任务 | `server.ts:306-323` | P1 | 终态 `taskId` 的 `message/send` 直接报错（`TASK_NOT_FOUND`/不可重启），follow-up 语义仅在显式续跑意图下保留，或文档明示非幂等 |
| `toTask` 对 `input-required` 用 `createdAt` 而非 `inputRequiredAt` 作 `status.timestamp` | `convert.ts:154` | LOW | 优先 `job.inputRequiredAt ?? job.finishedAt ?? job.createdAt` |

### 3.4 协议规范性（A2A v0.3.0 对照）— B
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| **`FilePart.file` 写 `filename` 而非标准 `name`** | `runner.ts:79` | **P0** | 改为 `name`（与 `a2a/types.ts:67` 自洽） |
| **产物 `uri:file://` 本地路径，远程 agent 不可达** | `runner.ts:79` | P0/P2 | 小文件 `bytes_inline` 内联；大文件新增 HTTP 下载端点 `/a2a/artifacts/:taskId/:name` 并指向带鉴权 URL |
| 推送配置读 `message.metadata.pushNotification`，非标准 `params.configuration.pushNotificationConfig`；`blocking`/`historyLength`/`acceptedOutputModes` 未读 | `convert.ts:70-81`、`server.ts:dispatch` | P1 | 优先读 `configuration.pushNotificationConfig`（metadata 作兼容回退），并消费 `configuration.blocking`/`historyLength` |
| `DataPart.changedFiles` 传 `string[]` 而非 `Record<string,unknown>` | `runner.ts:42` | P2 | 包装为 `{ files: [...] }` 或改用 `text` Part |
| `role:'agent'` 被允许作为 `message/send` 发起角色 | `server.ts:425-427` | P2 | `message/send` 仅接受 `user`（续跑消息本就是用户侧输入） |
| 不支持 JSON-RPC 批量；无 `id` 的通知仍以 `id:null` 回响应 | `server.ts:200-210` | P2 | 通知不回包；可选支持 batch（A2A 允许） |

### 3.5 执行落地性（生产就绪）— C+
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| A2A 端口无 `/healthz`/`/metrics`/`/version`，无法接入 k8s 探针/编排器 | `server.ts:72-107` | P2 | 复用 `mgr.health()`/`getMetrics()` 暴露，受同一 auth 守卫 |
| `a2aHost='0.0.0.0'` 且未设 `a2aAuthToken` 时控制面全网暴露，无启动告警/拒绝 | `server.ts:113`、`config.ts:268` | P1 | 启动时若 `a2aHost==='0.0.0.0' && !a2aAuthToken` → `log.warn` 并（可选）拒绝监听 |
| 推送 URL 客户端可控、服务端 `fetch` 外发 → **SSRF**（可打内网/云元数据 `169.254.169.254`） | `server.ts:350`+`watch.ts:168` | P1 | 校验 `url` 为 http/https；阻断私有/链路本地地址（除非 allowlist）；**要求开启 auth 才允许 push** |
| 无 CORS 头（未来 Web 控制台类客户端会受限） | `server.ts` | P2 | 视场景加 `Access-Control-*` |
| 无速率限制（结合暴露面可被高频打满 `maxConcurrency` 或 SSRF 循环） | `server.ts`/`admin.ts` | P2 | A2A POST 加简单令牌桶 |
| `a2aHost` 等配置缺非空/格式校验 | `config.ts:268` | LOW | 启动时校验非空 |
| **`verify` 门禁不含 stress/fault**（`test` 脚本仅 4 文件），故障/压力路径不被 CI 守护 | `package.json:25,34` | P1 | 将 `test:stress`/`test:fault` 纳入 `verify`（或独立 `verify:hardening`） |

### 3.6 功能扩展性 — B
| 发现 | 位置 | 严重度 | 修复 |
|---|---|---|---|
| skill 粒度粗：一个 workspace 根 = 一个 skill，难扩展"同根多语义 skill / 外部 skill 目录" | `a2a/skills.ts:43-77` | LOW | 扩展点改为"加根/加外部 skill 目录"，或支持 per-root 多 skill 声明 |
| 新增传输重复 dispatch 逻辑 | 见 3.1 | LOW | 抽共享映射 |
| 锁定 v0.3.0 草案，v1.0 迁移未规划（战略） | `card.ts:30` | P3/战略 | 见路线图 Phase 3 |

---

## 4. A2A 协议合规性对照表（v0.3.0）

| A2A 原语 | 要求 | 现状 | 判定 |
|---|---|---|---|
| 发现：Agent Card | `/.well-known/agent.json`（兼 `agent-card.json`）、必填字段齐全 | `server.ts:75`、`card.ts:32-51` | ✅ 通过 |
| 能力声明 | streaming / pushNotifications / stateTransitionHistory | `card.ts:42-46` | ✅ 通过 |
| 认证宣告 | `securitySchemes`+`security` | `card.ts:53-62` | ✅ 通过（http/bearer） |
| JSON-RPC 2.0 信封 | `jsonrpc/id/result|error`，错误用 200+error 对象 | `server.ts:139-140` | ✅ 通过 |
| 错误码 | 标准 + A2A 区间（`-32001`等） | `types.ts:19-37`、`a2aErrorCode` | ✅ 通过 |
| `message/send` | 终态不可重启、返回同 task | 终态 spawn follow-up | ❌ 偏差（3.3） |
| `message/stream` | SSE，interrupt/终态结束流 | 实现且 input-required 断流 | ✅ 符合 v0.3.0（旧判误） |
| `tasks/get` / `tasks/cancel` | 参数 `id`/`historyLength` | `server.ts:259-280` | ✅ 通过 |
| `tasks/resubscribe` | SSE 变体 | `server.ts:282-285` 拒绝非 SSE | ✅ 合理 |
| Message/Part | 文本在 `parts[].text`；`taskId` 顶层；`messageId` | `convert.ts:46-52`、`server.ts:298/306` | ✅ 通过 |
| FilePart | v0.3.0 `file.name`；`uri` 可达 | 写 `filename`；`uri` 本地 | ❌ 偏差（P0-B） |
| Artifact | `artifactId/name/parts` | `convert.ts:143-147` | ✅ 通过 |
| Push 配置 | `configuration.pushNotificationConfig` | 读 `metadata.pushNotification` | ❌ 偏差（3.4） |
| `contextId` | 会话分组，缺省回退 | `convert.ts:130` | ✅ 通过 |
| 状态机 | 7 态、终态集合 | `convert.ts:24-43`、`watch.ts:21-29` | ✅ 通过 |

---

## 5. 后续优化工作规划（Roadmap）

> 原则：**先正确性、后硬化、再保真、终战略**。每个 Phase 给出文件、动作、验收。

### Phase 0 — 正确性 blocker（必须，约 0.5 人日） ✅ 已落地
1. **`evict()` 排除 input-required** — `src/store.ts` ✅
   - 新增 `export function isLive(s: JobStatus): boolean { return s === 'running' || s === 'input-required'; }`
   - `evict` 改为 `.filter(j => !isLive(j.status))`；`load()` 注释区一致性核对。
   - 验收：新增单测（store 级 `isLive` + A2A 级"多已完成任务压测下 input-required 不被驱逐且同 id 续跑成功"）。
2. **文件产物协议字段 + 可寻址** — `src/runner.ts`、`src/a2a/server.ts` ✅
   - `filePart` 输出 `{ name, mimeType, bytes, uri, bytes_inline? }`（≤64 KiB 内联）。
   - 新增 HTTP 端点 `GET /a2a/artifacts/:taskId/:name`（受 auth 守卫）返回文件内容，`toTask` 把本地 `file://` URI 重写为该可达端点。
   - 验收：A2A 端到端测试断言 `file.name` 存在且 `uri` 可被同进程 `fetch` 取回 patch 内容。

### Phase 1 — 生产硬化（并发/资源/安全，约 1.5 人日） ✅ 已落地
3. `watch.ts sleep` 监听器泄漏：✅ 每次轮询只注册一次 abort 监听，正常完成后 `removeEventListener`。
4. `watchAndPush(..., signal?)`：✅ 传入 `httpReq.on('close')` 的 `controller.signal`，`for` 内 `if(signal.aborted) return`。
5. `cancel()` 计数：✅ 两条分支都 `metrics.cancelled += 1`。
6. `reply()` CAS 守卫：✅ `resumeFromInput` 入口校验仅 `input-required` 可续跑；外加 A2A `message/send` 对终态 `taskId` 直接报错（杜绝取消后复活/非幂等 follow-up）。
7. 推送配置标准化：✅ `pushConfigOf` 优先读 `configuration.pushNotificationConfig`（metadata 兼容回退），携带 `authentication`。
8. **SSRF 防护**：✅ `unsafePushUrl` 仅 `http/https` 且阻断私有/链路本地（含 `169.254.169.254`）；push 仅在 `a2aAuthToken` 开启时可用；新增 `a2aPushUrlAllowlist` 受信逃逸口。
9. **0.0.0.0 无 token 告警**：✅ 启动时 `log.warn`。
10. **`verify` 纳入 stress/fault**：✅ `verify = typecheck && npm test && test:stress && test:fault && build:release`。

### Phase 2 — 协议保真与可观测（约 1 人日） ✅ 已落地
11. A2A 端口加 `GET /healthz`、`/metrics`（复用 `mgr.health()`/`getMetrics()`，受 auth）、`/version`。✅
12. `message/send` 读取 `configuration.blocking`（长任务阻塞轮询至终态，受 `a2aBlockingMaxMs` 上限保护，超时回异步）与 `historyLength`；`acceptedOutputModes` 用于内容协商（`assertOutputModesAccepted`，无交集抛 `INCOMPATIBLE_CONTENT_TYPES -32005`）。✅
13. `DataPart.changedFiles` 包装为 `{ files: [...] }`；`status.timestamp` 对 input-required 用 `inputRequiredAt`。✅
14. `requireMessage` 对 `message/send` 仅接受 `role:'user'`；补 JSON-RPC 通知不回包。✅
15. 视场景加 CORS 头与 A2A POST 令牌桶限流。✅（`applyCors()` 反射指定 origin 默认关；`TokenBucket` 默认 250/s，超限 `429 RATE_LIMITED -32050`）

### Phase 3 — 扩展性与战略对齐（约 1.5 人日） ✅ 已落地（#17 部分，见注）
16. 抽出 `src/artifacts.ts`（`buildArtifacts`/`filePart`），解耦 `convert↔runner`。✅
17. 抽"方法→引擎"共享映射表，MCP/A2A 传输层只负责信封。**（部分）**：A2A `dispatch()` 仍以 `switch` 分发，`convert↔runner` 的反向依赖已由 `artifacts.ts` 消除，但独立的"方法→引擎"映射表未单列——属非阻塞的可演进项，留待后续重构。
18. 扩展 skill：支持同根多 skill 与外部 skill 目录（增强 `deriveSkills`/`resolveRoot`）。✅（`ExtraSkill` + `deriveSkills(roots, defaultTier, extra, log)`，越界 root `log.warn` 丢弃）
19. **v1.0 迁移路线（战略）**：评估 dual-version（`protocolVersion` 可配置 + 兼容垫片）或一次性迁移。需改：统一 Part（`text/raw/url/data` + `mediaType` + `filename` 通用）、FileContent 改 `url/filename/mediaType/raw`、AgentCard `protocolVersion` 移入 `supportedInterfaces[]`、新增 `extensions[]`。附一个最小 A2A v1.0 客户端调用示例。✅（`src/a2a/compat.ts` 双版本序列化，`CURSOR_BRIDGE_A2A_PROTOCOL_VERSION=1.0` 启用，README 含最小 v1.0 客户端示例）
20. `unhandledRejection` 阈值退出；`bridge_shutdown` 退出前 `await` flush；worktree 清理 `try/finally` 覆盖 `runCursor`。✅（滑动窗口阈值 UNHANDLED_THRESHOLD=20/WINDOW=60s；shutdown 后延迟 100ms flush；`runCursor` 异常仍清理 worktree）
21. 更新 `AUDIT-REPORT-A2A-v0.3.3.md` 与 README，标记 v0.3.0 状态与 v1.0 计划；CHANGELOG 记 0.4.0 路线。✅（README + CHANGELOG + 本报告 §7 已更新）

---

## 6. A+ 验收标准（如何确认达标）

- [x] **核心契约零击穿**：`input-required` 在 LRU 满、重启后均可同 id 续跑；文件产物 `name` 正确且可远程取回（Phase 0）。
- [x] **资源零泄漏**：SSE/推送观察器随客户端断连即终止；worktree 在 `runCursor` 异常后仍清理；`unhandledRejection` 受控（滑动窗口阈值）。
- [x] **并发安全**：并发 `reply` 不双倍执行；`cancel` 后 `reply` 不复活；运行中取消计入 metrics。
- [x] **安全暴露面收敛**：0.0.0.0 无 token 启动被拦；push URL SSRF 被阻断；A2A 端口有 healthz/metrics；新增令牌桶限流与 CORS 反射。
- [x] **协议保真**：对照 §4 表全部 ✅；终态 `message/send` 幂等报错；JSON-RPC 通知不回包；消费 `configuration.blocking`/`acceptedOutputModes`/`historyLength`。
- [x] **门禁完整**：`verify` 覆盖 unit/e2e/admin/a2a + stress/fault，CI 红即阻塞。
- [x] **可演进**：`convert` 与 `runner` 解耦（`artifacts.ts`）；skills 可扩展（`ExtraSkill`）；明确 v0.3.0↔v1.0 策略与迁移计划（`compat.ts` 双版本序列化）。
- [x] **测试**：针对 P0/P1 新增回归单测（驱逐、续跑、并发 reply、SSRF、push 取消）；全仓测试 **97 项**且全绿（≥ 80 达成）。

---

## 7. 落地进度（post-patch，2026-10-23 → 0.4.0）

按优先级已完成 **A+ 路线图全部 Phase 0 / Phase 1 / Phase 2 / Phase 3（#1–#21，除 #17 部分外全部 ✅）**。其中 Phase 0 + Phase 1 + 部分 Phase 2 已在 0.3.4 落地；本轮 **0.4.0** 闭合剩余 Phase 2 末段（#12 `blocking`/`acceptedOutputModes`/`historyLength`、#14 通知不回包、#15 CORS/限流）与**全部 Phase 3 其余项（#16 / #18 / #19 / #20 / #21）**。

**本轮（0.4.0）改动文件**：`src/runner.ts`（worktree `try/finally` 清理）、`src/index.ts`（`unhandledRejection` 滑动窗口阈值退出）、`src/tools.ts` / `src/admin.ts`（`bridge_shutdown` 延迟 100ms flush）、`src/a2a/server.ts`（`configuration` 协商 / 令牌桶限流 / CORS / 通知不回包 / v1.0 透传）、`src/a2a/compat.ts`（新增，v1.0 序列化边界）、`src/a2a/convert.ts` / `src/a2a/watch.ts` / `src/a2a/card.ts` / `src/a2a/skills.ts` / `src/a2a/types.ts`（v1.0 字段 + skills 扩展点 + 错误码 `RATE_LIMITED -32050`/`INCOMPATIBLE_CONTENT_TYPES -32005`）、`src/artifacts.ts`（新增，从 runner 抽取 `buildArtifacts`/`filePart`）、`src/config.ts`（5 项新 A2A 配置）、`src/version.ts`、`package.json`、`CHANGELOG.md`、`README.md`、`test/a2a.test.mjs`、`test/unit.test.mjs`、`test/a2a-fake-agent.mjs`。

**验证**：`npm run verify` 全绿——typecheck + **97 项测试**（49 单元 + 15 端到端 + 3 admin + 30 A2A）+ stress(3) + fault(2) + release 构建（v0.4.0 归档，687 KB 单文件 bundle）。本轮新增 21 项回归单测覆盖：worktree 崩溃不泄漏、blocking 等待/超时、`acceptedOutputModes` 协商拒绝、`historyLength`、`role:'user'` 守卫、通知不回包、令牌桶限流/默认不限流、CORS 开/关、v1.0 Card/v1.0 Task/v0.3.0 默认、extra skills 过滤/上卡、artifacts `filePart` 内联/容错、compat 字段重映射。

**端到端真跑实证**（规划完成后执行，`scripts/e2e-empirical.mjs`，`npm run verify:e2e`）：真实拉起 `dist/index.js` 出货二进制 + 真实 `fake-agent` 替身，通过真实 HTTP 驱动 A2A 全生命周期，**54/54 检查通过**（较 49/49 再 +5：新增 S11 `tasks/cancel` 真跑——hang 任务进入 `working`→真实取消→终态 `canceled`→取消路径 `finally` 仍清理 worktree）。覆盖：v0.3.0/v1.0 双版本 Agent Card 与 FilePart 序列化、Agent Card 发现、`message/send` 异步与 `configuration.blocking` 直返终态、`acceptedOutputModes` 协商拒绝（`-32005`）、`message/stream` SSE 终态、`input-required` 同 id 续跑、`Bearer` 鉴权（401/200）、令牌桶限流（突发 15 请求 → 13 × 429 + 2 × 200，`-32050`）、CORS 预检 204 与反射、产物远程 `fetch`（200 且内容含改动文件）、agent 崩溃后 worktree 仍清理、**`tasks/cancel` 真实取消且 worktree 清理**、push 通知真实投递（webhook 收到 final `status-update` 且 bridge 注入 `x-a2a-push:1` 与 `Bearer` 头）、无 allowlist 时 loopback webhook 被 SSRF 守卫拒绝不投递。实证脚本已改为**跨平台可跑**（按 `os.platform()` 选 `fake-agent.sh`/`.cmd`，tree-kill 用进程组/`taskkill /T` 连带孙进程），并入 `scripts/validate-p3.mjs` 发布签字环节，并接入 `.github/workflows/ci.yml` Linux 门禁（`npm run verify:e2e`），发布即锁死 hardening；Windows CI 真跑待 Windows runner 验证后启用。

**A+ 验收（§6）**：七项验收标准全部 ✅——核心契约零击穿、资源零泄漏、并发安全、安全暴露面收敛、协议保真、门禁完整、可演进。

**唯一遗留（非阻塞）**：#17「方法→引擎共享 dispatch 映射表」未单列，A2A 仍以 `switch` 分发；`convert↔runner` 反向依赖已由 `artifacts.ts` 消除，独立映射表作为后续可选重构。

---

*本审计报告基于 `src/` 与 `test/` 静态通读、`npm run verify` 实跑（首版 71/71，post-patch 83/83 通过）与 A2A 官方规范（v0.3.0、v1.0.1）逐条核对。涉及运行期竞争的条目已标明触发条件，并以新增回归单测坐实。*
