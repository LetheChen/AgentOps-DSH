---
description: "AgentOps 只读查询服务：在审计库之上的白名单 SQL 面。"
kind: "package-reference"
---

# @agentops/dsh-db

[English](README.md) | 中文

## 概述

本包在 AgentOps 审计库上回答只读问题。它提供白名单查询面、拒绝未登记的表，并为界面提供数据源元信息。这样模型拿不到任意 SQL，而报告仍能提出自己的问题。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

需要只读审计查询时使用；写入属于各领域包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/guard.ts` | 表白名单与 schema 校验 |
| `src/instances.ts` | 能力中心优先的实例解析与 AgentOps 访问策略归一化 |
| `src/query.ts` | SQLite / MySQL / PostgreSQL 执行与表结构读取 |
| `src/tools.ts` | 基于单一已解析实例的 `sql_query` 与 `describe_database` |
| `src/dsh.ts` | 插件入口与路由注册 |
| `src/datasources.ts` | 旧数据源元信息 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../vault/`](../vault/README.zh.md) — 本包读取的凭据库

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **白名单只校验带 schema 的引用** — 例如 `SELECT * FROM secrets` 这类裸表名目前会被放行；用 SQLite authorizer 取代字符串匹配仍待实现。
- **跨包引用源码** — 存储层直接引用 vault 包源码，而不是声明依赖。
- **元数据回退会写样例** — 数据源文件不可读时用生成的样例行替代，而不是显式失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
