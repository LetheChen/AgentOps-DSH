# AgentOps-DSH

**中文** | [English](#english)

AgentOps-DSH 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的开源 AgentOps 发行版，属于衍生项目，并非 DeepSeek AI 官方发布。AgentOps 包位于 [`packages/agentops/`](packages/agentops/)，部署资产位于 [`agentops/`](agentops/)。

## 中文

### 产品总览

**AgentOps-DSH / SupAgent** 是一个开源的多智能体办公调度与治理工作台。用户只面对一个 Manager，由它把工作派发给知识、问数、OA、运维、日志、任务、编码、内容与调研 Agent。

#### 核心亮点

- **一个入口，多 Agent 协作**：Manager 负责理解意图、拆解任务并派发给受限业务 Agent。
- **可执行工作流**：支持手动运行、定时运行，也支持编写、校验并固化为可复用的 DAG YAML。
- **办公能力集成**：知识库、数据库问数、OA、飞书、企业微信、SSH 日志采集与 Skill。
- **治理与证据链**：凭证加密、连接器授权、运行日志、会话回放与控制面审计。
- **插件化装配**：所有能力都以 DSH 插件包形式组合，而非堆进单一聊天上下文。

#### 快速开始

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
pnpm dsh web
```

容器部署见 [`packages/agentops/deploy/README.zh.md`](packages/agentops/deploy/README.zh.md)。

#### 当前状态

已落地：Manager 派发、DAG 执行、知识库、能力中心、只读数据库问数、定时计划和可观测性。部分落地：任务中心、SSH 日志采集、OA/飞书集成。项目仍在迁移期，不应宣传为企业级零信任平台。

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

### 开发者预览

AgentOps-DSH 处于 _开发者预览_ 阶段，正在快速迭代，其所基于的上游 DeepSeek Harness 亦然。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

### 运行

<a id="run"></a>

#### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

#### 从源码运行

<a id="run-from-source"></a>

如需从仓库源码运行：

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### 社区与支持

- 通过 [GitHub Issues](https://github.com/LetheChen/AgentOps-DSH/issues) 报告 AgentOps-DSH 的缺陷与功能需求。
- 针对 DeepSeek Harness 本身的反馈，请通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

### 参与贡献

参见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

### 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

### 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

### 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

[中文](#agentops-dsh) | **English**

AgentOps-DSH is an open-source distribution of AgentOps built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is a derivative project and is not an official DeepSeek AI release. AgentOps packages live under [`packages/agentops/`](packages/agentops/), and deployment assets live under [`agentops/`](agentops/).

### Product overview

**AgentOps-DSH / SupAgent** is an open-source multi-agent office orchestration and governance workbench. One Manager entry point dispatches work to specialized agents for knowledge, data querying, OA, operations, logs, tasks, coding, content, and research.

#### Highlights

- **One entry, many agents** — the Manager decomposes intent and delegates to constrained business agents.
- **Executable workflows** — manually run, schedule, or author and validate reusable DAG YAML.
- **Integrated office capabilities** — knowledge, database query, OA, Feishu, WeCom, SSH log collection, and skills.
- **Governance and evidence** — encrypted credentials, scoped connectors, run logs, session replay, and control-plane audit.
- **Plugin-native** — every capability is assembled as a DSH plugin package.

#### Quick start

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
pnpm dsh web
```

For container deployment, see [`packages/agentops/deploy/README.md`](packages/agentops/deploy/README.md).

#### Status

Implemented: Manager dispatch, DAG execution, knowledge base, capability center, read-only database query, schedules, and observability. Partial: task center, SSH log collection, and OA/Feishu integrations. This project is under active migration and is not yet an enterprise zero-trust platform.

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

### Developer preview

AgentOps-DSH is in _developer preview_ and iterating rapidly, as is the upstream DeepSeek Harness it builds on. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

### Run

#### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

#### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Community and support

- Report AgentOps-DSH defects and feature requests through [GitHub Issues](https://github.com/LetheChen/AgentOps-DSH/issues).
- Submit feedback about DeepSeek Harness itself through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

### Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

### Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

### License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
