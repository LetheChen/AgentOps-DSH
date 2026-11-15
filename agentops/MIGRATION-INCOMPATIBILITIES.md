# 迁移不兼容清单（T7-1）

原 AgentOps 项目的作者面资产（16 个 workflow + 20 个 agent）已全部迁入 `agentops/workflows/` 与
`agentops/agents/`。迁入不等于等价：下面每一条都是**读得到但用不了**或**读都读不了**的缺口，
按类别列出并给出判定依据。

复算命令：

```sh
node --import tsx agentops/scripts/verify-migration.ts          # 打印本清单的机读版
node --import tsx agentops/scripts/migrate-legacy-assets.ts --check   # 资产与迁移结果是否一致
```

硬失败（资产在 DSH 侧读不出来）当前为 **0**；下列全部是不兼容项。

## 摘要

| 类别 | 数量 | 影响面 | 运行时后果 |
|---|---|---|---|
| I1 工作流引用不存在的 agent | 18 处 / 4 个工作流 | example-greet、hello-world、hybrid-test、travel-expense | 节点启动即失败（无对应 preset） |
| I2 `command` 节点不执行 | 4 处 / 1 个工作流 | smart-query | 节点抛错并终止该次运行 |
| I3 工具未迁移 | 64 个工具 / 80 个 | 全部 20 个 agent | 工具不在 `only` 里，模型调不到 |
| I4 知识库未迁移 | 7 个 KB 键 | 7 个 agent | `readableSpaces` 为空，检索恒空 |
| I5 harness / model 改写 | 3 个 agent | coding_agent、proposal_planner、manager | 运行时语义由 DSH 接管，见下文 |
| I6 业务分类字段下线 | 16 个 workflow | 全部 | 无（原字段在 DSH 契约里不存在） |
| I7 历史运行指向已删工作流 | 187 / 189 条 | 运行历史、协作可视化 | 旧运行点开即 404 |
| I8 工具映射表格式升级 | v1 → v3 | 权限矩阵、工具目录 | 按旧字段解析的读取者取不到工具说明与域限制 |
| I9 业务域与 Actor Profile 端点字段差异 | 2 个端点 | Agent 身份页、协作 Actor 汇总 | 旧字段名或粒度不同，见下文 |

## I1 工作流引用了原项目里就不存在的 agent

这 18 个 `agent:` 引用在原项目 `config/agents/`（20 份）里**同样找不到**——不是迁移丢的，
是原项目自己就没写。四个工作流因此从来没能真正跑起来，属于 PoC / 示例文件。

| 工作流 | 引用不到的 agent | 节点 |
|---|---|---|
| example-greet | `content_curator` | generate、notify |
| hello-world | `echo_agent` | fetch、think、report |
| hybrid-test | `echo_agent` | fetch、analyze、report |
| travel-expense | `oa_data_fetcher`、`workflow_engine`、`corporate_travel_tool`、`oa_db_tool`、`attachment_router`、`vision_analyzer`、`prompt_assembler`、`auditor`、`result_splitter`、`reporter` | step1_fetch…step9_report |

DSH 侧的执行器按 `agentPreset: node.agentRef` 取 preset
（`packages/agentops/dag/src/dsh.ts:204`），没有 preset 的节点会在派生子代理时失败。

**处置**：这四个文件保留在目录里作为拓扑样例，但页面上的「运行」必须给出可解释的失败，
不能静默跑空。见 T7-4。

## I2 `command` 节点在 DSH 不可执行

`packages/agentops/dag/src/dsh.ts:190` 明确抛错：`command 节点 … 尚未在 DSH 中执行`。
受影响的是 smart-query 的 4 个节点：`resolve_schema`、`validate_sql`、`execute_query`、`refuse_intent`。

原项目用命令节点做 schema 探测、SQL 校验与执行；DSH 侧对应能力是 `sql_query` / `describe_database`
两个模型可调工具，需要把 workflow 改成 agent 节点后在 system prompt 里描述这四步。

**处置**：迁移阶段不改语义（改了就等于重写业务），列入 T7-4 的动作对拍。

