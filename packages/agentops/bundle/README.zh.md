---
description: "AgentOps 分发 bundle：profile 挂载的根插件行、preset 工具行与部署接线。"
kind: "package-bundle"
---

# @agentops/dsh-bundle

[English](README.md) | 中文

## 概述

本包没有运行时 API。它的本体是 `cordis.patch.yml`：`agentops` profile 在 `dsh-base` 与 `dsh-web-app` 之上应用的补丁集。使用方读的是那个文件，不是这个模块。把补丁行放在这里，意味着增删一个 AgentOps 能力不需要改 DSH 核心包。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

组装 AgentOps profile，或核对某次部署实际挂载了哪些插件时使用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | 根插件行、目录配置与技能目录覆盖 |
| `presets/agentops-tools.patch.yml` | 承载模型可见 AgentOps 工具的共享 Agent preset |
| `presets/agents.generated.patch.yml` | 从 `agentops/agents/*.yaml` 生成的 Agent preset（每个作者面文件一行，含 `task_inbox`；仅 `manager` 可由用户直接选择） |
| `src/index.ts` | 空模块，让包有可解析的入口 |

`dsh.bundle.patch` 按根层、共享工具层、生成式 Agent 层的顺序应用。用 `node --import tsx agentops/scripts/gen-agent-presets.ts --write` 重新生成 Agent 层；`--check` 只校验已提交文件，不修改磁盘。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../deploy/`](../deploy/README.zh.md) — 挂载本 bundle 的容器部署补丁

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅以补丁形式分发** — 没有可导入的运行时 API；需要行为的使用方必须依赖真正的宿主包。
- **补丁行重复描述包的事实** — 插件名、peer 依赖与 preset 行在本地与各 `package.json` 各维护一份；统一 target manifest 仍待实现。
- **根行受 Agent 作用域限制** — 注入 `tools` 的根行不会执行，工具行必须放在 preset 层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
