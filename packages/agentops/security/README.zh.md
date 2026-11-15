---
description: "AgentOps 安全域：用户、角色、会话、API Token、用量、审计与只读路由。"
kind: "package-reference"
---

# @agentops/dsh-security

[English](README.md) | 中文

## 概述

本包存储主体、角色、会话、API Token 描述、用量记录与审计事件，并为 AgentOps 的安全、用量、审计和监控界面提供七条只读 GET 路由。写操作保留在单独挂载的受审计工具中。授权判定本身在调用方，因此忘记检查权限的路由不会被这里拦下。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

安全域读取与存储时使用；授权仍在路由或工具层，写工具需单独挂载。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/store.ts` | 主体、角色、会话、用量与审计表 |
| `src/http.ts` | 七条只读 GET 路由，包括四个安全页面与监控 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../vault/`](../vault/README.zh.md) — 该 profile 共用的连接注册表

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **HTTP 安全面只读** — 用户、角色、会话与 Token 页面不提供变更界面或 HTTP 写路由。创建用户与修改状态、分配角色、签发 Token 都走受审计的 Agent 工具；`security_token_issue` 由 AgentOps tools preset 与部署挂载，明文只返回一次。
- **角色创建与会话生命周期没有生产写入方** — 角色分配已有受审计工具，但只有测试会创建角色或开始、结束会话。
- **平行的身份模型** — 这些表复制了 DSH 的身份体系，而非扩展它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