## I3 工具未迁移

80 条工具记录里只有 16 条在 DSH 侧有等价物，其余 64 条在 `agentops/mappings/tool-map.yaml` 里
标 `mapped: null`，生成器不会把它们写进 preset 的 `only` 列表，模型调不到。

已映射的 16 个：

| 旧工具 | DSH 工具 |
|---|---|
| `bash` | `@deepseek-ai/dsh-tool-pwsh` 的 `pwsh` |
| `board_cleanup` | `@agentops/dsh-host/tools` 的 `board_cleanup` |
| `describe_database`、`sql_query` | `@agentops/dsh-db/tools` |
| `list_tasks`、`task_advance_stage`、`task_commit_stage`、`task_create_project`、`task_detail_get` | `@agentops/dsh-task/tools` |
| `present_content` | `@agentops/dsh-host/tools` |
| `query_kb`、`query_knowledge` | `@agentops/dsh-knowledge/tools` 的 `knowledge_search` |
| `read_file`、`write_file` | `@deepseek-ai/dsh-tool-fs` |
| `read_skill` | `@deepseek-ai/dsh-tool-skill` |
| `todo` | `@deepseek-ai/dsh-tool-todo` 的 `todo_write` |

按 agent 统计的缺口数：`manager` 24、`smart_query` 11、`smart_analysis` 10、`proposal_planner` 10、
`smart_ops` 10、`coding_agent` 9、`oa_assistant` 9、`smart_approval` 9、`smart_form` 9、
`task_dispatcher` 7、`task_conductor` 6、`task_decomposer` 6、`video_creator` 6、`task_monitor` 5、
`task_planner` 5、`log_puller` 4、`log_analyst` 3、`multi-agent-report` 3、`quality_inspector` 3、
`weekly-reporter` 3。

缺口集中在四个业务域：**运维（日志查询、告警推送、服务器运维）、审批与表单、任务编排的
认领/分解/派发子动作、视频生产的 MiniMax 专用工具**。逐条原因写在 `tool-map.yaml` 的 `note` 里。

`trigger_workflow` 是唯一一条「有近似物但故意不映射」的：旧工具触发另一条 workflow，
DSH 的 `dag_run` 只在当前会话跑 DAG，语义不同，映射过去会让 manager 触发错的东西。

## I4 知识库未迁移

7 个 KB 键（`shared_kb`、`smart_analysis_kb`、`smart_query_kb`、`smart_approval_kb`、
`smart_form_kb`、`smart_ops_kb`、`video_production`）在 `kb-map.yaml` 里一律 `space: null`，
生成器不写进 `readableSpaces`，检索恒空。DSH 侧目前只有 `finance` / `hr` / `ops` 三个 space，
与旧 KB 键对不上，等 KB 迁移批次建好 space 再回填。

## I5 harness 与 model 改写

| agent | 原值 | 迁入值 | 原因 |
|---|---|---|---|
| coding_agent | `harness: claude_code` | `local_llm` | DSH 契约的 harness 闭集里没有 `claude_code` |
| proposal_planner | `harness: claude_code` | `local_llm` | 同上 |
| manager | `harness: claude_sdk` | `local_llm` | 同上 |
| manager | `model.id: MiniMax-M3.1-Flash` | `MiniMax-M3` | profile 里 `MiniMax-M3.1-Flash` 没配 `contextWindow` / `maxTokens` |

`codex` harness（multi-agent-report、smart_ops、video_creator）在契约闭集内，原样保留。

**tier**：原项目只有 `log_analyst` 显式写了 `tier`，其余 19 个靠加载器兜底成 T2。
迁移脚本给每份文件显式补上 `tier: T2`——补的是同一个值，但从此不再依赖「缺失即兜底」，
这正是 P0-3（静默降权）的修法。校验脚本把「缺 tier」单独归为 `implicit-tier` 不兼容项（当前 0 条），与真正的硬失败分开计数。

## I6 业务分类字段下线

