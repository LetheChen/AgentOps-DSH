---
description: "浏览并操作 AgentOps 能力定义、连接器实例、凭证状态、测试结果、Agent preset 绑定、日志采集、业务部署和控制面审计。"
kind: "package-reference"
---

# @agentops/dsh-ui-capability

[English](README.md) | 中文

## 概述

本插件在 DSH Web GUI 中提供独立的能力中心页面。它展示能力定义与连接器实例，显示凭证是否配置但不回显凭证，支持由 schema 驱动实例创建、编辑、删除和测试，并提供高级 JSON 兜底；同时从真实 preset roster 维护选中 Agent preset 的绑定，展示可搜索的工具目录与明确的运行/接口状态，并提供日志采集、业务部署和控制面审计页面。所有数据与变更均来自能力 RPC 接口。

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

与 `@agentops/dsh-capability` 一起挂载；本插件注册能力中心、日志采集、业务部署和控制面审计主面板。

### 何时选择

profile 需要 AgentOps 能力中心页面时使用。需要整套 AgentOps 面板而不是单页时使用 `@agentops/dsh-client`。

### 最小配置

```yaml
- id: agentops-ui-capability
  name: '@agentops/dsh-ui-capability'
```

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部结构 — 点击展开</summary>

| 文件 | 责任 |
|---|---|
| `src/client/index.ts` | 主面板注册 |
| `src/client/api.ts` | 能力 RPC bridge 的类型化调用 |
| `src/client/panel.tsx` | 能力卡片、实例表、可搜索工具目录、表单与绑定 |
| `src/client/deployment-panel.tsx` | 业务部署与构建实例配置 |`r`n| `src/client/audit-panel.tsx` | 控制面审计表格与汇总 |
| `src/client/style.css` | 使用 DSH 主题变量的页面布局 |

实例配置字段来自 `configSchema`；select 的选项约束引擎与认证值，数字/布尔/数组在提交前完成类型换算，高级 JSON 保留给旧实例或表单未声明字段。能力页面每次变更后重新读取同一仓储快照，因此实例与绑定通过同一路由收敛；审计页面另行读取最近的控制面事件。授权按能力分组；停用实例以及未配置可访问表的启用中数据库实例不可勾选。密码字段留空时保留已存凭证。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [`../capability/`](../capability/README.zh.md) — 领域仓储、路由与运行解析
- [`../client/`](../client/README.zh.md) — 更完整的 AgentOps Web GUI

-----

<a id="model-experience"></a>
## 模型体验

无；本包只渲染能力中心页面，不构造模型输入。

#### KV Cache 影响

无；本包既不构造也不发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **中文产品文案直接写在面板中** — 尚未接入 DSH 多语言字典。
- **绑定按 preset 全局生效** — 尚未提供工作流级覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
