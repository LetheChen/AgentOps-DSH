# AgentOps 体系 · 架构视角分析（分层 / 边界 / 能力接缝 / 编排信息流）

- 仓库：`<dsh-repo>`（pnpm workspace，Cordis 全插件化）
- 取证方式：只读（ls / rg / 读源码与包 README），未运行 build / test / install
- 分析范围：`packages/agentops/**`、`agentops/**`（仓库根，治理与资产面）、`packages/core/*`、`packages/subagent/*`、`packages/preset/*`、`packages/workflow/*`，以及 `guard / goal / todo / plan / schedule` 中与编排相关者
- 记号：`路径:行号` 为仓库相对路径；无行号表示整文件

---

## ① 核心结论（3 行内）

1. 真实编排链是 **Manager（`manager` preset 的会话）→ `subagent` 工具 → `ctx.subagents.startActivation()`（spawn provider，独立子会话 + 独立 preset）→ 业务 Agent 在自己的轮次里调 `dag_run` → `@agentops/dsh-dag` 的 `DagEngine` 为每个节点再派生一个子代理**；四段职责分别落在 `packages/preset`、`packages/subagent`、`packages/agentops/dag` 三处，没有单独的"编排服务"。
2. 能力接缝三角色在编排链上**结构完整但强制点错位**：`agent_preset` 白名单只在 Consumer（工具层）强制，Service（`ctx.subagents`）与 DAG 执行器都无白名单概念；`ctx.workflowEngine` 这条已有的 workflow seam **被 `@agentops/dsh-dag` 自建引擎旁路**，而把它"接回去"的编译器（`@agentops/dsh-workflow-compiler`）自述尚未接入 `workflow-ptc`。
3. 信息流是"**父会话只留事实、内容各归各的日志**"：父会话记录 `subagent/catalog` + 结算 notice；子会话记录 `subagent/descriptor` + `agent-preset/selected` + 自己的完整轮次；DAG 运行另有 SQLite run store。**节点 → 子会话 id 的边不在 run store 里**，只能回到业务 Agent 的 `subagent/catalog` 反查。

---

## ② 分层与模块清单

### 2.1 编排链路（自上而下）

| 层 | 模块 | 路径 | 职责 | 在编排中的位置 |
|---|---|---|---|---|
| L0 会话/循环 | `@deepseek-ai/dsh-agent` | `packages/core/agent/src/index.ts`、`runtime-types.ts` | `Agent` 句柄、`ctx.agents` 活体注册表、`agent/*` 事件、initiator 作用域 | 所有 Agent 的生命周期底座；编排者与被编排者都只是这里的 Agent |
| L0 | `@deepseek-ai/dsh-agent-loop` | `packages/core/agent-loop/src/agent.ts`、`inbox.ts` | 默认 driver：创建/驱动 Agent、durable inbox 投影 | 决定"派发消息如何在目标 Agent 的下一个 step 被 claim" |
| L1 组合 | `@deepseek-ai/dsh-agent-preset-registry` | `packages/preset/agent-preset-registry/src/index.ts`、`mount.ts` | `ctx.agentPresets`：注册/激活 preset 定义、revision 保留、Agent 绑定（`bindScopeParent`） | **"谁是 Manager / 谁是业务 Agent"的唯一实现点** |
| L1 | `@deepseek-ai/dsh-agent-preset` | `packages/preset/agent-preset/src/index.ts` | 一条 `plugins:` 条目列表 = 一个 preset 定义 | 业务 Agent 的"能力集合"声明单位 |
| L1 | `@deepseek-ai/dsh-persona` / `@agentops/dsh-host/persona-static` | `packages/preset/persona/src/index.ts`、`packages/agentops/host/src/persona-static.ts` | 往 `deployment:persona-prefix` section 写人设 | 业务 Agent 的 system prompt 来源（AgentOps 用的是后者） |
| L2 派生 | `@deepseek-ai/dsh-subagent` | `packages/subagent/subagent/src/index.ts`、`manager.ts`、`child-agent.ts` | `ctx.subagents`：provider 注册表、`startActivation()`、`sendMessage()`、`interrupt()`、容量/深度/归属判定 | **Manager→业务 Agent 与 DAG→节点子代理的共同执行面** |
| L2 provider | `subagent-spawn-in-process` / `-fork-in-process` / `-acp` / `-dsh-sdk` / `-codex` / `-claude-code` | `packages/subagent/subagent-*/src` | 同一接口下的子代理后端（新鲜上下文 / 继承已完成轮次 / 外进程） | AgentOps 部署只用 `spawn`（见下） |
| L2 consumer | `@deepseek-ai/dsh-tool-subagent` | `packages/subagent/tool-subagent/src/index.ts`、`preset-selection.ts` | 模型面 `subagent` 工具：schema、`agent_preset` allowlist、`maxDepth` | Manager 的"派发"入口 |
| L2 consumer | `@deepseek-ai/dsh-tool-subagent-control` | `packages/subagent/tool-subagent-control/src/index.ts`、`list-agents.ts` | `send_message` / `interrupt_agent` / `list_agents` | Manager 的中断与续聊入口 |
| L3 DAG | `@agentops/dsh-dag` | `packages/agentops/dag/src/engine.ts`、`dsh.ts`、`tools.ts`、`run-store.ts` | 分层调度、端口/数据边、节点子代理执行器、`dag_*` 工具、运行历史 | **业务 Agent 的"执行方式"之一（另一是 skill 手册）** |
| L3 定义 | `@agentops/dsh-contracts` | `packages/agentops/contracts/src/schema.ts`、`types.ts` | Agent / workflow YAML 解析、边规则、序列化 | 编译与运行共用的唯一判定源 |
| L3 目录 | `@agentops/dsh-workflow-catalog` | `packages/agentops/workflow-catalog/src/index.ts` | `ctx.workflowCatalog`：列/读/校验/编译/CAS 保存 YAML | 工作流定义面唯一写入者 |
| L3 编译 | `@agentops/dsh-workflow-compiler` | `packages/agentops/workflow-compiler/src/compile.ts` | YAML → `workflow-ptc` JS 脚本（`phase()` / `parallel()`） | **尚未接到执行侧**（见问题 A2） |
| 旁路 | `@deepseek-ai/dsh-workflow` + `workflow-ptc` + `tool-workflow` | `packages/workflow/workflow/src/index.ts`、`packages/workflow/tool-workflow/src/index.ts`、`workflow-ptc/src` | `ctx.workflowEngine` seam：模型写 JS 脚本，`agent()/parallel()/pipeline()` 扇出子代理 | **与 DAG 并列的第二套工作流栈，AgentOps 的 DAG 不使用它** |
| 周边 | `guard/*`、`goal/*`、`plan/plan-mode`、`todo/tool-todo`、`schedule/schedule` | 见 2.3 | 循环卫生、单会话目标、计划、待办、定时唤醒 | 与编排正交；均在 `dsh-base`/`dsh-web-app` 宿主面挂载 |

