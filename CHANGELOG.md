# 更新日志

## 0.5.0 — 按第三方审计的 PoC 逐条修复

上一版交付后收到一份外部审计，附 36 个可执行 PoC。本版把这份证据包在出货产物上
逐脚本复跑：**26 条缺陷仍可复现**，其中 4 条能在默认配置下打挂进程。修完后再跑一遍，
26 条全部不复现，并把它们改写成 `test/audit-b0.test.mjs` 的反向回归（修复后必须是绿的）。
全仓测试 **130 → 151** 项（其中 21 项是把 PoC 反向改写成的回归）。

### 阻断级：进程存活

- **`null` body 远程打挂**（`a2a/06`）。`JSON.parse('null')` 是合法解析，`parsed.id`
  随即抛 TypeError；`handlePost` 是 async，`return handlePost(...)` 的 rejection 逃出了
  同步 `try/catch`，20 个 4 字节 POST 就把进程顶到 unhandledRejection 阈值退出。
  现在先做形状校验（非对象/数组 → `-32600`），并在调用点挂 `.catch()`。
- **产物端点 `EISDIR` 打挂**（`a2a/10`）。`existsSync` 不是类型检查：把 patch 换成目录后
  `createReadStream().pipe(res)` 异步抛 EISDIR，升级为 `uncaughtException`。改为
  `statSync().isFile()` 前置 + `stream.pipeline()` 收口错误。
- **并发槽永久泄漏**（`engine/repro-21`）。外层 Promise 只挂 `close`，而 agent 派生的
  setsid 孙进程继承 stdout 后 `close` 永不触发——`cancel`、超时、`bridge_shutdown`
  三条恢复路径同时失效，只能重启。现在 `exit` 是主结算信号 + 1.5s 排空窗口，
  kill 路径 2s 硬结算，并在结算后销毁管道。
- **事件环只按条数限制**（`engine/repro-08`）。`maxResultBytes=1 MiB` 时单任务峰值
  RSS 仍到 490 MiB：每个 assistant 分片按原文入队，2000 条上限等于 2 GiB 上限。
  新增 `maxEventBytes`（默认 4 MiB/任务），按字节 + 条数双预算淘汰。

### 权限与隔离

- **argv 注入**（`engine/repro-01`）。prompt 直接作为位置参数追加，`prompt: "--force"`
  落进 flag 位，consult 档实际完成写入。现在 prompt 前固定 `--`，`model` 拒绝 `-` 开头。
- **隔离 fail closed**（`engine/repro-02/03/14`）。非 git 目录、worktree 创建失败、
  续跑撞名，原先一律降级为「让 Cursor 自己管」，结果是 `--force` 直写调用方 checkout、
  无 patch 无回滚。现在三种情况都**拒绝任务**；子目录白名单映射到 worktree 内对应子目录；
  每次尝试用 `jobId + 时间 + 随机` 命名。
- **宿主 env 透传**（`engine/repro-17`）。worker 曾能读到宿主全部环境变量（`sk-live-...`
  原样可见）。改为白名单 + 敏感名过滤，`CURSOR_BRIDGE_ENV_PASSTHROUGH` 可按名点名。
- **路径白名单误杀 8.3 短名**（Windows CI 发现，审计未覆盖）。原先任何形如 `REPO~1`
  的路径段一律拒绝；而 GitHub Windows runner 的 `%TEMP%` 正是
  `C:\Users\RUNNER~1\AppData\Local\Temp`，于是 11 个 e2e 用例全部 `E_PATH_DENIED`。
  短名只在同一父目录内别名，不构成穿越能力，改为**按 realpath 判定包含关系**：
  两侧都先解析再比较，安全属性不变（junction/symlink 逃逸仍被拒），并区分
  「指向外侧」与「解析后逃逸」两种报错以便排障。

### 数据与生命周期

- **commit 后成果消失**（`engine/repro-10`）。agent 自行 commit 后 `git diff HEAD` 为空，
  `changedFiles=[]`、无 patch，worktree 一删 commit 就悬空。产物捕获改为锚定
  `baseCommit`（worktree 创建时的 HEAD），并额外记一条「worker 在 worktree 内提交」事件。
- **report 永不导出**（`engine/repro-16`）。捕获时机早于 `finalise()`，`job.result` 还是
  undefined；续跑则写上一轮旧答案。改为用本次 `outcome.result` 写，续跑覆盖为最终答案。
