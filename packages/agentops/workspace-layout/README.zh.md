---
description: "在选定 Session cwd 下为 Agent 与工作流产物生成规范目录并执行包含校验。"
kind: "package-reference"
---

# @agentops/dsh-workspace-layout

[English](README.md) | 中文

## 概述

本包提供 Cordis 服务和普通解析器，用于在选定 Session 工作区内放置 AgentOps 产物。它检查产物路径、业务 ID、作用域 ID 与规范化 `sessionCwd`，创建 Agent 或工作流运行目录，并拒绝解析到工作区外的任何路径。调用方获得规范绝对 `dir` 与 `file` 路径。解析器只创建作用域目录；安全写盘与不跟随链接的保证仍由消费者负责。

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

当 Agent 或工作流执行必须从 Session cwd 推导稳定产物位置时挂载此服务。调用方不应自行拼接业务 ID 或产物模板。

### 何时选择

需要规范 AgentOps 产物布局及其包含校验时选择它。它不是通用临时目录服务，也不写入产物内容。

### 最小配置

```yaml
- name: '@agentops/dsh-workspace-layout'
```

服务没有配置字段。`LayoutRequest` 携带产物请求；`LayoutPolicyRequest` 还携带待收窄的基线执行策略。所有随部署变化的选择因此在调用点保持显式。

### 解析一个产物

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@agentops/dsh-workspace-layout'

declare const ctx: Context
declare const sessionCwd: string

const { dir, file } = await ctx.workspaceLayout.resolve({
  sessionCwd,
  businessId: 'acme',
  scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1', nodeId: 'build' },
  artifact: 'logs/build.txt',
})
```

| 作用域 | 在规范 `sessionCwd` 下创建的目录 |
|---|---|
| Agent | `<businessId>/agents/<agentId>` |
| 工作流运行 | `<businessId>/workflows/<workflowId>/<runId>` |
| 工作流节点 | `<businessId>/workflows/<workflowId>/<runId>/nodes/<nodeId>` |

`resolveScope()` 只创建规范作用域目录并返回 `{ dir }`；`resolve()` 额外返回产物 `file`。`resolvePolicy()` 将策略根设为该目录并返回 `{ cwd, policy }`，其中 `cwd === policy.workspaceRoot`。返回的策略保留基线模式与可选 Session ID，并省略部署级额外可写根。发布子 agent 或工作流运行前，必须先把该策略持久化到所属 Session。

校验按以下顺序运行：

1. 产物必须是非空业务相对路径，不含盘符、绝对前缀、`..` 段或 NUL。
2. 业务 ID 与每个作用域 ID 必须是单个安全路径组件。
3. `sessionCwd` 必须是已存在的绝对目录。
4. 其规范 `realpath` 成为每个返回路径使用的包含基准。
5. 已存在祖先与新建目录都会针对该基准检查。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

解析器先用 `lstat` 与 `realpath` 检查最近的已存在祖先。悬空符号链接无法证明写入目标安全，因此会被拒绝。`mkdir` 后再次规范化目录，并用 `path.relative()` 检查 `dir` 与 `file`，避免字符串前缀碰撞通过包含校验。

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 布局请求、结果、错误码与作用域字段类型 |
| [`src/layout.ts`](src/layout.ts) | 校验、规范化、目录创建、包含检查与策略收窄 |
| [`src/index.ts`](src/index.ts) | Cordis 服务注册与公共导出 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Agent 与工作流契约](../contracts/README.zh.md) — 拥有 `isRelativeArtifactPath()` 以及此处接受的产物模板。
- [AgentOps 迁移决策](../../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.zh.md) — 记录工作区布局验收范围与沙箱后续工作。

-----

<a id="model-experience"></a>
## 模型体验

无；本包解析并校验产物路径，不构造模型输入。

#### KV Cache 影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

返回路径与包含校验在上述校验顺序内稳定；文件系统在此之后仍可能变化。

- **TOCTOU 仍然可能**——消费者必须使用可用的不跟随链接或安全写盘语义；并发参与者可在校验与后续写入之间替换父目录。
- **检查后拒绝无法撤销副作用**——若父目录在校验与 `mkdir` 之间被替换，解析器可以拒绝返回路径，但无法撤销已在工作区外创建的目录。
- **只创建作用域目录**——产物文件、嵌套产物父目录及其写入保证属于消费者。
- **工作区根目录必须已存在**——`sessionCwd` 会按已存在的绝对目录校验，且从不创建。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
