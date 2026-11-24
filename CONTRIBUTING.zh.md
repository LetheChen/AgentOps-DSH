# 贡献

[English](CONTRIBUTING.md) | 中文

AgentOps-DSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的开源衍生项目。本文件说明本衍生仓库的贡献方式。改动 DSH 核心本身的贡献应提交到上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)；`packages/agentops/` 与 `agentops/` 之下的一切由本仓库负责。

## 开始之前

除 bug 修复以外，先开 issue。这样我们能在你投入精力之前就设计达成一致，也能让变更历史保持可读。

如果是安全问题，不要开公开 issue，请按 [SECURITY.md](SECURITY.zh.md) 处理。

## 开发环境

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
```

仓库需要 Node.js 24.9 或更高版本，以及 pnpm workspace。`pnpm run build` 产出类型检查与测试套件所依赖的产物；改动过 `packages/` 下的内容后，请先跑它再跑 `pnpm run typecheck` 或 `pnpm run test`。

## 代码分布

| 路径 | 内容 |
| --- | --- |
| `packages/agentops/**` | AgentOps 插件。每个目录是一个 `@deepseek-ai/dsh-*` workspace 包。 |
| `agentops/` | 部署资产，以及本衍生仓库的改动追踪清单。 |
| `docs/`、`website/` | 上游 DSH 文档及其站点投影。 |
| `vendor/` | 上游 Cordis 包的固定版本副本。 |

## 变更规则

1. Agent 行为写进 `packages/agentops/` 下的插件包。不要改 agent loop；如果需要新的扩展点，就在同一个改动里加上它并更新 `docs/architecture.md`。
2. `packages/agentops/` 或 `agentops/` 下的改动属于 AgentOps 自有。改动 DSH 核心文件则不属于，必须登记到 `agentops/CORE-PATHS.txt`，并在 `agentops/DSH-CORE-CHANGES.md` 记录原因、测试与回滚方式。
3. 能用 profile、bundle 或 preset 表达的改动，一律不要改 DSH 文件。
4. 推送前跑 `node agentops/scripts/check-owned-paths.mjs`。`UNEXPECTED` 必须为 0。
5. 在改动行为的同一个提交里，更新受影响的 README 与 JSDoc 契约。

完整约定见 [AGENTS.md](AGENTS.md)，请在第一次改动前读完。

## 检查

跑覆盖你改动的最小检查集，并且只报告实际跑过的命令：

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run doc-sync
```

CI 的覆盖率门禁是 `pnpm run test:coverage` 而不是 `pnpm run test`；穷尽的矩阵由 CI 负责。如果你的改动对模型或产品用户可见，请在同一个 pull request 里更新 `snapshots/` 下的录制会话快照。

## Pull request

按 `.github/pull_request_template.md` 填写。说明动机、改动与测试设计——包括测试证明了什么、以及是怎么跑的。一个 pull request 只做一件事；如果发现问题应该改在引入它的那次提交上，不要在上层再叠一个修正。

## 升级 DSH

本衍生仓库通过基线标签与改动台账跟踪上游，流程见 [agentops/UPGRADE.md](agentops/UPGRADE.md)。

## 行为准则

参与本项目须遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.zh.md)。

## 许可证

AgentOps-DSH 与上游 DSH 一样采用 MIT 许可证。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
