# 三个页面与旧项目的业务对照

本文把旧 AgentOps 前端的 Agent 管理、工作流管理、协作可视化三页与 DSH 侧实现逐项对上。
对照基准是旧仓库 `<legacy-repo>\web\src\pages\` 与 `api/server.py` 的路由，
新侧是 `packages/agentops/client/src/client/` 与 `packages/agentops/host`、`packages/agentops/dag` 的已注册端点。

状态分三档：

- **已迁移**：旧页面的主流程在 DSH 页面里可完成，字段含义一致。
- **语义不同**：页面提供了同等目的的能力，但数据来源或粒度与旧实现不同，使用时需要知道差别。
- **缺失**：旧页面有、DSH 侧目前没有等价能力。

## Agent 管理

| 旧端点 | DSH 端点 | 页面位置 | 状态 |
|---|---|---|---|
| `GET /api/agent/agents` | `GET /api/agentops/agents` | 目录卡片与搜索筛选 | 已迁移 |
| `GET /api/agent/agents/{id}` | `POST /api/agentops/agents/detail` | 编辑抽屉加载完整定义 | 已迁移 |
| `POST /api/agent/agents` | `POST /api/agentops/agents/create` | 新建 Agent | 已迁移 |
| `PUT /api/agent/agents/{id}` | `POST /api/agentops/agents/update` | 保存 Agent | 已迁移 |
| `DELETE /api/agent/agents/{id}` | `POST /api/agentops/agents/delete` | 删除 Agent | 已迁移 |
| `GET /api/agent/domains` | `GET /api/agentops/domains` | 业务域区块、领域筛选、身份页默认值 | 已迁移 |
| `GET /api/agent/tools` | `GET /api/agentops/tools` | 权限页工具目录 | 语义不同 |
| `GET /api/agent/agents/{id}/stats` | 客户端聚合 `GET /api/agentops/runs?workflowId=` | 运行页统计 | 语义不同 |
| `GET /api/runtime/summary` | 无等价端点 | 模型级联下拉改由 `GET /api/agentops/models` 提供 | 语义不同 |

Agent 编辑仍是旧项目的五个页签：身份、职责、权限、知识、运行。DSH 侧新增了两处旧页面没有的行为：

- 身份页选中一个已注册业务域后，显示该域的默认 Harness、模型、允许/禁止工具、知识库与成本上限；
  新建 Agent 时可直接应用这些默认值。
- 目录页单独展示业务域注册表，包括显示名、描述、默认值与解析问题，并提供按域筛选。

工具目录的语义差别：旧 `/api/agent/tools` 返回运行时注册的工具，新 `/api/agentops/tools` 返回
`agentops/mappings/tool-map.yaml` 里的迁移目录。它回答「旧工具迁移到了哪个 DSH 工具」，
不能当作当前会话已注册工具的列表使用。权限页已就地说明这一点。

运行统计的语义差别：旧端点按 Agent ID 聚合运行记录，并返回 token 与成本。DSH 的运行表没有
Agent ID、token 与成本字段，因此新页面按该 Agent 绑定的工作流 id 聚合运行状态，
只显示运行总数、各状态计数与最近一次运行；token 与成本不显示，编辑页已说明原因。

## 工作流管理

| 旧端点 | DSH 端点 | 页面位置 | 状态 |
|---|---|---|---|
| `GET /api/agent/workflows` | `GET /api/agentops/workflows` | 工作流列表、筛选、画布 | 已迁移 |
| `GET /api/agent/workflows/{id}` | `POST /api/agentops/workflow-edit` | 打开编辑器 | 已迁移 |
| `POST /api/agent/workflows/parse` | `POST /api/agentops/workflow-validate` | YAML 实时校验 | 已迁移 |
| `POST /api/agent/workflows` | `POST /api/agentops/workflow-create` | 新建工作流 | 已迁移 |
| `PUT /api/agent/workflows/{id}` | `POST /api/agentops/workflow-save` | 保存工作流 | 已迁移 |
| `DELETE /api/agent/workflows/{id}` | `POST /api/agentops/workflow-delete` | 删除工作流 | 已迁移 |
| `POST /api/agent/run` | `POST /api/agentops/workflow-run` | 运行工作流 | 已迁移 |
| `GET /api/audit/runs?workflow_id=` | `GET /api/agentops/runs?workflowId=` | 工作流运行历史 | 已迁移 |

旧页面没有只读 DAG 画布；DSH 侧新增了按层级排布、区分调度边与数据边的只读画布，
并从依赖图定位到 YAML 校验问题。工作流页的编辑、校验、运行主流程保持不变。

## 协作可视化

| 旧端点 | DSH 端点 | 页面位置 | 状态 |
|---|---|---|---|
| `GET /api/audit/runs` | `GET /api/agentops/runs` | 运行选择与分页 | 已迁移 |
| `GET /api/audit/runs/{id}/summary` | `GET /api/agentops/run-activity?id=` | 运行摘要 | 已迁移 |
| `GET /api/audit/runs/{id}/collaboration-graph` | `GET /api/agentops/run-activity?id=` | 依赖图、泳道图、Actor 汇总 | 已迁移 |
| `GET /api/audit/runs/{id}/collaboration-graph/timeline` | `GET /api/agentops/run-activity?id=` | 时间线 | 已迁移 |
| `GET /api/audit/runs/{id}/events` | `GET /api/agentops/run-activity?id=` | 重建后的时间线 | 语义不同 |
| `GET /api/actors` | `GET /api/agentops/actors` | Actor Profile 与允许发布的视图 | 已迁移 |
| `POST /api/agent/runs/{id}/resume` | `POST /api/agentops/workflow-rerun` | 节点重跑 | 语义不同 |
| `GET /api/audit/runs/{id}/nodes/{node}/detail` | 无等价端点 | 节点详情面板 | 缺失 |

协作页面的四个旧视图收敛为四个页签：依赖图、泳道图、Actor 汇总、时间线。依赖图默认打开。
Actor 汇总页顶部新增 Actor Profile 区块，展示每个 Actor 允许发布的 view id、输出契约、
前置阶段与字段数量；未注册或解析失败的 Profile 也会显示，并标明问题。

事件端点的语义差别：旧 `/events` 返回原始事件流，新页面消费宿主重建的持久化时间线，
更适合直接渲染；需要逐条原始事件的分析能力不在页面上提供。

重跑语义的差别：旧 `/resume` 会重跑整次运行并复用同一个 run id；DSH 的
`workflow-rerun` 按节点重跑，并产生新的运行记录。页面在重跑确认框里说明了作用范围。

节点详情的缺口：旧页面能按节点读取单独的 detail 端点。DSH 的活动载荷已经包含节点的
输入、输出、状态、耗时与错误，页面能显示这些字段；缺失的是旧端点额外返回的调试级明细。

## 数据资产

三个页面依赖的旧项目资产已经迁入仓库：

| 资产 | 位置 | 数量 |
|---|---|---|
| 业务域 | `agentops/domains/*.yaml` | 9 |
| Actor Profile | `agentops/actors/<id>/actor_visual_profile.json` | 7 |
| Agent 定义 | `agentops/agents/*.yaml` | 20 |
| 工作流定义 | `agentops/workflows/*.yaml` | 16 |

运行时由 `packages/agentops/bundle/cordis.patch.yml` 指向 `$DSH_HOME/agentops/domains`
与 `$DSH_HOME/agentops/actors`，部署镜像由 `packages/agentops/deploy/seed-agentops.mjs`
把这两个目录 seed 到数据卷。宿主把缺失目录当作空注册表，把非法文件保留为带问题的条目。

## 验收方式

三个页面都必须连真实宿主验证，不能只看构建产物：

1. Agent 管理：目录出现业务域区块；新建 Agent 时选择业务域并应用默认值；保存后卡片显示新值。
2. 工作流管理：列表、画布、YAML 编辑器、校验与运行入口都能打开。
3. 协作可视化：运行列表可加载；Actor 汇总页出现 Actor Profile 区块；时间线与节点详情可切换。

服务以 `agentops` profile、3092 端口启动时，页面必须使用同一 Cookie 会话访问
`/api/agentops/*`；直接用 `?token=` 调 API 会返回 401。
