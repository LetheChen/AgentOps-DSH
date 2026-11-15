---
description: "AgentOps 包组：packages/agentops/ 下已移植的能力，供读者选择或浏览这一族。"
kind: "package-group"
---

# agentops/ —— 以 DSH 插件形式移植的 AgentOps 能力

[English](README.md) | 中文

## 概述

AgentOps 的业务能力以普通插件的形式运行在 DSH 内。运行环境、模型供应商与模型凭据使用 DSH 原生能力，因此不再有重复的 AgentOps 运行时页面或 API；其余业务界面保留既有布局与交互。每个能力对应这里的一个包，由 `@agentops/dsh-bundle` 按 profile 装配。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 负责 |
|---|---|
| [`@agentops/dsh-contracts`](contracts/README.zh.md) | Agent 与工作流定义的解析、校验、序列化，以及唯一的边规则 |
| [`@agentops/dsh-workspace-layout`](workspace-layout/README.zh.md) | Session cwd 下的规范产物目录与包含校验 |
| [`@agentops/dsh-host`](host/README.zh.md) | Agent 目录、调度、归档、表面、会话回放与工具目录路由 |
| [`@agentops/dsh-dag`](dag/README.zh.md) | 工作流校验、分层调度，每个节点一个 subagent |
| [`@agentops/dsh-db`](db/README.zh.md) | 表白名单之后的只读审计查询 |
| [`@agentops/dsh-knowledge`](knowledge/README.zh.md) | 知识空间、分块、BM25 检索与模型工具 |
| [`@agentops/dsh-security`](security/README.zh.md) | 用户、角色、会话、用量与审计流 |
| [`@agentops/dsh-task`](task/README.zh.md) | 十四态任务生命周期、事件历史与工具 |
| [`@agentops/dsh-vault`](vault/README.zh.md) | 连接注册表与 AES-256-GCM 封装的密文 |
| [`@agentops/dsh-client`](client/README.zh.md) | 上述能力的 Web GUI 面板 |
| [`@agentops/dsh-bundle`](bundle/README.zh.md) | profile 挂载的补丁集 |
| [`deploy/`](deploy/README.zh.md) | 容器构建、compose 文件与部署补丁 |

<a id="related-documentation"></a>
## 相关文档

- [AgentOps 产物布局](../../docs/subsystems/agentops.zh.md) —— 这些包共享的工作区目录契约。
- [迁移决策](../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.zh.md) —— 已接受的约束与验收计划。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

这个包组仍在迁移中。`contracts` 与 `workspace-layout` 是新增的，遵循当前的文档与测试门禁；较早的包在门禁存在之前就已移植，因此部分仍带硬编码中文、没有 UI 测试，并用浏览器 `fetch` 而不是 Remote 调用。

</details>