### 2.2 AgentOps 包自身的分层（本仓库 AgentOps 本体）

| 子包 | 路径 | 职责边界 | 依赖方向 | 与 core / subagent / preset 的交互 |
|---|---|---|---|---|
| `@agentops/dsh-contracts` | `packages/agentops/contracts/src/{schema,types,catalog,ownership}.ts` | 纯库：Agent 与 workflow YAML 的解析/校验/序列化、`scheduleDependencies()`（只取 `node.after`）、`dataEdges()`（只取 `node.outputs`）、`topoLayers()` | 只依赖 `js-yaml`；**不依赖任何 DSH 包** | 不接触 core/subagent/preset；是 host / dag / compiler / catalog / workspace-layout / client 的共同上游 |
| `@agentops/dsh-host` | `packages/agentops/host/src/*` | 宿主面注册：`/api/agentops/{agents,sessions,session-log,domains,actors,models,schedules,archive,surfaces,tools}` 路由、`TOOL_NAMES = ['agentops_system_status','present_content','board_cleanup']`、`persona-static`、`tool-policy`、A2UI schema 拷贝 | → `contracts`、`@deepseek-ai/dsh-tools`、`dsh-system-prompt`、`dsh-llm`、`dsh-home-paths`；**不依赖 client，也不依赖 preset** | 只做 Consumer：`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.tools.guard`、`connection` 路由 |
| `@agentops/dsh-client` | `packages/agentops/client/src/{index.ts,client/*}` | Web GUI 面板：Agent 目录/编辑器、工作流 DAG 编辑、运行历史、任务面板、协作视图、A2UI 渲染 | → `contracts`、`@deepseek-ai/dsh-client-*`（ui-layout / primitives / renderer / sidebar / slots / store / locale）；**不依赖 host**（跨进程靠 HTTP，见 `panel.tsx` 的 `fetch('/api/agentops/tasks')`） | 不直接触碰 core/subagent/preset；只消费 host/dag/task 暴露的 HTTP 面 |
| `@agentops/dsh-dag` | `packages/agentops/dag/src/*` | DAG 引擎（`DagEngine`）、节点执行器（`createSubagentExecutor`）、`dag_catalog/dag_validate/dag_run/dag_rerun/list_runs`、运行历史（SQLite）、编辑器与运行路由 | → `contracts`、`workflow-catalog`、`@deepseek-ai/dsh-subagent`、`dsh-agent`、`dsh-tools`、`dsh-session`、`dsh-client-connection`、`dsh-api-session-controller`；**不依赖 `@deepseek-ai/dsh-workflow`** | 通过 `ctx.get('subagents').startActivation()` 派生节点子代理（`packages/agentops/dag/src/dsh.ts:231`），通过 `agentPreset` 钉住节点组合；通过 `ctx.agents` 的 `exec.agent` 取父 Agent |
| `@agentops/dsh-task` | `packages/agentops/task/src/{store,dsh,tools,status}.ts` | 十四态任务生命周期 + 事件历史（SQLite），5 条路由（`/api/agentops/{tasks,task-report,task-advance}` 等）+ 5 个模型工具（`TOOL_NAMES`） | → `dsh-tools`、`dsh-client-connection` | 只作为工具/路由 Consumer；preset 通过 `config.only` 只放行 `task_stage_add`（`packages/agentops/bundle/presets/agents.generated.patch.yml` 的 coding_agent 行） |
| 其他 | `knowledge/`、`db/`、`security/`、`vault/`、`workflow-catalog/`、`workflow-compiler/`、`workspace-layout/`、`bundle/`、`deploy/` | 知识库、数据源、安全审计、密钥、定义目录、编译、工作区路径、分发 patch、容器部署 | 见各自 `package.json` | `workspace-layout` 是唯一依赖 `dsh-sandbox` 的 AgentOps 包（`packages/agentops/workspace-layout/package.json`） |

**依赖方向结论**：`contracts ← (host, dag, client, workflow-compiler, workflow-catalog, workspace-layout)` 单向；`host ⇄ client` 无包级依赖，只经 HTTP；`dag → subagent(preset via 服务查找)` 是编排链上唯一一处 AgentOps 包指向 DSH 派生层的地方；`@agentops/dsh-bundle` 通过 `package.json` 的 `dsh.bundle.patch` 按 `cordis.patch.yml → presets/agentops-tools.patch.yml → presets/agents.generated.patch.yml` 三层装配（`packages/agentops/bundle/package.json:17-26`）。

### 2.3 与编排相关但不在关键路径上的包

| 模块 | 路径 | 与编排的关系 |
|---|---|---|
| `guard/repeat-tool-reminder`、`guard/timeout-policy` | `packages/guard/*` | `dsh-base` 宿主面挂载（`packages/bundle/base/cordis.patch.yml:404,444`）；对子代理同样生效，但不在编排 API 上 |
| `goal/goal` + `goal-round-driver` | `packages/goal/*` | `ctx.goals` 单会话持久目标；`goal-round-driver` 把 active goal 变成顺序 Round —— 是"同一会话内的自动续跑"，与"跨代理派发"不同轴；AgentOps bundle 未挂载 |
| `plan/plan-mode` | `packages/plan/plan-mode` | `/plan` 与 `exit_plan_mode`；AgentOps bundle 未挂载 |
| `todo/tool-todo` | `packages/todo/tool-todo` | `todo_write`；AgentOps 生成器里只作为可映射工具（`agentops/scripts/gen-agent-presets.ts:42`），当前无 agent 使用 |
| `schedule/schedule` | `packages/schedule/schedule` | 定时提醒 → 以 follow-up 消息回到原 Session；AgentOps 定时触发走的是自己的 `schedulesFile`（`packages/agentops/host/src/schedules.ts`），**不是** `dsh-schedule` |

---

## ③ 五个问题逐条回答

### Q1. Manager → 业务 Agent（preset）→ subagent → workflow 节点，职责边界落在哪个包 / 哪个 service？

**真实分层调用关系**（全部在代码里可追）：