- **孤儿 worker 无人回收**（`engine/repro-06/09`）。重启只把 job 标记 `orphaned`，
  进程还在跑且没人知道 pid。现在 pid 随 `onSpawn` 落盘，启动时校验
  `/proc/<pid>/cmdline` 后再回收（pid 复用不误杀）。
- **`graceMs` 无钳制**（`engine/repro-15/18`）。`0` 会在 kill 落地前退出（agent 存活），
  `1e999` 让等待循环永不返回、`flushNow` 不落盘。`shutdown()` 内部钳制 `[500, 60000]`，
  `num()` 改 `Number.isFinite`。
- **续跑绕过并发**（`engine/repro-04`）：`resumeFromInput` 现在先过与 `start()` 相同的
  准入检查，被拒时任务保持 `input-required`。
- **活任务无上限 / 暂停无 TTL / 产物不回收**（`engine/repro-13/20`）：新增
  `maxLiveJobs`、`inputRequiredTtlSec`，LRU 淘汰时同步删除 artifacts 与事件日志。

### A2A 互操作

- **SSE 没有 JSON-RPC 信封、且从不发 `artifact-update`**（`a2a/11/13`）：帧改为
  `{jsonrpc, id, result}`；生成器改为「产物先于终态」发送——终态是客户端消费的最后一帧，
  排在它后面的事件必然被丢弃。
- **通知不终止 HTTP 响应**（`a2a/06` §4）：JSON-RPC 说「不必回包」，HTTP 仍需收尾，
  现在回 `202` 空体。
- **`/healthz` 恒为 healthy**（`a2a/15`）：改为调用 `mgr.health()`，二进制缺失时 503。
- **Agent Card 泄露宿主路径**（`a2a/09`）：未鉴权卡片里的 skill 描述曾含
  `/home/alice/...`，改用 basename。
- **push URL 的 query secret 入日志**（`a2a/02`）：拒绝分支只记 origin + path。
- **SSRF 补 DNS 维度**（`a2a/03`）：字符串判定后解析全部 A/AAAA，任一地址落在私有段即拒；
  发送端 `redirect: 'manual'`，不再跟随未校验的跳转。
- **限流按来源分桶**（`a2a/07`）：单桶等于给所有人上同一把锁，一个客户端就能把其他调用方
  打成 429；现在按 peer 地址分桶并覆盖全部动态路由（卡片除外）。
- **容量拒绝改用 `-32006`**，不再冒充内部错误。

### 交付链

- **锁文件**：224 个 `resolved` 全部指向 `http://mirrors.tencent.com`（明文 HTTP），
  而 `npm ci` 只认锁里的主机。已改写为 `https://registry.npmjs.org` 并逐个校验 integrity
  与实际 tarball 一致；`.npmrc` 钉官方源 + `replace-registry-host=always`；
  `npm audit --omit=dev` 由 5 条（2 high）降到 **0**。
- **可复现构建**：`VERSION` 时间戳改用 `SOURCE_DATE_EPOCH` 或 commit time（原先每次构建
  都不同，发布哈希无法回溯）；smoke 挪到打包**之前**；产出 `SHA256SUMS`（zip + 载荷逐文件）。
- **安装器**：Node 运行时下载强制 https、镜像参数优先于环境变量、按 nodejs.org 的
  `SHASUMS256.txt` 校验；解压后核对载荷 `SHA256SUMS`；`-AllowUnverifiedNode` 才能跳过。
- **卸载器**：`SupportsShouldProcess` + 载荷特征断言 + 危险路径拒绝，`-RemovePayload`
  不再删除「脚本所在目录」这种任意路径。
- **CI**：最小权限 `contents: read`、`concurrency` 取消旧跑、`timeout-minutes`、
  生产依赖审计门禁、PowerShell 语法门禁、构建可复现复核、产物上传。

### 测试

- 新增 `test/audit-b0.test.mjs`（10 项）：形状校验、通知 202、产物类型守卫、
  孙进程占管道不泄漏槽位、`shutdown(Infinity)` 有限返回、事件字节预算、续跑并发、
  `--` 终止符与 `model` 校验。
- 新增 `fake-agent.mjs` 的 `hold-stdout` 模式，用于确定性复现「孙进程握着 stdout」。


