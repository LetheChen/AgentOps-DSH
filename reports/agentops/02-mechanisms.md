# AgentOps 体系：运行机制（只读代码分析）

范围：`packages/subagent/`、审批/权限（`interaction/user-approval`、`interaction/permission-presets`、`sandbox/*`）、`packages/workflow/` 与真正的 DAG 实现 `packages/agentops/dag/`、生成式 UI（`packages/agentops/host/src/surfaces.ts` + `packages/agentops/client/src/client/a2ui-panel.tsx`）。本报告不含任何代码改动。

## ① 核心结论

1. 子代理的状态机是「manager 内存驻留 + 会话日志事件对」，实际判定只有 `closed/retry/wait/ready` 四个内部态和 `start`/`end` 两条事件边；没有墙钟超时，容量槽只在 `finishDisposal` 释放。
2. 派发到子代理的权限在**派生边界被写死**：approval 恒为 `never`（仅继承父会话的 sandbox override），因此子代理内任何需要审批的动作都走「确定性拒绝」路径，且拒绝文案对模型说成「the user rejected」。
3. 子代理失败时父会话只拿到「failed + It left no closing message.」这类摘要；结构原因（`turn/end.reason.error.message/code`）只留在子会话日志里，本地进程内 provider 从不设置 `SubagentResult.diagnostic`。
4. DAG（`packages/agentops/dag`，不是 `packages/workflow/`）用 `after` 调度、`outputs` 只作数据流，gateway 端口路由 + 下游 skip；节点失败不触发兄弟取消，`command` 节点在 DSH 内根本不可执行。
5. 看板链路是「工具直写 SQLite → HTTP GET」，没有会话事件、没有推送：`view_id` 全局唯一（不含 session），`DELETE`+`INSERT` 非事务，面板只在挂载时读一次。

---

## ② 逐条回答

### Q1 一次 subagent 派发的完整状态序列；并发上限、超时、失败、无收尾消息

**代码里的真实状态命名**：题面提到的 `running / inactive` 枚举在仓库中**不存在**（未验证到任何 `SubagentState = 'running' | 'inactive'` 定义）。实际状态由三部分组成：

- 内部驻留阶段：`Activation.closing`（undefined = 接受输入，Promise = 拆除中）+ `activation.announced`（是否已经有过被接受的投递）——`packages/subagent/subagent/src/activation.ts:42-74`。
- 结算观察态：`type SettlementState = 'closed' | 'retry' | 'wait' | 'ready'`——`packages/subagent/subagent/src/manager.ts:117`。
- 对外可见事件：`subagent/start` → `subagent/end` 成对（`packages/subagent/subagent/src/lifecycle.ts:102-115`），`end` 只带 `stopReason` 与可选 `lastAssistantMessage`。

**完整序列**（本地可续 provider，`spawn`/`fork` 路径）：

