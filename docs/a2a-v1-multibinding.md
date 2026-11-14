# A2A v1.0 多绑定合规评估与交付说明（0.6.0）

> 本文是「推进 P1–P5 与完整 v1.0 push、多绑定合规后再发布新版本」的多绑定决策记录。
> 数据基准：官方 A2A TCK 固定提交 `70f6f73c30208e80c889141907e094899e6e9f05`，
> `TCK_TRANSPORT=jsonrpc,http_json`，2026-11-14 报告。
> 原则：**capability honesty** —— 卡片只声明已实现且经 TCK 验证的能力；skip / manual / not tested 不计入通过。

---

## 0. 结论先行

| 绑定 | Agent Card 声明 | 生产实现 | 官方 TCK | 0.6.0 结论 |
| --- | --- | --- | --- | --- |
| `JSONRPC` | 是（首选，第 1 项） | 是 | `76/83`，0 failure / 0 error | **交付** |
| `HTTP+JSON` | 是（第 2 项） | 是，零依赖 `src/a2a/rest.ts` | `72/78`，0 failure / 0 error | **交付** |
| `GRPC` | **否** | 否 | `0/65`（65 skipped，未跑） | **不交付**：仅出可行性 PoC + 本评估 |

- 0.6.0 在 `supportedInterfaces` 中声明 **2 个**绑定：`JSONRPC`（首选）+ `HTTP+JSON`。
- **不声明 `GRPC`**：未端到端实现、未跑 grpc TCK，声明即为能力虚报。
- 保持铁律：**零新增运行时依赖**（仍仅 `@modelcontextprotocol/sdk`）、**单文件 win-x64 离线包**。
- 交付 `scripts/poc-a2a-grpc.mjs` 作为 **transport 可行性探针**，明确标注 **NOT a production binding, NOT TCK compliance**。

---

## 1. 背景与本轮范围

用户授权链路：

```text
同意P0优先并接受引入跑TCK
合并PR#2
推进P1-P5与完整v1.0 push、多绑定合规后再发布新版本
```

P0 已完成 A2A v1.0 wire 合规（`src/a2a/v1.ts` 作 pure translation boundary）、官方 TCK MUST 门禁与 PR #2 合并。
本轮在其之上完成 P1–P5、完整 v1.0 push notification 契约、以及多绑定合规，然后发布 `0.6.0`。

三条不可让步的约束：

1. **零新增运行时依赖**：`package.json` 的 `dependencies` 不得增加条目。
2. **单文件 win-x64 离线包**：`npm run build:release` 仍须产出一个可离线运行的 exe 包。
3. **0.3 零改动**：默认路径与 legacy 静态开关路径完全保留，仅显式 `A2A-Version: 1.0` 进入新 wire。

---

## 2. 三绑定交付矩阵（明细）

### 2.1 JSONRPC（首选）

- 端点：`/a2a`（含 `/a2a/` 归一化，TCK 的 `JsonRpcClient` 实际 POST 到尾斜杠路径）。
- v1.0 方法映射在 `src/a2a/v1.ts` 的 `V1_METHODS`：`SendMessage` / `GetTask` / `ListTasks` / `CancelTask` / `SendStreamingMessage` / `SubscribeToTask` / `Create|Get|List|DeleteTaskPushNotificationConfig` / `GetExtendedAgentCard`。
- SSE 中每个 `data:` 是 JSON-RPC response，`result` 内为 `StreamResponse`。
- 错误码：`-32001`–`-32009` 及标准 `-32600` / `-32601` / `-32602` / `-32603` / `-32700`。

### 2.2 HTTP+JSON（REST）

- 实现：`src/a2a/rest.ts`，零依赖；在 `server.ts` 的 `/a2a/*` 路由前置 `handleRest()`。
- REST 路径：`/a2a/message:send`、`/a2a/message:stream`、`/a2a/tasks`、`/a2a/tasks/{id}`、`/a2a/tasks/{id}:cancel`、`/a2a/tasks/{id}:subscribe`、`/a2a/tasks/{id}/pushNotificationConfigs[/{configId}]`、`/a2a/extendedAgentCard`。
- 响应为 **bare ProtoJSON**（无 JSON-RPC envelope）；SSE `data:` 为 bare `StreamResponse`。
- 错误为 AIP-193：`{"error":{"code":...,"status":...,"message":...,"details":[...]}}`，`Content-Type` 必须含 `application/json`，`details` 含 `google.rpc.ErrorInfo`。
- 版本协商：客户端每次带 `A2A-Version`；不支持的版本返回 `VersionNotSupportedError`（HTTP 400 / `FAILED_PRECONDITION`）。
- 媒体类型校验 `application/a2a+json`；terminal task 的 `SubscribeToTask` 在开流前拒绝。

