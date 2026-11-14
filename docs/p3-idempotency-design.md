# P3 前置设计说明：store 单写者 / 原子提交 / 幂等恢复

> 依据：规划 §4 P3「前置：先出一份 store 单写者/原子提交的设计说明再动码」
> 对象：`src/store.ts`（531 行）、`src/runner.ts`（886 行）、`src/a2a/watch.ts`
> 约束（规划 §6.6 / §7）：**零新增运行时依赖**，不引入 SQLite / 外部编排服务，保持单文件 win-x64 离线包
> 日期：2026-11-14

---

## 1. 现状盘点（改码前的事实基线）

| 机制 | 现状 |
| --- | --- |
| 状态文件 | `stateDir/index.json`，`persist()` 用 `index.json.tmp` + `fs.renameSync` 原子替换，已是**单文件原子提交** |
| 事件日志 | `events-<id>.jsonl` 类 JSONL，`appendEvent()` 走 `setImmediate` 异步批量 flush，`flushNow()` 可等待 |
| 写触发 | `create()` 立即 persist；`touch()` 用 `setTimeout` debounce（默认短延迟）；`shutdown()` 强制 flush |
| 启动恢复 | `JobStore.load()` 把持久化的 `running` 标为 `orphaned`；`JobManager` 对带 `pid` 的孤儿校验 `/proc/<pid>/cmdline` 后回收进程 |
| 多实例 | `src/util/instance.ts` 有 `instanceId` 与 stale instance 目录回收；`index.json` 是**共享单文件**，多实例并发写会互相覆盖历史（现仅在日志里告警） |
| 幂等 | **无**：`StartJobOptions` 没有 requestKey；重复 `message/send` 无 taskId 会新建 job；A2A 侧仅对「terminal task + taskId」做了防重复，网络重试无 taskId 仍会双跑 |
| 租约 | **无**：`running` 没有 `leaseOwner` / `leaseExpiresAt`；恢复只按状态 + pid 判断，不区分「活着的另一个实例正在跑」与「真的崩了」 |
| 副作用 | patch 导出、push 发送没有幂等键或「已发送」标记；崩溃点落在副作用中途时，恢复可能重放 |

**结论**：原子写这一层已经具备，缺的是**提交边界的语义**（哪一步算"已受理"）、**去重身份**和**副作用标记**。P3 不需要换存储引擎，只需要在现有原子文件上补齐这三样。

---

## 2. 设计原则

1. **单写者**：所有状态变更只能经 `JobStore` 的提交入口；`JobManager` / A2A / MCP 不得直接改 `Job` 后自行 persist。坚持现有的「改内存对象 → `touch()`/`persist()`」路径，但把提交点显式化。
2. **一次原子提交 = 一个状态 + 它的幂等标记**：requestKey 索引、checkpoint 阶段、副作用已发送标记，全部写进同一个 `index.json`，与状态在同一次 `renameSync` 中落盘。绝不允许「状态已提交、标记没提交」的撕裂。
3. **先记 checkpoint，再做副作用**：任何可能重复执行的外部动作之前，必须先把「即将执行」的阶段原子落盘；恢复时看到该标记即认为副作用可能已发生，不重放。
4. **宁可少做，不可双做**：无法判定副作用是否已送达时，按「已发生」处理（at-most-once 交付），不重放 push / patch。
5. **不引依赖**：不引入 SQLite、Temporal、Restate；只取 journal / 幂等键 / checkpoint 的模式。

---

## 3. 数据模型增量（全部落在 `index.json`）

```ts
// Job 新增字段（src/types.ts）
interface Job {
  // ... 既有字段
  /** 客户端幂等键；同一 key 重复提交返回同一 job，不产生第二个 run。 */
  requestKey?: string;
  /** 最近一次原子提交的业务阶段。 */
  checkpoint?: JobCheckpoint;
  /** 租约：谁在跑、到什么时候为止。 */
  leaseOwner?: string;      // instanceId
  leaseExpiresAt?: string;  // ISO-8601
  /** 已完成的副作用标记，恢复时不重放。 */
  sideEffects?: Record<string, string>; // phase -> ISO-8601 完成时间
}

type JobCheckpoint =
  | 'accepted'        // 已受理，job 已原子落盘，尚未 spawn
  | 'spawned'         // worker 已启动
  | 'input-required'  // 等待审批
  | 'patch-exporting' // patch 导出中
  | 'push-sending'    // push 发送中
  | 'settled';        // 终态已提交
```

`JobStore` 新增 `requestKey -> jobId` 索引（与 jobs 同一 payload），启动 `load()` 时重建。

---

## 4. 四个机制

### 4.1 requestKey 去重

- `StartJobOptions.requestKey?: string`；MCP `cursor_run` 与 A2A `message/send` 都从 Action 层透传（P1 的收益：只改一处）。
- `JobManager.start()` 入口：`store.findByRequestKey(key)` 命中即**返回既有 Job**（不 spawn、不重复记账），并在 `JobView` / A2A Task 上返回同一 id。
- 未命中：在**同一次 `persist()`** 里同时写入 job（`checkpoint:'accepted'`、`leaseOwner=instanceId`、`leaseExpiresAt=now+TTL`）和 requestKey 索引，然后才 spawn。
- A2A `message/send` 无 taskId 时，把 `message.messageId` 作为默认 requestKey（协议里它本就唯一），从根上消除网络重试双跑。