```
[用户]
  └─ Session(preset = "manager")                       ← packages/preset/agent-preset-registry/src/index.ts:297 mount()
       │  工具面由 preset 行决定：
       │    @deepseek-ai/dsh-tool-subagent (provider=spawn, allowedAgentPresets=[19 个], maxDepth=1)
       │    @deepseek-ai/dsh-tool-subagent-control
       │  packages/agentops/bundle/presets/agents.generated.patch.yml:138-146
       ↓  模型调用 subagent(prompt, agent_preset)
  SubagentPresetSelection.resolve()                    ← packages/subagent/tool-subagent/src/preset-selection.ts:89-97
       ↓  subagents.startActivation({request:{parent, prompt, agentPreset, maxDepth}, delivery:'parent'})
       │  packages/subagent/tool-subagent/src/index.ts:315-331
  SubagentManager.startActivation()                    ← packages/subagent/subagent/src/manager.ts:384-450
       ├─ resolveChildDepth(parent, maxDepth)          ← child-agent.ts:49-58
       ├─ childSessionMeta(...)  → header.agentPreset / parentSession / delegationDepth / origin='subagent'
       │                                                ← child-agent.ts:135-154
       ├─ applyChildComposition()                      ← child-agent.ts:186-202
       │    ├─ composition.agentPreset ≠ undefined → agentPresets.mount(childCtx, id)   （独立组合）
       │    └─ undefined                          → agentPresets.composeFrom(childCtx, parent.ctx)（继承父的同一 revision）
       └─ ctx.agents.create({...})  → 子会话（独立 Session 日志）
       ↓  子代理完成 → continuation-messages 生成结算 notice → 回到父会话（下一轮模型输入）
  业务 Agent Session(preset = 例如 "log_analyst")       ← 由 subagent/descriptor + agent-preset/selected 决定
       │  preset 行里挂 @agentops/dsh-dag/tools，且钉死 {ownedWorkflowId, ownerAgentPreset, only:['dag_run','list_runs']}
       │  packages/agentops/scripts/gen-agent-presets.ts:197-213
       ↓  模型调用 dag_run(workflowId 被忽略)
  @agentops/dsh-dag 工具层                             ← packages/agentops/dag/src/dsh.ts:681-703
       ↓
  DagEngine.run()  分层调度                            ← packages/agentops/dag/src/engine.ts:113-200
       ↓  每个可运行节点
  createSubagentExecutor()                             ← packages/agentops/dag/src/dsh.ts:202-263
       │  agentPreset = ownerAgentPreset ?? node.agentRef（否则 fail-loud）
       │  subagents.startActivation({provider:'spawn', delivery:'caller', request:{prompt, parent, agentPreset, agentOptions, outputSchema}})
       ↓
  节点子代理 Session（= 业务 Agent preset 的又一份实例）
```

**职责边界（代码落点）**：

| 职责 | 落在哪个 service / 包 | 证据 |
|---|---|---|
| "谁是 Manager、谁能被派发"（组合） | `ctx.agentPresets`（`AgentPresetRegistry`） | `packages/preset/agent-preset-registry/src/index.ts:297-306`、`:313-327` |
| "派发一次子代理"（生命周期、容量、归属） | `ctx.subagents`（`SubagentRuntime` / `SubagentManager`） | `packages/subagent/subagent/src/index.ts:276`、`manager.ts:183-228,543-574` |
| "模型如何表达一次派发"（schema/白名单/深度） | `@deepseek-ai/dsh-tool-subagent`（Consumer） | `packages/subagent/tool-subagent/src/preset-selection.ts`、`src/index.ts:315-331` |
| "中断与续聊" | `ctx.subagents.interrupt()` / `sendMessage()` + `tool-subagent-control` 薄适配 | `packages/subagent/subagent/src/manager.ts:183,543`；`packages/subagent/tool-subagent-control/README.md:47-51` |
| "业务 Agent 如何执行"（skill 手册 or 跑自己的工作流） | 该 Agent 的 preset `plugins` 列表 | `agentops/agents/manager.yaml:3-5`（执行方式由业务 Agent 的 execution 声明决定）；`gen-agent-presets.ts:190-213` |
| "工作流一次运行"（节点、端口、并发、运行历史） | `@agentops/dsh-dag` 的 `DagEngine` + `SqliteRunStore`（**不是 Cordis service**） | `packages/agentops/dag/src/engine.ts:113`、`run-store.ts:13-41` |

**关键边界事实（与委派方的核对结论一致）**：`packages/workflow/`（`workflow` / `tool-workflow` / `workflow-ptc`）**不是 DAG 引擎**，它是"模型写 JS 脚本 + `agent()/parallel()/pipeline()` 扇出子代理"的脚本引擎（`packages/workflow/workflow/README.md:12,36`；`packages/workflow/workflow/src/index.ts:43-89` 的 `workflow/*` 事件）。DAG 的节点定义、端口路由（`after` / `outputs`）与 `dag_*` 工具全部在 `packages/agentops/dag/`（`packages/agentops/contracts/src/schema.ts:444,567-590`；`packages/agentops/dag/src/tools.ts`）。`@agentops/dsh-dag` 的 `package.json` 依赖里**没有** `@deepseek-ai/dsh-workflow`，二者互不引用。

### Q2. `agent_preset` 白名单从哪加载、如何组合与继承？继承链是否清晰？

**加载（三段，全在部署配置里，不在模型输入里）**：

1. **来源**：`agentops/agents/*.yaml`（20 份）→ 生成器 `agentops/scripts/gen-agent-presets.ts`。
   - `presetId = agent.agent_id`（`gen-agent-presets.ts:266`），即"业务 Agent id 就是 preset id"。
   - 白名单是**派生**的：`const dispatcherId = 'manager'`；`delegablePresets = agents.map(a => a.agent_id).filter(id => id !== dispatcherId)`（`gen-agent-presets.ts:316-320`）——除 manager 之外全部可被派发，**不按 tier / domain / 权限过滤**。
2. **落地**：写进 `packages/agentops/bundle/presets/agents.generated.patch.yml:142` 的
   `allowedAgentPresets: ["coding_agent","log_analyst",...19 项]`，以及 manager preset 的 `maxDepth: 1`（同文件 :143）。