本项目的版本号遵循语义化版本（SemVer）：`MAJOR.MINOR.PATCH`。
`src/version.ts` 是版本号的唯一来源，测试会断言其与 `package.json` 一致——
版本不一致无法通过测试，因此不可能发出版本号错乱的包。

## 0.4.3 — 工程门禁：lint / 发布前校验 / Windows 全量测试

全仓测试 **129 → 130** 项，`verify` 与 `prepublishOnly` 都先过 lint。这一版不改运行时
语义（除下面那处 Windows 启动分支），补的是"能让这些问题被机器发现"的门禁。

### 新增：ESLint 门禁

`eslint.config.mjs` 接入 flat config，只启用偏正确性的规则（未使用绑定、松散相等、`var`、
应 `const` 却 `let`、未定义全局），不引入会和现有代码风格打架的格式化规则。

首次运行就抓到 **12 error**，其中 3 处是真问题而不是风格：

- `src/a2a/watch.ts`：`lastArtifactCount` 只赋值从未读取，属死代码，删除。
- `test/a2a.test.mjs`：`leftoverWorktrees()` 调用 `fs.readdirSync` 但从未导入 `fs`，
  `ReferenceError` 被外层 `catch` 吞掉，**断言永远看到空数组**——见下。
- `test/a2a.test.mjs`：0.4.2 把 worktree 改成 `<stateDir>/worktrees/<instanceId>/` 后，
  该函数仍按旧的 `wb-` 前缀过滤，即使不抛错也永远匹配不到。

### 修复：一个从 0.4.2 起就空转的 worktree 泄漏断言

`a2a(P3#20): a crashed agent does not leak its git worktree` 一直在"通过"，但它检查的是
一个恒为空的数组：`fs` 未导入 → 抛错 → `catch { return [] }`。0.4.2 改了目录层级后，
即使导入正确，前缀过滤也只会返回空。

现在按 `worktrees/<instanceId>/<worktree>` 走一层，跳过 `owner.json`。并做变异验证：
人为在断言前创建一个残留目录，用例**如期失败**（`actual` 里出现 `probe-inst/probe-wt`），
证明它不再是摆设。

### 新增：`prepublishOnly`

`npm publish` / 打包前强制 `lint + typecheck + npm test`。此前 `bin` 指向 `dist/` 而
`dist/` 不入库，漏构建会发出一个装完就跑不起来的包。

### 修复：Windows 上测试跑不起来（`.cmd` 无法无 shell 启动）

Node 18.20.2+ 起，`spawn()` 一个 `.cmd`/`.bat` 且未开 `shell` 会直接 `EINVAL`
（CVE-2024-27980）；`execFile()` 同样不行。原 CI 的做法是"临时生成 `test/fake-agent.cmd`，
把 `CURSOR_BIN` 指过去"，因此 Windows 上只能跑 unit/e2e/admin，a2a/stress/fault 一直缺席。

- 新增 `resolveSpawnTarget()`：Windows 上若 `CURSOR_BIN` 指向 `.js`/`.mjs`，改用当前
  Node 执行该脚本；其余情况（含生产的 `agent.exe`）保持直接 spawn。
  **不启用 shell**——prompt 是 argv，走 shell 会把 `&`、`^` 变成命令注入。
- 测试统一经 `test/fake-bin.mjs` 取假 Agent 路径：POSIX 用 `.sh`（shebang + exec 位），
  Windows 用 `.mjs`。
- CI 的 Windows job 改为跑 `npm test`（含 a2a、hardening）+ `test:stress` + `test:fault`，
  不再内联生成 shim。
- `.gitattributes` 固定 `*.sh` 为 LF（CRLF shebang 在 POSIX 上无法执行）。

### 顺带

- `test/client.mjs`：把 `cond ? a() : b()` 的三元语句改成 `if/else`（lint 的
  `no-unused-expressions`），行为不变。

## 0.4.2 — 配置严格化 + CORS 凭证收敛 + 多实例共存

全仓测试 **110 → 129** 项（68 单元 + 5 硬化 + 20 端到端 + 3 admin + 33 A2A），
`verify:e2e` 54 项全过。三项都属于"不报错但结果不对"的静默故障。

### 修复：非法配置值不再静默回退

