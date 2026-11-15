---
description: "AgentOps 容器部署资产：Docker 构建上下文、compose 服务、bootstrap 软链，以及容器挂载的部署补丁。"
kind: "package-reference"
---

# @agentops/deploy

[English](README.md) | 中文

## 概述

本目录保存 AgentOps 在 DSH 上的容器部署形态：Dockerfile、compose 文件、把包装进 profile 的 bootstrap，以及挂载到 `/etc/agentops/agentops.patch.yml` 的补丁。它没有 JavaScript 入口；部署方消费这些文件，而不是导入代码。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在仓库根构建，然后启动 compose 服务：

```bash
docker build -f packages/agentops/deploy/Dockerfile -t agentops-dsh .
docker compose -f packages/agentops/deploy/docker-compose.yml up -d
```

Web 入口为 `http://<host>:3080`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>容器布局与补丁形态——点击展开</summary>

| 路径 | 作用 |
|---|---|
| `/app` | 构建后的 DSH 工作区 |
| `/data/dsh` | `DSH_HOME`：profile、存储以及 seed 后的运行目录 |
| `/data/dsh/agentops/agents` | 运行时 Agent YAML，首次启动时从镜像 seed |
| `/data/dsh/agentops/workflows` | 运行时工作流 YAML，首次启动时从镜像 seed |
| `/data/dsh/agentops/mappings` | 工具与知识库迁移映射，从镜像 seed |
| `/data/dsh/agentops/domains` | Agent 身份页读取的业务域默认值 |
| `/data/dsh/agentops/actors` | 协作页 Actor 汇总读取的 Actor Profile |
| `/data/agentops-outputs` | Agent 产物，只读挂载供归档界面扫描 |
| `/app/agentops/agents`、`/app/agentops/workflows`、`/app/agentops/mappings`、`/app/agentops/domains`、`/app/agentops/actors` | 镜像携带的默认迁移资产 |
| `/etc/agentops/agentops.patch.yml` | 挂载的部署补丁：绝对路径根行加 preset 包名 |
| `/app/packages/agentops/bundle/presets/agents.generated.patch.yml` | 作为第二层补丁应用的生成式 Agent preset |

根行指向镜像内的 `/app/packages/agentops/*/lib/index.js`。preset 行位于 Agent 作用域，必须按包名解析，因此 `bootstrap.mjs` 会把包软链到 `$DSH_HOME/profiles/<profile>/node_modules/@agentops/*`。每次启动都会把镜像资产 seed 到 `$DSH_HOME/agentops`，不覆盖已有文件，然后把两层补丁都传给 `dsh web`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../bundle/`](../bundle/README.zh.md) —— 本部署挂载的分发 bundle。
- [`../README.md`](../README.zh.md) —— 包组总览。

-----

<a id="model-experience"></a>
## 模型体验

无。本目录提供部署文件，不构造模型输入。

#### KV 缓存影响

无；这里既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **compose 只有一个服务** —— `docker-compose.yml` 仅定义 `dsh` 服务，而早先的文案描述过第二容器（sidecar）；以 compose 文件为准。
- **seed 保留本地修改** —— 默认启动不覆盖已有 Agent 或工作流文件；需要替换时显式编辑文件，或带 `--force` 运行 seed 脚本。
- **CI 不构建镜像** —— 部署补丁与 Dockerfile 靠阅读评审，没有门禁真正构建它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
