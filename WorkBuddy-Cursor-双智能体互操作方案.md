# WorkBuddy（主）× Cursor（从）双智能体互操作生产级方案

> 论证文档 v1.0 ｜ 实测基线：CodeBuddy/WorkBuddy CLI `2.155.0`、Cursor CLI `agent`（ACP + print 模式）
> 参照系：Qoder ↔ Codex 的 `agent-bridge` / `qoder-as-subagent`，以及 WorkBuddy × Elastic 的 A2A 双层架构

---

## 0. 结论先行

**一句话主张：用 MCP 做传输层，用 A2A 做语义层，用文件系统做状态层；WorkBuddy 作为唯一的控制面持有者（Supervisor），Cursor 退化为无状态、可替换的执行器（Worker）。**

三个关键判断：

1. **不要做"对等互操作"。** 两个 Agent 互相派活会形成控制环路，无法收敛、无法审计、无法定责。生产系统必须是**单向控制面 + 双向数据面**：WorkBuddy 派活给 Cursor，Cursor 只能"回问取证"，不能反向派活。
2. **不要直接上 A2A。** A2A 语义上最正确（WorkBuddy 官方已用它跑通 Supervisor↔Worker），但 Cursor **不提供 Agent Card、不提供 A2A server**，为其自建 adapter 的成本在 P0 阶段不划算。正确做法是**先用 MCP 传输把 A2A 的语义跑起来**（Agent Card 描述能力、任务 ID 异步取结果、会话 ID 持久化），等链路稳定再把传输层换成真 A2A——上层语义不需要改动。
3. **不要用 ACP 做主通道。** ACP 是 *Agent ↔ Client（编辑器）* 协议，两侧都是 server 角色；且 ACP 的核心价值是流式 UI 与**向人类请求权限**——而在主从场景下，权限决策必须由 bridge 的策略层自动裁决，抛回人类会让自动化断流。ACP 只在"要把 Cursor 嵌进 WorkBuddy UI"时才有价值。

已交付的完整工程：`/workspace/wb-cursor-bridge/` —— win-x64 单文件 bundle（零运行时依赖）+ 一键安装包（`wb-cursor-bridge-v0.3.3-win-x64.zip`）。
验证状态：TypeScript 严格模式无错 · Node 测试 **56/56**（36 单元 + 14 端到端 + 3 admin HTTP + 3 stress/fault）· PowerShell 安装器测试 **20/20** · ZIP 完整性与 bundle 构建后 smoke 自检均通过；另有 `npm run test:stress` 与 `npm run test:fault` 做真跑实证。

实现过程中修正了 4 个真实缺陷（详见 §6.6）：事件游标在环形截断后语义失效、`git diff` 漏掉未跟踪的新文件、取消动作与进程终止存在竞态、二进制缺失时结果为空却未报错。

---

## 1. 问题定义：什么叫"两个智能体互相操作"

大多数所谓"Agent 协作"只做了控制面，生产上必然崩。完整的互操作必须同时有**三个面**：

| 面 | 要解决的问题 | 缺失后果 |
|---|---|---|
| **控制面** | 谁调谁、传什么指令、什么时候返回 | 无法编排 |
| **状态面** | 任务进度、产物落点、会话如何接续 | 长任务一断就丢，重跑烧钱 |
| **治理面** | 权限分级、预算上限、行为审计 | 越权、失控、无法定责 |

对照参照系就能看出差距：

| 参照方案 | 机制 | 做到了 | **没做到** |
|---|---|---|---|
| `agent-bridge`（Qoder↔Codex） | MCP 消息总线 + 任务状态机 + SQLite | 控制面、弱状态面 | 治理面（无权限分级、无隔离、无超时）；"发消息"不等于"执行"，两端还得各自写轮询循环 |
| `qoder-as-subagent`（Qoder↔Codex） | 把 `qoderclicn` 包成 MCP server 供 Codex 调用 | 提交即返回 job、权限分档、workspace 白名单 | 单向、无会话接续、无审计落盘；作者自述"是调用方策略上的洞" |
| `qoder-continues` | 转录会话上下文迁移 | 状态面（接续） | 一次性搬运，不是运行时互操作 |
| **WorkBuddy × Elastic A2A** | Agent Card + JSON-RPC + 异步任务 + 会话持久化 | **三面齐全**，且官方验证 | 依赖 Worker 侧实现 A2A server——**Cursor 没有** |