### 2.3 GRPC（评估项，未交付）

见 §4–§5。卡片不声明，`supportedInterfaces` 只有两项：

```ts
supportedInterfaces: [
  { url: opts.endpointUrl, protocolBinding: 'JSONRPC',   protocolVersion: '1.0' },
  { url: opts.endpointUrl, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
],
```

---

## 3. 官方 TCK 一手结果（双 transport）

复现命令：

```bash
TCK_TRANSPORT=jsonrpc,http_json npm run test:tck
```

`npm run pretest:tck`（`npm run build`）先重建 `dist/`，避免「代码改了但 TCK 仍读旧卡片」的假绿。

结果（`reports/tck/`）：

```text
136 passed, 93 skipped, 34 deselected in 6.39s
[tck] junit: tests=229 passed=136 failures=0 errors=0 skipped=93
[tck] compatibility: overall=70.5% must=82.0% should=8.3% may=0.0%
[tck] PASS

BY TRANSPORT:
  agent_card:    6/6 ✓
  grpc:          0/65 (65 skipped) ✓
  jsonrpc:      76/83 (7 skipped)  ✓
  http_json:    72/78 (6 skipped)  ✓
```

按 `reports/tck/compatibility.json` 的 `per_requirement` 精确统计（共 133 条需求）：

| level | PASS | MANUAL | SKIPPED | NOT TESTED | 合计 |
| --- | --- | --- | --- | --- | --- |
| MUST | 73 | 7 | 19 | 16 | 115 |
| SHOULD | 1 | 2 | 0 | 11 | 14 |
| MAY | 0 | 0 | 0 | 4 | 4 |

- **自动评分范围内 0 failed / 0 error**（JUnit `tests=229 passed=136 failures=0 errors=0`）。
- 关键口径：**`SKIPPED` / `MANUAL` / `NOT TESTED` 都不是 `pass`**。`grpc` 65 个 parametrized case 全为 skipped，代表未测，不构成任何 gRPC 合规主张。
- `must_compatibility: 82.0%` 是 TCK 在「自动化 scope」内的比例，**不等于「全部 MUST 需求已通过」**：7 项 MANUAL 与 16 项 NOT TESTED 未纳入自动评分。

`package.json` 加入 `"pretest:tck": "npm run build"`，专门修复首次双绑定跑批时 stale `dist` 导致 `http_json` 仍全 skip 的问题。

---

## 4. gRPC transport 可行性 PoC

文件：`scripts/poc-a2a-grpc.mjs`（231 行，零依赖），入口 `npm run poc:a2a-grpc`。

### 4.1 设计

- 用 Node 内置 `node:http2` 起一个明文 h2 服务，手写 protobuf wire 编解码（varint / tag / length-delimited / gRPC 5 字节帧头 / trailers `grpc-status`）。
- 字段编号逐字取自 `specification/a2a.proto`（`lf.a2a.v1`）：`GetTaskRequest.id=2`、`Task.id=1 / context_id=2 / status=3`、`TaskStatus.state=1 / timestamp=3`、`TaskState.TASK_STATE_COMPLETED=3`、`Timestamp.seconds=1 / nanos=2`。
- 服务 `/lf.a2a.v1.A2AService/GetTask`，返回静态 `TASK_STATE_COMPLETED` 的 Task。
- 双重验证：① Node http2 客户端自洽 round-trip；② **官方 TCK 生成的 Python grpcio `A2AServiceStub`** 真实发起 `GetTask` 并解析 protobuf 响应 —— 不是自说自话的自解码器。

> 实现要点：grpcio 要求 `grpc-status` 出现在 TRAILERS，Node http2 需 `respond(..., { waitForTrailers: true })` 且在 `wantTrailers` 里 `sendTrailers()`；数据用 `write()` 写、`end()` 单独调用，否则 `end(data)` 会先刷 `END_STREAM`。Python 客户端必须异步 `spawn`（`spawnSync` 会阻塞事件循环，服务永远无法应答）。

