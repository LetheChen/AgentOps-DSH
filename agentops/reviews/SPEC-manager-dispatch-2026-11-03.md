# 待审方案：Manager Agent 调度面设计（方案一 vs 方案二）

> 本文是**被审对象**，不是结论。审查者请只依据本文件 + 仓库代码取证，不得读取仓库内任何 `R*-*.md` / `REVIEW-*.md` / `_codex_*` / `_claude_*` 文件，也不得把它们当证据。

## 0. 业务目标（不可改）

用户在 Web GUI 里选择「Manager Agent」作为主对话入口。Manager 只做三件事：**意图识别、任务分解、动态编排**；**不自己执行业务动作**。

具体执行分两种方式：

1. **skill 方式**：子代理拥有该任务领域的 skill 执行手册，自己编排接口 / 脚本 / 内置工具完成任务，结果返回 Manager。自由度较高。
2. **工作流方式**：一条工作流 = **一个显式 Agent**。该 Agent 定义了这个工作流的场景、任务范围，以及工具 / 知识库 / skill 的调用权限；工作流节点子代理**继承**这个显式 Agent 的权限，**节点不能独立设定工具权限**，但每个节点保留自己的 actor 角色名。节点之间按严格 DAG 衔接上下文与成果物。输出确定性要求高。

附加要求：
- 通过 agent id 在监控中心显示气泡提醒（执行状态、节点完成情况）。
- 新增 agent / workflow / skill / 工具只需要「注册 + 分配权限」，不应要求改 Manager 的配置或上下文。

## 1. 已核实的现状（带代码位置，审查者可复验）

| # | 事实 | 位置 |
|---|---|---|
| F1 | Manager preset 实际只挂载：persona、agent-instructions、`db-tools only:[sql_query,describe_database]`、`host-tools only:[present_content,board_cleanup]`、fs-tools、pwsh、skill、tool-policy | `packages/agentops/bundle/presets/agents.generated.patch.yml`（`preset-agent-manager` 段） |
| F2 | Manager 没有 `subagent`、没有 `dag_*` 工具；`dispatch` / `trigger_workflow` / `request_cross_domain` / `collect_child_result` 在映射表中 `mapped: null`，生成器不写入 preset | `agentops/mappings/tool-map.yaml`；`agentops/scripts/gen-agent-presets.ts` |
| F3 | `subagent` 工具支持 `allowedAgentPresets`；模型参数描述里会列出每个允许 preset 的 `description`（渐进式暴露的现成机制） | `packages/subagent/tool-subagent/src/preset-selection.ts`（`description` getter、`validate()`）；`src/index.ts`（`agent_preset` 参数描述取 `presets.description`） |
| F4 | `subagent` 工具启动子代理后**立即返回** `{kind:'activation', subagentId}`，`delivery:'parent'` | `packages/subagent/tool-subagent/src/index.ts` |
| F5 | 子代理完成后，DSH 自动向父会话投递一条 `source.kind='subagent-settled'` 的运行时消息（含摘要、子代理收尾文本、structured result），并唤醒父代理 | `packages/subagent/subagent/src/continuation-messages.ts`（`createSettlementMessage`） |
| F6 | 子代理可被 `send_message` 追问、`interrupt_agent` 取消（continuable） | `packages/subagent/tool-subagent-control/src/index.ts` |
| F7 | `dag_run` **同步阻塞**调用方整轮直到整条 DAG 结束 | `packages/agentops/dag/src/dsh.ts`（`dag_run` execute） |
| F8 | DAG 执行器派生节点子代理时只传 `agentPreset: node.agentRef`；**不传 `maxDepth`** | `packages/agentops/dag/src/dsh.ts`（`createSubagentExecutor`） |
| F9 | 节点未声明 `agentRef` 时（如 `inline_agent` 节点），**不传 `agentPreset`** → 子代理继承调用方当前 preset | 同上；`packages/subagent/subagent/src/child-agent.ts`（`childSessionMeta`：`selectedPreset ?? parent composedPreset`） |
| F10 | `contracts` 层已解析 `inline_agent` 的 `allowed_tools` / `denied_tools`，但 DAG 运行时 loader **不读** `inline_agent`，执行器也忽略 | `packages/agentops/contracts/src/schema.ts`（`parseInlineAgent`）；`packages/agentops/dag/src/load.ts`；`dsh.ts` |
| F11 | `WorkflowDefinition` 没有顶层 `agent` 字段；权限只由每个节点的 `agentRef` 决定 | `packages/agentops/contracts/src/types.ts`；`packages/agentops/dag/src/types.ts` |
| F12 | `command` 节点在 DSH 中直接抛错 | `packages/agentops/dag/src/dsh.ts` |
| F13 | 节点 prompt 要求「最终回复是 JSON 对象，键严格等于输出端口名」；而 `smart_query` 人格要求调 `handoff`，DSH 侧没有 `handoff` | `packages/agentops/dag/src/dsh.ts`（`nodePrompt`）；`agentops/agents/smart_query.yaml` |
| F14 | 工作流运行页实际做法：新建一个 `agentPreset:'agentops'` 的会话，再发一句「请用 dag_run 运行 …」的固定指令 | `packages/agentops/dag/src/workflow-run.ts` |
| F15 | `subagent` 服务默认 `maxDepth` = 1 | `packages/subagent/subagent/src/index.ts`（Config 默认值） |
| F16 | 所有 agent preset 的 `readableSpaces` 均为空；`kb-map.yaml` 中 7 个 KB 键全为 `space: null` | 生成物；`agentops/mappings/kb-map.yaml` |
| F17 | `tool-skill` 只有 `catalogDescriptionMaxLength` 配置，没有 per-agent skill allowlist；skill 目录对所有 agent 全局可见 | `packages/skill/tool-skill/src/index.ts` |
| F18 | Agent 编辑器只把 YAML 写回磁盘，不重建 preset | `packages/agentops/host/src/agents.ts`（`updateAgent`） |
| F19 | run 记录只有 `workflowId` / 节点状态，没有 `agentId` / 子会话 id / actor 名 | `packages/agentops/dag/src/run-store.ts`；`runs.ts` |
| F20 | 存在 `packages/client/ui-subagent`，按父子会话展示子代理谱系 | 该包 |

