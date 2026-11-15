---
description: "把已校验的 AgentOps 工作流定义编译成 PTC 运行时执行的 DSH 工作流脚本。"
kind: "package-library"
---

# @agentops/dsh-workflow-compiler

[English](README.md) | 中文

## 概述

DSH 以 JavaScript 脚本执行工作流，而 AgentOps 以 YAML 存储工作流。本包连接两者：接收已校验的定义，产出 PTC 运行时求值的脚本，按 `after` 把节点分组成 `phase()`，并把多节点层变成一次 `parallel([...])` 屏障。把编译集中在一处，意味着无法编译的工作流在开跑之前就失败，而不是跑到一半才失败。

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

### 何时使用

编译一份已被 `parseWorkflowDefinition` 接受的：

```ts
import { compileWorkflow } from '@agentops/dsh-workflow-compiler'
import type { WorkflowDefinition } from '@agentops/dsh-contracts'

declare const definition: WorkflowDefinition

const compiled = compileWorkflow(definition, { model: { provider: 'minimax', id: 'MiniMax-M2.7' } })
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
// compiled.value.source  → evaluated by workflow-ptc
// compiled.value.layers  → node ids per layer, for the editor preview
// compiled.value.digest  → stable fingerprint for CAS and parity checks
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/compile.ts`](src/compile.ts) | 层遍历、源码生成与指纹 |
| [`src/index.ts`](src/index.ts) | 公开导出 |

分层来自 contracts 包的 `topoLayers()`，因此编译器不可能与校验对「依赖是什么」产生分歧。生成的函数体形如：

```js
phase("layer-0")
const node_scan = await agent("扫描日志", { label: "scan", phase: "layer-0" })
phase("layer-1")
const [node_left, node_right] = await parallel([
  () => agent("left", { label: "left", phase: "layer-1" }),
  () => agent("right", { label: "right", phase: "layer-1" }),
])
return { "scan": node_scan, "left": node_left, "right": node_right }
```

`parallel` 是屏障，正好等价于分层调度器「整层等齐」的语义。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../contracts/`](../contracts/README.zh.md) —— 本编译器消费的定义类型与边规则。
- [`../dag/`](../dag/README.zh.md) —— 生成脚本要替代的分层调度器。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只产出脚本文本，从不构造模型请求。

#### KV 缓存影响

无；没有任何模型请求经过本包。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **节点间没有数据流** —— 脚本会返回每个节点的结果，但不会把上游 `outputs` 的值喂进下游 prompt；端口接线仍待实现。
- **重试与超时已有实现，但尚未接线** —— `runNode()` 提供带指数退避的有界重试与单次尝试超时，但生成的脚本仍直接调用 `agent()`；把包装写进脚本是后续工作。
- **只用 `outputs` 的依赖会并行** —— 仅通过 `outputs` 声明依赖的节点会与生产者同层，这是既定契约，但在 YAML 里读起来反直觉。
- **模型提示是全局的** —— 一对 `provider`/`model` 作用于所有调用；节点级模型需要定义本身携带。
- **尚未接入 `workflow-ptc`** —— 本包只产出源码；在集成步骤落地之前没有东西调度它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

编译器存在的原因是 DSH 不接受「只有 YAML」：运行时求值的是脚本，所以 YAML 编辑器必须编译。把它放在独立包里，编辑器就能在不引入引擎的前提下展示 `digest` 与 `layers`。

</details>