### 4.2 实测输出

```text
[poc-a2a-grpc] 3 checks passed

Node http2 client round-trips a protobuf Task over gRPC wire  → ok
  { grpcStatus: "0", id: "poc-node", contextId: "ctx-poc-node", state: 3 }
server received the correct :path and content-type           → ok
official TCK Python grpcio A2AServiceStub parses the response → ok
  PYTHON_GRPC_OK poc-python ctx-poc-python TASK_STATE_COMPLETED
```

### 4.3 证明了什么 / 没证明什么

| 已证明 | 未证明（明确边界） |
| --- | --- |
| 零依赖即可说出合法 gRPC wire | 任何 A2A 语义正确性 |
| Node `http2` + 手写 codec 可服务**真实第三方** grpcio 客户端 | 除 `GetTask` 外的 10 个 RPC |
| `GetTask` 单消息编解码与 trailers 处理可行 | `Struct` / `Timestamp` / `Value` 的递归与 map 编解码 |
| — | 2 个 server-streaming RPC、AIP-193 over trailers、错误码映射 |
| — | TCK `grpc` 65 个 case、SUT h2 代理、端到端合规 |

**结论：这是 transport 可行性探针，不是生产绑定，不构成 TCK 合规声明。**

---

## 5. 为什么 0.6.0 不声明 GRPC

### 5.1 协议规模（用 protobuf descriptor 精确统计，非估算）

```text
messages = 44    fields = 176    maps = 7    enums = 2
services = [('A2AService', 11)]      server_streaming RPC = 2
well-known types = google.protobuf.Struct / Timestamp / Value
```

### 5.2 完整生产化所需工作（远超 PoC）

1. 全量 codec：44 个 message、176 字段、7 个 map entry、2 个 enum，外加 `Struct`（递归 `Value` + map）、`Timestamp`、`Value` 三个 WKT 的双向编解码。
2. 11 个 RPC 的路由与语义（含 2 个 server-streaming：`SendStreamingMessage` / `SubscribeToTask` 等价物），对齐 `src/a2a/v1.ts` 的 translation boundary。
3. gRPC 错误模型：AIP-193 经 trailers 传递、`grpc-status` 与 `google.rpc.Status` details、版本协商、认证。
4. 测试基础设施：TCK 需要的 **h2 SUT 代理**（`scripts/tck-sut.mjs` 目前是 HTTP/1.1 透明代理）、`grpc` 65 个 parametrized case 全量跑通。
5. 长尾维护：手写 wire codec 没有 schema 演进保护，proto 每次变更都要人工同步字段编号。

### 5.3 与铁律的冲突

- 引入 `@grpc/grpc-js` + `protobufjs` 会**新增运行时依赖**，破坏「零新增运行时依赖」与「单文件 win-x64 离线包」。
- 全手写则投入产出比在本版本不成立：0.6.0 的核心目标是 P1–P5 + 完整 push + 双绑定合规后的**可发布状态**，不是新增第三种传输栈。

因此按 §0 的 capability honesty：**不在卡片声明 `GRPC`、不跑 `TCK_TRANSPORT=...,grpc`、不把 65 个 skip 算作通过**。

---

## 6. 诚实口径：MANUAL / SKIPPED / NOT TESTED

`reports/tck/compatibility.json` 的 `manual_verification_required` 列出 **9 项 MUST/SHOULD 未纳入自动评分**：

```text
CARD-CLIENT-001  [MUST]   client 必须按所选 AgentInterface 设置 tenant（客户端侧行为，服务端探针无法观测）
CARD-SIGN-001..4 [MUST]   JCS/RFC 8785 规范化、signatures 字段排除、JWS alg+kid、过期/吊销密钥
AUTH-TLS-001     [MUST]   生产部署必须 HTTPS / gRPC TLS
AUTH-TLS-002     [SHOULD] 现代 TLS 配置（TLS 1.3+）
AUTH-SERVER-001  [SHOULD] 客户端校验服务端证书
BIND-CUSTOM-002  [MUST]   custom binding 破坏性变更须换 URI（需跨版本比较，单快照不可观测）
```