`num()` 把解析失败当作"用默认值"，于是 `CURSOR_BRIDGE_TIMEOUT_SEC=15m` 被静默换成
900 秒——运维以为超时是 15 分钟，任务实际跑了 15 小时才被杀。实测六个非法值全部被接受：

| 环境变量 | 修复前 | 修复后 |
|---|---|---|
| `CURSOR_BRIDGE_TIMEOUT_SEC=15m` | 静默用 900 | 启动失败，错误信息点名该键 |
| `CURSOR_BRIDGE_MAX_JOBS=lots` | 静默用 100 | 启动失败 |
| `CURSOR_BRIDGE_LOG_LEVEL=verbose` | 原样透传 | 启动失败 |
| `CURSOR_BRIDGE_FORCE_WORKTREE=ture` | 静默按 false | 启动失败 |
| `CURSOR_BRIDGE_A2A_PROTOCOL_VERSION=2.0` | 静默按 0.3.0 | 启动失败 |
| 通配 CORS + 允许凭证 | 接受 | 启动失败 |

- `num()`：环境变量显式给出却不可解析时抛 `badConfig`，信息含键名与示例值；配置文件
  里的非数字同样拒绝（数字字符串仍兼容）。
- `bool()`：只接受 `1/0`、`true/false`、`yes/no`、`on/off`。`=ture` 以前被读成
  false，等于静默关掉了功能。
- `logLevel`：限定 `debug|info|warn|error`。未知等级会让比较落到"全记"或"全丢"，
  取决于比较顺序，等于把告警关掉了还不知道。
- `a2aProtocolVersion`：限定 `0.3.0|1.0`。

### 修复：CORS 通配不再授予凭证

`applyCors` 命中 `*` 时反射任意 `Origin`，并无条件发送
`access-control-allow-credentials: true`——**任何网站都能带凭证读取桥的响应**。实测
`Origin: http://anywhere.example.com` 得到反射 origin + `allow-credentials: true`。

- 新增 `CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS`（默认关闭）：只有显式开启且来源为
  精确列表时才发送 `allow-credentials`。
- 通配 `*` 与"允许凭证"同时出现时**拒绝启动**（该组合没有合法用途）。
- 反射来源时补 `Vary: origin`，避免共享缓存把一个来源的响应发给另一个。

### 修复：多实例共享 stateDir 互相删除 worktree

MCP 客户端每个会话起一个 bridge，且都解析到同一个默认 stateDir，所以"两个实例同时
活着"是常态而非误配。旧启动清理会**删光** `<stateDir>/worktrees` 下的所有目录：第二个
会话启动时，第一个会话正在执行的 worktree 被删除，worker 的 `cwd` 消失，任务以无关
错误失败。实测：兄弟实例启动后，运行中任务的 worktree 从存在变为不存在。

- 新增 `src/util/instance.ts`：worktree 落在 `<stateDir>/worktrees/<instanceId>/`，
  目录内写 `owner.json`（pid / hostname / instanceId / startedAt）。
- 启动清理改为 `pruneStaleInstanceDirs`：只回收**同主机且 pid 已不存在**的实例目录；
  跨主机（网络盘）一律不动；无 owner 记录的旧布局目录超过 6 小时才回收。
- `pruneOwnedWorktrees` → `pruneWorktreeMetadata`：只跑 `git worktree prune` 清元数据，
  **不再删除任何目录**。
- `index.json` 增加 `owner` 字段：加载时只有"本实例"的 running 任务才算崩溃孤儿，兄弟
  实例的存活任务保持 running（否则两边会来回把对方改成 orphaned）。
- 写入前按 mtime+size 检测他人写入并合并：不是本进程创建的 job 以磁盘版本为准，
  兄弟实例的 completed 不会被回滚成旧状态。
- 检测到同主机存活兄弟实例时告警，提示可用独立 `CURSOR_BRIDGE_STATE_DIR` 隔离历史。

### 测试

新增 19 项（unit 16 + a2a 2 + e2e 1）：配置拒绝 7、实例目录回收语义 5（存活 / 已死 /
跨主机 / 旧布局 / pidAlive）、store 多实例合并 4、CORS 凭证 2、兄弟实例不删运行中
worktree 1（真实 git worktree + 假 Agent，修复前该断言为 `false`）。

## 0.4.1 — 中断续跑不再丢工作 + 失败路径硬化

