---
name: agentops-dsh-workflow-author
description: 创建或修改 AgentOps-DSH 生产工作流时使用：查重、核对 Agent 与工具权限、生成 agent-only DAG YAML、调用 dag_validate 校验并安全落盘。
---

# AgentOps-DSH 工作流创建

用于把业务需求落成 DSH 可发现、可校验、可执行的 `agentops/workflows/<workflow_id>.yaml`。

路径约定：`references/...` 相对本 skill 目录；`agentops/...`、`packages/agentops/...` 相对当前 AgentOps workspace 根目录，不是 skill 目录。写文件前先确认当前 cwd 下存在 `agentops/workflows/`。

## 适用边界

只有用户明确要求“新建工作流”“修改生产工作流”“把流程编排成 DAG”时才使用。

不要为以下请求创建工作流：

- 简单问答、一次性查询、单步工具调用。
- 用户只是要解释、审查或比较现有工作流。
- 没有明确业务输入、输出或责任 Agent 的模糊需求。

已有工作流能覆盖时，先复用；不要为了换名字复制一份。

## 铁律

1. **先查再写**：先用 `dag_catalog` 查工作流是否已存在，再用 `read` 核对目标 Agent、工具和相邻样例。
2. **不编造能力**：Agent id、工具名、数据源、通知实例必须来自当前仓库配置或能力中心；不确定就停止并说明缺什么。
3. **一个主责 Agent**：节点默认使用同一个 Agent；确有跨 Agent 需求时，逐个核对每个 Agent 的 preset 和工具权限。
4. **只用 agent 节点**：当前 DSH 运行器会拒绝 `command`、`gateway`、`parallel_branch`、`while` 节点。不要生成当前执行器无法运行的节点。
5. **禁止 inline_agent**：节点权限由 Agent preset 统一定义，不允许在工作流里内联 Agent。
6. **无 handoff 协议**：节点交接靠 `outputs` 端口和最终 JSON 回复，不存在旧 AgentOps 的 `handoff` 工具。
7. **先校验后落盘**：`dag_validate` 返回 `ok: true` 之前不得写生产目录。
8. **创建不等于执行**：落盘并确认可发现后停止。未经用户另行授权，不得运行新工作流或触发有外部副作用的业务。
9. **覆盖必须显式授权**：目标文件已存在时，先读取并向用户确认要修改的文件、版本和范围；禁止顺手覆盖。

## 创建流程

### 1. 收集最小需求

必须知道：

- `workflow_id`：kebab-case，稳定且全局唯一。
- 业务名称和一句话目标。
- 运行输入及类型、是否必填、默认值。
- 最终产物/答案的消费方式。
- 主责 Agent preset。
- 是否调用外部系统、是否有写操作或通知等副作用。

缺少关键项时先问，不要猜业务口径。

### 2. 查重与能力核对

按顺序取证：

1. `dag_catalog`：确认 id 未占用，查看现有工作流的输入和校验状态。
2. `read agentops/agents/<agent_id>.yaml`：确认 Agent 存在、职责匹配、工具权限足够。
3. `read agentops/mappings/tool-map.yaml`：确认 role_prompt 里的工具已映射到运行期插件。
4. 读取最接近的现有工作流：日志类参考 `agentops/workflows/log-patrol.yaml` 和 `log-puller.yaml`，问数类参考 `agentops/workflows/smart-query.yaml`。
5. 需要实际运行期组合时，核对 `packages/agentops/bundle/presets/agents.generated.patch.yml`。

不要根据工具描述猜测工具存在；以映射和生成后的 preset 为准。

### 3. 设计最小 DAG

- 每个节点只承担一个可验收职责。
- 依赖用 `after` 显式声明；汇聚节点列出全部上游。
- 数据边用上游 `outputs.<port>.to: "<downstream>.in:<port>"` 表达。
- 分支优先用 `skip_if` 守卫两个终止分支；不要让未选分支继续产生副作用。
- 每个节点只保留完成职责所需的输入和输出，不复制整份上下文。
- 失败必须有结构化错误字段；禁止把失败写成成功。

### 4. 写节点角色提示

每个 agent 节点的 `role_prompt` 必须包含：