3. **读取与暴露**：`@deepseek-ai/dsh-tool-subagent` 的 `PresetSelectionConfig.allowedAgentPresets`（`packages/subagent/tool-subagent/src/preset-selection.ts:7-12`）：
   - 构造期校验"无重复 / `agentPreset` 必须在 allowlist 内"（`:23-32`）；
   - 挂载期 `validate(ctx)` 用 `ctx.get('agentPresets').readDocument(id)` 取每个 preset 的 `description`，拼进模型可见的参数说明（`:57-72`）——**这就是 Manager system prompt 里"从 `agent_preset` 参数描述里选业务 Agent"的实际机制**（`agentops/agents/manager.yaml:27`）；
   - 调用期 `resolve()` 只接受 `this.choices.includes(id)`，否则抛 `agent_preset must be one of: ...`（`:89-97`）。

**组合**：一个 preset = 一条 `@deepseek-ai/dsh-agent-preset` 行 + 其 `plugins:` 条目列表（`packages/preset/agent-preset/src/index.ts`）。registry 为每个声明 eager 建一个 registry 私有 scope 与内存 Loader 树，`mountPreset()` 里 `prepareProfileEntries` + `auditRows` + 泄漏检查（`packages/preset/agent-preset-registry/src/mount.ts:204-216`）；Agent 通过 `bindScopeParent` 把自己的 scope 父链挂到该 revision 上（`index.ts:281-290`）。

**继承**：**preset 定义之间没有继承/extends 机制**（全仓无 `extends`/`inherits` 字段；`agent-preset-registry/README.md:99` 明确"A user override replaces the complete child list and does not automatically merge future changes to the builtin list"）。存在的是两种**沿 Agent 作用域的继承**：

- 默认（未选 `agent_preset`）：子代理 `composeFrom(childCtx, parent.ctx)`，**加入父的那一份 revision**（共享，不复制），`index.ts:313-327`；若父的 revision 不可用则抛 `Parent preset revision is unavailable`（`:316-318`）。
- 显式选择：`presets.mount(childCtx, id)` 挂**当前可用 revision**，即使 id 与父相同也另建一次挂载（`child-agent.ts:191-198` + `subagent/README.md:65`）。

**继承链清晰度评估**：**中等偏弱**。
- 清晰的部分：`bindScopeParent` 的 scope 父链是唯一机制，`composeFrom` 明确拒绝"已经挂过 preset 的子上下文"（`index.ts:324`），并有"preset 里的 provider 若未 `isolate` 会泄漏到 root realm 并导致挂载失败"的硬校验（`mount.ts:211-213`）。
- 不清晰的部分：**冷恢复时"子代理是否独立选择过 preset"不是显式字段，而是靠事件顺序推断**——必须 `agent-preset/selected` 出现在该子会话**自己的第一条 `subagent/descriptor` 之前**，否则回退为"跟随父的当前组合"（`packages/subagent/subagent/README.md:125-131`）。而 `subagent/descriptor` v3 的字段表里**没有 `agentPreset`**（`packages/subagent/subagent/src/descriptor.ts:96-110`），preset id 只用 `header.agentPreset` + `agent-preset/selected` 两处承载（`child-agent.ts:142-145`；`packages/preset/agent-preset-registry/src/session.ts:31`）。

### Q3. 「Service Definition / Provider / Consumer」三角色在编排链路上是否完整？哪里缺失或越界？

| 接缝 | Service Definition | Provider(s) | Consumer(s) | 判定 |
|---|---|---|---|---|
| **Agent** | `ctx.agents`（`packages/core/agent/src/index.ts`） | `dsh-agent-loop` 注册的 factory | `dsh-subagent`、`@agentops/dsh-dag`、UI | ✅ 完整（driver 可换） |
| **Agent 组合（preset）** | `ctx.agentPresets`（`agent-preset-registry/src/index.ts:54`） | `@deepseek-ai/dsh-agent-preset` 声明行 | `tool-subagent`（`preset-selection.ts:58`）、`subagent`（`child-agent.ts:191-200`）、client roster | ✅ 完整 |
| **subagent 委派** | `ctx.subagents`（`packages/subagent/subagent/src/index.ts`） | spawn / fork / acp / dsh-sdk / codex / claude-code 六个 provider | `tool-subagent`、`tool-subagent-control`、`@agentops/dsh-dag`（`dsh.ts:687,810`） | ✅ 完整，**但白名单策略只在 Consumer 强制（见下）** |
| **workflow（脚本引擎）** | `ctx.workflowEngine`（`packages/workflow/workflow/src/index.ts`） | `workflow-ptc` | `tool-workflow` | ⚠️ **三角色都在，但 AgentOps 的 DAG 完全不用它**（`@agentops/dsh-dag/package.json` 无该依赖），DAG 是旁路的第二套执行栈 |
| **workflow 定义** | `ctx.workflowCatalog`（`packages/agentops/workflow-catalog/src/index.ts:58-67`） | 该包自身 | `@agentops/dsh-dag`（`dsh.ts:297,317`）、client 编辑器 | ⚠️ 定义面和执行面不是同一条链（编译产物无人执行，见 A2） |
| **persona/section** | prompt section 注册表 `ctx.systemPrompt`（`packages/core/system-prompt`） | `dsh-persona` **和** `@agentops/dsh-host/persona-static` | 两侧分别被不同 preset 使用 | ⚠️ **同一 section 两个 Provider 竞争**（见 A5） |
| **工具策略** | `ctx.tools`（含 `guard()`） | —— | `@agentops/dsh-host/tool-policy`（`tool-policy.ts:42-44`） | ✅ Consumer 用法正确，强制在 `execute` 时刻 |
| **DAG 引擎** | **无**（`DagEngine` 是普通类，无 `ctx.*` key） | —— | —— | ❌ 不是 seam：不可替换，也没登记到 `docs/capability-seams.md` 的服务表（该表只出现 `ctx.workflowCatalog`、`ctx.workspaceLayout` 等 AgentOps 服务，`docs/capability-seams.md:745-746`） |

**具体缺失 / 越界位置**：