## 2. 两个候选方案

### 方案一「编排面收敛」（Manager 直接拉起工作流）

- Manager 持有：`subagent(allowedAgentPresets=[所有业务 agent])`、`run_workflow(agent_id, inputs)`、`list_agents` / `send_message` / `interrupt_agent`、`present_content`。不持业务工具。
- `run_workflow(agent_id)` 内部：查该 agent 绑定的 workflow（agent 定义里声明，或工作流顶层 `agent:` 反查），校验一致后执行 DAG；节点统一 `agentPreset = workflow.agent`。
- skill 方式仍走 `subagent(agent_preset)`。
- 节点子代理是 **Manager 的直接子会话**（Manager → 节点），中间没有业务 agent 会话。
- 业务 agent 的 preset **不需要** dag 工具（启动权只在 Manager 与定时 runner）。

### 方案二「派发面收敛」（Manager 只认 agent，业务 agent 自己决定执行方式）

- Manager 只持有：`subagent(allowedAgentPresets=[所有业务 agent])` + `present_content` + 控制类工具。**不持有** `run_workflow` / `dag_*`。
- Manager 只读每个 agent 的**顶层描述**（preset description），据此路由；不知道 workflow 的存在。
- 业务 agent 的 preset 内挂：`skill`（skill 目录渐进暴露）、`dag_catalog` + `dag_run`（或 `run_workflow`）、`knowledge_search`、业务工具。
- 业务 agent 收到任务后自己判断：直接按 skill 执行，还是 `dag_run` 跑自己的工作流。
- 节点子代理是 **业务 agent 的子会话**（Manager → 业务 agent → 节点）。
- 新增 agent/workflow 只需注册 + 分配权限，Manager 侧完全不动。

## 3. 审查要求

请判断：**哪个方案更符合第 0 节的业务目标与扩展性要求？** 必须给出可核验证据（`文件:行号` + 原文），并显式列出对方方案的具体失败场景。

重点考察（不限于）：

1. Manager 上下文占用：两方案下 Manager 的 system prompt / 工具 schema 各需要承载多少信息？「渐进式暴露」是否真的只发生在子代理侧？
2. 扩展面：新增第 N 个 agent、第 N 条 workflow 时，两方案各需要改哪些文件？是否存在「必须同步改 Manager」的隐式耦合？
3. 权限边界与递归风险：方案二里节点子代理继承业务 agent preset（F9），是否会连带拿到 `dag_run` / `subagent` 从而自我递归或越权启动别的工作流？F8（不传 maxDepth）+ F15（默认 1）组合下深度到底是多少？
4. 阻塞与并发：F7（dag_run 同步阻塞）+ F4/F5（subagent 立即返回、完成回投）在各方案下分别阻塞谁？长流程（log-patrol、video-pipeline）会不会卡住对话？
5. 监控可见性：F19（run 记录没有 agentId）+ F20（ui-subagent 按父子谱系展示）下，两方案的「气泡」分别能挂在哪一层？节点完成事件如何驱动提醒？
6. 确定性与可控性：方案二多一次「业务 agent 决定走哪条路」的模型判断，对「输出确定性要求高」的目标是否构成实质风险？能否用 prompt/工具约束消除？
7. 失败语义：业务 agent 崩溃 / 超时 / 只回一句话就结束，两方案下 Manager 分别看到什么？能否发现「工作流根本没启动」？
8. 实现成本：基于 F1–F20，两方案各需要新增/改动哪些包与接口？哪些是新增能力，哪些是修既有缺口（修缺口在哪个方案下都必须做，不能算方案成本）？
9. 反例：是否存在「两方案都必须做」的公共改造，被某一方算成了自己的优势？
10. 是否存在**第三方案**（例如：Manager 只认 agent；由 agent 的 preset 声明自己是 skill 型还是 workflow 型，Manager 用同一把工具、但工具内部按 agent 类型分派）？若有，请给出并比较。

## 4. 输出格式

- 先声明你使用的取证方法档位（S1 静态核验 / S2 实测执行 / S3 反向重建 / S4 边界专项）。
- 结论：推荐哪个方案，一句话。
- 逐条论证：`指控 | 证据（文件:行号 + 原文片段）| 等级（L4/L3/L2/L1）`。
- 对方方案的**具体失败场景**（能落到某次真实调用）。
- 你对第 3 节 10 个问题中每个的回答（可简短，但必须回答）。
- 存疑项：你无法核验但认为关键的点，写明需要什么证据。
