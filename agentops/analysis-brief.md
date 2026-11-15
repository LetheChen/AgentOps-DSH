# Analysis Brief - AgentOps

> Evidence classes used below: **Configuration fact**, **Source fact**, **Measured result**, **Teaching simulation**. Configuration declares intent; source code establishes runtime behavior. Neither proves a live production run.

## Scope

- Project: AgentOps Manager → 智能问数
- Project shape: agentic
- Revision / date: `仓库基线` / 2026-11-05
- Analyzed root: `<dsh-repo>`
- Included paths: `agentops/agents/`, `agentops/workflows/`, `packages/agentops/dag/src/`, `packages/agentops/db/src/`, `packages/agentops/bundle/presets/agents.generated.patch.yml`
- Excluded paths and reason: vendored dependencies, generated build output, and unrelated domains were excluded because they do not participate in the Manager → smart_query representative path.
- Verification scope: static source inspection; `@agentops/dsh-dag` 124 tests pass; `@agentops/dsh-db` 15 tests pass; offline Chrome checks include 59 generic shell checks and 104 AgentOps teaching-page checks. No live production query or health check was performed.

## Capability ledger

| ID | User capability | Business value | Entry | Input | Output | Evidence | Limits |
|---|---|---|---|---|---|---|---|
| C1 | 识别意图并拆解可执行任务 | 把自然语言请求变成清晰的业务委派 | Manager 对话入口 | 用户原话、会话上下文、候选 preset | 自包含派发任务 | Configuration fact: `agentops/agents/manager.yaml:9-40,52-73`; `packages/agentops/bundle/presets/agents.generated.patch.yml:138-149` | Manager 不持有 SQL、数据库描述等业务工具 |
| C2 | 异步委派业务 Agent | Manager 不阻塞在一项长任务上 | `subagent` 工具 | `agent_preset`、自包含 prompt、父会话身份 | 立即返回 `subagentId`，完成后回投 | Configuration fact: `agentops/agents/manager.yaml:15-40,52-73` | 一次只派一层；`maxDepth: 1` |
| C3 | 钉定并启动业务工作流 | 防止模型越权选择其他 workflow | smart_query Agent | 用户问题与数据源 | `{runId,status,nodes[],outputs}` | Configuration fact: `agentops/agents/smart_query.yaml:18-40`; Source fact: `packages/agentops/dag/src/dsh.ts:683-704,697-703` | `execution: workflow`，固定 `workflow: smart-query`，不能覆盖 workflowId/yaml |
| C4 | 由节点角色完成问数流水线 | 把路由、SQL、执行、讲解分工 | smart-query DAG | `question`、`database` 与上游端口 | `intent`、`sql`、`result`、`answer` | Configuration fact: `agentops/workflows/smart-query.yaml:20-139`; Source fact: `packages/agentops/dag/src/engine.ts:140-214,288-293` | 声明 5 个 agent 节点；正常回答只执行 4 个，`refuse_intent` 被 `skip_if` 跳过 |
| C5 | 只读查询并解释结果 | 在可用性与数据安全之间建立边界 | `run_sql` 节点调用 `sql_query` | 自然语言、schema、SQL | 结构化结果与最终回答 | Source fact: `packages/agentops/db/src/guard.ts:50-108`; `packages/agentops/db/src/query.ts:87,151`; `packages/agentops/db/src/tools.ts:34`; `packages/agentops/db/src/datasources.ts:34-39` | 单语句、SELECT/WITH、白名单、屏蔽列、自动 LIMIT、只读连接、结果截断 |
| C6 | 追踪节点状态并把结果回投 | 让一次问数可检查、可复盘、可汇报 | smart_query 工作流运行 | 工作流输入、节点状态、actor、session | `runs` 与 `run_nodes` 记录，最终 answer 返回 Manager | Source fact: `packages/agentops/dag/src/run-store.ts:13-40,189-243`; Configuration fact: `agentops/agents/smart_query.yaml:18-40` | 进程崩溃可能留下 `running`；重跑读取当前 YAML，不保存历史 revision；没有自动节点重试 |

## Agent and workflow topology

- Entry Agent: `manager`；职责是意图识别、任务分解、动态编排和最终汇报。
- Delegation tool: `subagent`。Manager 通过白名单选择 `agent_preset`。
- Return semantics: 立即返回 `subagentId`；子代理完成后结果自动回到 Manager 会话。
- Allowed targets: preset 中列出的候选 Agent；`smart_query` 是本次代表链路的业务 Agent。
- Denied tools / boundaries: Manager 禁止 `sql_query`、`describe_database`、`oa_affair_*`、`data_analysis` 等业务动作；`maxDepth: 1`。
- Delegated Agent and workflow ownership: `smart_query` 声明 `execution: workflow` 与 `workflow: smart-query`。
- Depth and recursion guard: Manager `0` → smart_query `1` → DAG node `2`；`packages/agentops/dag/src/dsh.ts:697-703` 在深度大于 1 时拒绝节点内再次 `dag_run`。
- Node roles and preset reuse: 节点声明 `route_intent`、`refuse_intent`、`plan_sql`、`run_sql`、`present_result`；每个节点继承所属 `smart_query` preset，角色由节点 prompt 与 `business_role` 决定，不等同于五个独立 Agent identity。
- Result return path: 节点产出 answer → smart_query 汇总 `{runId,status,nodes[],outputs}` → Manager 向用户汇报。