| 阶段 | 代码位置 | 行为 |
|---|---|---|
| 工具入口 | `packages/subagent/tool-subagent/src/index.ts:269-333` | 解析 preset/model/maxDepth，`startActivation({provider, request, signal: exec.signal, delivery: 'parent'})`，立即返回 `{kind:'activation', subagentId}` |
| 服务校验 | `packages/subagent/subagent/src/index.ts:271-286` | provider 存在、能力匹配、`maxDepth` 合法、父 Agent 必须是**同一个 live 对象**，否则 `UNAUTHORIZED` |
| 准入 | `manager.ts:382`、`696-705` | `assertAdmitting`：manager drain 或该父树的 closing scope 生效时抛 `DRAINING` |
| 深度 | `manager.ts:387` → `child-agent.ts:49-58` | `resolveChildDepth`，超 `maxDepth` 抛 `SubagentDepthError` |
| 描述符 + 策略快照 | `manager.ts:394-404` | `snapshotSubagentDescriptor`；`captureDelegatedPolicyOverrides` 在**第一个 await 之前**同步取父会话的 sandbox override 与 approval pin |
| 容量 | `manager.ts:743-744` → `activation.ts:24-35` | `pool.reserve(maxActiveSubagents())`，超限抛 `SubagentError('ACTIVATION_LIMIT_REACHED')` |
| 子 Agent 创建 | `manager.ts:905-922` | `agents.create/resume`，`meta` 带 `parentSession / delegationDepth / isSeeded / origin:'subagent'`（`child-agent.ts:135-154`） |
| 策略盖章 | `manager.ts:886-896` → `child-agent.ts:266-279` | 子会话日志顺序追加 `subagent/descriptor` → `approval/policy{policy:'never',source:'delegation'}` → `sandbox/mode{source:'delegation'}` → `permission/preset` |
| 注册驻留 | `manager.ts:951`、`956` | `resident.set(childId, activation)` + `acquireOwnership`（父 activation 的 `ownedChildren`） |
| 起点事件 | `manager.ts:975` | `observer.start()` → `subagent/start` |
| 初始投递 | `manager.ts:459-469`、`989-998` | 初始 prompt 入 inbox（`delivery:'queue'`），`announce()` 启动结算观察 |
| 结算循环 | `manager.ts:1043-1092` | `whenIdle()` → `settlementState()`：`closed`/`retry`/`wait`（有 pending 输入或未结算子代理）/`ready` → `flushFinalState` → `runMaintenance` → `close()` |
| 收尾 | `manager.ts:1113-1203` | `captureLocalResult` → `handle.dispose()` → `resident.delete` + `releaseSlot()` → `notifySettlement` → `observer.settle()`（`subagent/end`）→ `result.resolve/reject` |

**并发上限**：`maxActiveSubagents`，schema 默认 **8**，`volatile`（运行期可改）：`packages/subagent/subagent/src/index.ts:186-198`，取值经 `:220` 注入 manager。池是 **per-root** 的：`rootPool`（`manager.ts:841-847`），后代直接复用父 activation 的 `pool`（`manager.ts:743`）——即「一条不间断的 continuable 父链共享 8 个槽」。DAG 另有自己的每层并发，默认 4（`packages/agentops/dag/src/dsh.ts:66-67`，`engine.ts:152`）。

**超时**：**不存在 per-run 超时**。`packages/subagent/**` 里所有 `setTimeout`/`AbortSignal.timeout` 都是 provider 内部的握手/优雅关闭，例如 `subagent-acp/src/run.ts:175,390`、`subagent-codex/src/run.ts:405`、`subagent-dsh-sdk/src/run.ts:79`（`DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000`）。本地子代理的取消只来自 `dispose()`（父拆除、用户 interrupt、或 DAG 节点的 `AbortSignal.timeout`，见 Q4）。后果：卡住的子代理会**永久占住一个容量槽**，直到父树拆除。

**失败如何被处理与上报**：
- 子 Agent 模型/工具失败：`turn/end` 记录结构化原因 `{kind:'error', error:{message, code}}`（`packages/core/agent-loop/src/agent.ts:405-415`），同时 `agent/error` 事件被 `observeLocalFailure` 记为 `failureAt`（`activation.ts:136-142`）；只有晚于 `failureAt` 的 `turn/end` 才清除它（`:143-148`）。
- 结算时 `captureLocalResult`：`stopReason = failureAt===undefined ? epochStopReason(events) : 'error'`（`activation.ts:156-168`）；`epochStopReason` 把 `turn/end` 原因映射成 `max-tokens / aborted / error / refusal(blocked) / completed`，未知原因一律 `error`（`lifecycle.ts:134-160`）。
- 上报双通道：父会话拿一条 user message（`notifySettlement` → `sendWaking(parent, ..., parent.status==='idle' ? 'queue' : 'steer')`，`manager.ts:1206-1218`）；观测者拿 `subagent/end`（`lifecycle.ts:108-114`，**不含 diagnostic**）。
- 拆除失败（teardown）不改变捕获结果：失败聚合成 `ACTIVATION_TEARDOWN_FAILED` 抛出，同时 `terminal` 被替换为 `{output:[], stopReason:'error'}`（`manager.ts:1164-1202`）。