其余未测项：

- `grpc`：65/65 skipped（未实现，未测）。
- `jsonrpc` 7 skipped、`http_json` 6 skipped：TCK 参数化用例在当前 SUT 夹具下不适用，如实保留。
- Card signatures、TLS、tenant propagation、客户端侧行为：**未实现或未测**，不写进通过率。

---

## 7. 零依赖与单文件离线包核对

| 检查项 | 状态 |
| --- | --- |
| `package.json` `dependencies` | 仍仅 `@modelcontextprotocol/sdk`（`^1.0.0`，lock `1.32.1`） |
| `src/index.ts` SDK 导入 | 仍为 v1 单体路径（P5 决策：本版本不升级 SDK v2） |
| gRPC PoC 依赖 | 仅 `node:http2` / `node:child_process` / `node:fs` / `node:path` 内置模块 |
| PoC 是否进 production bundle | 否，`scripts/` 不参与 `build:release` 输入 |
| `build:release` | 仍产单文件 win-x64 离线 zip（发布阶段复核） |

---

## 8. 重评触发条件与未来路线

满足**任一**条件时单独立项实现完整 gRPC 绑定：

1. 需求方明确要求 gRPC 客户端接入，且接受引入 `@grpc/grpc-js` + `protobufjs`（放宽零依赖 / 单文件约束）；或
2. 官方 A2A proto 进入长期稳定、且有资源维护全手写 codec + h2 SUT 代理 + TCK grpc 65 case 的长期回归。

届时路线：proto → codec → 11 RPC → streaming → AIP-193/trailers → h2 SUT proxy → `TCK_TRANSPORT=jsonrpc,http_json,grpc` 全绿 → 才在 `supportedInterfaces` 追加 `GRPC`。

对照 P5 的同构决策：MCP SDK v2 同样评估后判定「本版本不升级」（`docs/p5-mcp-sdk-v2-decision.md`）。两处均遵循「评估先行、能力诚实、不为凑数引入风险」。

---

## 9. 本版本（0.6.0）交付物清单

| 类别 | 文件 |
| --- | --- |
| 协议核心 | `src/a2a/v1.ts`、`src/a2a/push.ts`、`src/a2a/rest.ts`、`src/a2a/server.ts`、`src/a2a/card.ts`、`src/a2a/types.ts` |
| P1 | `src/actions/{types,validate,registry,index}.ts`、`src/tools.ts` |
| P2 | `src/artifacts.ts`、`src/a2a/convert.ts` |
| P3 | `src/types.ts`、`src/store.ts`、`src/runner.ts` |
| P4 | `scripts/scan-card.mjs`、`docs/agentic-security-matrix.md`、CI `Agent Card static scan` step |
| P5 | `scripts/poc-mcp-tasks.mjs`、`docs/p5-mcp-sdk-v2-decision.md` |
| 多绑定 | `scripts/poc-a2a-grpc.mjs`、**本文** `docs/a2a-v1-multibinding.md` |
| 测试 | `test/a2a-v1.test.mjs`、`test/actions-dual-surface.test.mjs`、`test/p2-structured.test.mjs`、`test/p3-idempotency.test.mjs`、`test/card-scan.test.mjs`、`test/push-v1.test.mjs` |
| TCK | `scripts/tck.mjs`、`scripts/tck-sut.mjs`、`pretest:tck`、CI TCK step |
| 文档 | `docs/agent-collaboration-research-plan.md`、`docs/p0-a2a-v1-tck-compliance.md`、`docs/p3-idempotency-design.md` |

---

## 10. 复现命令

```bash
npm run verify                                    # 8 阶段并行全量验证
npm run scan:card                                 # Agent Card 静态扫描门禁
npm run test:card-scan                            # 扫描器自身 12 个回归
npm run poc:mcp-tasks                             # P5 Tasks 扩展对齐 PoC（7/7）
npm run poc:a2a-grpc                              # gRPC transport 可行性 PoC（3/3）
npm run test:tck                                  # 默认 jsonrpc MUST 门禁
TCK_TRANSPORT=jsonrpc,http_json npm run test:tck # 双 transport（0 failure / 0 error）
npm run build:release                             # 单文件 win-x64 离线包
```