## Runtime path

1. Trigger: 用户向 Manager 提出业务数据问题。
2. Validation: Manager 判断是否需要业务执行；需要时选择白名单业务 Agent。
3. Entry decision: 闲聊直接回答，业务问数派发 `smart_query`。
4. Delegation / dispatch: 调用 `subagent`，立即得到 `subagentId`，任务在业务 Agent 轮次继续。
5. Workflow or execution start: smart_query 第一动作调用绑定到 `smart-query` 的 `dag_run`。
6. Scheduling and node roles: DAG 按依赖执行 route_intent → plan_sql → run_sql → present_result；refuse_intent 在正常路径由 `skip_if` 跳过。
7. State persistence: 运行开始时创建 run，节点结算时更新 `run_nodes`；记录 actor、attempts、chosen port、outputs、错误与时间。
8. Result return: present_result 产生 answer 端口，smart_query 返回终结答案。
9. User response: Manager 将结果整理后回复用户。
10. Failure and recovery: SQL 可自修一次；权限、白名单、连接或超时错误不重试。DAG 没有自动节点重试，重跑读取当前 YAML。

## Scenarios

- Normal path: 数据问题经 `route_intent` 判定为数据查询，执行 `plan_sql → run_sql → present_result`，返回 answer。
- Real limitation or branch: 非数据问题进入 `refuse_intent`；`skip_if` 属于配置分支，正常路径不会启动该节点，而不是把节点标成执行失败。
- Failure path: SQL 执行失败时，run_sql 只对可自修错误最小改写并重试一次；仍失败则把错误结果交给 present_result，明确告知用户，不编造数据。
- Evidence for each scenario: `Configuration fact` from `agentops/workflows/smart-query.yaml:20-139`; `Source fact` from `packages/agentops/dag/src/engine.ts:140-214,288-293` and `packages/agentops/db/src/query.ts:87,151`.
- `skip_if` semantics: 命中时不启动节点 subagent，但节点仍结算为 `completed`，outputs 记录 `{skipped:true, reason}`。这与“上游失败导致 skipped”不同。

## Governance boundaries

| Domain | Enforcement point | Protected failure | Known limit | Evidence |
|---|---|---|---|---|
| Delegation least privilege | Manager allow/deny tools + subagent depth gate | 越权业务工具、无限嵌套 | 配置层白名单仍需与实际 preset 同步 | Configuration fact: `agentops/agents/manager.yaml:52-73`; Source fact: `packages/agentops/dag/src/dsh.ts:697-703` |
| Workflow ownership | `ownedWorkflowId` / `ownerAgentPreset` | 模型切换未授权 workflow | 重跑使用当前 YAML，不冻结历史 revision | Source fact: `packages/agentops/dag/src/dsh.ts:71-78,683-704` |
| Read-only data access | SQL guard + datasource whitelist + read-only connection | 多语句、写操作、系统库、越权表列 | 自动 LIMIT 与本地正则检查不能替代数据库账号权限审计 | Source fact: `packages/agentops/db/src/guard.ts:50-108`; `packages/agentops/db/src/query.ts:87,151` |
| State and auditability | `runs` / `run_nodes` persistence | 丢失运行归属、节点状态和错误 | 进程崩溃可能留下 running；无自动重试 | Source fact: `packages/agentops/dag/src/run-store.ts:13-40,189-243` |

## Evidence index

- C1: `agentops/agents/manager.yaml:9-40,52-73` — Configuration fact.
- C2: `agentops/agents/manager.yaml:15-40` — Configuration fact.
- C3: `agentops/agents/smart_query.yaml:18-40`; `packages/agentops/dag/src/dsh.ts:683-704` — Configuration fact + Source fact.
- C4: `agentops/workflows/smart-query.yaml:20-139`; `packages/agentops/dag/src/engine.ts:140-214,288-293` — Configuration fact + Source fact.
- C5: `packages/agentops/db/src/guard.ts:50-108`; `packages/agentops/db/src/query.ts:87,151`; `packages/agentops/db/src/tools.ts:34` — Source fact.
- C6: `packages/agentops/dag/src/run-store.ts:13-40,189-243` — Source fact.
- Runtime: the complete chain above is a source-grounded narrative; elapsed times, run IDs, node durations, row counts, and final answers shown in the HTML are Teaching simulation unless copied from a measured run.
- Scenarios: normal/limitation/failure are grounded in the workflow and engine behavior above.
- Governance checks: the teaching page references source paths; it does not execute production probes.
- Measured result: the DAG, database-guard, generic tour smoke, and AgentOps tour regression commands are local engineering checks only. They are not production health checks.

## Unknowns and limits

- Not verified: a live production Manager request and a live `audit_example` query were not executed for this brief.
- Not verified: actual model invocation may differ from the configured `minimax / MiniMax-M3`; configuration defaults such as `codex / deepseek-coder` must not be presented as the model that actually ran.
- Not verified: production database availability, latency, data freshness, and real row counts.
- Not verified: process-crash recovery behavior in a real deployment.
- Teaching simulation: tour run IDs, timestamps, status transitions, row counts, percentages, and answer text are illustrative unless explicitly tied to a measured command.
- Known limit: `skip_if` completion semantics differ from upstream-failure skipped semantics; the page must state this distinction.
- Not applicable: this tour does not claim that all source references loaded equals a production health result.