**「无收尾消息即终止」的三条分支**（`packages/subagent/subagent/src/continuation-messages.ts:140-173`）：
1. `omitClosingText=true`（子代理最后一个动作是给直接父 `send_message`，且此后没有 claimed 输入、没有新的 `tool/call`）→ 通知文本「It sent you a message just before finishing, so its closing message is omitted.」。置位：`manager.ts:1325`；复位：`manager.ts:961-966`（`inbox/claimed`）、`971-973`（任何 `tool/call`）。
2. `output` 中 text 块为空 → 「It left no closing message.」（`:158-160`）。
3. 正常 → 「Its closing message:」+ 文本块（`:160`）。

**interrupt**：`manager.interrupt(targetSessionId, authority)`（`manager.ts:183-228`）。权威二选一：`{kind:'user', parentSessionId}` 必须等于 `activation.parent.id`；`{kind:'ancestor', agent}` 必须命中 materialize 时快照的 `ancestry` WeakSet 且不得是自身。本地子代理 → `agent.cancel({kind}, {keepInbox:true})`（只中止当前 turn，保留 inbox，`:222`）；外部执行 → `controller.abort()` + `dispose()`（`:224-226`）。远端入口的 payload 校验在 `packages/subagent/subagent/src/control.ts:22-27`。

### Q2 审批策略的枚举与生效点；never 时被拒动作走哪条路径、如何呈现

**枚举与默认值**（问题问的「总是询问 / 从不询问」就落在 `@deepseek-ai/dsh-user-approval`）：

- `export type ApprovalPolicy = 'ask' | 'never'`——`packages/interaction/user-approval/src/index.ts:68`；`APPROVAL_POLICIES` 在 `:71`。
- 部署默认值：`static Config = z.object({ policy: z.union(['ask','never']).default('ask') })`——`:170-172`；`effectivePolicy = overrideOf(session) ?? config.policy ?? 'ask'`——`:270-272`；override 来自会话日志最后一个 `approval/policy` 事件（projection，`:89-109`）。
- 预设表（用户可见的「权限档位」）默认：`workspace-write → {sandbox:'workspace-write', approval:'ask'}`、`danger-full-access → {sandbox:'danger-full-access', approval:'never'}`——`packages/interaction/permission-presets/src/index.ts:182-191`；切档写 `setApprovalPolicy`（`:443`、`:455`），并给模型发一条切换通知（`user-approval/src/index.ts:211-222`）。

**生效点**：`ApprovalService.decide()`——`user-approval/src/index.ts:293-333`。`'never'` 在**任何 listener/answerer 被调用之前**直接返回 `'rejected'`：

```ts
// user-approval/src/index.ts:296-301
// The 'never' policy is decided HERE, before any dispatch: a listener
// registered with `prepend: true` ... only the service's own request path can.
if (this.effectivePolicy(session) === 'never') return 'rejected'
```

`request()` 先 append `approval/asked`，再 `decide()`，再 append `approval/decided`（`:242-261`），并要求 turn 已打开（`:244-250`，否则抛错）。

**被拒动作的路径**（工具侧）：

1. `tools/pre-execute` waterfall 返回 `{kind:'ask'}` → `pipeline.serviceAsk`——`packages/core/tools/src/pipeline.ts:203-205`、`432-473`。
2. 无 `approval` 服务或无 agent：直接 `deny`，**不经过**审批 seam（`:436-447`）。
3. 有服务：`approval.request(...)` → `'rejected'` → `decision = {kind:'deny', reason: 'the user rejected tool "X"'}`（`:459-462`）。
4. `prepare()` 把 deny 变成最终结果：`content: [{type:'text', text:'Error: ' + denialReason}]`、`isError: true`、`error:{message, info}`（`:213-224`）——模型看到的就是 `Error: the user rejected tool "bash"`。