1. **越界（策略落在错误角色）——`agent_preset` 白名单**：只在 `packages/subagent/tool-subagent/src/preset-selection.ts:89-97` 强制。`ctx.subagents` 的 `startActivation` 从不校验白名单：`packages/subagent/subagent/src/child-agent.ts:191-198` 对任意已注册 id 直接 `mount`；`@agentops/dsh-dag` 的 `ownerAgentPreset ?? node.agentRef`（`packages/agentops/dag/src/dsh.ts:227`）同样绕过。违反 `packages/AGENTS.md` 的「Enforce a decision in the operation that makes it」。
2. **缺失（Definition 缺字段）——递归预算不是 service 契约的一部分**：`maxDepth` 只存在于 `SubagentStartRequest`（`manager.ts:384` → `resolveChildDepth(parent, request.maxDepth)`），`undefined` 即无上限（`child-agent.ts:54`）。DAG 节点执行器不传（`packages/agentops/dag/src/dsh.ts:231-243`）。
3. **缺失（Provider 缺能力项）——persona 无 `interpolate` 开关**：`@agentops/dsh-host/persona-static` 的模块注释直接写明这是绕过原因（`packages/agentops/host/src/persona-static.ts:4-9`）；`packages/preset/persona/src/index.ts:63-68` 确实只有一个 `section()` 调用、无配置项。
4. **缺失（Provider 整体不在仓库）——编排链引用的业务工具**：`log_query`、`pull_logs`、`wecom_notify`、`emit_alert`、`report_surface_state`、`handoff`、`finalize`、`sql_query`、`data_analysis` 出现在 20 份 agent YAML 与 16 份 workflow YAML 的 prompt/inputs 里，但 `packages/agentops/host/src/tools.ts:23` 只注册 `agentops_system_status / present_content / board_cleanup`；`agentops/mappings/tool-map.yaml` 中这些条目要么 `mapped: null`，要么不存在。同时 prompt 反复引用的 `config/patrol.yaml` 白名单文件**在仓库内不存在**（引用点：`agentops/agents/log_analyst.yaml:17,22`、`agentops/workflows/log-patrol.yaml:31`、`agentops/workflows/log-puller.yaml:25`）。

### Q4. subagent 是"独立上下文 + 结果回传"还是共享上下文？interrupt / send_message 语义由谁定义？

**结论：默认是独立上下文 + 结果回传；共享只发生在 `fork` provider 的"一次性种子"，且 AgentOps 部署用的是 `spawn`。**

- `spawn`：全新子会话，空对话，继承父的 cwd / provider / model / reasoningEffort / 输出上限（`packages/subagent/subagent-spawn-in-process/README.md:12`）。
- `fork`：把父**已完成的轮次**作为一次性种子写入子会话（`fork-in-process/README.md:12,32-34`），之后的父轮次不再进入子会话；工具作用域与权限仍是新的。
- **结果回传**：本地子代理 `delivery: 'parent'` 时，结算后由 `continuation-messages.ts` 生成一条 user-role notice 写进父会话（`packages/subagent/subagent/src/continuation-messages.ts:29-40` 定义 `subagent-settled` source；`subagent/README.md:167`）。DAG 用 `delivery: 'caller'`（`packages/agentops/dag/src/dsh.ts:242`），因此**不产生父通知**，由 DAG 自己 `await activation.result` 收结果（`dsh.ts:245`）。
- 上下文隔离由 session 承载：子代理是**另一个 Session**（`child-agent.ts:135-154` 写 `parentSession` / `origin: 'subagent'`），父会话只留 `subagent/catalog` 事实（`packages/subagent/subagent/src/catalog.ts:44`）。

**interrupt / send_message 的语义归属**：

| 语义 | 定义处（权威） | 薄适配 |
|---|---|---|
| `sendMessage(sender, targetId, content)`：只允许"精确活体 sender → 直接可续子代理"，或"驻留可续子代理 → 其直接父"；工作中的目标走 **Steer**（最近 step 边界），空闲目标走 follow-up / 冷恢复 | `packages/subagent/subagent/src/manager.ts:543-574`（含 `UNAUTHORIZED` 判定）、`deliver()` `:615-628` | `packages/subagent/tool-subagent-control/src/index.ts` |
| `interrupt(target, authority)`：`authority.kind==='user'` 用 `parentSessionId` 校验归属；`'ancestor'` 用活体祖先 `activation.ancestry` 校验；本地目标只 `cancel({kind},{keepInbox:true})`（队列消息保留），外部执行则 `controller.abort` + `dispose` | `packages/subagent/subagent/src/manager.ts:183-228` | 同上 |
| 消息在目标侧的落地形式 | `agent.steer(message)` / `agent.followup(message)`（`manager.ts:626-627`）、durable inbox 投影（`packages/core/agent/README.md:100-104`） | —— |
| 浏览器（人工）续聊 | `packages/subagent/subagent/src/control.ts:22` 的 `subagent.interrupt` 请求校验 + `index.ts:505-536` 的 Remote face（`kind:'user'`） | client 面板 |

### Q5. 编排信息流：一次"派发任务"经过哪些事件/投影？会话日志能重建什么、不能重建什么？

**一次派发（Manager → 子代理）的完整轨迹**：

| 阶段 | 载体 | 证据 |
|---|---|---|
| 1. 模型发起工具调用 | 父会话 `tool/call`（`tool/result` 回包） | `docs/architecture.md:106` |
| 2. 工具层解析 `agent_preset` | 纯内存（`PresetSelectionRequest` → `resolve()`） | `packages/subagent/tool-subagent/src/preset-selection.ts:89` |
| 3. 服务层受理 | 内存：`Activation` 记录 + 容量槽 + `resident` 图 | `packages/subagent/subagent/src/activation.ts`、`manager.ts:384-450` |
| 4. 子会话开启 + 组合 | 子会话 header `{parentSession, agentPreset, delegationDepth, origin:'subagent'}` | `child-agent.ts:135-154` |
| 5. 子会话第一条自有事实 | durable `agent-preset/selected`（仅独立选择时）/ `subagent/descriptor`（v3，log-only，不进模型历史，跨 compaction 存留） | `packages/preset/agent-preset-registry/src/session.ts:31`；`descriptor.ts:38,48` |
| 6. 父会话记账 | durable `subagent/catalog`（v0/v1/v2；本地子代理**无论 delivery 都写**） | `catalog.ts:44`；`subagent/README.md:123` |
| 7. 实时观测 | 能力事件 `subagent/start` / `subagent/end` / `subagent/provider-added|removed`（observe-only） | `packages/subagent/subagent/src/index.ts:142-166`；`manager.ts:508` |
| 8. 结算回传 | 父会话一条 user-role 消息，source = `{kind:'subagent-settled', form:'notice', summary, senderSessionId}`；内容为子代理非空最终文本 +（可选）`Structured result: <JSON>` + 诊断 | `continuation-messages.ts:29-40`；`subagent/README.md:167` |
| 9. 投影 | `subagent`（identity: mode/label/seq）、`subagentTiming`（settledMs/active/lastTurnCompleted）、`subagentCatalog`、`agentPreset` | `packages/subagent/subagent/src/projection.ts:61,170`；`catalog.ts:114`；`preset/.../session.ts:42` |