- 当前角色和单一职责。
- 可调用工具及参数来源。
- 失败时如何如实返回。
- 最终输出 JSON 的端口名和字段结构。
- “最终回复必须是一个 JSON 对象，键严格等于端口名，不得有 Markdown 代码块、解释文字或额外键。”

输出值优先使用直接 JSON 对象；为兼容既有下游而使用 JSON 字符串时，要在提示中明确说明字符串内部结构。

### 5. 校验

先生成完整 YAML 字符串，再调用：

```text
dag_validate(yaml="<完整 YAML>")
```

只有同时满足以下条件才能继续：

- 返回 `ok: true`。
- 没有循环依赖、未知节点、无效表达式或输入类型错误。
- 每个 agent 节点有 `agent` 和 `outputs`（终止节点可用空目标端口）。
- 所有 `to` 指向的节点和端口真实存在。
- 所有 Agent 和工具已通过第 2 步核对。

`dag_validate` 只证明结构和拓扑有效，不证明 Agent、工具、业务口径或外部连接可用。

### 6. 落盘与确认

仅当用户本次明确要求创建/修改时：

1. 使用 `write` 写入工作区内的 `agentops/workflows/<workflow_id>.yaml`。
2. 重新读取文件，确认内容没有被截断或替换。
3. 再次调用 `dag_catalog`，确认该 id 出现且状态有效。
4. 向用户报告：文件路径、输入契约、节点拓扑、校验结果、未执行状态。

如果当前 workspace 中不存在 `agentops/workflows/`，停止写入并向用户确认 AgentOps 工作区路径。

## YAML 骨架

```yaml
workflow_id: example-flow
name: 示例业务流程
version: 1
description: |
  这个流程解决什么问题，按什么顺序产出什么。

inputs:
  - name: topic
    type: string
    required: true
    description: 本次任务主题

nodes:
  process:
    name: 处理任务
    type: agent
    agent: manager
    business_role: 流程执行员
    after: []
    timeout_seconds: 180
    outputs:
      result:
        to: "report.in:result"
    role_prompt: |
      你是流程执行员，负责完成本次处理。

      最终回复必须是一个 JSON 对象：
      {"result": {"status": "ok", "data": "<处理结果>"}}

  report:
    name: 生成结果
    type: agent
    agent: manager
    business_role: 结果撰写员
    after: [process]
    timeout_seconds: 120
    outputs:
      answer: ""
    role_prompt: |
      根据上游 result 生成最终回答。
      失败时如实说明，不要编造。

      最终回复必须是一个 JSON 对象：
      {"answer": "<最终答复>"}
```

将示例中的 `manager` 替换为经过核对的业务 Agent。

## 运行时约束

- 顶层输入类型只支持 `string`、`integer`、`number`、`boolean`、`array`。
- 输入名必须唯一；默认值必须符合声明类型。
- 节点 `outputs` 的键就是模型必须返回的 JSON 键。
- 终止节点也应有交付端口，例如 `answer: ""`，否则终端交付为空。
- 节点级 `inputs` 在当前 DSH loader 中不是数据路由机制；不要依赖它传值，使用顶层输入、上游输出和 `after`/`outputs`。
- 不要依赖 `{{workspace.root}}`；当前 DSH 工作流 prompt 没有稳定暴露该变量。使用当前会话 workspace 内的相对文件路径。
- 默认不要在节点上覆盖 `model` 或 `harness`，继承 Agent preset，避免 provider 漂移。
- `layout`、`workspace` 等 UI 辅助字段不能替代运行语义。

详细字段和表达式契约见 `references/dsh-yaml-contract.md`。

## 生产审查

落盘前逐项检查 `references/production-review.md`：

- 查重完成。
- Agent 与工具存在且权限足够。
- 输入契约稳定。
- 拓扑无环、依赖完整。
- 每个端口有明确消费者。
- 失败路径不伪造成功。
- `dag_validate` 通过。
- 外部副作用已由用户明确授权。
- 创建后未自动执行。

## 参考

- `references/dsh-yaml-contract.md`
- `references/patterns.md`
- `references/production-review.md`
- 现有样例：`agentops/workflows/log-patrol.yaml`
- 现有样例：`agentops/workflows/log-puller.yaml`
- 现有样例：`agentops/workflows/smart-query.yaml`