### 4.2 副作用幂等键

- 键格式 `phase = 'patch-export' | 'push-delivery:<targetHash>'`。
- 执行前：`job.sideEffects ??= {}`，若已有该 phase 则跳过；否则**先写 `checkpoint='patch-exporting'|'push-sending'` 并 `persist()`**，再执行动作，成功后写 `sideEffects[phase]=now` 再 `persist()`。
- 恢复时若 `sideEffects[phase]` 缺失但 checkpoint 显示已进入该阶段，按「可能已送达」跳过重放（原则 4）。

### 4.3 checkpoint 边界

五个注入点对应五种可恢复状态，每处都必须「状态 + checkpoint 原子同提交」：

| 点 | 落盘内容 | 恢复动作 |
| --- | --- | --- |
| 已受理 | `accepted` + requestKey + lease | 租约有效则不接管；过期且 pid 不存在才认领 |
| 执行中 | `spawned` + `pid` | 校验 pid；活着则继续等，死了则标 orphaned，**不重新 spawn** |
| 等待审批 | `input-required` + `pendingInput` | 保持暂停，等待同一 contextId 的续跑（P2 已实现） |
| patch 导出中 | `patch-exporting` | 不重放导出；保留已有 patch 文件 |
| push 发送中 | `push-sending` | 不重发；按已送达处理 |

### 4.4 lease / reconcile（避免第二个 run）

- `running` job 带 `leaseOwner` + `leaseExpiresAt`，在 `create()` 中与初始状态**同一次原子写**落盘；`touch()` 在每次批量写时续租；`checkpoint(...'settled')` 或 orphan 回收时清除。
- **实施修正（重要）**：初版把「`leaseExpiresAt` 未过期」当作存活判据，导致 `e2e.test.mjs` 的崩溃恢复用例失败——**SIGKILL 会留下一个未过期的 lease**。因此恢复判定改为以 `ownerStillAlive(meta.owner)`（校验 owner 前缀 pid 的 `/proc/<pid>/cmdline`）为准：
  1. owner 进程存活 → 保持 `running`（绝不被第二个实例认领或重跑），lease 是否过期都不影响；
  2. owner 进程已死 → 标 `orphaned`、清除 lease、回收遗留 pid，**不启动新 run**；
  3. `input-required` 是暂停态而非在跑的进程，跨重启原样保留。
- lease 字段的实际职责因此收敛为**跨实例诊断与审计**（谁在跑、最后一次续租到何时），而不是存活判据；「不产生第二个 run」由 owner 活体判断 + requestKey 去重 + orphan 不重跑三者共同保证。这个偏差是刻意保留的：本机 loopback 下 pid 可靠，用 lease 覆盖硬杀反而会造成 60s 的 phantom `running` 窗口。

---

## 5. 崩溃注入验收（规划 §4 P3 / §6.4）

沿用 0.5.1 已验证的「等条件不等时间」原则：用真实 `SIGKILL` 在五个 checkpoint 点杀死 bridge，重启后断言：

- 无重复 spawn（`pid` 不被二次创建，孤儿进程数不增长）；
- 无重复 push（webhook 接收计数 == 1）；
- 无重复 patch 回放（patch 文件 checksum 稳定）；
- 同一 requestKey 重复提交只跑一次（`JobManager.start` 返回同一 id）；
- lease 过期不启动第二 run；
- 恢复不重放已提交步骤（`sideEffects` 生效）。

注入脚本放在 `test/p3-crash.test.mjs`，通过 `checkpoint` 文件与子进程通信确定 kill 时机，避免 sleep-based 断言。

---

## 6. 风险与不做项

- **文件型 store 的多实例**：`index.json` 仍是共享单文件。本设计只保证「不会因恢复产生第二个 run」，**不解决**两个活实例并发写互相覆盖历史的问题（既有行为，规划 §7 明确不引入外部协调服务）。建议继续用 `CURSOR_BRIDGE_STATE_DIR` 隔离实例。
- **原子性边界**：`renameSync` 在 POSIX/Windows 都是原子替换，但不提供跨文件事务；JSONL 事件日志与 index 仍可能短暂不一致，恢复以 index 为准。
- **不引依赖**：不引入 SQLite / WAL / 外部编排；不实现分布式租约（本机 loopback 无场景）。
- **不做**：worker 自主认领任务、去中心化调度、跨机身份（规划 §7 铁律）。
- **性能**：每个 checkpoint 一次 `persist()` 会增加少量写放大；用现有 debounce 合并相邻提交，实测 `verify` 8 阶段耗时不得显著退化（§6.5 基线 18.0s）。

---

## 7. 实施顺序

1. `src/types.ts`：Job 增量字段 + `JobCheckpoint`；`StartJobOptions.requestKey`。
2. `src/store.ts`：`findByRequestKey`、`checkpoint()` 原子提交入口、lease 字段随 index 落盘、`load()` 认领逻辑。
3. `src/runner.ts`：`start()` 去重、checkpoint 埋点、心跳续租、patch/push 副作用标记接入。
4. `src/a2a/server.ts` / P1 Action 层：`messageId` → requestKey 透传。
5. `test/p3-crash.test.mjs`：五点 SIGKILL 注入。
6. 全量 `npm run verify` + TCK + 双平台 CI；性能基线对比。