**沙箱升级（`sandbox_permissions`）另一条路径**：`approveEscalation`——`packages/sandbox/sandbox/src/escalation.ts:172-206`。严格执行「只允许严格更宽的一档」（`WIDER_MODES`，`:29-32`，检查在 `:178-180`），`rejected` 时抛 `the user rejected escalating this <subject> to "<mode>"; it stays denied, so stop and explain instead of working around it`（`:201`）；工具层把它转成 `isError`（`pipeline.ts:280-281` → `toolErrorResult`）。子代理场景下这条路径**永远拒绝**（因为 approval 被钉成 `never`）。

**呈现给模型 vs 呈现给用户**：
- 模型：一句「the user rejected ...」，以及 runtime-context 里的 `NEVER_SENTENCE`（「Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation」，`:74`）。
- 用户（交互式）：`approval/asked` 事件 → 客户端审批卡（`packages/client/ui-approval/src/client/ApprovalPanel.tsx:18`，`onReject: () => approval.answer('rejected')`）。
- 用户（`never` 档）：**没有任何弹窗**（`decide` 在 dispatch 前返回），但日志里仍然留下 `approval/asked` + `approval/decided{outcome:'rejected'}` 审计对——用户在会话日志/审计里能看到「问过并拒绝」，而实际上没人被问。
- 关键矛盾（可验证的文案不一致）：策略是「从不询问」时，模型收到的却是「**the user** rejected」（`pipeline.ts:460`），无法区分「人拒绝」与「策略不问」；同时沙箱参数描述仍写着「retry 会向用户请求批准」（`escalation.ts:96-98`），与该 session 的 `NEVER_SENTENCE` 直接相反。

### Q3 子代理失败后父会话能拿到什么（是否能只得到「failed、无 closing message、无结构化原因」）

**能，且这就是默认 in-process provider 的常态路径。** 具体代码位置：

1. 失败原因只写进**子**会话日志：`packages/core/agent-loop/src/agent.ts:405-415`
   ```ts
   turnEnds = { kind: 'error', error: { message: errorChain(error), code: ... } }
   this.session.append('turn/end', { turn, reason: turnEnds! })
   ```
2. 本地子代理的结果捕获**不**读取、也**不**携带任何文字原因：`packages/subagent/subagent/src/activation.ts:156-168`
   ```ts
   const output = finalAssistantOutput(events) ?? []
   const stopReason = activation.failureAt === undefined ? epochStopReason(events) : 'error'
   ...
   return { output, stopReason }          // 无 diagnostic 字段
   ```
3. `SubagentResult.diagnostic` 的唯一生产者是**进程外 provider**（`subagent/src/out-of-process.ts:160-172` 的 `collectDiagnostic`，以及 acp/codex/claude-code/dsh-sdk 各自的 `collectDiagnostic`）。`packages/subagent/subagent-spawn-in-process`（默认 `provider: 'spawn'`，`packages/agentops/dag/src/dsh.ts:64-65`）走 `prepareContinuable` 本地路径，**从不设置 diagnostic**。
4. 通知文本因此只有摘要：`continuation-messages.ts:106-129`（`error → "Background subagent <id> failed before it finished."`）+ `:158-160`（`"It left no closing message."`）；`diagnostic` 只在存在时追加一行（`:163-164`）。
5. 投递：`manager.ts:1206-1218`。

所以父会话模型实际看到的是：

```
Background subagent 3f2a… failed before it finished.
It left no closing message.
```

——没有 message、没有 code、没有失败的 turn 序号。原因可恢复的唯一入口是子会话自己的 `turn/end` 事件（需要父方主动去读该 session，例如 `sessionQuery` / 会话回放面板），父会话的模型没有任何自动通道。

**附带发现（可能是缺陷）**：`manager.ts:1196-1199`