**DAG 那一段的额外信息流**（`packages/agentops/dag`）：

- 节点子代理同样走 `startActivation`（`delivery:'caller'`），因此**不写父通知**，但**仍写父会话的 `subagent/catalog`**（本地 spawn）。
- 运行进度进 **SQLite**（不是 session log）：`runs(run_id, workflow_id, status, inputs, started_at, finished_at, error, agent_id, session_id)` 与 `run_nodes(run_id, node_id, status, attempts, started_at, finished_at, error, chosen_port, outputs, actor)`（`packages/agentops/dag/src/run-store.ts:13-41`）。`beginRun()` 在首个节点结算前就落行，`save()` 每次结算 upsert，且 `agent_id/session_id` 用 `COALESCE` 保留原归属（`run-store.ts:147-162`）。
- 若走 `dsh-tool-workflow`（脚本栈）而非 DAG：父会话有 4 条 log-only 事件 `tool-workflow/run-start|agent-start|agent-end|run-end`（`packages/workflow/tool-workflow/src/types.ts:47-62`），但 `workflow/phase` / `workflow/log` **没有持久化面**，且嵌套 transport 调用不记录（`packages/workflow/tool-workflow/README.md:78-80`）。

**能重建**（只靠日志/持久化）：

- 父会话：谁被派发了（`subagent/catalog` 的 label/mode/顺序）、何时结算、结算文本、"我当时用的工具参数"（`tool/call`）。
- 子会话：它用的组合（`agent-preset/selected` 或 header `agentPreset`）、它是 one-shot 还是 continuable（`subagent/descriptor`）、它自己的每一轮对话与工具调用。
- 运行面：某次 DAG 运行的 workflow id、节点状态/尝试次数/起止时间/错误/选中端口/输出/业务角色，以及**运行所属的 Agent preset 与会话 id**。

**不能重建**（明确缺口，按影响排序）：

1. **节点 → 子会话 id 的边不在 run store**：`run_nodes` 只有 `actor`（业务角色），没有 `session_id`；执行器拿到 `activation` 后只 `await result` + `dispose()`，从不读 `activation.childId`（`packages/agentops/dag/src/dsh.ts:231-261`）。要从运行节点反查子会话，只能回到业务 Agent 会话里的 `subagent/catalog` 按顺序猜。
2. **workflow 定义 revision**：`runs` 表无 digest / revision 列（`run-store.ts:16-26`），而 `workflow-catalog` 的 `save()` 是覆盖写（`packages/agentops/workflow-catalog/README.md:93`）。所以"重跑用的是当时的 YAML 还是改过的 YAML"无法从记录判定（`packages/agentops/dag/README.md:146`）。
3. **handoff / 端口交接事件**：`projectAgentActivity` 的 `handoffs` 恒为空（`packages/agentops/dag/README.md:90`）。
4. **子代理的中间过程**：父会话永远看不到子代理的中间消息，只有一条结算 notice（`subagent/README.md:167`、`tool-workflow/README.md:38`）。
5. **脚本栈的 phase/log 行**：不落 session log，只进 job 的临时输出环（`tool-workflow/README.md:80`）。
6. **crash 窗口**：已受理但未写入子会话的 prompt 不会重放（`subagent/README.md:211`）；DAG 崩溃可留下 `running` 状态（`dag/README.md:145`）。

---

## ④ 发现的架构问题（按严重度排序）

### A1【严重】两套工作流执行栈并存，DAG 旁路了已有的 `ctx.workflowEngine` seam

- **问题**：`@agentops/dsh-dag` 自带 `DagEngine` + 自建节点执行器，直接消费 `ctx.subagents`，不实现也不消费 `ctx.workflowEngine`；同时仓库里另有 `workflow` / `workflow-ptc` / `tool-workflow` 这条正式 seam，以及一个**没人消费其产出**的 YAML→脚本编译器。
- **证据**：`packages/agentops/dag/src/engine.ts:113`（`DagEngine.run`）；`packages/agentops/dag/src/dsh.ts:202-263`（`createSubagentExecutor` → `subagents.startActivation`）；`packages/agentops/dag/package.json` 依赖列表无 `@deepseek-ai/dsh-workflow`；`packages/workflow/workflow/src/index.ts:43-89`（`ctx.workflowEngine` 侧的事件与契约）；`packages/agentops/workflow-compiler/README.md:102`（"Not yet wired into `workflow-ptc`"）；`packages/agentops/workflow-catalog/README.md:96`（"the compiler is not yet connected to `workflow-ptc`"）。
- **影响**：`workflowCatalog.compile()` 产生的 `{source, layers, digest}` 只是编辑器预览，没有任何执行者；两条栈的语义不同（DAG：分层 + 端口 + `after` 屏障；PTC：脚本 + `parallel()` 屏障），一旦有人把编译产物接进 PTC，同一个 YAML 会出现两种执行顺序；`docs/architecture.md:134-140` 的能力接缝图无法表达 AgentOps 的执行栈。
- **建议**：二选一并显式化——(a) 把 DAG 的分层调度实现为 `ctx.workflowEngine` 的第二个 Provider（请求体扩成 `{workflow, inputs}`），让 `dag_run` 成为 workflow seam 的 Consumer；(b) 或明确承认 DAG 是 AgentOps 私有执行器，在 `docs/architecture.md#capability-seams` 登记为独立 seam 并注明"不消费 `ctx.workflowEngine`"，同时把 `workflow-compiler` 标注为未接线（不要让它看起来是 DAG 的编译前端）。

### A2【严重】`agent_preset` 白名单只在 Consumer 强制，Service 与 DAG 执行器均可绕过

- **问题**：白名单是工具层（`tool-subagent`）的私有策略，`ctx.subagents` 与 `@agentops/dsh-dag` 都没有"这个调用者可以挂哪些 preset"的概念。
- **证据**：强制点 `packages/subagent/tool-subagent/src/preset-selection.ts:89-97`；无强制点的路径 `packages/subagent/subagent/src/child-agent.ts:191-198`（`presets.mount(childCtx, composition.agentPreset)` 只判断 service 是否存在）、`packages/agentops/dag/src/dsh.ts:227`（`agentPreset = ownerAgentPreset ?? node.agentRef`，来自 YAML 而非白名单）；旁证：`packages/preset/agent-preset-registry/src/index.ts:298-306` 的 `mount()` 只按 id 查 definitions。
- **影响**：Manager 的"禁止调用白名单之外的 Agent"（`agentops/agents/manager.yaml:50`）只是提示词 + 一个工具实例的策略；任何直接调用 `ctx.subagents.startActivation()` 的插件（含 DAG、未来的 SDK/API 面）都能挂上 `manager` 或任意 preset，从而继承其工具集；preset 的 `manager` 自身也被排除在白名单外，但没有任何运行时保证。
- **建议**：把白名单提升为 service 契约——给 `SubagentStartRequest` 增加显式策略（如 `permittedPresets?: string[]`，由发起方声明、由 `SubagentManager` 在 `startActivation` 里对 `agentPreset` 做 membership 判定并 fail loud），或引入 `ctx.presetPolicy` 服务；DAG 的 `ownerAgentPreset` 走同一条校验。

