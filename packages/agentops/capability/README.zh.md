---
description: "定义 AgentOps 能力、连接器实例与 Agent preset 绑定，加密保存凭证并解析一个已授权运行实例。"
kind: "package-reference"
---

# @agentops/dsh-capability

[English](README.md) | 中文

## 概述

本包用于承载 AgentOps 能力中心，并为工具解析唯一可用的连接器实例。能力定义描述平台支持什么；实例保存部署配置、访问策略与加密凭证；preset 绑定决定 Agent 能调用哪些实例；数据库实例在绑定前必须至少授权一张可访问表，表白名单为空的数据库实例会被仓储拒绝。静态工具目录区分已接 handler 的可运行工具与仅完成接口声明的 MCP / CLI / REST / Webhook，避免 UI 把未桥接接口误标成可调用。重开已有数据库会原位刷新内置定义，同时保留实例、绑定、凭证和审计。每次控制面状态变化还会在同一 SQLite 事务中写入审计和 outbox。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载 root 插件；root 会发布 `capabilityRuntime` 服务，preset 作用域内的工具通过执行 Agent 的 preset 调用 `resolveSet`。需要单实例解析时使用 `resolveCapabilityForTool`。

### 何时选择

需要 AgentOps 连接器实例、加密凭证、Agent preset 绑定与运行期实例解析时使用。只需要通用连接存储和探测时使用 `@agentops/dsh-vault`。

### 最小配置

```yaml
- id: agentops-capability
  name: '@agentops/dsh-capability'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dbPath` | `$DSH_HOME/agentops/capabilities.db` | 能力控制面数据库。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部结构 — 点击展开</summary>

| 文件 | 责任 |
|---|---|
| `src/schema.ts` | 能力定义、实例、绑定、审计与 outbox 的版本化表 |
| `src/store.ts` | 事务写入、凭证安全投影、绑定替换与运行解析 |
| `src/http.ts` | 传输无关的能力、实例、真实连接测试、SSH 主机指纹、数据库表清单、绑定、工具目录与审计路由 |
| `src/probe.ts` | 数据库实例的真实 SQLite/MySQL/PostgreSQL 连接探测、表清单读取，以及不读取凭证的 SSH 主机指纹读取 |
| `src/ssh2.ts` | 对 `ssh2` CommonJS 导出的具名访问，包含 `Server` |
| `src/mount-rpc.ts` | 已认证 `/api` RPC 通道与精确浏览器 bridge |
| `src/runtime.ts` | root-owned 运行服务与 preset 作用域解析函数 |

实例测试会解密已保存凭证并实际连接数据库；没有运行探测的接口类型会明确返回未接入，而不是伪造成功。内置定义目录每次打开都会幂等同步，但部署数据不参与刷新。实例测试会解密已保存凭证并实际连接数据库；没有运行探测的接口类型会明确返回未接入，而不是伪造成功。工具目录区分 `runtime_tool` 与 `interface`；只有本仓库实际拥有可调用 handler 时才置 `runtime_available=true`。实例、凭证明文、审计和 outbox 在同一事务提交。页面行不带凭证引用或密文。运行解析会拒绝缺失、歧义、停用、能力不匹配和无法解密的实例；列表形式会打开每个启用中的已授权实例并跳过停用项；绑定替换也会拒绝未配置可访问表的启用中数据库实例。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [`../vault/`](../vault/README.zh.md) — 能力凭证复用的 AES-256-GCM 加密
- [`../db/`](../db/README.zh.md) — 消费已授权运行目标的数据库工具
- [`../client/`](../client/README.zh.md) — 更完整的 AgentOps Web GUI

-----

<a id="model-experience"></a>
## 模型体验

无；本包只投影控制面数据并为 handler 解析数据，不构造模型输入。

#### KV Cache 影响

无；本包既不构造也不发送模型请求。

## 已知限制与后续工作

- **旧数据迁移尚未完成** — AgentOps Fernet 凭证和既有 `audit.db` 行需要独立迁移切片。
- **运行覆盖仍属部分完成** — 数据库查询工具已消费 preset 作用域的能力实例；浏览器、通知、SSH 与外部 HTTP 适配器仍需各自接入 resolver。
- **删除不等待活跃轮次** — 已经解析快照的会话可能继续持有实例数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