**因此本方案的差异化定位**：把 A2A 那套已被验证的三面语义，用一个本地 bridge 落到 Cursor CLI 上，同时补齐 `qoder-as-subagent` 明确缺失的**会话接续**与**审计落盘**。

---

## 2. 接口盘点（实证）

### 2.1 WorkBuddy 侧（实测 `codebuddy --help`，v2.155.0）

| 能力 | 实测参数/路径 | 在本方案中的用途 |
|---|---|---|
| MCP client | `~/.codebuddy/.mcp.json`（实测支持 http / `transparent_proxy` / `builtin_tools`）、`--mcp-config`、`--strict-mcp-config`、`codebuddy mcp` | **主控通道入口** |
| 子代理 | `--agents '<json>'`、`--agent`、`--subagent-permission-mode` | 定义"何时该派给 Cursor"的路由策略 |
| 无头执行 | `-p`、`--output-format text\|json\|stream-json`、`--input-format stream-json`、`--json-schema` | 反向通道；结构化输出校验 |
| 权限 | `--permission-mode auto\|acceptEdits\|dontAsk\|plan\|bypassPermissions`、`--allowedTools`/`--disallowedTools`/`--tools`、`--permission-prompt-tool` | 治理面；用 MCP 工具自动裁决权限 |
| 隔离 | `--worktree`、`--sandbox container\|E2B`、`--add-dir` | 写操作的爆炸半径控制 |
| 长时任务 | `--bg --name`、`codebuddy ps/logs/attach/kill` | 编排层可复用 |
| 对外服务 | `--serve`（Web UI + REST API + **ACP over HTTP SSE**）、`--acp`、`--acp-transport stdio\|streamable-http`、`--auth password` | 反向通道 P2 选项 |
| A2A | 内置 A2A client，Agent Card 发现 + 同步/异步任务 + 会话持久化 | **P2 演进目标** |

### 2.2 Cursor 侧（官方文档 + CLI 能力）

| 能力 | 形态 | 备注 |
|---|---|---|
| 无头执行 | `agent -p --force --output-format text\|json\|stream-json` | `--force` 才有写权限；print 模式为脚本/CI 设计 |
| 只读档位 | `--mode ask`（问答）、`--mode plan`（规划） | **天然的 tier 分级依据** |
| 会话 | `--resume <threadId>`、`--continue`、`agent ls`/`resume` | 状态面：跨轮次接续 |
| 隔离 | `--workspace <path>`、`--worktree [name]` | 与 WorkBuddy 同名能力，语义一致 |
| MCP client | 自动读 `~/.cursor/mcp.json` 与项目级 `.cursor/mcp.json` | 反向通道入口 |
| ACP server | `agent acp`（stdio JSON-RPC）：`session/new\|load\|prompt\|update\|request_permission\|cancel` + `cursor/*` 扩展 | 需要自定义 client 才能驱动 |
| 云端 | Cloud Agents REST API（`api.cursor.com/v0/agents`）、消息前加 `&` 交云端 | 断网/离机续跑的降级选项 |
| 规则 | `.cursor/rules/*.mdc`、`AGENTS.md`、`CLAUDE.md` | **共享约定的落点** |

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  WorkBuddy（Supervisor · 唯一控制面持有者）                     │
│  意图理解 · 任务分解 · 权限终审 · 跨应用交付 · 腾讯生态          │
│                                                              │
│   ├─ 路由决策（Skill: when-to-delegate-cursor）               │
│   ├─ MCP client ──► cursor-bridge                            │
│   └─ 结果翻译 → 文档/表格/PPT/交付物                           │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 控制面（MCP over stdio）       │ 状态面（共享工件）
                ▼                              ▼