```ts
const terminal: SubagentResult = failure === undefined ? result : { output: [], stopReason: 'error' }
this.notifySettlement(activation, result)   // ← 父会话拿到的是原始 result
this.releaseOwnership(childId)
activation.observer.settle(terminal)        // ← subagent/end 拿到的是降级后的 terminal
```

拆除失败时，`subagent/end` 报 `error`，而父会话的通知可能仍是 `completed`（「finished」）。二者不一致；是否有意为之未在注释中说明（**未验证**）。

### Q4 workflow 的 DAG 节点路由与权限继承；失败时兄弟/下游如何处置

**先纠正取证范围**：`packages/workflow/`（`workflow` / `tool-workflow` / `workflow-ptc`）不是 DAG，而是「模型写一段 JS 脚本 + `agent()/parallel()/pipeline()` 扇出子代理」的引擎（`packages/workflow/workflow/README.md:10-12`；致命错误在 `parallel()`/`pipeline()` 处重抛，`packages/workflow/workflow/src/index.ts:124-128`）。**DAG 节点定义、端口路由、DAG 工具全部在 `packages/agentops/dag/`**。

**DAG 的两套边，只允许一套参与调度**（`packages/agentops/contracts/src/schema.ts:1107-1135`）：
- `scheduleDependencies(node) = node.after`——**唯一**调度依据；
- `dataEdges(nodes)`——`outputs: {port: target|target[]}`，**只画数据流、绝不延迟执行**（注释明确这是对旧引擎「`outputs` 声明依赖却并行执行」缺陷的修正，`schema.ts:9-11`）。
- 执行层：`topologicalLevels(deps)`（`packages/agentops/dag/src/validate.ts:125-141`），`effectiveDependencies` 额外把 `parallel_branch.branches` 加为该聚合节点的依赖（`:110-116`）。

**节点内路由**：
- `gateway`：求值 `condition`，字符串必须等于已声明端口名，否则抛「条件返回了未声明的端口」；布尔/其他值取 `ports[0]`/`ports[1]`（`engine.ts:229-245`），选中端口记入 `NodeState.chosenPort`（`:181`）。
- 端口路由的落地点：`blockedByGatewayPort`（`engine.ts:300-314`）——未选中端口的目标节点即使调度依赖（gateway 本身）已完成也会被置 `skipped`。
- `{{...}}` 只出现在**条件表达式**里，不是 prompt 插值：`expr.ts:48-57` 把 `{{body}}` 递归 tokenize 成表达式（`{{not report.critical_summary}}`、`{{step1_fetch.fetched.count}} == 0` 等，见 `dag/tests/workflow-yaml.test.ts:27,46`）。DSH 侧节点 prompt 由 `nodePrompt` 生成，只嵌入 `inputs` + `upstream` JSON（`dag/src/dsh.ts:127-145`，上限 `maxUpstreamChars` 默认 8000）。
- 旧模板变量 `{{node_id}}` **不做插值**：`packages/agentops/host/src/persona-static.ts:1-12,41-47` 以 `interpolate: false` 注册到保留 section `deployment:persona-prefix`，注释解释原因——DSH 的 strict 插值对 agent 级未知变量会抛 `unknown prompt variable`，导致整轮渲染失败。

**节点权限继承**（这是设计中明确的反泄漏点，`dag/src/dsh.ts:222-243`）：

```ts
const agentPreset = ownerAgentPreset ?? node.agentRef
if (agentPreset === undefined)
  throw new Error(`节点 ${node.id} 既没有所属 Agent preset，也没有 agentRef：拒绝按调用方权限继承执行`)
const activation = await subagents.startActivation({
  provider: config.provider ?? 'spawn',
  request: { prompt, parent, agentPreset, ...agentOptions, ...outputSchema },
  signal, delivery: 'caller',
})
```

