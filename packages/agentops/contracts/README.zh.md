---
description: "面向 AgentOps 消费者的 Agent 与工作流定义解析、校验、序列化及边规则。"
kind: "package-library"
---

# @agentops/dsh-contracts

[English](README.md) | 中文

## 概述

当 AgentOps 读取或写入 Agent 与工作流 YAML 时，本库是共享的定义层。它把 snake_case YAML 与 camelCase API 值解析为不可变类型，报告结构问题，并提供唯一的调度边与数据边辅助函数。采用本库后，管理 API、图视图和 DAG 编译器遵循同一套边规则。`serializeAgentDefinition` 会写全每个字段（包括 `tier`），因此保存不会静默改变 Agent 的权限级别。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 使用此包

在 Agent 管理 API、工作流编辑器、YAML 加载器和 DAG 编译器中使用它；不要从原始定义重新推导依赖。

### 入口

```ts
import { parseWorkflowDefinition, scheduleDependencies } from '@agentops/dsh-contracts'

declare const rawWorkflow: string

const parsed = parseWorkflowDefinition(rawWorkflow)
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))

const firstNode = parsed.value.nodes.at(0)
const upstream = firstNode === undefined ? [] : scheduleDependencies(firstNode)
```

硬校验失败会携带字段路径与消息。成功结果在应用非致命兜底时也会携带 `issues`。`dataEdges()` 返回独立的数据流视图，`serializeAgentDefinition()` 写出完整 Agent 记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`scheduleDependencies()` 只返回 `node.after`；`dataEdges()` 只返回 `node.outputs`。`topoLayers()` 使用同一份 `after` 列表，因此数据边永不延迟执行。解析器在 YAML 或 API 边界校验引用、环路和产物模板。

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 不可变 Agent、工作流、校验与边类型 |
| [`src/schema.ts`](src/schema.ts) | 解析、边推导、分层与序列化 |
| [`src/index.ts`](src/index.ts) | 公共模块导出 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工作区布局](../workspace-layout/README.zh.md) — 解析此处生成的业务相对产物模板。
- [AgentOps 迁移决策](../../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.zh.md) — 记录迁移约束与验收计划。

-----

<a id="model-experience"></a>
## 模型体验

无；本包只解析和序列化 Agent 与工作流定义，不构造模型输入。

#### KV Cache 影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

本包在明确边规则的同时保留旧加载行为。

- **Tier 兜底不是校验失败**——缺失或未知的 `tier` 会变成 `T2`，并向成功结果添加一条 issue，调用方可以告警而不必拒绝定义。
- **两套键拼写**——解析器接受 snake_case 与 camelCase，序列化始终写出 snake_case。
- **不支持的节点能力会报告**——解析器会报告 `condition`、`branches`、`body` 等字段，以及 `agent` 以外的节点类型，让编辑器显示源码行，而不是静默把节点当成 agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
