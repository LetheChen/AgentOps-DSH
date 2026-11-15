---
description: "AgentOps 工作流引擎：旧 YAML 校验、分层调度、工作流编辑与节点重跑路由，每个节点一个 subagent。"
kind: "package-reference"
---

# @agentops/dsh-dag

[English](README.md) | 中文

## 概述

本包把旧工作流 YAML 变成执行计划并运行它。校验拒绝重复 id、未知依赖、悬空输出目标与环；执行时把节点分层、层内并发，每个节点在独立 subagent 上运行，节点间只传 JSON。它还提供工作流编辑器使用的源码读取、带编译预览的实时校验、仅源码编辑与 CAS 保存路由、分页运行历史与运行详情路由、只负责入队的节点重跑路由，以及从持久化运行到协作视图的投影。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

校验或运行 AgentOps 工作流时使用；管理路由建立在其上。

### 模型可调工具

| 工具 | 行为 |
|---|---|
| `dag_catalog` | 列出已配置的工作流及其标识、描述、声明的输入、节点数与校验状态 |
| `dag_validate` | 校验一份 YAML 并返回执行层次；只读 |
| `dag_run` | 按标识或 YAML 运行工作流；每个 agent 节点派生一个子代理 |
| `dag_rerun` | 重跑一次已持久化运行中的某个节点，可选择保留下游结果 |
| `list_runs` | 列出最近运行及其节点状态；只读 |

拥有某条工作流的 Agent preset 挂载本插件时会设置 `ownedWorkflowId` 与 `ownerAgentPreset`。该配置钉定执行：`dag_run` 解析配置里的工作流并忽略模型传入的 `workflowId`，每个节点子代理被强制使用该 Agent 的 preset；无法解析所属 preset 的节点直接失败，而不是继承调用方的组合。生成的行同时设置 `only: ['dag_run', 'list_runs']`——编目与编辑属于运维，不属于被测 Agent。

### 运行归属

`dag_run` 记录所属 Agent、执行会话与每个节点的业务角色。运行行在首个节点结算前写入，并在每次结算时更新，因此监控能看到实时进度而非只有终态快照。`list_runs` 读取该记录，调度方据此确认工作流确实启动过，而不是从回复里推断。

### 工作流编辑路由

| 路由 | 行为 |
|---|---|
| `GET /api/agentops/workflow-source?id=<id>` | 不解析，直接返回精确 YAML 原文与 SHA-256 指纹 |
| `POST /api/agentops/workflow-validate` | 校验 `{ text }`，返回问题；合法时同时返回调度图与编译预览 |
| `POST /api/agentops/workflow-save` | 通过比较后写入保存 `{ workflowId, text, expectedDigest }` |
| `POST /api/agentops/workflow-edit` | 对 `{ text, operation }` 应用一个仅源码编辑，返回候选文本及其已校验依赖图与编译预览 |