┌───────────────────────────────────┐  ┌──────────────────────────┐
│  wb-cursor-bridge（本地 MCP server）│  │  <stateDir>/             │
│  ├ 工具层：run/status/reply/       │  │   index.json             │
│  │        cancel/list             │  │   artifacts/<jobId>/     │
│  ├ 策略层：tier / workspace 白名单 │  │     diff.patch / report  │
│  ├ 执行层：spawn `agent -p`        │  │   events/<jobId>/        │
│  └ 状态层：job 状态机 + 审计落盘    │  │     events.jsonl  ←可选  │
│                                    │  └──────────────────────────┘
└───────────────┬───────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Cursor CLI `agent`（Worker · 无状态可替换）                    │
│  --mode ask|plan（只读） / --force（可写） · --worktree 隔离     │
└──────────────────────────────────────────────────────────────┘
        ▲ 数据面（只读回问，禁止反向派活）
        └── Cursor 侧 MCP server → `codebuddy -p`（可选 R1）
```

**三层契约**：

- **控制面**：MCP over stdio。WorkBuddy 只认 5 个工具，Cursor 的具体 CLI 演进对上层透明。
- **状态面**：`.agents/wb-cursor/<jobId>/`。产物、diff、事件流全部落盘，**Agent 之间不靠内存传状态**——这是长任务可恢复的前提。
- **数据面**：反向通道只允许 WorkBuddy 的能力被"查询"，不允许被"驱动"。

---

## 4. 主控权设计：为什么 WorkBuddy 必须是主

| 判据 | 说明 |
|---|---|
| **用户距离** | WorkBuddy 是桌面工作台，承载意图输入与结果验收。权限终审必须在离用户最近的一侧 |
| **交付物形态** | 文档/表格/PPT/腾讯生态（IMA、腾讯文档、企微）都在 WorkBuddy 侧；Cursor 产出的是 diff，不是交付物 |
| **能力性质** | Cursor 的强项是"仓库内的确定性工程动作"（多文件重构、类型/测试修复、审查）——是**手段**不是目的 |
| **官方定位** | WorkBuddy × Elastic 的 A2A 架构中，WorkBuddy 就是 Supervisor：只做调度与翻译，不持有 Worker 的领域技能 |
| **故障定责** | 单一控制面 = 单一责任链。对等架构出问题时无法归因 |

### 4.1 路由决策矩阵

| 任务特征 | 归属 | 理由 |
|---|---|---|
| 跨应用交付、文档/表格/PPT、知识库检索、IM/邮件 | **WorkBuddy 自持** | Cursor 没有这些连接器 |
| 单仓多文件重构、类型/lint/测试修复、代码审查 | **派给 Cursor** | 仓库内工程动作，Cursor 上下文索引更强 |
| 需先理解业务意图再改代码 | **WorkBuddy 拆解 → Cursor 执行** | 意图在 WorkBuddy，执行在 Cursor |
| 长时间构建/测试 | **派给 Cursor（异步 job）** | 提交即返回，轮询取结果 |
| 需外部数据（ES/Jira/监控）作为输入 | **WorkBuddy 取数 → 注入 Context Envelope → Cursor** | 避免给 Cursor 发密钥 |

### 4.2 上下文传递：Context Envelope

**反模式**：把整个仓库或整段对话塞进 prompt。正确做法是传**指针 + 约束 + 交付契约**：

```json
{
  "task": "修复 auth 模块的 token 刷新竞态",
  "repo": "/abs/path/to/repo",
  "entrypoints": ["src/auth/token.ts:42", "src/auth/refresh.ts:17"],
  "constraints": ["不得修改公开 API 签名", "必须保持向后兼容"],
  "acceptance": ["pnpm test 全绿", "新增一个回归测试"],
  "deliverable": { "type": "diff", "path": ".agents/wb-cursor/<jobId>/" },
  "budget": { "tier": "execute", "timeoutSec": 900, "worktree": true }
}
```

**收益**：prompt 体积从"整仓"降到 KB 级；约束与验收标准显式化，可回检；交付路径约定好，WorkBuddy 不需要猜产物在哪。

---

## 5. 协议设计

### 5.1 任务状态机

```
                 ┌──────────► completed
                 │