16 个 workflow 顶层都有 `business_category:`（智能办公 / 运维巡检 / 任务管理 / 内容生产 / 智能问数 /
示例测试）。DSH 的 workflow 契约没有这个字段，迁移时统一删除；工作流在页面上的归类改由
`workflowId` 前缀与描述决定，不再有独立分类轴。

## I7 历史运行记录指向已删除的工作流

`~/.dsh/agentops/runs.db` 里有 189 条历史运行，指向 10 个工作流 id。其中 `hello-world`（2 条）
本次已迁入，可以打开；其余 187 条指向原项目里已被删掉的工作流：

| 工作流 id | 运行条数 |
|---|---|
| `linear` | 178 |
| `ping` | 2 |
| `skill_to_task` | 1 |
| `parity-parallel` | 1 |
| `parity-linear` | 1 |
| `learn_generative_ui_skill` | 1 |
| `find-a2ui-components` | 1 |
| `discover` | 1 |
| `beijing-weather-probe` | 1 |

服务端行为是对的：`packages/agentops/dag/src/runs.ts:153` 对找不到定义的工作流返回
`workflow_missing` 404，不是前端 bug。

**处置**：T7-2 迁运行记录时按「定义已不存在」把这些运行归到「历史遗留」分组，
不删数据、不伪装成可重放。

## I8 工具映射表从 v1 升到 v3

`agentops/mappings/tool-map.yaml` 原先只记迁移结论：每条只有 `mapped` / `used_by` / 可选
`note`，`agents` 也只列了当时迁入的 5 个 agent。v3 给每条补上旧项目工具目录的真实元数据，
并把 agent 名单扩到本批 20 个。

新增字段由 `agentops/scripts/gen-tool-catalogue.ts` 从旧项目 `config/tools/*.yaml` 与
`api/server.py` 的 `_BUILTIN_TOOLS` 刷新，脚本只刷新这四个字段，不覆盖人工标注：

| 字段 | 含义 |
|---|---|
| `display_name` | 旧项目里的工具显示名 |
| `description` | 旧项目里的工具说明 |
| `allowed_domains` | 旧项目里限制的业务域 |
| `requires_human_approval` | 旧项目里是否需要人工审批 |

**消费方**：宿主新增 `GET /api/agentops/tools`（`packages/agentops/host/src/tool-catalog.ts`），
Agent 权限页据此显示工具说明、域限制、审批要求与迁移目标。

**不变量**：`mapped: null`（未迁移）的条目必须带 `note` 说明原因，否则权限矩阵会出现一个没有
解释的「未迁移」。这条不变量由 `agentops/tests/gen-tool-catalogue.test.ts` 守着。

**表规模**：80 条 = 76 条旧项目工具 + 4 条只出现在旧 agent 工具清单里、旧项目没有定义的 DSH 自带
工具（`handoff`、`present_content`、`todo`、`upsert_generated_view`）；16 条已映射，64 条未迁移。

## I9 业务域与 Actor Profile 的端点字段差异

旧项目的 9 份业务域 YAML 与 7 份 `actor_visual_profile.json` 已迁入 `agentops/domains/` 与
`agentops/actors/`，宿主新增 `GET /api/agentops/domains`、`GET /api/agentops/actors`。
两个端点都做了字段改名，旧读取者不能直接复用解析代码。

**业务域**：旧 `GET /api/agent/domains` 只返回 `domain`、`display_name`、`description`、
`default_harness`、`allowed_tools`、`denied_tools`。新端点改用 camelCase，并补齐
`defaultModel`、`defaultKnowledgeBases`、`costLimitPerRun`、`valid`、`issues`。
默认值没有丢失；按旧 snake_case 字段读取的调用方会得到 `undefined`。

**Actor Profile**：旧 `GET /api/actors` 返回每个 view 的完整 `fields` 约束；
新 `GET /api/agentops/actors` 返回 view 的 `viewId`、`outputContract`、`description`、
`requiredPhases` 与 `fieldCount`。页面只需要白名单与摘要，逐字段约束仍保存在源文件里，
需要时按文件读取，端点不重复传输。
