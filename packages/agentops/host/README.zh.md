---
description: "AgentOps 宿主路由：Agent、调度、归档、表面、会话回放与工具目录端点，集中在一个插件里。"
kind: "package-reference"
---

# @agentops/dsh-host

[English](README.md) | 中文

## 概述

本包是 Agent 管理界面的读取侧。它扫描旧的 `config/agents/*.yaml` 目录，暴露调度与归档元信息，发布客户端渲染所需的表面清单，并提供旧工具目录及其 DSH 迁移目标。目录型与文件型路由只在部署提供对应目录或文件时才注册，因此未配置的 profile 不提供数据，而不是在请求时才失败。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

提供 Agent 管理读取时使用；写入走迁移契约包。

本包提供以下路由：

| 路由 | 返回内容 |
|---|---|
| `GET /api/agentops/agents` | 从指定 YAML 目录读取的 Agent 目录 |
| `GET /api/agentops/schedules` | 调度记录及其归档元信息 |
| `GET /api/agentops/archive` | Agent 产出的文件 |
| `GET /api/agentops/surfaces` | 生成式 UI 表面清单 |
| `GET /api/agentops/tools` | 旧工具目录及每个工具的 DSH 迁移目标 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/agents.ts` | 基于旧 YAML 目录的 Agent 目录路由 |
| `src/schedules.ts` | 调度与归档读取 |
| `src/tool-catalog.ts` | 权限矩阵所用的工具目录与 DSH 迁移目标 |
| `src/dsh.ts` | 插件入口与路由注册 |

工具目录来自 `agentops/mappings/tool-map.yaml`，其中列出每个旧工具的显示名、描述、允许的业务域与是否需要人工审批，并给出替代它的 DSH 插件与工具。没有 DSH 对应物的工具带一条 `note` 说明原因。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../client/`](../client/README.zh.md) — 消费这些路由的面板

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **目录型路由需要配置** — 只有 `agentDir`、`schedulesFile`、`archiveDir` 非空时 `/agents`、`/schedules`、`/archive` 才注册。
- **工具目录路由需要配置** — 只有 `toolMapFile`（或 `AGENTOPS_TOOL_MAP_FILE`）非空时 `/tools` 才注册。
- **工具映射文件非法时提供空目录** — 无法解析的 YAML 返回空目录而不是「部署缺失」，页面因此显示无工具，而不是声称部署不存在。
- **只读** — 本包从不写 Agent YAML；保存需要走迁移契约路径。
- **SurfaceStore 从不关闭** — 表面注册表在整个进程生命周期内持有存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