全仓测试 **97 → 110** 项（52 单元 + 5 硬化 + 19 端到端 + 3 admin + 31 A2A），
`verify:e2e` 54 项全过。所有条目都有先红后绿的回归用例，修复前的失败原因已实测记录。

### 修复：`input-required` 暂停期丢失已完成的改动（P0，数据丢失）

`execute` 档任务在 `input-required` 暂停时，托管 worktree 随该轮结束被删除，而续跑轮
从干净的 `HEAD` 重建——**第一轮已经写好的文件全部消失**，续跑线程却以为自己还在原来的
树上继续工作。实测：续跑轮的 worker 看不到自己上一轮创建的 `first-pass.txt`。

- **`runner.ts`**：续跑前把暂停时保存的 patch 回放到新 worktree（`applyPatch`）。
  最终 patch 仍是相对 `HEAD` 的累计 diff，跨多轮中断也成立。
- **`util/git.ts` 新增 `applyPatch()`**：`git apply --index` → 失败时 `--3way`
  （调用方在暂停期间提交过、基线移动的常见情形）。
- **失败即关闭（fail closed）**：无法回放时任务退回 `input-required`，保留原问题、
  保留 patch 文件并追加 `resume blocked: …` 事件，**绝不在残缺的树上继续跑 worker**
  而假装成功。
- **`captureDiff` 加 `--binary`**：此前二进制改动只会得到 `Binary files differ`，
  无法回放，图片/资源类改动会让续跑必然失败。
- **`store.ts`**：持久化 `patchFile` / `reportFile` / `changedFiles` / `diffStat` /
  `isolation` / `model` / `inputRequiredAt`。此前只存内存，**桥重启后暂停任务的 patch
  指针丢失，同样无法还原**；`input-required` 可跨天存在，重启是常态而非例外。

### 修复：续跑不得静默改变权限档位

`cursor_reply` 暴露 `tier` 参数，但 `input-required` 原地续跑时被静默忽略——调用方会
误以为任务降级/升级了，实际仍按原档位运行。现在显式拒绝并说明原因，需换档请新建任务。

### 修复：异常 worker 可把内存吃光（无上限缓冲）

- **`util/ndjson.ts`**：`NdjsonReader` 现在有单行硬上限（默认 8 MiB）。一个永不换行（或吐出超大单行）的 worker 过去会让 `buffer` 无限增长直到进程 OOM；现在超限行被丢弃、计数并跳过至下一个换行，后续正常事件照常解析，并给出 `dropped N oversized stream line(s)` 事件而不是假装无输出。
- **`cursor/cli.ts`**：`result` 边流边截断，`maxResultBytes` 不再只在进程退出时生效；同时保留 16 KiB 尾部窗口，**结果被截断后仍能识别最后一行 `NEED_INPUT:`**（否则话多的 worker 会"静默完成"而不是暂停提问）。
- **`runner.ts`**：`pauseForInput` 补写 `truncated`，暂停态不再丢失"结果被截断"的事实。

### 改进：blocking 调用不再为已断开的客户端空转

`awaitBlockingFinal` 接 `AbortSignal`（由 `res` 的 `close` 触发）：客户端挂断后立即结束等待，**但绝不取消任务**——工作仍然被需要，调用方可以重连轮询/重订阅。
`sendJson` 增加已销毁响应的写入保护。

> 说明：实测 Node 会静默吞掉对已销毁响应的写入，因此这**不是**一个防崩修复（曾有此假设，已被用例证伪）；真实收益是每个被放弃的 blocking 请求不再空转至 `a2aBlockingMaxMs`，以及不再依赖运行时行为兜底。

### 测试

- `e2e(P0-B)` ×3：暂停后文件不丢（含二进制）、**桥重启后仍能续跑并还原**、
  patch 不可回放时 fail closed 且问题与 patch 都还在。
- `e2e(P1)`：20 万字符洪泛下结果被截断在预算内，且**截断后仍正确进入 input-required**。
- `unit` ×3：永不换行的行被限界/计数/可恢复、超长完整行被丢弃、`end()` 不泄漏残片。
- `a2a(P1)`：blocking 客户端断连不取消任务、服务仍可用、任务自行完成。
- `test/fake-agent.mjs` 新增 `needinput-write` 与 `flood-needinput` 模式，把"是否丢工作""是否被截断"变成可断言的事实。

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