- preset 是**强制**的：绝不回退到调用方的 standing composition（注释 `:222-226` 称这正是要关闭的 permission leak）。
- sandbox / approval 不由 DAG 传参，而由 subagent manager 在派生边界盖章：`approval` 恒 `never`、`sandbox/mode` 只继承父会话的**显式 override**（`child-agent.ts:248-255`、`266-279`）。
- 递归闸门：`delegationDepthOf(exec.agent) > 1` 时 `dag_run` 直接拒绝（`dsh.ts:697-699`）——dispatcher → workflow agent（depth 1）→ 节点（depth 2），节点不得再入。
- 节点级超时：`node.timeoutMs`（YAML `timeout_ms` / `timeout_seconds`，`load.ts:275-280`）→ `combineSignals(context.signal, node.timeoutMs)` 用 `AbortSignal.timeout`（`dsh.ts:283-287`），abort 触发 activation 拆除，结果 `stopReason !== 'completed'` → 节点抛错（`dsh.ts:245-248`）。
- `command` 节点在 DSH 内**不可执行**：`node.type === 'command'` 直接抛「尚未在 DSH 中执行」（`dsh.ts:210-212`）。

**节点失败后的处置**：
- 该节点：`settle(status:'failed', error: message)`（`engine.ts:183-189`），`attempts += 1`。
- 同层兄弟：**不取消、继续跑完**（`runLevel` 只是并发游标，无 fail-fast，`engine.ts:328-345`）。
- 下游：下一层开头 `blockedByUpstream` 检查**直接依赖**是否为 `failed|skipped`，是则置 `skipped`（`engine.ts:159-163`、`288-293`）。注意只沿 `after` 边传播：仅用 `outputs` 声明数据依赖的下游不会被 skip，且会读到空 upstream（`upstreamOf` 返回 `{}`，`:276-286`）——这是配置错误而非机制保护。
- 整轮：任一节点 `failed` → `run.status='failed'`（`:195-197`），模型侧 `dag_run` 返回每个节点的 `status/attempts/error/chosenPort` 与终端节点 outputs（`dsh.ts:744-761`）。
- 取消：`cancel()` 只把 `pending|ready` 置 `skipped`，其余保持（`engine.ts:347-354`）。
- 重跑：`invalidateRunForNode` 把目标与传递下游重置为 `pending`（保留 attempts），run 置 `running`（`engine.ts:49-99`）；`run_running`/`workflow_mismatch`/`unknown_node` 三种拒绝码（`:20-32`）。resume 时 `completed` 之外（failed/skipped/中断）全部重跑（`:143-151`）。

### Q5 生成式 UI（看板卡片）的呈现链路与状态同步/幂等风险

**链路（无事件、无推送）**：

`present_content` 工具（注册：`packages/agentops/host/src/tools.ts:58-62`；定义：`host/src/surfaces.ts:499-581`）→ `validateSurfaceEnvelope`（`:234-281`，校验 version/catalogId/components/id/component 名、禁止 `props` 包裹、JSON Schema、总字节）→ `SurfaceStore.put`（`:326-346`）→ SQLite 表 `surfaces`（`:289-299`）→ HTTP `GET /api/agentops/surfaces/views`（`:471-476`）→ 客户端 `A2uiPanel`：**仅挂载时 `load()` 一次 + 手动刷新按钮**（`packages/agentops/client/src/client/a2ui-panel.tsx:89-121,118-121,140-147`）。

关键中间环节缺失：工具 `execute` 只返回 `{stored, id, components, reason?}`（`surfaces.ts:545-579`），**不 append 任何 session event**；面板不订阅事件、不轮询（对比：协作面板有 `collaboration-polling.ts` 的可见性感知轮询，看板没有）。因此「工具返回 → 事件 → 卡片渲染」这条链上**没有事件这一环**，只有一次性的 HTTP 读。