工作流 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]*$`。源码上限为 1 MiB UTF-8 字节。源码不存在返回 404，非法请求返回 400，源码超限返回 413，非法 YAML 返回 422 并带问题列表。指纹过期返回 409 与 `actualDigest`；路由不会自动采用该指纹，也不会覆盖磁盘上的新文件。未预期的文件系统错误返回不暴露宿主路径的通用 500。

编辑路由接受 `add-node`、`remove-node`、`add-schedule-edge`、`remove-schedule-edge`、`add-data-edge` 与 `remove-data-edge`。YAML 始终是权威源：路由只替换受影响的源码范围并返回候选文本，不写入磁盘；`workflow-save` 仍是唯一写入路径。校验和编辑成功响应包含 `compiled: { source, layers, digest }`；422 响应包含问题列表，不包含 `compiled` 产物。被拒绝的编辑也不返回候选文本。

### 运行历史路由

| 路由 | 行为 |
|---|---|
| `GET /api/agentops/runs?limit=&offset=&status=&workflowId=` | 按最新优先返回 `{ runs, total }`；limit 默认 50，范围 1–200 |
| `GET /api/agentops/run?id=<id>` | 返回一次运行的工作流标识、根错误、节点时间、尝试次数、所选端口与输出 |
| `GET /api/agentops/run-activity?id=<id>` | 返回一次持久化运行的业务泳道、节点、调度与数据边、时间线和 handoffs |

列表路由的状态筛选接受 `running`、`completed`、`failed` 或 `cancelled`，并与精确工作流标识筛选组合。非法分页或状态参数返回 400。未知详情标识返回 404。

`GET /api/agentops/run-activity?id=<id>` 在缺少 id 时返回 `invalid_query`（400），运行不存在时返回 `unknown_run`（404），当前 YAML 不存在时返回 `workflow_missing`（404），YAML 标识与运行标识不一致时返回 `workflow_mismatch`（409），YAML 无法解析或校验失败时返回 `workflow_invalid`（422），未预期失败时返回 `internal_error`（500）。端点读取工作流当前 YAML；运行存储不保存定义 revision，因此无法单凭运行记录重建已删除或已修改的文件。

### 节点重跑路由

| 路由 | 行为 |
|---|---|
| `POST /api/agentops/workflow-rerun` | 在新的 `agentops` Session 中排队一条 `dag_rerun` 指令 |

请求为 `{ runId, workflowId, nodeId, onlyNode, inputs }`。路由在创建 Session 前校验持久化运行、当前工作流、节点、运行状态与已声明的输入。`onlyNode: true` 只重跑目标节点；`onlyNode: false` 还会重跑全部传递调度下游节点。200 响应表示 Session 已创建且指令已入队，不表示节点已经执行完成。

失败码为 `invalid_request`（400）、`unknown_run`（404）、`workflow_mismatch`（409）、`node_missing`（404）、`run_running`（409）、`workflow_invalid`（422）、`invalid_inputs`（422）、`session_unavailable`（503）与 `internal_error`（500）。Session 创建后入队失败时，`session_unavailable` 响应可包含内部 `sessionId`；浏览器客户端不会渲染它。

`dag_rerun` 使用原 `runId` 与请求输入恢复运行。它使目标节点以及 `onlyNode` 不为 true 时的全部传递调度下游节点失效。已完成输出仍可供恢复使用，最终状态会写回运行历史。

### 协作活动投影

`projectAgentActivity({ record, workflow })` 把一个 `RunRecord` 与其工作流定义组合为业务泳道、开发者 DAG 和时间线视图所需的数据。

- `nodes` 保持工作流声明顺序，按 `businessRole → agentRef → 节点 id` 降级确定泳道，并按 `displayName ?? id` 显示名称。
- 定义中不存在的运行节点会被忽略；运行中缺失的定义节点显示为 `pending`，尝试次数为 0。
- `scheduleEdges` 只来自 `after`。`dataEdges` 只来自 `outputs`，空输出目标会被忽略。
- `timeline` 只包含有持久化时间戳支撑的运行与节点生命周期事件。相同时间按生命周期优先级和工作流顺序稳定排列。
- 在 DSH 持久化 handoff 事件前，`handoffs` 始终为空。

YAML 加载器会保留 `name`、`agent`、`business_role`、`harness` 与 `model` 字段提供的可选节点元数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/validate.ts` | 结构校验、环检测与分层计算 |
| `src/engine.ts` | 分层调度、逐节点 subagent 运行与取消 |
| `src/run-store.ts` | 运行与节点持久化、筛选分页与完整运行记录 |
| `src/activity.ts` | 生成确定性的泳道、节点、两类边与生命周期事件协作投影 |
| `src/runs.ts` | 分页运行历史与运行详情路由 |
| `src/load.ts` | YAML 读取与归一 |
| `src/workflow-edit.ts` | 增删节点及调度/数据边的源码替换 |
| `src/workflow-editor.ts` | 源码读取、校验、编辑与 CAS 保存路由 |
| `src/workflow-rerun.ts` | 持久化运行校验与只负责入队的重跑 Session 路由 |

编辑路由通过 `ctx.effect()` 注册，并要求 `connection` 与 `workflowCatalog`。路由原样返回契约校验问题，使客户端能定位 YAML 行并高亮环中的节点。编辑路由先校验候选文本，再编译内存中已校验的定义，不再次解析候选源码。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../contracts/`](../contracts/README.zh.md) — 本引擎消费的共享校验与边规则
- [`../workflow-catalog/`](../workflow-catalog/README.zh.md) — 精确源码读取与 CAS 持久化

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dag_validate`、`dag_run` 与 `dag_rerun`，向节点 Agent 暴露工作流输入与上游节点输出。

#### KV 缓存影响

提示内容随运行输入与上游节点输出变化；本包不管理 KV 缓存键。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有节点级超时与重试** — 卡住的节点只能随整次运行一起取消。
- **四种节点原语不完整** — gateway 恒走第一个端口、`await_command` 恒超时、`while` 不循环、`parallel_branch` 不实现 `join_strategy`。
- **`command` 节点经 shell 执行** — 模板值不做转义替换，`parse_stdout` 会求值表达式；工作流写权限应视为宿主执行权限。
- **节点重跑没有互斥** — 两个已入队 Session 都可能通过校验并修改同一次运行；当前没有运行级锁。
- **进程崩溃可能让运行停留在 `running`** — 当前没有可靠的原子转换到 `running`，因此在修复持久化状态前，后续重跑都会返回 `run_running`。
- **重跑读取当前 YAML** — 运行存储不保存 workflow revision，因此无法重建已删除或已修改的定义，重跑会使用磁盘上的当前文件。
- **重跑受理不等于完成** — 成功的路由或工具响应只表示重跑指令已入队或已由该工具调用执行，不表示下游工作已经完成。
- **协作投影没有 handoff 与对话历史** — 运行存储既没有 handoff 事件，也没有运行到 Session 的关联，因此 `handoffs` 为空，时间线不包含聊天消息。
- **协作投影读取当前定义** — 运行存储不保存一次运行实际使用的 workflow revision，单靠运行记录无法重建已删除或已修改的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
