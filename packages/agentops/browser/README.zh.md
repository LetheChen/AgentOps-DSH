---
description: "可选的 AgentOps profile bundle，用于挂载 DSH browser-use 与 Chrome DevTools MCP provider。"
kind: "package-bundle"
---

# @agentops/dsh-browser

[English](README.md) | 中文

## 概述

需要让 AgentOps profile 暴露 DSH 原生浏览器工具时使用这个可选 bundle。它挂载 browser-use 服务和一个 Chrome DevTools MCP provider，不增加 AgentOps 专属浏览器操作。单独分层可以让 AgentOps 插件发布时不硬依赖某个具体浏览器 provider。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

安装路径是 profile 的 bundle 列表，因为本包声明了 `dsh.bundle.patch`，自身不含插件。在 profile 的 `dsh.profile.bundles` 中，把 `@agentops/dsh-browser` 放在 `@deepseek-ai/dsh-web-app` 之后、AgentOps 能力 bundle 之前。

```yaml
---
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
      - '@agentops/dsh-browser'
      - '@agentops/dsh-bundle'
```

### 你得到什么

默认 provider 为每个活动 Agent 启动一个隔离的无头 Chromium，模型工具名为 `mcp__chrome-devtools-mcp__*`。provider 选择和启动模式属于 profile，不属于 AgentOps 能力实例。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部结构 — 点击展开</summary>

| 文件 | 责任 |
|---|---|
| `cordis.patch.yml` | 挂载 `@deepseek-ai/dsh-browser-use` 与 Chrome DevTools MCP provider |

浏览器 provider 需要 DSH 的 Agents、tools、system-prompt 与 working-directory 服务。它每个进程只注册一个 provider，并为每个活动 Agent 创建一个浏览器 MCP 连接。Session 所有权、工具发现、截图投递和清理仍由 DSH 负责。

这个 bundle 故意与 `@agentops/dsh-bundle` 分开：纯 AgentOps 部署可以不装它，也可以替换 provider 而不改 AgentOps 能力代码。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../bundle/`](../bundle/README.zh.md) — 组装这个可选层的 AgentOps 发行 bundle。
- [`../../browser-use/browser-use/`](../../browser-use/browser-use/README.zh.md) — 本 bundle 挂载的 DSH browser-use 服务。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具与截图

#### 模型可见内容

AgentOps bundle 挂载 DSH browser-use provider，它为每个活动 Agent 注册一个 MCP server。工具保留上游描述与 JSON schema，名称为 `mcp__chrome-devtools-mcp__<tool>`；文本与截图走正常工具结果管线。

#### Token 影响

该目录、资源助手与服务端指令会增加工具定义与提示文本。每次调用把参数、文本与已接纳的图片加入 Session 历史。

#### KV Cache 影响

provider 目录不变时会保留工具定义前缀。浏览器结果追加到 Session 历史；更换 provider 或上游目录会降低前缀复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **每个进程只能有一个 provider** — DSH browser-use 会拒绝第二个 provider 注册。
- **上游工具属于实验性接口** — Chrome DevTools MCP 的 schema 跟随固定版本依赖。
- **能力实例不负责隔离** — provider 配置属于 profile；AgentOps 实例不能启动独立浏览器后端。
- **浏览器状态不写入历史** — 新建或恢复 Session 会重新启动浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
