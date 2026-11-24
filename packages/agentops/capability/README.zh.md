---
description: "定义 AgentOps 能力、连接器实例与 Agent preset 绑定，加密保存凭证并解析一个已授权运行实例。"
kind: "package-reference"
---

# @agentops/dsh-capability

[English](README.md) | 中文

## 概述

本包用于承载 AgentOps 能力中心，并为工具解析可用连接器实例。能力定义描述能力；实例保存部署配置、访问策略与加密凭证；preset 绑定决定 Agent 能调用哪些实例。工具目录区分已接 handler 的可运行工具与仅完成接口声明的条目。数据库绑定必须至少授权一张表，运行解析会拒绝缺失、歧义、停用、能力不匹配或无法解密的实例。控制面状态变化、审计和 outbox 在同一事务提交。

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
| `src/probe.ts` | SQLite/MySQL/PostgreSQL、SSH、Webhook、飞书文档与致远 OA 的真实连接探测 |
| `src/ssh2.ts` | 对 `ssh2` CommonJS 导出的具名访问，包含 `Server` |
| `src/mount-rpc.ts` | 已认证 `/api` RPC 通道与精确浏览器 bridge |
| `src/runtime.ts` | root-owned 运行服务与 preset 作用域解析函数 |
| `src/auth.ts` | 通用 token 端点声明：逐参数位置、身份来源、无效值与 token 提取 |
| `src/token-broker.ts` | 按实例、凭证版本与请求身份缓存 token，并按作用域失效 |
| `src/rest.ts` | 自动注入 token、401 时按身份重新获取并重试一次的 REST 传输 |
| `src/feishu-tools.ts` | preset 作用域的飞书云空间目录与云文档读取工具 |
| `src/notify-tools.ts` | preset 作用域的飞书与企业微信群通知工具 |
| `src/oa-affairs.ts` | 致远 OA 身份、路由、响应归一、分页与客户端过滤 |
| `src/oa-tools.ts` | preset 作用域的致远 OA 事项工具 |

能力实例的 `auth` 声明 token 获取、请求身份绑定与 token 传输方式。token 参数可分别放在 JSON、表单或 query 中，来源可以是加密凭证、实例配置或 `subject.memberCode` 一类请求身份；声明的无效 token 会在缓存前拒绝。broker 按实例、凭证版本、认证声明与身份缓存，因此切换查询用户不会复用其他用户的 token。REST 传输自动注入 token，并在 401 时按同一身份重新获取一次后重试。

实例测试会走与运行期工具相同的认证和传输路径；OA 探测会获取 token 并读取一条待办，飞书文档探测会通过飞书或 Lark 官方 API 获取 tenant token 并读取一页云空间。缺失身份、缺失 token 端点、账号无权限或 App 凭证无效都会在 Agent 使用实例前暴露。没有运行探测的接口类型会明确返回未接入，而不是伪造成功。内置定义目录每次打开都会幂等同步，但部署数据不参与刷新。工具目录区分 `runtime_tool` 与 `interface`；只有本仓库实际拥有可调用 handler 时才置 `runtime_available=true`。实例、凭证明文、审计和 outbox 在同一事务提交。页面行不带凭证引用或密文。运行解析会拒绝缺失、歧义、停用、能力不匹配和无法解密的实例；列表形式会打开每个启用中的已授权实例并跳过停用项；绑定替换也会拒绝未配置可访问表的启用中数据库实例。
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

通过 preset 作用域的 OA 事项、飞书云文档与通知工具，以及 profile 级 DSH browser-use provider 提供能力。

#### KV Cache 影响

preset 作用域工具与 DSH 浏览器 provider 负责自己的模型参数与渲染结果；能力存储和控制面不增加模型可见文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **旧数据迁移尚未完成** — AgentOps Fernet 凭证和既有 `audit.db` 行需要独立迁移切片。
- **运行覆盖仍属部分完成** — 数据库查询工具、OA 事项工具和飞书云文档目录/正文读取已消费 preset 作用域的能力实例；DSH browser-use 通过 `@agentops/dsh-browser` 在 profile 层提供。天眼查、飞书电子表格与文档写入仍需接线。
- **运行期 token 端点只声明、不自动发现** — 运行期 REST 工具自行声明 token 来源；OA 与飞书文档已具备认证加业务探测。
- **OA 权限通过实例选择** — 每个 REST 凭证或上游权限场景建立一个 OA 能力实例；preset 绑定决定 Agent 可解析哪一个。
- **OA 工具只覆盖协同事项** — 当前支持待办与已办；公文、表单读取以及需要单点登录 ticket 的事项盒尚未接入。
- **删除不等待活跃轮次** — 已经解析快照的会话可能继续持有实例数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