**幂等性/同步风险**：
1. **同 viewId 覆盖且跨会话共享**：`put()` 的主键语义是 `view_id`，`session_id` 只存不用：
   ```ts
   // surfaces.ts:331-334
   const viewId = options.viewId?.trim() || 'main'
   this.#db.prepare('DELETE FROM surfaces WHERE view_id = ?').run(viewId)
   ```
   默认 `viewId = 'main'`，所以任意两个会话/Agent 只要都不指定 viewId，就会互相顶掉同一张卡（工具描述还鼓励「reuse the same viewId to update a card in place」，`:503-504,522`）。
2. **非事务 DELETE+INSERT**：`:334-345` 两条语句之间没有事务；中途失败/进程被杀 → 旧卡已删、新卡未写，看板丢卡。
3. **每次构建 store 都跑一次破坏性「迁移」**：`SurfaceStore` 构造函数执行
   ```sql
   -- surfaces.ts:310-312
   DELETE FROM surfaces WHERE id NOT IN (SELECT MAX(id) FROM surfaces GROUP BY view_id)
   ```
   而 `host/src/tools.ts:58-62` 在**每个 Agent preset scope** 各 `new SurfaceStore(path)`（注释：「registry is Agent-scoped, so this half cannot live at the root」，`:1-6`），且**没有注册 `ctx.effect` 关闭句柄**（对比根 store 在 `host/src/dsh.ts:171-173` 注册了 `store.close()`）。结果：每次创建 Agent 都对同一 DB 文件执行一次写删除、并多留一个未关闭的 `DatabaseSync` 连接。
4. **`board_cleanup` 无作用域**：`viewId` 删除按 view_id（`:622`），`all:true` 走 `clear()` 清全表（`:385-388`）；`confirm:true` 只是防手滑（`:617`）。任何能拿到该工具的 Agent/会话都能清掉**所有**会话的卡片。
5. **可见上限 500**：`views()` = `list(500).reverse()`（`:352-354`），HTTP 层 limit 上限 100（`:443`）；卡片总数（= 不同 viewId 数）超过 500 后旧的静默不可见，工具侧没有任何告警。
6. **无版本/幂等键**：每次 `put` 生成新自增 `id`，工具返回值里只有这个 id，模型无法据此判断「我这次是新建还是覆盖」，也无法乐观并发控制——两个并发发布同一 viewId 时后者静默胜出。

---

## ③ 机制风险表