### A3【高】DAG 节点子代理不受 `maxDepth` 约束，可递归启动自己的 workflow

- **问题**：深度上限只在 `tool-subagent` 传参时生效；DAG 执行器不传，`undefined` 即无限；而节点子代理被钉在 owning preset 上，该 preset 通常含 `dag_run`。
- **证据**：`packages/subagent/tool-subagent/src/index.ts:315-322`（传 `maxDepth`）对比 `packages/agentops/dag/src/dsh.ts:231-243`（不传）；`packages/subagent/subagent/src/child-agent.ts:49-58`（`maxDepth === undefined` 时无上限）；节点 preset 的 `dag-tools` 行 `only: ['dag_run','list_runs']`（`packages/agentops/bundle/presets/agents.generated.patch.yml` 的 log_analyst / log_puller / multi-agent-report 行；生成逻辑 `agentops/scripts/gen-agent-presets.ts:205-207`）。
- **影响**：Manager → 业务 Agent（depth 1）→ DAG 节点（depth 2+）已经越过 Manager 声明的 `maxDepth: 1`；节点子代理还能再次 `dag_run` 同一 workflow，形成一个仅靠 `maxActiveSubagents`（默认 8，`packages/subagent/subagent/README.md:53`）兜底的递归过程；「一次只派一层」的编排约束在代码里不成立。
- **建议**：`createSubagentExecutor` 显式传 `maxDepth`（沿用父的深度上限或新增 DAG 配置项），并在 `startActivation` 层对"本次调用的发起方是子代理"给出统一策略；同时考虑让 DAG 节点 preset 不携带 `dag_run`（`only: ['list_runs']`）。

### A4【高】`tier` 被声明为安全闸门，但全仓没有任何强制点

- **问题**：`contracts` 的类型注释声称 tier 是安全闸门（低于工具 required tier 的 agent 会被 loader 拒绝），实现只有解析、默认值回落与序列化 round-trip。
- **证据**：`packages/agentops/contracts/src/types.ts:11-12,44-45,58`；解析与回落 `packages/agentops/contracts/src/schema.ts:38,141-147,277-293`；序列化 `schema.ts:1202-1218`；全仓 `rg` 无 `requiredTier` / tier 比较逻辑（仅在 `client/src/client/agent-form.ts:117-150` 做字符串枚举校验）；20 份 agent YAML 实际写有 `tier: T1/T2/T3`（如 `agentops/agents/coding_agent.yaml:9` 为 `T3`，`agentops/agents/manager.yaml:7` 为 `T2`）。
- **影响**：审计/评审若按注释理解会高估隔离强度；真实权限只来自 `@agentops/dsh-host/tool-policy` 的 deny 名单（`packages/agentops/host/src/tool-policy.ts:42-44`）与"不挂那行就不注册工具"的组装约定，二者都不是 tier 语义，也与 `tier` 完全解耦。
- **建议**：要么把 tier 降级为分类标签并改注释/README（`packages/agentops/contracts/README.md:91` 的"Tier fallback is not a validation failure"已接近这个口径），要么在 preset 生成/挂载处实现 tier×tool 校验（生成器已有 `KNOWN_TOOLS` 交叉校验的成熟模式可复用，`agentops/scripts/gen-agent-presets.ts:161-169`）。

### A5【中】编排链引用的业务工具与白名单配置整体缺失（Provider 不存在）

- **问题**：agent YAML / workflow YAML / persona 文本里引用的 `log_query`、`pull_logs`、`wecom_notify`、`emit_alert`、`report_surface_state`、`handoff`、`finalize`、`sql_query`、`sql_execute`、`data_analysis`、`oa_affair_*` 等工具，本仓库没有任何插件注册；prompt 反复引用的 `config/patrol.yaml` 也不存在。
- **证据**：`packages/agentops/host/src/tools.ts:23`（只有 3 个工具）；`agentops/mappings/tool-map.yaml`（`emit_alert:121`、`finalize:153`、`handoff:177`、`log_query:232`、`pull_logs:319`、`report_surface_state:355`、`wecom_notify:645` 等条目，含 `mapped: null` 语义，见该文件头注释 `:1-8`）；生成器对未映射工具只 `warnings.push(...)`（`agentops/scripts/gen-agent-presets.ts:154-160`），不阻断产物；`config/patrol.yaml` 引用点 `agentops/agents/log_analyst.yaml:17,22`、`agentops/workflows/log-patrol.yaml:31`、`agentops/workflows/log-puller.yaml:25`，仓库内不存在该文件。
- **影响**：`log_analyst` / `log_puller` / `multi-agent-report` 等预设的模型被告知"必须真实调用 log_query / handoff / finalize"，但工具不存在 —— 与这些 persona 里反复出现的"禁止只 thinking 不调工具"（如 `agentops/bundle/.../agents.generated.patch.yml` 的 log_analyst persona）形成直接的失败闭环；编排链在这些 Agent 上是"名义可编排、实际不可执行"。
- **建议**：把缺失工具登记为显式缺口（Definition 与 Provider 同时缺失），并在生成器里把"agent 声明了 `mapped: null` 的工具"从 warning 升级为 error（或产出 `degraded: true` 标记进 preset 元数据），避免部署后才发现。

### A6【中】同一个人设 section 有两个 Provider，靠"占用保留 section 名"隐式竞争

