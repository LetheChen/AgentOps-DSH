# agentops/ —— AgentOps 在 DSH 仓库里的自有目录

[English](README.md) | 中文

这个目录是 **AgentOps 项目在 DSH 仓库中的唯一入口**：治理清单、基线记录、升级流程、检查脚本。
代码本体在 `packages/agentops/**`（被 `pnpm-workspace.yaml` 的 `packages/*/*` 自动纳入 workspace）。

## 文件

| 文件 | 作用 |
|---|---|
| [`OWNED-PATHS.txt`](./OWNED-PATHS.txt) | 自有路径白名单（`packages/agentops/`、`agentops/`） |
| [`CORE-PATHS.txt`](./CORE-PATHS.txt) | 经登记的 DSH 核心源码改动（我们改过的 DSH 代码） |
| [`INTEGRATION-PATHS.txt`](./INTEGRATION-PATHS.txt) | 接入 workspace 必需的 DSH 文件（tsconfig ×2 + pnpm-lock） |
| [`ENV-ARTIFACTS.txt`](./ENV-ARTIFACTS.txt) | 检出造成的 symlink/权限差异（blob 相同） |
| [`DSH-BASELINE.md`](./DSH-BASELINE.md) | 基线坐标、基线怎么来的、历史深度怎么补 |
| [`DSH-CORE-CHANGES.md`](./DSH-CORE-CHANGES.md) | CORE 核心改动与 INTEGRATION 构建接入台账 |
| [`UPGRADE.md`](./UPGRADE.md) | DSH 升级 SOP（禁止覆盖式拷贝） |
| [`scripts/check-owned-paths.mjs`](./scripts/check-owned-paths.mjs) | 五类变更检查，UNEXPECTED ≠ 0 时退出码 1 |

## 迁移资产

| 目录 | 内容 | 消费方 |
|---|---|---|
| `agents/` | 20 份 Agent YAML 定义 | Agent 目录、preset 生成器 |
| `workflows/` | 16 份工作流 YAML 定义 | 工作流列表、YAML 编辑器、DAG 运行 |
| `domains/` | 9 份业务域 YAML，带 Agent 默认值 | `GET /api/agentops/domains`、Agent 身份页 |
| `actors/` | 7 份 Actor Profile，按 `<id>/actor_visual_profile.json` 存放 | `GET /api/agentops/actors`、协作页 Actor 汇总 |
| `mappings/` | 工具与知识库迁移映射 | 工具目录、preset 生成器 |

bundle 把 `domainDir` 指向 `$DSH_HOME/agentops/domains`，把 `actorDir` 指向
`$DSH_HOME/agentops/actors`。部署 seed 会把两个目录复制到数据卷；目录缺失时按空注册表读取，
文件非法时保留为带校验问题的条目。

## 一条命令看清"五类内容"

```powershell
node agentops/scripts/check-owned-paths.mjs
```

脚本把 HEAD 与基线标签 `agentops-baseline` 比较，每一类输出一行：

```text
OWNED
CORE
INTEGRATION
ENV-ARTIFACT
UNEXPECTED
```

`UNEXPECTED` 必须恒为 0：所有改动都要落进已登记的四类之一。要跟别的上游点比较，用 `--base <ref>`。

## 纪律

1. **AgentOps 自有代码**只放 `OWNED-PATHS.txt` 登记的前缀；这是未来 `subtree split` 的边界。
2. **能通过 profile / bundle / preset 解决的，不许改 DSH 文件**。
3. 确实必须修改 DSH 通用源码时，路径同时登记到 `CORE-PATHS.txt` 和 `DSH-CORE-CHANGES.md`，并附原因、测试与回滚方式。
4. 构建接入文件放 `INTEGRATION-PATHS.txt`，不得伪装成 CORE；环境差异放 `ENV-ARTIFACTS.txt`。
5. 升级只走 `UPGRADE.md`；禁止把上游目录整体覆盖进来（会删掉 `packages/agentops`）。
6. `agentops/` 只放治理与资产，**不要**在这里放需要被 Loader 解析的插件包（那些必须放 `packages/agentops/*`，preset 行只认包名）。
