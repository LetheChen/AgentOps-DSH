# DSH 工作流 YAML 契约

本文以当前 `@agentops/dsh-dag` 的 loader、validator 和 executor 为准。不要沿用旧 AgentOps 的 `command`、`gateway`、`handoff` 或 `output_files` 假设。

## 顶层字段

```yaml
workflow_id: unique-kebab-id
name: 中文名称
version: 1
description: |
  业务目标、适用边界、节点拓扑摘要。
inputs: []
nodes: {}
```

- `workflow_id` 必填；缺失时 loader 会尝试用 `id` 或 `name`，生产工作流不要依赖该回退。
- `version` 是业务修订号，建议每次兼容性修改递增。
- `inputs` 省略时为空数组。
- `nodes` 必填，支持 mapping 或带 `id` 的 list；生产工作流统一使用 mapping。
- `layout`、`workspace` 可作为 UI 辅助信息保留，但当前执行器不把它们作为节点运行参数。不要用 `{{workspace.root}}` 生成生产文件路径。

## inputs

```yaml
inputs:
  - name: log_task_id
    type: string
    required: true
    description: 日志采集任务 ID
  - name: level
    type: string
    required: false
    default: ERROR
```

- 类型只支持：`string`、`integer`、`number`、`boolean`、`array`。
- 不支持 `object`。
- `required` 必须是布尔值。
- 输入名必须唯一。
- `default` 必须符合声明类型，并且可无损 JSON 序列化。
- 未声明的输入会被运行入口拒绝。

## agent 节点

```yaml
node_id:
  name: 中文节点名
  type: agent
  agent: agent_preset_id
  business_role: 业务角色
  after: []
  timeout_seconds: 120
  outputs:
    port_name:
      to: "downstream.in:port_name"
  role_prompt: |
    ...
```

字段规则：

- `type` 省略时默认 `agent`；生产工作流显式写 `agent`。
- `agent` 必填。当前执行器不会接受 `inline_agent`。
- `business_role` 用于活动视图和节点标识；失败诊断也会用到。
- `after` 是调度依赖，不是数据边。汇聚节点必须列出全部上游。
- `timeout_seconds` 必须是正数。
- `model` 和 `harness` 支持覆盖，但生产工作流默认继承 Agent preset；节点级覆盖必须有明确理由并通过实际运行验证。
- 节点级 `inputs` 不是当前 DSH loader 的运行路由字段。数据通过顶层输入、上游输出和 `outputs.to` 传递；不要依靠 `inputs` 改变执行语义。

## outputs 与数据边

单目标：

```yaml
outputs:
  result:
    to: "report.in:result"
```

多目标：

```yaml
outputs:
  result:
    to:
      - "report.in:result"
      - "notify.in:result"
```

终止端口：

```yaml
outputs:
  answer: ""
```

约束：

- 每个 `to` 必须指向存在的下游节点。
- 下游 prompt 会收到上游节点输出 JSON，端口名必须稳定一致。
- 终止节点至少保留一个交付端口；否则终结交付为空。
- 不要在 DSH 工作流中使用 `handoff` 工具；交接由 DAG 引擎完成。

## 节点输出协议

执行器会为节点声明的端口建立严格输出 schema：

- 最终回复必须是单个 JSON 对象。
- JSON 的键必须恰好等于 `outputs` 的键。
- 不允许 Markdown 代码块。
- 不允许解释文字。
- 不允许额外键。
- 无端口的节点最终回复必须是 `{}`。

推荐在 `role_prompt` 中明确写出：

```text
最终回复必须是一个 JSON 对象：{"result": {...}}。
不得包含代码块、解释文字或额外键。
```

优先直接输出嵌套对象。兼容既有消费者时可以输出 JSON 字符串，但必须明确字符串内部结构。

## 表达式与分支

当前支持的常用守卫是 `skip_if`：

```yaml
skip_if: "{{not route_intent.intent}}"
```

规则：

- 表达式读取运行输入或上游端口。
- 只使用验证器接受的比较、布尔和字段访问语法。
- 分支节点必须各自有明确终止输出。
- 不要靠 `gateway.condition` 设计新生产流程；当前节点执行器只执行 `agent` 节点。
- `command`、`gateway`、`parallel_branch`、`while` 目前即使能通过部分解析/校验，也没有对应生产执行器，禁止用于新建工作流。

## 校验工具

```text
dag_validate(yaml="<完整 YAML 字符串>")
```

返回值至少检查：

- YAML 可解析。
- 节点 id 唯一。
- 所有 `after` 引用存在。
- 所有 `to` 目标存在。
- 拓扑无环。
- `inputs` 名称、类型和默认值有效。
- `skip_if` 等表达式可解析。
- 能计算执行层级。

校验通过不代表：

- Agent preset 存在。
- 工具真的挂载在 Agent 上。
- 数据源、通知通道、SSH 实例可用。
- 业务口径正确。
- 外部副作用安全。

以上必须额外取证。

## 工作流目录

生产工作流写入当前 AgentOps 工作区的：

```text
agentops/workflows/<workflow_id>.yaml
```

写入前必须确认该文件不存在，或用户明确授权覆盖。写入后必须用 `dag_catalog` 确认可发现且有效。