- **问题**：`dsh-persona` 与 `@agentops/dsh-host/persona-static` 都向 `deployment:persona-prefix` 注册，后者的存在理由就是前者缺 `interpolate` 开关。
- **证据**：`packages/agentops/host/src/persona-static.ts:2-9,41-47`（注释明确"为什么不用 dsh-persona"+"必须占用保留 section 名才能顶替"）；`packages/preset/persona/src/index.ts:63-68`（无 `interpolate` 配置项）；`PERSONA_PREFIX_SECTION` 由 `@deepseek-ai/dsh-system-prompt` 导出（`persona-static.ts:16`）。
- **影响**：若某 preset 同时挂了 `dsh-persona` 与 `persona-static`，人设内容取决于注册顺序而非契约；AgentOps 的 `{{node_id}}` 类模板变量能保留，纯粹因为走了另一份实现，`dsh-persona` 的任何 Config 演进都不会影响 AgentOps，反之亦然——两套人设语义长期分叉。
- **建议**：给 `dsh-persona` 增加 `interpolate: boolean` 配置（它已经支持严格插值，缺的只是关闭开关），让 AgentOps 回到纯 Consumer 角色；在完成前，在 `persona-static` 的 section 注册上加一条"同名 section 已被占用则 fail loud"的校验。

### A7【中】A2UI 协议层在 host 与 client 各存一份逐字拷贝（约 5000 行，`@ts-nocheck`）

- **问题**：`packages/agentops/host/src/a2ui-schema/` 与 `packages/agentops/client/src/client/a2ui/lib/` 是同一份 vendored 协议层的两份拷贝，且都与 DSH 的严格编译选项绝缘。
- **证据**：两目录 10 个同名文件行数完全一致（`a2ui.ts` 1093、`schemas.ts` 1312、`runtime.ts` 638、`view-spec.ts` 518、`validation.ts` 538、`types.ts` 355、`json-value.ts` 261、`reducer.ts` 238、`artifact-uri.ts` 68、`index.ts` 29）；两份 `index.ts` 头部均为 `// @ts-nocheck` + "Vendored from AgentOps A2UI runtime … Do not edit here"；`packages/agentops/host/package.json` 与 `packages/agentops/client/package.json` 之间无相互依赖。
- **影响**：`contracts` 已经把"Agent/workflow 定义"收敛成单一来源，唯独 A2UI 的 viewSpec / schema 是双份；host 校验通过的 payload 与 client 渲染所依据的协议可能不同版本；`@ts-nocheck` 让这 ~5000 行完全脱离仓库的类型纪律。
- **建议**：抽 `@agentops/dsh-a2ui-protocol` 单包（保持 vendored 语义与再拷贝流程），host/client 各自引用；至少把两份拷贝纳入一个 `--check` 等值门禁（生成器已有的 `--check` 模式可直接复用）。

### A8【中】文档与代码漂移：包 README 描述的文件与行为已不存在

- **问题**：三处 README 与源码不符，且都在编排关键路径上。
- **证据**：
  - `packages/agentops/task/README.md:39-41` 声明路由在 `src/http.ts`；该文件不存在，路由在 `packages/agentops/task/src/dsh.ts:273,291,361`。
  - `packages/agentops/dag/README.md:143` 称 "`command` nodes execute through a shell"；代码 `packages/agentops/dag/src/dsh.ts:210-212` 直接抛 `command 节点 … 尚未在 DSH 中执行`。
  - `packages/agentops/dag/README.md:148` 称 "run storage has neither handoff events nor a run-to-session link"；`runs` 表已有 `agent_id` / `session_id`（`packages/agentops/dag/src/run-store.ts:24-25`，`RunAttribution` 见 `:50-57`）。
- **影响**：以 README 为审计依据会得出"命令节点有 RCE 风险"（实际未接）与"运行记录无法追溯会话"（实际可追溯）两个相反结论。
- **建议**：把 `packages/agentops/**` 的 README 纳入 `doc-sync` 覆盖并补 `verify-md-links`/文件存在性检查（该 gate 是否已覆盖此目录：**未验证**）。

### A9【低】默认 preset 未指向 `manager`，编排入口依赖运行期用户设置

- **问题**：AgentOps 部署起来后，新会话的默认 preset 仍是 `standard`。
- **证据**：`packages/bundle/web-app/cordis.patch.yml:589-592`（`agent-preset-registry.config.default: standard`）；`packages/agentops/bundle/cordis.patch.yml` 与 `packages/agentops/deploy/agentops.patch.yml` 均未覆盖 `default`；全仓 `default: manager` 零命中；`manager` 仅作为 `packages/agentops/bundle/presets/agents.generated.patch.yml:107` 的一个候选 preset 存在。`agent-preset-registry/README.md:46` 说明用户默认值走 volatile 的 `selectedDefault`。
- **影响**：AgentOps 的"Manager 是用户主对话入口"（`agentops/agents/manager.yaml:16`）在代码层不成立，除非运维/用户在 UI 里选过；离线部署（`deploy/agentops.patch.yml`）无法自带这一选择。
- **建议**：在部署 patch 里显式声明 `default: manager`，或在 README 中把"选择 Manager preset"写成部署步骤。

### A10【低】`agentRef` 与 preset id 是两个命名空间，却被压成同一个字符串

- **问题**：workflow YAML 的 `agent:` 字段（→ `agentRef`）取值是 agent YAML 的 `agent_id`，而生成器让 `presetId = agent_id`，两者靠约定相等。
- **证据**：`packages/agentops/contracts/src/schema.ts:444`（`agentRef = readString(value.agent)`）、`:587`（写入节点）；`agentops/scripts/gen-agent-presets.ts:266`（`presetId: agent.agent_id`）；DAG 只在运行时才因 `agentPreset === undefined` 失败（`packages/agentops/dag/src/dsh.ts:227-230`），`agentRef` 指向不存在的 preset 时错误来自更下游的 `presets.mount`。
- **影响**：业务 Agent 改名会同时牵动 preset 历史与 16 份 workflow YAML 的节点引用；`agentRef` 解析期不校验，错误暴露点离作者面很远。
- **建议**：在 `workflowCatalog.compile()` / `contracts` 加载期用 `ctx.agentPresets.list()` 校核 `agentRef`；或引入显式 `preset_ref` 字段并在 contracts 里保留 `agent_ref`（业务角色）与 `preset_ref`（组合）的区分。

---

## ⑤ 摘要（≤150 字）

AgentOps 的分层是"preset 定组合、subagent 定派生、dag 定执行、contracts 定定义"。四个边界各有归属，但三处接缝没接好：`agent_preset` 白名单只在工具层强制，DAG 执行器与任何服务直调都能绕过；`ctx.workflowEngine` 被自建 `DagEngine` 旁路，编译器产出无人执行；`tier` 被写成安全闸门却无强制点。信息流本身干净（catalog + descriptor + 结算 notice + run store），缺的是"节点→子会话"这条边与 workflow 定义 revision。