pending ──► running ────────┼──────────► failed
                 │          │
                 │          ├──────────► cancelled  (调用方主动)
                 │          │
                 └──────────┴──────────► timeout    (墙钟上限)
```

`pending` 状态在 bridge 内部被消除（spawn 后即 `running`），对外只暴露终态与 `running`——减少调用方需要处理的分支。

### 5.2 工具签名（9 个）

核心 5 个：

| 工具 | 入参 | 返回 | 设计要点 |
|---|---|---|---|
| `cursor_run` | `prompt, workspace, tier, model?, timeoutSec?` | `jobId, status, isolation` | **永不阻塞**，立即返回 |
| `cursor_status` | `jobId, since?, waitSeconds?` | `status, result, events, cursor` | `since` 增量取事件；`waitSeconds` 上限 55s |
| `cursor_reply` | `jobId, prompt, tier?` | 新 `jobId` | 携带 `threadId` 实现接续 |
| `cursor_cancel` | `jobId` | `status` | 同步标记 + kill 整个进程组 |
| `cursor_list` | `status?, limit?` | job 摘要列表 | 可观测性入口 |

运维 4 个（生产必备，故不追求"最少"）：

| 工具 | 用途 |
|---|---|
| `cursor_diff` | 查看 `execute` 任务的改动文件、diffstat、分页 patch |
| `bridge_health` | 预检：二进制、白名单、状态目录可写、并发、指标、问题清单 |
| `bridge_stats` | 成功率 / 耗时分布 / tier 分布，用于容量规划 |
| `bridge_shutdown` | 取消在途任务、落盘、退出，避免留下孤儿进程 |

**为什么 `cursor_run` 必须不阻塞**：真实代码任务耗时数分钟，而调用方工具超时是秒级。阻塞式调用必然超时，超时后调用方不知任务死活——这是 `qoder-as-subagent` 明确踩过并写进文档的坑。

### 5.3 会话接续

`qoder-as-subagent` 最大的缺口是**每轮都是全新会话**。本方案在 bridge 内捕获 Cursor 的 `threadId`（来自 stream-json 的 `system/init` 事件），`cursor_reply` 时携带它继续。**跨轮次、跨天都能凭 jobId 取回结果，不重跑。**

### 5.4 事件游标语义

事件缓冲是环形截断的，因此事件带**绝对序号 `seq`**，`cursor_status(since=N)` 返回 `seq > N` 的事件。若按数组下标切片，截断后会造成漏发或重发——这是实现中实测发现并修正的缺陷（§7）。

## 6. 工程实现（win-x64）

代码位于 `/workspace/wb-cursor-bridge/`，13 个源文件分层如下：

```
src/index.ts    入口：协议装配、stdout 保护、优雅关闭、全局异常兜底
src/config.ts   配置解析（env > 文件 > 默认），启动即校验
src/tools.ts    9 个 MCP 工具的定义与分发
src/runner.ts   任务调度、worktree 托管、指标聚合
src/store.ts    任务仓库：原子落盘、LRU、崩溃恢复
src/logger.ts   分级日志 + JSONL 轮转（默认 5 MB × 3）
src/admin.ts    可选 HTTP 运维端点（仅 127.0.0.1）
src/cursor/cli.ts    Cursor 调用、进程管理、结果装配
src/cursor/parse.ts  stream-json 解析（对 beta 版字段漂移容错）
src/util/paths.ts    Windows 感知路径白名单
src/util/processes.ts 跨平台进程树终止
src/util/git.ts      worktree 生命周期与产物抓取
src/util/ndjson.ts   增量 JSON 行读取
```

### 6.1 权限分档

| tier | CLI 参数 | 能力 | 隔离 |
|---|---|---|---|
| `consult` | `--mode ask` | 只读问答 | 无 |
| `plan` | `--mode plan` | 只读规划 | 无 |
| `execute` | `--force` | 可写 | **bridge 托管的 detached worktree** |

**调用方只选档位，永远不碰 CLI flag**——权限策略集中在 bridge，不会被上层 prompt 绕过。提示词始终作为最后一个位置参数传入，且不经过 shell，因此 prompt 内容无法被解释成 flag（已有单测覆盖）。

### 6.2 worktree 由 bridge 托管，而非交给 Cursor

Cursor 自己建 worktree（`--worktree`）会把目录藏起来，导致**拿不到 diff、无法可靠清理**。因此 bridge 用 `git worktree add --detach` 自己建（不建分支，避免并发任务分支名冲突），任务结束后：

1. `git add -A` + `git diff --cached HEAD` → 导出 patch 与 diffstat
2. 写出 `report.md`
3. `git worktree remove --force` 清理

结果：调用方的检出目录**始终不被污染**，且每次改动都有可审计的补丁留档。

### 6.3 win-x64 专项处理

| 问题 | 处理 |
|---|---|
| 杀进程树 | Windows 无进程组，`taskkill /PID x /T /F`；POSIX 杀 `-pid` 进程组 |
| 避免弹出黑窗 | `windowsHide: true` + `detached` 仅在非 Windows 生效 |
| 路径大小写不敏感 | 比较前统一小写归一化 |
| 符号链接/junction 逃逸 | 字面路径与 realpath **双重**校验 |
| 8.3 短名绕过 | 直接拒绝（`REPO~1`） |
| DOS 保留设备名 | 拒绝（`CON`、`NUL`、`COM1`…） |
| `taskkill` 报"进程已存在" | 视为成功（`already exited`） |
| JSONL 中文截断 | `StringDecoder` 处理跨 chunk 的多字节字符 |
| 路径过长 | 归一化后再比较，避免 `\?\` 前缀差异 |

### 6.4 健壮性

| 机制 | 实现 |
|---|---|
| stdout 洁癖 | 入口重定向 `console.log/info/debug` 到 stderr，杜绝污染 JSON-RPC |
| 崩溃恢复 | `running` 任务重启后标记 `orphaned`；索引原子写（tmp + rename） |
| 硬杀兜底 | `SIGINT/SIGTERM/SIGBREAK/SIGHUP` + `uncaughtException` → 取消在途任务后退出 |
| 启动清理 | 启动时 prune 遗留 worktree |
| 超时 | 默认 900s，上限 3600s，超时杀树并置 `timeout` |
| 并发 | 默认 4，超限**快速失败**而非排队 |
| 内存 | 事件环形缓冲（默认 2000/任务）+ job LRU（默认 100） |
| 结果体积 | 默认 2 MB 上限；截断时回退到完整 UTF-8 字符边界，绝不产生 U+FFFD |
| patch 分页 | `cursor_diff` 按字节切片后解码，中文补丁不会被切成乱码 |
| 日志 | 5 MB 轮转，保留 3 份；按写入次数（每 50 次）而非每次写入做 stat；日志失败绝不影响主流程 |
| 健康检查 | `bridge_health` 结果 5 秒缓存，避免高频 probe 重复 I/O；响应带 `cached` 字段 |
| 版本一致性 | `src/version.ts` 为唯一来源，测试断言其等于 `package.json`，发布物六处版本号不可能不一致 |

### 6.5 安装包

`release/wb-cursor-bridge-v0.3.2-win-x64.zip` 内含：

```
lib/index.mjs        单文件 bundle（641 KB，含 MCP SDK，零 node_modules 依赖）
lib/McpConfig.ps1    安装器共享库
install.ps1          一键安装
uninstall.ps1        卸载（默认保留审计日志）
launcher.cmd         人工排障入口
verify.cmd           一键自检
VERSION              版本号与构建时间
```

**版本号贯穿发布物**：目录名、ZIP 文件名、ZIP 内条目前缀、bundle banner、`VERSION` 文件与构建报告六处一致。`src/version.ts` 是唯一来源，测试会断言它与 `package.json` 相同——版本号不一致无法通过测试，因此不可能发版出带错版本的包。构建时会自动清理上一版本的目录与 ZIP，`release/` 下永远只有一个当前版本。

一条命令完成：校验 → 复制 → 解析 Node（缺失则 `-BundleNode` 下载私有运行时，可用 `-NodeVersion` 指定）→ 探测 Cursor → 写配置 → 注册到 **WorkBuddy 与 Cursor 两端** → 自检。

安装器会**备份并合并**已有 MCP 配置，绝不覆盖用户其他 server；JSON 非法时报错而非静默重写。

> **MCP 入口为什么指向 `node.exe` 而非 `launcher.cmd`**：MCP 客户端用 `child_process.spawn` 启动 server，Node 在不经 shell 时拒绝执行 `.cmd/.bat`。

### 6.6 实现中实测发现并修正的缺陷

这四点不是设想出来的风险，而是端到端测试跑出来的真实缺陷——也正因如此，测试套件的价值高于单元覆盖率本身。

| # | 缺陷 | 现象 | 修正 |
|---|---|---|---|
| 1 | 事件游标按数组下标切片 | 环形缓冲截断后，`since=N` 返回空，调用方**永久收不到后续事件** | 事件带绝对序号 `seq`，按 `seq > since` 过滤；截断不影响游标语义 |
| 2 | `git diff HEAD` 漏掉新文件 | agent 最常做的事是**新建文件**，而未跟踪文件不在 `git diff` 里，导致 patch 永远抓不到改动 | 抓取前先 `git add -A`，再 `git diff --cached HEAD` |
| 3 | 取消与进程终止竞态 | `cancel()` 只发信号不落状态，轮询方在进程真正被杀前会看到 `running`，`durationMs` 缺失 | `cancel()` 同步置终态并落盘，进程收尾只补结果不覆盖决定 |
| 4 | 二进制缺失时结果为空 | `spawn` ENOENT 既无 stdout 也无 stderr，`result` 为空串，调用方无法判断原因 | 记录 `spawnError`，在结果装配时回填为可读错误 |

另一个 Windows 专属陷阱：安装脚本在 `Set-StrictMode -Version Latest` 下读取空 `PSObject` 的 `.Name` 会抛异常（新建的配置对象没有任何属性），已抽出 `Get-MemberNames` 统一处理——否则"首次安装"这一最常见路径会直接失败。

#### 迭代期全仓审计追加发现（第二批）

前四点由端到端测试暴露；下面这批是逐文件全仓审计挖出来的，**测试跑不到**——它们藏在配置解析、安装脚本与边界参数里。

| # | 缺陷 | 现象 | 修正 |
|---|---|---|---|
| 5 | `cursor_run` 的 `model` 参数不生效 | 工具层解析了 `model`，但 runner 未保存，`buildArgs` 只用 bridge 默认模型——传了等于没传 | `Job` 增加 `model` 字段，`start()` 保存、`execute()` 使用 |
| 6 | 结果/patch 截断切在 UTF-8 字节中间 | 中文结果或中文 patch 分页后出现 `U+FFFD` | `capText` 回退到完整字符边界；`cursor_diff` 按字节切片后再解码 |
| 7 | 安装器升级时停不掉旧进程 | 进程匹配用的是**状态目录**路径，而状态目录经 env 传递、从不出现在命令行里 → 匹配永远为空，旧 `node.exe` 仍锁着 `lib\index.mjs` | 改为匹配安装路径与 `wb-cursor-bridge`；停止后等待 600 ms 释放文件锁 |
| 8 | `uninstall.ps1 -RemovePayload` 崩溃 | `$script:Source` 从未定义，`Test-Path $null` 抛异常（已用 PowerShell 实测复现） | 定义 `$script:Source`；当脚本就在安装目录内时跳过删除，避免自删 |
| 9 | 配置越界错误不含配置项名 | 报错形如 `5 must be between 60 and 86400`，运维无法定位是哪个旋钮 | `num()` 增加 name 参数，错误消息带上配置项名 |
| 10 | 排序依赖机器 locale | 用 `localeCompare` 比较 ISO 时间戳，不同 locale 下顺序可能不同 → job 淘汰顺序不确定 | 改为纯字符串比较（ISO-8601 字典序即时间序） |

> 第 7 条值得单独说：它只在**升级安装**时触发，而首次安装永远正常——这类"只在第二次发生"的缺陷，正是全仓审计相对功能测试的价值所在。

## 7. 反向通道（Cursor → WorkBuddy）

主从架构下反向通道**只用于取证，不用于派活**：

| 方案 | 机制 | 阶段 | 评价 |
|---|---|---|---|
| **R1** | Cursor 的 `mcp.json` 挂一个 server，内部 `spawn codebuddy -p --output-format json --permission-mode dontAsk` | P1 | 与 `qoder-as-subagent` 对称，实现简单；`--json-schema` 可强制结构化输出 |
| **R2** | WorkBuddy 常驻 `codebuddy --serve --auth password`，Cursor 侧写 ACP/REST client | P2 | 能力最强（流式、会话），但引入常驻进程与认证面 |
| **R3** | 完全不做反向通道，缺什么由 WorkBuddy 主动补进 Context Envelope | P0 | **推荐起步**——多数"回问"其实是初次上下文没给全 |

**硬性约束**：反向通道禁止触发 WorkBuddy 再派任务给 Cursor，防止环路。在 R1 的 server 内用 `--disallowedTools` 去掉所有会触发委派的工具即可。

---

## 8. 治理面：三档权限与预算

| 维度 | 机制 |
|---|---|
| 权限 | tier 三档；`execute` 才给写 |
| 范围 | workspace root 白名单 + worktree |
| 时间 | 超时强杀 |
| 成本 | 并发上限 + `--max-turns`（WorkBuddy 侧） |
| 审计 | `events.jsonl`：start / assistant / tool / result / stderr / end，带 ISO 时间戳 |
| 人工兜底 | WorkBuddy 侧 `--permission-prompt-tool` 把高危权限请求路由到一个审批 MCP 工具 |

**必须正视的风险**：MCP server 不受调用方的沙箱与审批策略约束（`qoder-as-subagent` 的作者把这条写在文档最前面）。也就是说，**bridge 是调用方策略上的洞**。对策是把上述边界全部实现在 bridge 内部，并把 bridge 本身跑在低权限用户下、必要时进容器（`codebuddy --sandbox container` 可用于 WorkBuddy 侧隔离）。

---

## 9. 可靠性

| 故障 | 处理 |
|---|---|
| 长任务超时 | 状态置 `timeout`，杀进程组，产物仍可读 |
| CLI 不存在/未登录 | `spawn error` 立即失败，错误信息回传调用方 |
| 输出非 JSON | 逐行解析容错，非 JSON 行丢弃不中断 |
| 并发超限 | 直接拒绝，快速失败，调用方稍后重试 |
| 任务结果丢失 | 状态与事件落盘，凭 jobId 随时取回 |
| Cursor 云端不可用 | 降级到 Cloud Agents REST API 或纯本地只读（`consult` 档） |
| 幂等 | `execute` 一律走 worktree + 独立 jobId，天然不覆盖既有产物 |

---

## 10. 可观测性

`events.jsonl` 每行一条：

```json
{"ts":"2026-10-09T03:31:00.000Z","type":"start","text":"/root/.local/bin/agent","detail":{"args":["-p","--output-format","stream-json", "..."],"timeoutSec":900,"tier":"execute"}}
```

建议采集的最小指标集：**成功率 / p50·p95 耗时 / 超时率 / tier 分布 / 取消率 / 单 job 事件数**。前三个决定是否该调整超时默认值，tier 分布反映委派策略是否过宽。

---

## 11. 落地路线图

| 阶段 | 状态 | 交付 | 验收标准 |
|---|---|---|---|
| **P0** 单向可用 | ✅ 已完成 | 9 工具 + 白名单 + worktree 托管 + patch 产物 + 审计 | WorkBuddy 一句自然语言完成"让 Cursor 改这个仓库并回传 diff" |
| **P1** 状态面完备 | ✅ 已完成 | `threadId` 接续、崩溃 `orphaned` 恢复、Context Envelope | 跨轮追问不丢上下文；硬杀 bridge 后仍能取回任务与产物 |
| **P2** 协议升级 | ⬜ 待做 | 为 Cursor 写 A2A adapter（Agent Card + 异步任务 + 会话持久化），替换 MCP 传输 | WorkBuddy 通过 A2A 发现并调度 Cursor，**上层语义零改动** |
| **P3** 生产加固 | 🟡 部分 | 已具备超时/并发/内存上限/日志轮转/HTTP 运维端点；待补容器化、预算配额、人工审批工具（`--permission-prompt-tool`）、指标看板 | 可交付给非本人使用；异常可归因 |

**P2 是本方案的关键伏笔**：因为语义层从一开始就按 A2A 建模（能力描述 + 任务 ID + 异步 + 会话持久化），换传输层时上层不需要改。

当前实现的部署形态：`install.ps1` 一条命令完成运行时准备、双端 MCP 注册与自检；`bridge_health` 与可选的 `/healthz` 端点构成运维兜底。

## 12. 与 Qoder/Codex 方案的对照

| 维度 | `agent-bridge` | `qoder-as-subagent` | **本方案** |
|---|---|---|---|
| 控制面 | 消息总线（需两端自实现循环） | CLI 包装成 MCP | CLI 包装成 MCP（继承其优点） |
| 状态面 | 任务表 | 内存 job | **落盘 events.jsonl + threadId 接续** |
| 治理面 | 无 | tier + 白名单 | **tier + 白名单 + worktree + 超时 + 并发 + 审计** |
| 架构 | 对等 | 单向 | **显式单向控制面 + 双向数据面（防环路）** |
| 上下文 | 全量消息 | 每轮新会话 | **Context Envelope（指针+约束+契约）** |
| 演进 | — | — | **MCP 传输 → A2A 传输，语义不动** |

---

## 13. 风险与未决

1. **Cursor CLI 仍在 beta**，stream-json 的事件结构（`tool_call` / `result` 字段）可能变化 → bridge 的解析层需做成容错 + 版本快照测试。
2. **`--force` 在 print 模式是完整写权限**，且 MCP server 不受调用方沙箱约束 → `execute` 档必须配 worktree + 白名单，缺一不可。
3. **Cloud Agents 需关闭 Privacy Mode**，企业账号可能不允许 → 云端降级路径要按账号能力开关。
4. **A2A 的 Agent Card 注册入口**在 WorkBuddy 侧由平台管理，Cursor adapter 如何被"发现"需要在 P2 阶段确认具体接入方式。
5. **双 Agent 计费叠加**，预算需在 bridge 层做配额，否则一次误委派就是双倍消耗。

---

## 附录：命令速查

```powershell
# Windows 一键安装
powershell -ExecutionPolicy Bypass -File install.ps1 -WorkspaceRoots "C:\src\api;C:\src\web"
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
```

```bash
# Linux / macOS 开发态
npm install && npm run build:release

# WorkBuddy 侧
codebuddy mcp list                                  # 验证 bridge 是否注册
codebuddy --mcp-config ./cursor-bridge.json -p "..."  # 隔离验证
codebuddy -p --output-format json --json-schema '...' # 结构化输出

# Cursor 侧
agent -p --mode ask "..."                            # 只读问答
agent -p --force --output-format json "..."           # 可写 + 结构化
agent -p --worktree feat-x --force "..."              # 隔离写
agent --resume <threadId> -p "继续"                    # 会话接续
agent ls                                              # 列出历史会话
agent acp                                             # ACP server（P2 用）
```

```bash
# bridge 本地验证
cd /workspace/wb-cursor-bridge
npm install && npm run build
CURSOR_BRIDGE_WORKSPACE_ROOTS=/workspace node dist/index.js
```
