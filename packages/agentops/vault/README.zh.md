---
description: "AgentOps 凭据库：SQLite 保存连接元信息，密文用 AES-256-GCM 并以 AAD 绑定。"
kind: "package-reference"
---

# @agentops/dsh-vault

[English](README.md) | 中文

## 概述

连接元信息存在 SQLite；密码用 AES-256-GCM 封装并通过 AAD 绑定到记录，把密文复制到另一行会解不开而不是静默生效。读取不返回密文：调用方必须显式索取，得到的是仅供当前操作使用的一次性字符串。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

存取连接密文时使用；返回的值不得记录或序列化。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/store.ts` | 连接记录与密文读取 |
| `src/crypto.ts` | 密钥加载、封装与解封 |
| `src/probe.ts` | 凭据界面的连接探测 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../security/`](../security/README.zh.md) — 共享该 profile 的安全域

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **密钥文件与数据库放在一起** — 主密钥能防住被复制的数据库文件，防不住能读取整个 home 目录的人。
- **AAD 仍是 `kind:id:password`** — 端点、用户名与凭据版本尚未绑定；AAD v2 迁移待做。
- **回退路径按包而异** — 本包与 task/knowledge 包对缺失 home 的处理不同，未设 `DSH_HOME` 时会静默分裂状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