| 机制 | 风险 | 触发条件 | 后果 | 建议 |
|---|---|---|---|---|
| 子代理容量池（per-root，默认 8，`activation.ts:24-35`、`manager.ts:743`） | 无墙钟超时，槽只在 `finishDisposal` 释放 | 子代理卡在一个长 turn / provider 不响应 | 该父链后续所有委派报 `ACTIVATION_LIMIT_REACHED`，父会话无法自愈 | 暴露 per-run 截止时间（`startActivation` 增加 `deadline`）或在 manager 侧对超时驻留 activation 强制 `dispose` |
| 派发权限盖章（`child-agent.ts:248-255`） | 子代理 approval 恒 `never`，不可配置 | 任何需要审批的工具调用（写盘升级、插件安装等） | 子代理内的合法提权需求被**确定性**拒绝，模型只能转述「无法继续」 | 允许 preset 声明子代理 approval（如 `inherit`/`never`），或至少让拒绝原因区分「策略不问」 |
| 拒绝文案（`pipeline.ts:460`、`escalation.ts:201`、`user-approval/src/index.ts:74`） | 「never」被表述成「the user rejected」，且沙箱参数描述仍承诺「会问用户」 | 任一 `never` 会话触发 ask | 模型误判有人类在场、反复重试或改写命令绕过；用户侧无任何提示 | 按 `effectivePolicy` 生成不同 deny 文案（`policy 'never' → rejected by policy`），并按策略裁剪 `sandbox_permissions` 描述 |
| 失败原因传播（`activation.ts:156-168`、`continuation-messages.ts:158-164`） | 本地子代理从不设置 `diagnostic`；`turn/end.error` 只在子会话日志 | 子代理模型/工具报错且无收尾输出 | 父会话只得到「failed + It left no closing message.」，需要人工/额外读取子会话才能定位 | `captureLocalResult` 从 epoch 末 `turn/end.reason.error` 提取 `message/code` 填入 `diagnostic`（复用 4096 字节上限） |
| 结算信息双通道（`manager.ts:1196-1199`） | 拆除失败时 `notifySettlement` 用 `result`，`observer.settle` 用降级 `terminal` | teardown/dispose 抛错但子代理本轮其实已完成 | 父会话被告知「finished」，`subagent/end` 却是 `error`；指标与叙事不一致 | 二选一，统一用 `terminal`（并把失败原因写入 notice） |
| DAG 下游 skip（`engine.ts:159-163`、`288-293`） | 只沿 `after` 边传播，`outputs` 数据边不参与 | workflow 只写 `outputs` 不写 `after` | 失败节点的数据下游照常执行并读空 upstream，产出静默错误结果 | 在 `validateWorkflow` 对「data edge 无对应 schedule edge」给出告警级 issue |
| DAG 命令节点（`dsh.ts:210-212`） | `command` 类型在 DSH 内一律抛错 | 迁移带 `command` 节点的旧 workflow | 校验通过但运行必败，失败点在执行期而非校验期 | `validateWorkflow` 对 DSH 运行期拒绝已不支持的节点类型直接报错 |
| 看板卡片键（`surfaces.ts:326-346`） | `view_id` 全局唯一、不按 session 隔离，默认 `main` | 两个会话/Agent 都省略 viewId | 互相覆盖，看板出现「别人的卡消失/内容错乱」 | 唯一键改为 `(session_id, view_id)`，或强制 `sessionId` 并以其为默认命名空间 |
| 看板写入原子性（`surfaces.ts:334-345`） | `DELETE` + `INSERT` 非事务 | 写入中途异常/进程退出 | 卡片被删且新卡未落库，看板丢卡 | 用 `BEGIN IMMEDIATE … COMMIT`，或 `INSERT … ON CONFLICT(view_id) DO UPDATE` |
| store 生命周期（`host/src/tools.ts:54-62`、`surfaces.ts:310-312`） | 每个 Agent scope 新建 `SurfaceStore`、跑破坏性 collapse DELETE、且未注册关闭 | 反复创建/销毁 Agent（长驻宿主） | 同一 DB 多连接 + 每次挂载一次写删除；SQLITE_BUSY / 句柄泄漏（并发争用未验证） | 抽成 single-owner 服务（根 scope 持有），用 `ctx.effect` 关闭；迁移只在 schema 变更时执行一次 |
| 看板读取时机（`a2ui-panel.tsx:89-121`） | 无事件、无轮询，只在挂载 + 手动刷新时读 | 会话进行中 Agent 发布/更新卡片 | 用户看到过期看板，误以为 Agent 没发布 | 复用 `collaboration-polling.ts` 的可见性感知轮询，或订阅会话事件做增量刷新 |
| `board_cleanup`（`surfaces.ts:590-625`） | 无 session 作用域、`all:true` 清全表 | 任一 Agent 误用/被提示注入诱导 | 跨会话看板数据全部丢失（不可恢复，无软删） | `all` 限定为调用方会话；或引入软删 + 撤销窗口 |

---

## ④ 摘要（≤150 字）

派发是「manager 内存驻留 + start/end 事件对」，限额 8 且无超时，卡死即耗尽槽位。approval 只有 ask/never，子代理被钉死 never，拒绝却被写成「the user rejected」，与「从不再问」的提示自相矛盾。失败原因只留在子会话日志，父会话常只收到「failed / It left no closing message.」，拆除失败还会把 error 报成 finished。DAG 以 `after` 调度、gateway 端口路由、节点强制继承 preset 且恒 never；兄弟不取消、下游 skip。看板工具直写 SQLite，无事件无推送，`view_id` 跨会话混用，删插非事务。
