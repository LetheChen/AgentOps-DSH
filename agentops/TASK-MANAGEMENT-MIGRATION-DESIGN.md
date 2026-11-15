# AgentOps 任务管理与任务报告迁移设计规格

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-28（2026-11-07 修订 B） |
| 分支 | `agentops/main` |
| 状态 | 已红队审查并完成最小修订，待用户审阅 |
| 迁移来源 | `<legacy-repo>` 的任务管理、任务报告与导出实现 |
| 迁移目标 | DeepSeek Harness 内的 `@agentops/*` 插件、SQLite 数据库、HTTP API、Agent 工具与 Web UI |
| 兼容目标 | 保留功能的生命周期、数据语义、报告与导出行为等价恢复；执行载体改为 DSH Session；上游来源同步不迁移；不复刻旧 Python 内部分层和旧 UI 外观 |
| 审核记录 | [REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07](reviews/REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07.md) |
| 修订记录 | 见 [附录 A](#附录-a修订记录) |

## 1. 范围与成功标准

本迁移恢复旧 AgentOps 的任务管理模块，包括项目、任务、灵感、阶段、依赖、看板、仪表盘、甘特图、依赖网络图、全屏详情、评论、审批、验收标准、设计文档提案、活动、产物和正式任务报告。上游来源同步不属于本次恢复范围；依赖图按修订 E 以星图渲染。

任务的权威状态、版本、依赖关系、风险门禁、审批、验收和报告状态全部由新的 `TaskService` 独占管理。HTTP 路由、Agent 工具和 Web UI 只能通过受控命令修改这些数据，不能直接写 SQLite。

成功标准是旧系统能够完成的任务管理工作在保留功能上具有等价行为；执行过程按第 6.6 节替换为 Session 弱关联，上游来源同步不在本次范围。仅沿用旧的数据内容和交互结果，不沿用 Python 模块划分、FastAPI 路由实现、旧数据库初始化缺陷或旧前端视觉样式。

**执行过程可见性受 Session 生命周期约束。** `task_runs.session_id` 是指向 DSH Session 的不透明弱指针。任务详情可以通过现有 Session API 打开受持久化、profile 和清理策略约束的截断事件预览；该预览可能缺少已清理的 Session、截断单个事件并省略较早事件，不承诺完整推理过程或完整工具输出回放。任务模块不拥有、不代理会话内容，也不新增回放系统。

本次迁移不把 AgentOps 业务任务实现为 DSH Session projection。Session 保存模型可见上下文、工具调用与工具结果；业务任务单独保存在 AgentOps 任务数据库中，二者通过不透明 ID 弱关联。

本次迁移不把 AgentOps 任务合并到 DSH Agent Teams，也不复用 Session team task 作为任务真源。Agent Teams 负责执行期协作，AgentOps 任务负责项目交付、审批、版本和审计。

本次迁移不为每个 DAG 节点创建 Agent preset。DAG 节点描述工作单元，preset 描述 Agent 身份、模型、persona 与工具权限；多个节点复用同一 preset，执行期通过独立子智能体会话隔离上下文。

本次迁移不建立 AgentOps 数据库与 DSH Session 数据库之间的 SQL 外键。`run_id`、`session_id`、`terminal_session_id`、`thread_id` 和 `workspace_id` 都按不透明引用保存，由服务层校验可达性并在目标消失时保留历史记录。`ideas` 用 `channel` / `source_system` / `connector_ref` 描述来源，`source_ref` 保存外部标识。

## 2. 核心架构决策

DSH 是应用宿主，提供插件加载、Session、Agent、工具、客户端 slot、主题和 profile。AgentOps 任务是宿主内的业务能力，不反向修改 agent loop。

`TaskService` 是任务领域的目标唯一写入口。它负责生命周期转移、`if_version` 乐观锁、依赖与父链校验、用户审批门禁、验收门禁、报告审批、执行绑定和导出历史。

“唯一写入口”已经达成：`store.ts`、`tools.ts` 与旧端点均已删除，插件与 preset 工具都经 `TaskService` 写入；数据库约束仍是最后一道一致性保护，不替代服务层对错误码、权限和副作用顺序的编排。

`TaskService` 持有 SQLite 事务、查询和 schema 版本检查，不把业务状态交给数据库触发器决定。数据库约束是最后一道一致性保护，不能替代 `TaskService` 对错误码、用户权限和副作用顺序的编排。

`global_revision` 为客户端轮询提供单调版本。每张参与任务数据修订的表通过触发器递增该版本；`task_report_exports`、贡献表和 Agent 档案不参与该修订号。

模型可见的每次任务工具调用仍写入 Session 事件，因为工具参数与结果需要可重建。业务任务事件同时写入 `task_events`，供任务审计、详情页和报告使用。这两份日志用途不同，不互相替代。

任务与执行记录的关联采用弱引用：

```text
AgentOps task
  ├─ task_runs ─ run_id              -> DSH session/runtime 的不透明引用
  │             session_id           -> DSH Session 的不透明弱指针
  │             terminal_session_id  -> 旧终端执行的只读弱指针
  ├─ tasks.thread_id                 -> 会话线程的不透明引用
  ├─ tasks.source_idea_id            -> ideas 的不透明引用
  └─ projects.workspace_id           -> DSH Workspace 的不透明引用
```

任务数据库只对自身表建立 SQL 外键。跨数据库引用在读取时解析为可选关联；关联对象不存在时，任务记录、历史报告和导出仍然可读。

## 3. Agent preset 方案

### 3.1 结论

“每个任务节点参与一个 Agent，就为该节点创建一个 preset”不合理。节点数量和 preset 数量不应同构，否则会产生大量只差提示词的重复身份，破坏模型配置、权限审计和升级一致性。

preset 按真实职责拆分。任务节点通过执行配置选择 preset，并在节点输入中携带具体目标、约束和预期产物；执行配置的 preset 绑定持久化到 `task_stages.assigned_agent`。并行、串行、重试或不同层级的节点复用同一 preset；每次 spawn 仍是独立 Session 和独立上下文。

固定使用以下六个 preset：

| Preset | 职责 | 允许的节点类型 | 禁止行为 |
|---|---|---|---|
| `task_inbox` | 收件箱分诊（按 `kind` 与门槛把 `captured` 推到 `triaged`/`ready`）与就绪任务调度（领取、建立执行绑定、spawn 执行体） | intake、triage、dispatch、assignment | 不做分解规划，不审批、不验收、不关闭任务，不作为评论 mention 目标 |
| `task_planner` | 立项、需求澄清、方案讨论、拆解与计划产物 | idea、discussion、decomposition、planning | 不执行代码修改，不代替用户批准方案，不关闭任务 |
| `task_dispatcher` | 选择可执行任务、建立执行绑定、调度运行 | dispatch、assignment、execution routing | 不审批、不验收、不关闭任务，不作为评论 mention 目标 |
| `task_conductor` | 观察执行、维护阶段、收敛状态、触发归档建议 | orchestration、monitoring、completion coordination | 不越过用户审批边，不代替 quality inspector 给出验收结论 |
| `coding_agent` | 在隔离工作区执行代码、文档或数据产物 | implementation、artifact production | 不审批自己的报告，不关闭任务，不验收自己的产物 |
| `quality_inspector` | 只读验收、提出回退建议、提交验收结论 | validation、review、quality inspection | 不使用 `bash`、不写文件、不调用 `task_close`、不批准验收门禁 |

`task_decomposer` 折叠到 `task_planner`。拆解只是 planner 的一项能力，不是独立身份。

`task_monitor` 折叠到 `task_conductor`。执行监控只是 conductor 的一项能力，不是独立身份。

不得为这两个旧名称新增兼容 preset、别名 preset 或仅用于路由的占位 preset；旧配置在迁移时映射到新名称。

### 3.2 执行、并发与权限约束

Host 全局设置 `subagent.maxDepth = 2` 与 `subagent.maxActiveSubagents = 8`。`maxActiveSubagents` 按根父会话统计同时存活的子会话，不按 preset 分配；达到容量时 Host 直接返回 `ACTIVATION_LIMIT_REACHED`，不排队。允许的调用链是 conductor（depth 0）→ dispatcher（1）→ coding（2）；任何角色不得再向更深层派发。

| Preset | 可启动 | AgentOps 业务并发 |
|---|---|---:|
| `task_conductor` | planner / dispatcher / inbox / coding / inspector | 1 个控制流 |
| `task_inbox` | coding_agent | 最多 4 个任务执行，作为业务队列在 Host spawn 前检查；分诊与调度用两条短会话，不共用长期会话 |
| `task_dispatcher` | coding_agent | 最多 4 个任务执行，作为业务队列在 Host spawn 前检查 |
| `task_planner` | — | 1 |
| `coding_agent` | — | 同一任务 1 个活跃执行 |
| `quality_inspector` | — | 1 |

规则：

- 4 个执行槽位只属于 AgentOps 业务队列，不是 preset 或 Host 配置字段。队列满时等待；真正 spawn 时若 Host 已达 8 个活跃子会话，本次调用明确失败，不把 Host 拒绝伪装成排队。
- 同一任务只允许一个活跃 `task_run`，执行与验收串行；验收只能读取已提交的执行结果。重试与返工新增执行记录，不覆盖旧记录。
- 工具权限来自 preset 的插件组合和任务插件在 preset 内的 `only` 配置。现有 preset 组合没有按子智能体名称逐一过滤工具的白名单字段，本设计不新增该机制。
- `quality_inspector` 的插件组合只装配读取、`task_validate` 与 `task_rollback`；`task_validate` 写入验收结果或提交验收建议，`task_rollback` 在目标边不要求用户确认时才可执行。
- `task_close` 不暴露给任何 Agent preset；关闭只能走用户操作路径。

评论 mentions 的合法目标为 `coding_agent`、`task_planner`、`quality_inspector`、`task_conductor`。`task_dispatcher` 与 `task_inbox` 是内部执行角色，不接受评论 mention。

`agent_styles` 是运行期 overlay，不是新 preset。`style_id` 可以叠加 system prompt、denied tools 和 model 选择，但不得扩大 preset 的工具权限，也不得绕过用户审批、验收或关闭门禁。

### 3.3 DAG 绑定规则

任务节点由 `tasks` 行、`task_stages` 行和 `task_relations` 依赖共同表达；节点目标与描述来自 `tasks`，阶段输入输出落在 `task_stages.stage_input`/`stage_output`，preset 绑定落在 `task_stages.assigned_agent`，不透明 `style_id` 落在 `task_stages.style_id`。目标 schema 不新增独立 DAG 节点表或节点级 `agent_preset` 字段。节点不得保存一份内联工具白名单来绕过 preset；需要不同权限时，必须创建一个真实职责不同的 preset，并经过权限评审。

相同 preset 的并行节点各自获得独立 Agent Session；它们共享业务任务 ID，但不共享模型上下文。父节点只接收结构化完成结果和引用，不把子智能体的完整推理上下文复制回任务真源。

## 4. 生命周期

### 4.1 权威来源与修正

旧 `<legacy-repo>\task\status.py` 是状态、动作名称、`requires_user` 标志和终态集合的迁移依据。

旧 V1 注释声称有 45 条转移，但可执行 `TRANSITIONS` 表实际包含 52 条。迁移以实现中的 52 条边为准，并把该计数写入自动验收测试，防止后续再次依赖错误注释。

P0 和 V1 是两套不可过滤合并的生命周期。每条任务保存 `lifecycle_mode`，取值为 `p0` 或 `v1`。P0 只允许五个 P0 状态，V1 只允许十四状态；状态读取、转移建议、写入校验和 UI 动作都必须使用该任务自己的模式。

新任务默认 `lifecycle_mode = 'v1'`。导入旧 P0 数据时写 `p0`；导入旧 V1 数据时写 `v1`。生命周期模式创建后不可原地切换，确需升级模式时必须创建受审计的转换记录并通过专门迁移流程处理。

### 4.2 P0 五状态与九条边

P0 状态为 `idea`、`backlog`、`discussing`、`reviewing`、`closed`。终态为 `closed`，没有暂停态。

| # | 从 | 到 | 动作 | 需要用户 |
|---:|---|---|---|---|
| 1 | `idea` | `backlog` | 立项 | 否 |
| 2 | `backlog` | `discussing` | 触发方案讨论 | 否 |
| 3 | `discussing` | `reviewing` | 提交方案评审 | 否 |
| 4 | `reviewing` | `closed` | 评审通过，关闭任务 | 是 |
| 5 | `reviewing` | `backlog` | 退回立项 | 是 |
| 6 | `reviewing` | `discussing` | 退回讨论 | 是 |
| 7 | `idea` | `closed` | 废弃灵感 | 是 |
| 8 | `backlog` | `closed` | 取消待办 | 是 |
| 9 | `discussing` | `closed` | 取消讨论 | 是 |

### 4.3 V1 十四状态与五十二条边

V1 状态为 `idea`、`backlog`、`discussing`、`reviewing`、`decomposing`、`in_progress`、`validating`、`closing`、`closed`、`paused`、`blocked`、`failed`、`canceled`、`abandoned`。

V1 主链为 `idea → discussing → decomposing → reviewing → backlog → in_progress → validating → closing → closed`。终态为 `closed`、`canceled`、`abandoned`；可暂停态为 `in_progress`、`validating`。

下表中的 `U` 表示 `requires_user = true`。没有 `U` 的边可以由持有相应职责的 Agent 在生命周期规则允许时发起。

| # | 从 | 到 | 动作 | U |
|---:|---|---|---|:---:|
| 1 | `idea` | `discussing` | 用户审核立项 | U |
| 2 | `discussing` | `discussing` | 多轮讨论 |  |
| 3 | `discussing` | `decomposing` | 方案讨论完成，自动拆解 |  |
| 4 | `decomposing` | `reviewing` | 拆分完成，提交评审 |  |
| 5 | `reviewing` | `backlog` | 评审通过，入待办池 |  |
| 6 | `backlog` | `in_progress` | 调度 agent 执行 |  |
| 7 | `in_progress` | `in_progress` | 并行子任务调度 |  |
| 8 | `backlog` | `validating` | 子任务全部完成，父任务收尾 |  |
| 9 | `in_progress` | `validating` | agent 执行完成 |  |
| 10 | `validating` | `closing` | 验收通过 | U |
| 11 | `closing` | `closed` | 关闭（硬约束满足） |  |
| 12 | `reviewing` | `discussing` | 评审打回：方案有问题 | U |
| 13 | `reviewing` | `decomposing` | 评审打回：拆分不当 | U |
| 14 | `validating` | `in_progress` | local 执行偏差 | U |
| 15 | `validating` | `decomposing` | partial 拆解错 | U |
| 16 | `validating` | `discussing` | global 方案错 | U |
| 17 | `closing` | `validating` | 关闭前退回重验 | U |
| 18 | `closing` | `in_progress` | 关闭前退回执行 | U |
| 19 | `closing` | `decomposing` | 关闭前退回分解 | U |
| 20 | `closing` | `discussing` | 关闭前退回方案 | U |
| 21 | `backlog` | `discussing` | 退回讨论 | U |
| 22 | `backlog` | `idea` | 退回灵感重新讨论 | U |
| 23 | `in_progress` | `blocked` | 外部阻塞 |  |
| 24 | `validating` | `blocked` | 外部阻塞 |  |
| 25 | `blocked` | `in_progress` | 阻塞解除恢复 |  |
| 26 | `in_progress` | `paused` | 用户暂停 | U |
| 27 | `validating` | `paused` | 用户暂停 | U |
| 28 | `paused` | `in_progress` | 用户恢复 | U |
| 29 | `in_progress` | `failed` | agent 崩溃/超时 |  |
| 30 | `failed` | `in_progress` | 修复后重试 |  |
| 31 | `idea` | `canceled` | 用户取消 | U |
| 32 | `backlog` | `canceled` | 用户取消 | U |
| 33 | `discussing` | `canceled` | 用户取消 | U |
| 34 | `reviewing` | `canceled` | 用户取消 | U |
| 35 | `decomposing` | `canceled` | 用户取消 | U |
| 36 | `in_progress` | `canceled` | 用户取消 | U |
| 37 | `validating` | `canceled` | 用户取消 | U |
| 38 | `closing` | `canceled` | 用户取消 | U |
| 39 | `paused` | `canceled` | 用户取消 | U |
| 40 | `blocked` | `canceled` | 用户取消 | U |
| 41 | `failed` | `canceled` | 用户取消 | U |
| 42 | `idea` | `abandoned` | 30天无活动自动归档 |  |
| 43 | `backlog` | `abandoned` | 30天无活动自动归档 |  |
| 44 | `discussing` | `abandoned` | 30天无活动自动归档 |  |
| 45 | `reviewing` | `abandoned` | 30天无活动自动归档 |  |
| 46 | `decomposing` | `abandoned` | 30天无活动自动归档 |  |
| 47 | `in_progress` | `abandoned` | 30天无活动自动归档 |  |
| 48 | `validating` | `abandoned` | 30天无活动自动归档 |  |
| 49 | `closing` | `abandoned` | 30天无活动自动归档 |  |
| 50 | `paused` | `abandoned` | 30天无活动自动归档 |  |
| 51 | `blocked` | `abandoned` | 30天无活动自动归档 |  |
| 52 | `failed` | `abandoned` | 30天无活动自动归档 |  |

### 4.4 风险、拆解与关闭门禁

风险评审门槛保持旧规则：`low` 自动通过，`medium` 通知用户后放行，`high` 必须人工审批。Agent 不得把 `high` 风险任务自动标记为 approved。

拆解策略保持旧规则：`simple` 不拆分，`medium` 拆一层，`complex` 需要递归拆解。策略决定规划产物，不改变 V1 状态转移表。

进入 `closed` 前必须满足关闭门禁。存在验收标准时，所有标准必须为 `passed`；存在 `pending` 的设计文档变更提案时必须拒绝关闭。关闭按 `validating → closing → closed` 推进，不能跳过 `closing`。

评论请求修改时，review 评论、报告状态 `changes_requested` 与 rollback 必须在同一事务中全部成功或全部回滚，不能留下孤立评论或半更新报告。直接指定 `target_status` 时优先于 `local/partial/global` 别名。

用户审批必须由宿主可信主体和权限能力判定。请求体中的 `approvedByUser`、`actor_type = user` 或客户端声明的角色只能用于审计，不能作为授权依据。

## 5. 数据模型

### 5.0 存储拓扑

这是 DSH 上的重构，不是旧项目的延续性迁移：旧库只作为可选的一次性数据来源，新项目拥有自己的库名与 schema。

业务数据合并为**一个业务库** `agentops.db`（默认 `$DSH_HOME/agentops/agentops.db`），容纳任务、收件箱、项目、验收、评论、报告、运行绑定、agent 档案与风格、设计文档提案。理由是看板与统计需要"任务 × 项目 × agent"的跨表查询，且单库才能让迁移、备份与事务保持一致。

以下数据仍独立存放，因为它们的安全模型或体量与业务库不同：

| 库 | 内容 | 理由 |
|---|---|---|
| `security.db` | 用户、角色、会话、审计 | 鉴权边界独立，便于单独审计与轮换 |
| `credentials.db` | 凭证与密钥 | 与业务数据分开加密 |
| `knowledge.db` | 文档、分块、向量 | 体积大、可重建、更新频繁 |
| DSH Session 存储 | 会话日志 | 属于宿主，不归 AgentOps |

旧 `tasks.db`、`runs.db`、`surfaces.db` 不再新增文案；需要保留的历史数据按 §10 一次性导入业务库后归档。

### 5.1 目标表

目标任务数据库包含 21 张业务表。所有时间使用 ISO 8601 字符串，所有版本从 0 开始，所有布尔值使用 SQLite `INTEGER` 的 0/1。

| 表 | 字段 | 关键约束 |
|---|---|---|
| `global_revision` | `singleton INTEGER PRIMARY KEY`、`revision INTEGER NOT NULL DEFAULT 0` | `singleton = 1` 单行；`revision >= 0` |
| `projects` | `project_id TEXT PK`、`name TEXT NOT NULL`、`type TEXT NOT NULL DEFAULT 'code'`、`local_path TEXT`、`github_url TEXT`、`feishu_doc_token TEXT`、`workspace_id TEXT`、`next_task_number INTEGER NOT NULL DEFAULT 1`、`metadata TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL` | `type IN ('code','knowledge','hybrid')`；`workspace_id` 不建跨库外键；`metadata` 是 JSON |
| `tasks` | `task_id TEXT PK`、`project_id TEXT NOT NULL`、`lifecycle_mode TEXT NOT NULL DEFAULT 'v1'`、`identifier TEXT`、`parent_task_id TEXT`、`source_idea_id TEXT`、`title TEXT NOT NULL`、`description TEXT`、`status TEXT NOT NULL DEFAULT 'idea'`、`task_type TEXT NOT NULL DEFAULT 'code'`、`risk_level TEXT NOT NULL DEFAULT 'medium'`、`creator_type TEXT NOT NULL DEFAULT 'user'`、`creator_id TEXT`、`creator_name TEXT`、`assignee_type TEXT`、`assignee_id TEXT`、`assignee_name TEXT`、`style_id TEXT`、`sort_order REAL NOT NULL DEFAULT 0`、`thread_id TEXT`、`approved INTEGER`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL`、`closed_at TEXT`、`archived_at TEXT` | `project_id` 引用 `projects` 并级联删除；父任务删除后置空；`parent_task_id` 是父层级唯一事实来源；`task_type IN ('code','knowledge','design','hybrid')`；`risk_level IN ('low','medium','high')`；生命周期组合 CHECK 见 5.2 |
| `task_stages` | `stage_id TEXT PK`、`task_id TEXT NOT NULL`、`stage_type TEXT NOT NULL`、`status TEXT NOT NULL DEFAULT 'pending'`、`assigned_agent TEXT`、`style_id TEXT`、`stage_input TEXT`、`stage_output TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`started_at TEXT`、`committed_at TEXT` | `task_id` 引用 `tasks` 并级联删除；`status IN ('pending','running','committed','failed')`；输入输出是 JSON |
| `ideas` | `idea_id TEXT PK`、`project_id TEXT`、`channel TEXT NOT NULL DEFAULT 'manual'`、`source_system TEXT`、`connector_ref TEXT`、`source_ref TEXT`、`kind TEXT NOT NULL DEFAULT 'idea'`、`title TEXT`、`content TEXT NOT NULL`、`tags TEXT`、`status TEXT NOT NULL DEFAULT 'captured'`、`confidence TEXT NOT NULL DEFAULT 'medium'`、`priority TEXT NOT NULL DEFAULT 'P2'`、`raw_ref TEXT`、`content_hash TEXT`、`revision INTEGER NOT NULL DEFAULT 1`、`captured_at TEXT`、`converted_task_id TEXT`、`converted_idea_id TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL` | `channel IN ('manual','bot','agent','connector','agent_extract')`；`kind IN ('requirement','bug','doc','question','idea')`；`status IN ('captured','triaged','ready','converted','ignored','archived')`；`confidence IN ('high','medium','low')`；`priority IN ('P0','P1','P2')`；`source_system` 是配置校验的小写 slug（无 CHECK 枚举）；`connector_ref` 是弱引用；`raw_ref` 指向 spill/attachment；`project_id` 允许为空并由分诊补齐 |
| `task_relations` | `relation_id TEXT PK`、`relation_type TEXT NOT NULL`、`source_task_id TEXT NOT NULL`、`target_task_id TEXT NOT NULL`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL` | `relation_type IN ('parent','blocks','related')`；源与目标不得相同；两端引用任务并级联删除；`parent` 是 `tasks.parent_task_id` 的事务同步派生投影 |
| `task_events` | `event_id TEXT PK`、`task_id TEXT NOT NULL`、`stage_id TEXT`、`event_type TEXT NOT NULL`、`actor TEXT`、`payload TEXT`、`created_at TEXT NOT NULL` | 任务删除时级联删除；`payload` 是 JSON |
| `task_activities` | `activity_id TEXT PK`、`task_id TEXT NOT NULL`、`actor_type TEXT NOT NULL`、`actor_id TEXT`、`actor_name TEXT`、`changes TEXT`、`created_at TEXT NOT NULL` | `actor_type IN ('user','agent')`；`changes` 是 `{field: {before, after}}` JSON；任务删除时级联删除 |
| `task_artifacts` | `artifact_id TEXT PK`、`task_id TEXT NOT NULL`、`type TEXT NOT NULL`、`path TEXT`、`content_hash TEXT`、`description TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL` | `type IN ('code','doc','report','data')`；任务删除时级联删除 |
| `task_reports` | `report_id TEXT PK`、`task_id TEXT NOT NULL`、`agent_id TEXT`、`session_id TEXT`、`content TEXT NOT NULL`、`artifact_ids TEXT`、`acceptance_self_check TEXT`、`status TEXT NOT NULL DEFAULT 'submitted'`、`version INTEGER NOT NULL DEFAULT 0`、`submitted_at TEXT NOT NULL` | `status IN ('submitted','approved','changes_requested')`；`artifact_ids` 与 `acceptance_self_check` 是 JSON；`session_id` 是有效的弱引用 |
| `task_comments` | `comment_id TEXT PK`、`task_id TEXT NOT NULL`、`report_id TEXT`、`author_type TEXT NOT NULL`、`author_id TEXT`、`author_name TEXT`、`body TEXT NOT NULL`、`comment_type TEXT NOT NULL DEFAULT 'discussion'`、`decision TEXT`、`rollback_target TEXT`、`thread_id TEXT`、`mentions TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL` | `author_type IN ('user','agent')`；`comment_type IN ('report','review','discussion')`；`decision IN ('approve','request_changes',NULL)`；`mentions` 是 JSON 数组而不是独立表 |
| `acceptance_criteria` | `criteria_id TEXT PK`、`task_id TEXT NOT NULL`、`description TEXT NOT NULL`、`check_type TEXT NOT NULL DEFAULT 'manual'`、`status TEXT NOT NULL DEFAULT 'pending'`、`version INTEGER NOT NULL DEFAULT 0`、`checked_at TEXT` | `check_type IN ('auto','manual')`；`status IN ('pending','passed','failed')`；任务删除时级联删除 |
| `design_docs` | `doc_id TEXT PK`、`project_id TEXT NOT NULL`、`title TEXT NOT NULL`、`path TEXT NOT NULL`、`content_hash TEXT`、`affected_by_tasks TEXT`、`last_updated_by_task TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`last_updated_at TEXT` | `project_id` 引用项目并级联删除；`affected_by_tasks` 是 JSON 数组；路径必须限制在项目 `local_path` 内 |
| `doc_change_proposals` | `proposal_id TEXT PK`、`doc_id TEXT NOT NULL`、`task_id TEXT NOT NULL`、`change_type TEXT NOT NULL`、`section_path TEXT`、`old_content_hash TEXT`、`new_content TEXT`、`rationale TEXT`、`status TEXT NOT NULL DEFAULT 'pending'`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL`、`applied_at TEXT` | `change_type IN ('add','modify','deprecate','replace')`；`status IN ('pending','approved','rejected','applied')`；文档和任务删除时级联删除 |
| `design_doc_changes` | `change_id TEXT PK`、`doc_id TEXT NOT NULL`、`task_id TEXT NOT NULL`、`proposal_id TEXT`、`change_type TEXT NOT NULL`、`section_path TEXT`、`prev_hash TEXT`、`new_hash TEXT`、`changed_at TEXT NOT NULL` | 文档删除时级联删除；任务删除时级联删除；提案删除后 `proposal_id` 置空 |
| `agent_styles` | `style_id TEXT PK`、`name TEXT NOT NULL`、`description TEXT`、`system_prompt_overlay TEXT`、`permissions_overlay TEXT`、`model_overlay TEXT`、`version INTEGER NOT NULL DEFAULT 0` | `permissions_overlay` 与 `model_overlay` 是 JSON；overlay 不能扩大 preset 权限 |
| `task_runs` | `link_id TEXT PK`、`task_id TEXT NOT NULL`、`run_id TEXT`、`session_id TEXT`、`terminal_session_id TEXT`、`role TEXT NOT NULL DEFAULT 'main_execution'`、`status TEXT NOT NULL DEFAULT 'pending'`、`idempotency_key TEXT`、`linked_at TEXT NOT NULL` | `status IN ('pending','running','succeeded','failed','canceled','unknown')`；`role IN ('main_execution','validation','discussion')`；`run_id`、`session_id`、`terminal_session_id` 不建跨库外键；`terminal_session_id` 仅用于旧终端只读指针；部分唯一索引保证每个任务至多一个活跃运行；`task_id + idempotency_key` 唯一 |
| `design_notes` | `note_id TEXT PK`、`task_id TEXT NOT NULL`、`project_id TEXT NOT NULL`、`status TEXT NOT NULL DEFAULT 'proposed'`、`content TEXT NOT NULL`、`supersedes TEXT`、`reject_reason TEXT`、`source_run TEXT`、`version INTEGER NOT NULL DEFAULT 0`、`created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL` | `status IN ('proposed','implemented','rejected','archived')`；`supersedes` 自引用；`source_run` 是弱引用 |
| `task_contributions` | `contribution_id TEXT PK`、`task_id TEXT NOT NULL`、`agent_id TEXT NOT NULL`、`contribution_pct REAL NOT NULL`、`basis TEXT`、`round INTEGER NOT NULL DEFAULT 1`、`created_at TEXT NOT NULL` | `0 <= contribution_pct <= 100`；任务删除时级联删除 |
| `agent_profiles` | `agent_id TEXT PK`、`reputation REAL NOT NULL DEFAULT 0`、`reputation_updated_at TEXT`、`tasks_won INTEGER NOT NULL DEFAULT 0`、`contribution_total REAL NOT NULL DEFAULT 0`、`avg_report_score REAL`、`updated_at TEXT NOT NULL` | `agent_id` 是业务 Agent 标识，不与 DSH preset 名强制相等 |
| `task_report_exports` | `export_id TEXT PK`、`report_id TEXT NOT NULL`、`task_id TEXT NOT NULL`、`format TEXT NOT NULL`、`path TEXT NOT NULL`、`sha256 TEXT NOT NULL`、`size_bytes INTEGER NOT NULL`、`exported_at TEXT NOT NULL` | `format IN ('md','html','json')`；报告或任务删除时级联删除；路径与摘要指向实际导出文件 |

### 5.2 生命周期数据库约束

`tasks` 必须同时校验生命周期模式和状态集合：

```sql
CHECK (lifecycle_mode IN ('p0', 'v1'))
CHECK (
  (lifecycle_mode = 'p0' AND status IN (
    'idea', 'backlog', 'discussing', 'reviewing', 'closed'
  ))
  OR
  (lifecycle_mode = 'v1' AND status IN (
    'idea', 'backlog', 'discussing', 'reviewing', 'decomposing',
    'in_progress', 'validating', 'closing', 'closed',
    'paused', 'blocked', 'failed', 'canceled', 'abandoned'
  ))
)
```

数据库 CHECK 只阻止非法组合。允许的转移、用户审批要求、终态和副作用仍由 `TaskService` 使用模式对应的 9 条或 52 条边执行。

### 5.3 外键、弱引用与 JSON

任务库内部关系使用外键并启用 `PRAGMA foreign_keys = ON`。删除项目或任务时，子记录按 5.1 中的级联规则清理；需要保留历史的外部引用使用 `SET NULL`。

不得恢复以下旧外键：`projects.workspace_id -> authorized_workspaces.workspace_id`、`task_runs.run_id -> runs.run_id`、`task_runs.session_id -> sessions.session_id`。这些对象可能属于不同 DSH profile、数据库或生命周期。

所有 JSON 列在 HTTP、工具或持久化读取入口解析，拒绝非数组、非对象或枚举外元素。`task_comments.mentions`、`task_reports.artifact_ids`、`task_artifacts` 引用和 `ideas.tags` 是重点校验对象。

不透明 ID 在 TypeScript 公共接口中使用 branded string，不以裸 `string` 跨越服务边界。SQLite 保存其文本值，比较时不解析内部结构。`tasks.thread_id` 只标识跨任务、评论和运行绑定使用的不透明会话线程键，不承载飞书 topic 或负责人归属语义。`tasks.parent_task_id` 是父层级唯一事实来源；`task_relations(type = 'parent')` 由 `TaskService` 在同一事务中同步，读取到冲突时拒绝继续写入。

### 5.4 索引

目标保留旧任务域的 24 个命名索引，并新增 3 个索引（2 个运行保护 + 1 个收件箱去重），共 27 个命名索引：

| # | 索引 | 定义 |
|---:|---|---|
| 1 | `idx_tasks_project` | `tasks(project_id)` |
| 2 | `idx_tasks_status` | `tasks(status)` |
| 3 | `idx_tasks_thread` | `tasks(thread_id)` |
| 4 | `idx_tasks_parent` | `tasks(parent_task_id)` |
| 5 | `idx_stages_task` | `task_stages(task_id)` |
| 6 | `idx_ideas_project` | `ideas(project_id)` |
| 7 | `idx_ideas_status` | `ideas(status)` |
| 8 | `idx_task_rel_source` | `task_relations(source_task_id)` |
| 9 | `idx_task_rel_target` | `task_relations(target_task_id)` |
| 10 | `idx_task_events_task` | `task_events(task_id, created_at)` |
| 11 | `idx_task_activities_task` | `task_activities(task_id, created_at)` |
| 12 | `idx_task_artifacts_task` | `task_artifacts(task_id)` |
| 13 | `idx_task_reports_task` | `task_reports(task_id, submitted_at DESC)` |
| 14 | `idx_task_comments_task` | `task_comments(task_id, created_at)` |
| 15 | `idx_acceptance_task` | `acceptance_criteria(task_id)` |
| 16 | `idx_design_docs_project` | `design_docs(project_id)` |
| 17 | `idx_doc_proposals_task` | `doc_change_proposals(task_id, status)` |
| 18 | `idx_doc_changes_doc` | `design_doc_changes(doc_id, changed_at DESC)` |
| 19 | `idx_task_runs_task` | `task_runs(task_id)` |
| 20 | `idx_design_notes_task` | `design_notes(task_id)` |
| 21 | `idx_design_notes_project` | `design_notes(project_id)` |
| 22 | `idx_contributions_task` | `task_contributions(task_id)` |
| 23 | `idx_contributions_agent` | `task_contributions(agent_id)` |
| 24 | `idx_task_report_exports_report` | `task_report_exports(report_id, exported_at DESC)` |
| 25 | `idx_task_runs_one_active` | `UNIQUE task_runs(task_id) WHERE status IN ('pending','running')` |
| 26 | `idx_task_runs_idempotency` | `UNIQUE task_runs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL` |
| 27 | `idx_ideas_capture` | `UNIQUE ideas(channel, source_system, source_ref, content_hash) WHERE channel IN ('connector','agent_extract')` |

### 5.5 修订触发器

目标共有 49 个唯一触发器：16 张表各三个 INSERT/UPDATE/DELETE 触发器，加一个 parent 环检测触发器。

| 修订表 | 触发器前缀 |
|---|---|
| `projects` | `projects_rev_after_` |
| `tasks` | `tasks_rev_after_` |
| `task_stages` | `stages_rev_after_` |
| `ideas` | `ideas_rev_after_` |
| `task_relations` | `task_relations_rev_after_` |
| `task_events` | `task_events_rev_after_` |
| `task_activities` | `task_activities_rev_after_` |
| `task_artifacts` | `task_artifacts_rev_after_` |
| `task_reports` | `task_reports_rev_after_` |
| `task_comments` | `task_comments_rev_after_` |
| `acceptance_criteria` | `acceptance_criteria_rev_after_` |
| `design_docs` | `design_docs_rev_after_` |
| `doc_change_proposals` | `doc_change_proposals_rev_after_` |
| `design_doc_changes` | `design_doc_changes_rev_after_` |
| `agent_styles` | `agent_styles_rev_after_` |
| `task_runs` | `task_runs_rev_after_` |

每个前缀追加 `insert`、`update`、`delete`，触发器体为 `UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1`。`task_stages` 的旧命名前缀是 `stages_rev_after_`，迁移必须保留该名称。

第 49 个触发器为 `task_relations_prevent_parent_cycle`。它在插入 `parent` 关系前使用递归 CTE 检查祖先链；形成环时以 `RELATION_CYCLE` 拒绝写入。

以下表不参与修订号：`global_revision`、`design_notes`、`task_contributions`、`agent_profiles`、`task_report_exports`。

### 5.6 事务不变量

每个任务 mutation 在单个 SQLite 事务中完成：读取当前版本、校验 `if_version`、校验状态与权限、更新业务行、递增该行版本、追加 `task_events` 和必要的 `task_activities`、提交事务。

同一事务内任一写入失败时全部回滚，包括状态、阶段、评论、验收和报告变更。触发器递增的 `global_revision` 随事务回滚，不会出现客户端看到未提交修订号的情况。

创建任务时在同一事务内分配 `projects.next_task_number` 并生成 `identifier`。并发创建不得重复编号。

删除项目、任务或报告前由 `TaskService` 检查保留策略；涉及导出文件和外部产物的删除必须在文件系统操作成功或明确登记失败后才提交数据库删除。

### 5.7 Schema 版本

目标 `SCHEMA_VERSION = 1`，目标数据库写入 `PRAGMA user_version = 1`。当前 DSH 简化库为 `0`；旧 AgentOps 的 `user_version = 93` 只是旧结构标记，必须结合表与列探测识别，不能当作目标版本。

迁移器先按结构识别已知旧 P0、旧 V1 和当前简化库。目标是版本 `1`，其他高版本或未知版本拒绝打开；无法证明属于已知旧形态的低版本也拒绝。已有目标库的结构必须与版本 `1` 完全匹配。

代码不得通过 `CREATE TABLE IF NOT EXISTS` 静默接受旧 CHECK、旧列或旧级联规则。结构不匹配或不支持的高版本必须显式报错，不能继续以部分 schema 运行。

### 5.8 收件箱与分诊

收件箱（`ideas`）是**人和自动化共用的唯一入口**，用三个正交轴描述一条记录，禁止把它们挤进一个字段：

| 轴 | 字段 | 取值 | 谁决定 |
|---|---|---|---|
| 通道 | `channel` | `manual` / `bot` / `agent` / `connector` / `agent_extract` | 系统固定 |
| 来源系统 | `source_system` | `github` / `feishu` / `wecom` / `oa` / `web` / `internal` 等小写 slug | **配置校验**（`allowedSourceSystems`），不是 schema 枚举 |
| 业务类型 | `kind` | `requirement` / `bug` / `doc` / `question` / `idea` | 枚举，决定门槛 |

规则：

- `source_system` 写入时必须在配置的允许列表内，未知值返回 `invalid_request`；新增来源系统只改配置与展示名，不改表、不做迁移。
- `connector_ref` 是弱引用，指向未来的连接器实例；连接器被删除或改名时来源记录仍可读，UI 显示为不可用。能力中心在 OPS 侧实现，DSH 只预留字段，不依赖其内部结构。
- `kind` 是收件箱业务类型，与任务的 `task_type`（`code` / `knowledge` / `design` / `hybrid`）是两个轴；转换时按固定映射选择 `task_type`。
- 状态机：`captured → triaged → ready → converted`，另有 `ignored` / `archived`。`channel IN ('bot','agent')` 只能推进到 `captured`；`triaged` 与之后的迁移只能由用户或 `task_inbox` preset 执行。
- 转换生成的任务默认落在 `backlog`，可直接认领与启动执行；收件箱在 `ready` 状态提供"转任务"。`n- 门槛：`captured → triaged` 要求 `kind`、内容与去重检查通过；`triaged → ready` 仅允许 `kind IN ('requirement','bug')`，且描述足以验收；`doc` 转为设计文档提案，`question` 答复后归档；`ready → converted` 回写 `converted_task_id`。
- 自动来源按 `(channel, source_system, source_ref, content_hash)` 幂等；上游内容变化插入新 `revision` 行，旧行保留；人工与 bot 记录不做此约束。
- 上游原始快照放 `raw_ref`（spill/attachment），不塞进 `ideas` 行；没有快照的通道允许 `raw_ref` 为空。
- 建任务前置：任务可以带 `converted_idea_id` 溯源；不带来源的手工任务允许存在，但 `task_inbox` 与 bot 不得跳过收件箱直接建任务。

## 6. HTTP API

### 6.1 路由映射

所有旧 `/api/tasks/...` 路由迁移到 `/api/agentops/tasks/...`。目标保留旧功能的 **37 条**已注册路由；执行过程的观察与绑定由 `/api/agentops/sessions`、`/session-log` 承担，不进入任务路由。静态路径必须在 `/{task_id}` 之前注册，避免 `search`、`graph`、`dashboard`、`projects` 等被解释为任务 ID。

| # | 方法与路径 | 行为 |
|---:|---|---|
| 1 | `GET /api/agentops/tasks/projects` | 列出项目及其任务计数、当前版本 |
| 2 | `POST /api/agentops/tasks/projects` | 创建项目并初始化 `next_task_number` |
| 3 | `GET /api/agentops/tasks/ideas` | 按项目和状态列出灵感 |
| 4 | `POST /api/agentops/tasks/ideas` | 创建灵感 |
| 5 | `GET /api/agentops/tasks/relations` | 按任务或项目列出依赖关系 |
| 6 | `POST /api/agentops/tasks/relations` | 创建 `parent`、`blocks` 或 `related` 关系并检测环 |
| 7 | `GET /api/agentops/tasks/proposals` | 按任务或状态列出设计文档变更提案 |
| 8 | `GET /api/agentops/tasks/revision` | 返回当前 `global_revision.revision` |
| 9 | `GET /api/agentops/tasks` | 按项目、状态、负责人过滤任务列表 |
| 10 | `GET /api/agentops/tasks/search` | 搜索任务标题、描述和标识符 |
| 11 | `GET /api/agentops/tasks/graph` | 返回普通依赖网络数据：节点、关系、父链与可执行状态 |
| 12 | `GET /api/agentops/tasks/dashboard` | 返回仪表盘聚合数据 |
| 13 | `POST /api/agentops/tasks` | 创建任务并分配项目内标识符 |
| 14 | `GET /api/agentops/tasks/{task_id}` | 返回任务、阶段、事件、评论摘要、设计笔记摘要、验收信息和当前允许动作 |
| 15 | `PATCH /api/agentops/tasks/{task_id}` | 更新允许编辑的任务字段并校验 `if_version` |
| 16 | `POST /api/agentops/tasks/{task_id}/advance` | 按目标状态或动作推进生命周期 |
| 17 | `GET /api/agentops/tasks/{task_id}/transitions` | 返回当前模式和状态下的合法转移及审批要求 |
| 18 | `POST /api/agentops/tasks/{task_id}/claim` | 把任务绑定到调用方线程并记录执行认领 |
| 19 | `POST /api/agentops/tasks/{task_id}/rollback` | 按别名或目标状态回退并记录原因 |
| 20 | `POST /api/agentops/tasks/{task_id}/close` | 校验验收、提案和关闭门禁后进入关闭流程 |
| 21 | `GET /api/agentops/tasks/{task_id}/reports` | 列出正式任务报告 |
| 22 | `POST /api/agentops/tasks/{task_id}/reports` | 提交正式任务报告 |
| 23 | `POST /api/agentops/tasks/{task_id}/reports/{report_id}/export` | 生成 Markdown 报告文档并登记产物与历史 |
| 24 | `GET /api/agentops/tasks/{task_id}/reports/{report_id}/export` | 读取报告文档内容与摘要状态；缺失返回 404 |
| 25 | `GET /api/agentops/tasks/{task_id}/reports/{report_id}/exports` | 列出导出历史并报告磁盘摘要状态 |
| 26 | `POST /api/agentops/tasks/{task_id}/design-notes/{note_id}/status` | 更新设计笔记状态 |
| 27 | `GET /api/agentops/tasks/{task_id}/comments` | 按类型列出任务评论 |
| 28 | `POST /api/agentops/tasks/{task_id}/comments` | 创建讨论、报告评论或评审决定 |
| 29 | `GET /api/agentops/tasks/{task_id}/relations` | 返回单个任务的入边、出边和父链 |
| 30 | `POST /api/agentops/tasks/{task_id}/execute` | 建立受控执行的 Session 绑定（`task_runs.session_id`） |
| 31 | `GET /api/agentops/tasks/{task_id}/criteria` | 列出验收标准 |
| 32 | `POST /api/agentops/tasks/{task_id}/criteria` | 新增或更新验收标准 |
| 33 | `POST /api/agentops/tasks/{task_id}/ideas/{idea_id}/confirm` | 兼容旧路径，确认灵感可进入任务流程 |
| 34 | `POST /api/agentops/tasks/{task_id}/ideas/{idea_id}/convert` | 兼容旧路径，把灵感转换为任务 |
| 35 | `POST /api/agentops/tasks/proposals/{proposal_id}/apply` | 应用已批准的设计文档提案 |
| 36 | `GET /api/agentops/tasks/{task_id}/activities` | 列出字段级活动 |
| 37 | `GET /api/agentops/tasks/{task_id}/artifacts` | 列出任务产物 |
| 38 | `POST /api/agentops/tasks/{task_id}/criteria/{criterion_id}/status` | 把一条验收标准标记为 passed / failed |
| 39 | `POST /api/agentops/tasks/{task_id}/reports/{report_id}/review` | 审批正式报告：approve 或 request_changes |
| 40 | `GET /api/agentops/tasks/{task_id}/runs` | 列出任务的执行记录 |
| 41 | `POST /api/agentops/tasks/{task_id}/runs/{run_id}/finish` | 结算执行记录：succeeded / failed / canceled / unknown |

v1 在 37 条迁移路由之外新增第 38–41 条（验收标准状态、报告审批、执行记录、执行结算）与四个 canonical 路由（收件箱三条 + 全局动态一条），并保留第 33、34 条旧路径作为兼容入口：

- `POST /api/agentops/tasks/ideas/{idea_id}/confirm`
- `POST /api/agentops/tasks/ideas/{idea_id}/convert`
- `POST /api/agentops/tasks/ideas/{idea_id}/triage`（按 `kind` 与门槛推进 `captured → triaged → ready`，或置 `ignored`/`archived`）`n- `GET /api/agentops/tasks/activities`（跨任务最近动态，供监控页使用）

第 33、34 条旧路径中的 `{task_id}` 只用于兼容旧调用。服务必须校验 `idea_id` 存在、已绑定到该任务或转换关系有效；不能因为路径里带了任务 ID 就跳过归属校验。`triage` 只接受用户或 `task_inbox` preset；`channel IN ('bot','agent')` 的记录不能越过 `captured`。

旧 `task_list_design_notes` 没有注册 `@app.get` 路由，因此不计入 37 条迁移路由。设计笔记通过任务详情、报告和状态更新路径访问。

### 6.2 通用请求与响应

任务读取响应包含当前 `task`、`version`、当前模式、允许动作和关联摘要。任务 mutation 成功返回更新后的最新记录及递增后的 0-based `version`。

版本承载记录使用 0-based 乐观锁。新建任务的首个版本为 `0`；`PATCH`、`advance`、`claim`、`rollback`、`close` 以及其他修改任务的 mutation 接受 `if_version`，缺省为 `0`。

版本不匹配返回 HTTP 409 和 `version_conflict`，响应同时返回最新记录、当前版本和冲突字段，客户端据此刷新而不是覆盖他人修改。

错误响应统一为 `{ "error": { "code": string, "message": string, "details": unknown } }`。错误信息使用英文技术代码，用户文案由客户端 locale 字典生成。

| HTTP | 代码 | 触发条件 |
|---:|---|---|
| 400 | `invalid_request` | 字段缺失、类型错误、JSON 无效、编辑字段不在白名单 |
| 400 | `invalid_transition` | 转移不在当前 `lifecycle_mode` 的 9 条或 52 条边中 |
| 403 | `user_approval_required` | Agent 尝试执行 `requires_user = true` 的边 |
| 404 | `task_not_found` | 任务不存在 |
| 404 | `report_not_found` | 报告不属于该任务或不存在 |
| 409 | `version_conflict` | `if_version` 与当前版本不一致 |
| 409 | `thread_conflict` | 任务已绑定其他 thread 且调用方试图抢占 |
| 409 | `relation_cycle` | parent 关系形成环 |
| 409 | `active_run_conflict` | 同一任务已有活跃运行，且请求使用不同幂等键 |
| 503 | `exporter_unavailable` | 报告导出服务缺失或工作区不可写 |
| 503 | `session_binding_unavailable` | 宿主无法创建或激活执行会话（Session 服务缺失、profile 不可用） |

### 6.3 任务创建与更新

`POST /api/agentops/tasks` 接受项目、标题、描述、任务类型、风险、负责人、父任务、来源灵感、生命周期模式和可选 `style_id`。服务校验父任务同项目、来源灵感同项目、模式合法，并在同一事务内分配 `identifier`。

新任务默认 `lifecycle_mode = 'v1'`、`status = 'idea'`、`version = 0`、`approved = NULL`。显式创建 P0 任务时必须同时提供 P0 合法初始状态；不能先写入 V1 状态再切换模式。

`PATCH /api/agentops/tasks/{task_id}` 只允许修改 title、description、task_type、risk_level、assignee、sort_order、style_id 和父任务等可编辑字段。状态通过 advance/rollback/close 修改，版本、lifecycle mode、identifier、closed_at 和 archived_at 不接受普通 PATCH 覆盖。

### 6.4 转移、认领与回退

`POST /advance` 接受 `target_status` 或动作名称、`if_version`、`thread_id`、`comment` 和 `actor`。存在 `target_status` 时以状态为准；动作名称只用于同一状态存在多个动作时的 UI 消歧。

`requires_user = true` 的边只能由用户操作路径执行。Agent 工具尝试执行时必须返回明确拒绝并保留待用户确认的上下文，不得把拒绝伪装成普通状态冲突。

`POST /claim` 必须提供 `thread_id`。任务尚未绑定时写入绑定；已绑定同一线程时幂等返回；已绑定其他线程时返回 409 `thread_conflict`，不覆盖原绑定。认领只写线程绑定和任务事件；`task_runs` 仅由 `POST /execute` 创建，避免认领与执行形成两个活跃运行入口。

`POST /rollback` 支持 `local`、`partial`、`global` 三个旧别名，也支持直接 `target_status`。`target_status` 优先；没有直接状态时，`local → in_progress`、`partial → decomposing`、`global → discussing`。每条回退都必须写入原因和 review 上下文。

`POST /close` 先从当前 `validating` 状态推进到 `closing`，再检查关闭硬约束并推进到 `closed`。验收标准未全部通过或仍有 `pending` 文档提案时返回 400，并列出阻塞项；任一推进边的用户审批要求仍需满足。

### 6.5 列表、图与仪表盘

任务列表支持项目、状态、负责人、任务类型、风险、父任务和文本过滤，返回稳定排序与分页游标。搜索必须转义 SQL 通配符，不把用户输入拼入 SQL。

仪表盘按项目返回各状态数量、风险分布、阻塞、逾期、最近活动和当前修订号。依赖图返回节点、关系、父链和可执行状态；P0 与 V1 节点显示各自模式对应的状态集合。

甘特图与依赖图共用关系数据，不另建一套依赖 JSON。`task_relations` 是 `blocks` / `related` 关系真源；`tasks.parent_task_id` 是父层级唯一事实来源，`parent` 关系是事务同步的派生投影。两者发生冲突时由服务校验并拒绝写入。

### 6.6 执行与会话绑定

`POST /execute` 必须接受 `idempotency_key`，并接受 `agent_preset`、`workspace_id`、`style_id` 与可选 `role`。服务校验任务状态（仅 `backlog` / `in_progress` 可执行）、preset 的 `allowedAgentPresets` 与 Workspace 可解析性，然后创建或复用执行会话，把 `run_id`、`session_id`、运行状态与幂等键写入 `task_runs`，返回 `{ run_id, session_id, role, status }`。

Workspace 只提供路径解析与绑定，不提供授权判断。权限来自 preset 插件组合和任务插件在 preset 内的 `only` 配置；请求中的其他角色声明不能扩大权限。

同一任务串行执行，且最多一个 `task_runs.status IN ('pending', 'running')`。相同幂等键重复请求返回同一运行；不同幂等键遇到活跃运行时返回 409 `active_run_conflict`，不排队、不创建第二条活跃记录。运行结束必须落到 `succeeded`、`failed` 或 `canceled`；无法确定结果时落到 `unknown`，不得把未知伪装成成功。

执行过程本身就是一次模型会话：模型调用、工具参数、工具结果与错误可能在 Session 日志中，任务侧只保存弱指针。任务详情通过现有 Session API 提供受持久化、profile 和清理策略约束的截断事件预览；现有预览最多返回 200 个事件，单事件最大 1200 字符。会话缺失、归档或跨 profile 时，任务记录仍保留并标记为不可用；不新增回放系统，也不承诺完整过程。

宿主没有 Session 能力、preset 不存在时返回 503 `session_binding_unavailable`；Workspace 无法解析时返回 400；均不得降级为宿主 shell 或任意命令执行路径。`task_runs` 允许同一任务存在多次执行；旧终端 `terminal_session_id` 只读展示，不提供打开能力，删除任务时关联行级联删除。

## 7. 正式任务报告

### 7.1 报告真源

`task_reports` 是正式任务报告的唯一真源。报告包含正文、提交 Agent、Session 弱引用、artifact ID、验收自检、状态、版本和提交时间。

当前 `task-report-panel.tsx` 中的 `generated: false` 聚合视图只描述由阶段和事件派生的运行摘要，不能冒充模型撰写的正式报告，也不能作为审批、导出或完成任务的依据。保留该聚合视图时，界面必须明确标为运行诊断摘要。

正式报告状态为 `submitted`、`approved`、`changes_requested`。Agent 可以提交 `submitted` 报告；用户可以批准或请求修改；Agent 不能批准自己的报告。

`POST /reports` 接受 Markdown 正文、artifact IDs 和 acceptance self-check。服务校验所有 artifact 属于同一任务、self-check 是合法 JSON、报告内容非空，并在事务中写入报告和任务事件。

### 7.2 评论与审批

评论类型为 `report`、`review`、`discussion`。报告审批使用 review 评论，`decision` 为 `approve` 或 `request_changes`；请求修改同时写入 `rollback_target`。

`task_comments.report_id` 可指向正式报告。`comment_type = review` 的评论若携带 `request_changes`，服务必须执行第 6.4 节的评论后回退顺序；回退失败时保留 review 评论并返回明确的状态，不能用无评论的静默回退替代。

评论 mentions 为 JSON 数组，只允许第 3.2 节的四个交互角色。未知 mention 在写入前返回 400；`task_dispatcher` 不是合法 mention。

### 7.3 导出格式与路径

报告交付物是 **Markdown 报告文档**：写入 `<workspace_root>/reports/<task_id>/<report_id>.md`，并在同一事务外登记一条 `task_artifacts`（`type = 'report'`）与一条 `task_report_exports` 历史。任务详情与客户端通过文档路径和摘要引用它，不经过下载路由。

`html` 与 `json` 渲染器保留在 `reports.ts` 中作为后续格式，但当前不暴露路由；引入时需同时定义下载载体（见修订 D 的挂载说明）。

文件路径由服务使用已知 workspace root、任务 ID 和报告 ID 构造，不直接信任请求中的路径。`task_id` 与 `report_id` 必须匹配白名单字符并经过解析后路径 containment 检查，拒绝 `..`、绝对路径、分隔符和符号链接逃逸。

Markdown 包含标题、任务标识、报告状态、提交信息、正文、artifact IDs 与验收自检；正文与所有元数据在渲染时保持纯文本，不执行 HTML。

### 7.4 原子导出与历史

导出顺序固定为：校验输入、渲染到同目录临时文件、原子替换文档路径、重新读取磁盘文件计算 SHA-256 与大小、登记 artifact、写入新的 `task_report_exports` 历史行。任一步失败都必须删除新文档并返回明确失败，不留下半成品。

重复导出覆盖同一文档路径，但每次成功导出都新增一条历史记录，artifact 行按 `artifact_id` 覆盖更新。历史行保存实际磁盘摘要和大小，不保存对内存中渲染结果的猜测值。

`POST /export` 接受可选的 `format`（当前只允许 `md`）与 `verify_only`。`verify_only = true` 只比对现有文档是否存在、摘要是否匹配，不新增历史。`GET /export` 返回文档内容与摘要状态，文件不存在时返回 404，不隐式生成。`GET /exports` 返回历史、存在性与摘要比对结果。

导出器不可用、workspace root 不可解析或目录不可写时返回 503 `exporter_unavailable`。路径不安全返回 400，报告或任务不属于调用上下文返回 404。

## 8. Agent 工具边界

Agent 工具只暴露任务领域的受控命令，不暴露 SQL、任意 HTTP 代理或直接数据库句柄。

只读工具包括任务列表、任务详情、合法转移、报告、评论、验收标准、关系、活动、产物和项目元数据。读取结果必须携带 `version` 和 `lifecycle_mode`，使调用方知道后续写操作应使用的锁版本和状态集合。

写工具至少覆盖 `task_create`、`task_advance`、`task_stage_add`、`task_claim`、`task_report_submit`、`task_comment`、`task_validate` 和 `task_rollback`。每个写工具都调用 `TaskService`，不接受原始 SQL、直接状态字段覆盖或未注册的 mention。

`task_advance` 仅允许 `requires_user = false` 的边。`task_validate` 写入验收结果或提交验收建议，不能直接关闭任务。`task_rollback` 在目标边要求用户确认时只生成待审动作，不直接改变状态。`task_close` 不暴露给任何 Agent preset，关闭只能走用户操作路径。工具权限来自 preset 插件组合和任务插件在 preset 内的 `only` 配置，不新增逐子级工具白名单。

工具输出使用稳定对象结构并进入 Session 日志。工具拒绝、版本冲突和部分状态未知必须作为结构化结果返回，不能返回模糊的“失败”文本让模型猜测是否已写入。

## 9. Web 客户端

### 9.1 五个任务中心视图

任务中心恢复旧系统的五个视图，共享项目、状态、风险和搜索筛选：

| 视图 | 必须恢复的行为 |
|---|---|
| Dashboard | 状态分布、风险、阻塞、最近活动、修订轮询、进入任务详情的入口 |
| Board | 按状态列展示任务卡，显示版本、风险、负责人和可执行动作；需要审批的动作转到用户确认；`canceled` 与 `abandoned` 必须有列或可达的过滤入口，不得不可见 |
| List | 表格、过滤、搜索、排序、分页、批量选择入口和多字段摘要 |
| Gantt | 按任务关系和阶段时间展示时间轴，支持按项目与状态过滤 |
| Dependency network graph | 展示 parent、blocks、related 边，突出阻塞和父链，不把关系复制为本地状态 |

看板当前的四列只读版本不满足迁移要求，必须恢复 V1 状态列、模式差异、风险、负责人、版本和动作可用性。P0 任务只展示 P0 五状态，V1 任务展示 V1 十四状态。

"查看执行过程"不是独立视图：任务详情提供"打开执行会话"入口，跳到 `session_id` 对应的会话回放。

### 9.2 详情与报告页面

全屏任务详情至少包含概览、阶段、评论、正式报告、验收、关系、产物、活动，以及一个**执行记录**区块（列出该任务的 `task_runs`：角色、`run_id`、`session_id`、链接与时间）。执行记录只展示指针与状态，不回放会话内容。详情页通过 `global_revision` 和任务版本刷新，不能每个组件独立维护冲突状态。

正式报告页展示报告正文、提交者、状态、artifact 引用、自检、审批评论、请求修改和导出历史。`submitted` 报告提供用户批准与请求修改动作；请求修改必须选择回退目标并写入 review 评论。

导出操作提供 Markdown、HTML、JSON、下载和摘要校验。下载失败或导出器不可用时显示明确错误；摘要不匹配时显示不可信警告；不把缺失文件显示为成功。

### 9.3 主题、文案与响应式

客户端使用 DSH 的 theme token、组件、字体、间距和图标规范，不复制旧 AgentOps 的全局 CSS、字体栈和页面壳。任务视图嵌入 AgentOps 面板 slot，并保持键盘操作、加载态、空态和错误态。

所有产品文案进入 typed locale dictionary，通过 `t` 或本地化 primitive 输出。禁止在任务中心、详情页、报告页和错误提示中硬编码中文或英文；英文标题和按钮使用 sentence case。

看板、列表、甘特图和依赖图在窄屏下可切换为单列或抽屉详情，不因响应式布局隐藏关键操作。依赖图的节点选择、详情打开和键盘操作必须可用，不提供 hover-only 信息。

## 10. 旧数据迁移

### 10.1 需要识别的数据库形态

迁移器支持以下输入形态，并在 `PRAGMA table_info`、`PRAGMA user_version` 和表清单基础上选择迁移路径：

| 形态 | 识别条件 | 处理 |
|---|---|---|
| 旧 AgentOps P0 | `tasks` 有 `task_id`、`approved` 缺省，状态 CHECK 只接受 P0 五状态 | 导入为 `lifecycle_mode = 'p0'` |
| 旧 AgentOps V1 | `tasks` 有 `task_id`，存在 V1 状态、`approved`、`archived_at` 或 V1 扩展表 | 导入为 `lifecycle_mode = 'v1'` |
| 当前 DSH 简化库 | `tasks` 有 `id`、`parent_id`，缺少 `task_id` 和 `lifecycle_mode` | 重命名映射并按 V1 导入 |
| 目标 schema | `tasks` 有 `task_id` 和 `lifecycle_mode`，`PRAGMA user_version` 等于目标版本 | 校验结构后直接打开 |

无法识别的版本、高于当前代码支持版本的数据库、或缺少必要表但无法证明是已知旧形态的数据库必须拒绝打开。不能自动创建空表掩盖数据丢失。

### 10.2 预检与备份

迁移前执行只读预检：检查数据库文件、WAL/SHM、表与列、行数、外键、状态枚举、重复主键、孤儿引用、JSON 可解析性、导出目录和可用磁盘空间。

预检输出机器可读迁移清单，包含源 schema 版本、表行数、任务状态分布、生命周期模式推断、项目映射、计划转换、将被隔离的记录和预计目标文件。

执行迁移前停止所有源库写入。使用 SQLite backup API 取得一致性快照，或在关闭写连接前执行 `wal_checkpoint(TRUNCATE)`；不得只复制主库。备份主库及当时存在的 WAL/SHM，递归备份 `task_exports`，并记录每个文件的 SHA-256、大小和相对路径。staging 与目标文件必须位于同一文件系统。备份路径、源数据库摘要、代码版本和开始时间写入迁移 manifest。

`--dry-run` 只生成清单和校验结果，不改数据库、不移动文件、不写正式目标。`--apply` 才执行迁移。

### 10.3 安全重建

迁移在独立 staging 文件中创建完整目标 schema：21 张表、26 个索引和 49 个触发器。禁止在旧业务表上直接执行旧 P0→V1 的 `DROP task_stages; DROP tasks;` 流程。

复制顺序遵守外键依赖：global_revision、projects、agent_styles、design_docs、ideas、tasks、task_stages、relations、events、activities、artifacts、reports、comments、criteria、proposals、changes、task_runs、design_notes、contributions、profiles、exports。执行记录只通过 `task_runs` 进入目标库，其他执行载体不入库。

复制 `global_revision` 时保留旧单行值；旧真实库为 `(1,21)`。若旧任务域没有该行，在创建触发器前写入 `(1,0)`。全部业务行复制完成后再创建索引和触发器，避免导入期间递增 revision；`design_notes` 等后续表也必须在触发器启用前完成复制。

复制完成后执行 `PRAGMA foreign_key_check`、`PRAGMA integrity_check`、表行数比对、主键集合比对、关系端点检查、状态可读性检查和报告导出摘要检查。

staging 校验只在未发生写入时允许被丢弃。staging 在关闭前 checkpoint，或以 rollback journal 构建，确保没有需要随主库一起替换的 sidecar。正式替换前停止写入者并关闭全部连接，把旧主库、WAL、SHM 作为一个文件组移到备份位置，把 staging 原子重命名到目标路径，再以只读连接执行最终校验。最终校验失败时恢复整个旧文件组。

### 10.4 当前简化库映射

当前 DSH 简化库的映射固定如下：

| 简化库字段 | 目标字段 | 规则 |
|---|---|---|
| `tasks.id` | `tasks.task_id` | 原值保留 |
| `tasks.parent_id` | `tasks.parent_task_id` | 原值保留，引用同一映射 |
| `tasks.project_id` | `tasks.project_id` | 有项目则保留；缺失项目创建可审计占位项目 |
| `tasks.title`、`description` | 同名目标字段 | 原值保留 |
| `tasks.status` | `tasks.status` | 合法 V1 状态保留；非法值进入拒绝清单 |
| `tasks.risk_level` | `tasks.risk_level` | 合法值保留；缺失使用 `medium` |
| `tasks.assignee` | `tasks.assignee_name` | 原值保留；无法证明类型时 `assignee_type` 为空 |
| `tasks.stage` | `task_events.payload` | 生成 `legacy_import` 事件保存旧阶段文本 |
| `tasks.version` | `tasks.version` | 所有 `version >= 1` 的值减一；`0` 不变；负数拒绝 |
| `tasks.closed_at` | `tasks.closed_at` | 原值保留 |
| `task_stages(task_id, seq)` | `task_stages(stage_id, task_id)` | 生成稳定 stage ID，保留任务和顺序信息 |
| `task_stages.name` | `task_stages.stage_type` | 原值保留 |
| `task_stages.status` | `task_stages.status` | `pending`、`running`、`failed` 保留；`done` 映射为 `committed`；未知状态进入拒绝清单 |
| `task_stages.note` | `task_stages.stage_output` | 包装为合法 JSON，保留旧文本 |
| `task_stages.entered_at` | `task_stages.started_at` | 原值保留 |
| `task_stages.left_at` | `task_stages.committed_at` | 存在时保留 |
| `task_events.seq` | `task_events.event_id` | 使用任务 ID 和序号生成稳定 ID |
| `task_events.kind` | `task_events.event_type` | 原值保留 |
| `task_events.from_status`、`to_status`、`reason` | `task_events.payload` | 写入 JSON，不丢弃 |
| `task_events.actor`、`at` | `task_events.actor`、`created_at` | 原值保留 |

旧 AgentOps 已使用 0-based 任务版本，原值不需要减一。当前 DSH 简化库以 `version = 1` 表示首版，因此所有 `version >= 1` 的记录统一减一，`0` 保持不变，负数拒绝；fixture 覆盖 `1`、`2`、`3`。

### 10.5 项目、版本和引用规则

任务引用了不存在的项目时，迁移器创建一个可审计项目行，保留原 `project_id`，名称标记为旧项目，`metadata` 写入来源数据库、原标识和迁移原因。迁移清单记录每个占位项目；任务不能因项目缺失而被静默丢弃。

`projects.workspace_id` 原值保存为不透明字符串。无法在当前 DSH 解析到 Workspace 时保留引用并在 UI 显示不可用状态，不能清空、重写或删除项目。

旧 `projects` 的 `owner_user_id`、`root_subpath`、`binding_state`、`deleted_at` 不新增目标列，原值写入 `projects.metadata.legacy_project` 并在迁移 manifest 记录映射；不得静默丢弃真实值。

`task_runs.run_id`、`session_id` 和 `terminal_session_id` 原值保存为不透明字符串。当前 Session 数据库找不到对应记录时保留历史行，不把关联置空，也不启动跨库级联删除；旧 `terminal_session_id` 只读展示，不提供打开能力。

`task_reports.session_id` 原值保存为弱引用；被删除的 `task_reports.terminal_session_id` 若存在，原值写入迁移 manifest 供审计。

P0 数据只允许 P0 状态。若发现 P0 表内出现 V1 状态，该任务进入拒绝清单，不自动提升模式。

版本、状态、项目、父链和 JSON 字段的每次自动转换都写入迁移 manifest。无法安全转换的单条记录进入隔离清单，不能因一条坏记录阻断其他可迁移记录，也不能让坏记录进入目标权威表。

### 10.6 导出文件迁移

修订 D 把报告交付物改为 Markdown 文档后，旧 `task_exports` 文件**不再转换**：迁移只归档并登记历史，不重写内容。

备份 `task_exports` 后按 `<task_id>/<report_id>.<ext>` 结构解析现有文件。文件对应的报告和任务必须存在，扩展名必须在 `md/html/json` 内；不满足条件的文件移入隔离目录并在 manifest 中记录原因。

对合法文件计算 SHA-256 和大小，原样复制到 `<workspace_root>/reports_archive/<task_id>/<report_id>.<ext>`，写入 `task_report_exports`（`format` 保留原扩展名，摘要取复制后的磁盘值），并把该历史行标记为 `legacy_archive`。这类行不参与 `GET /export` 的 Markdown 文档读取，也不会被新导出覆盖。

不得把归档失败当作报告迁移失败；正式报告先迁移，归档单独校验。归档失败的报告仍可通过新 exporter 生成 Markdown 文档。

## 11. 实施阶段

本规格审阅通过后，下一步按以下阶段编写可执行任务计划。每个阶段必须以独立可验收的交付物结束。

| 阶段 | 交付物 | 退出条件 |
|---|---|---|
| 0. 契约快照 | 9 条 P0 边、52 条 V1 边、37 条迁移路由、21 张表、26 个索引、49 个触发器的 fixture 或生成清单 | 与旧 AgentOps 取证结果逐项一致；错误注释不进入 fixture |
| 1. Schema 与迁移器 | 版本化 SQLite schema、dry-run、staging 重建、一致性备份、校验、atomic replace | P0、V1、当前简化库三类 fixture 通过；失败恢复旧主库与 WAL/SHM 文件组 |
| 2. TaskService | 生命周期、版本、依赖、审批、验收、评论、报告、执行会话绑定与运行幂等 | 所有 mutation 只在 TaskService 中改变权威状态；并发与冲突测试通过 |
| 3. HTTP API | 37 条迁移路由、2 条 canonical 灵感路由、错误协议 | 路由顺序、状态码、版本冲突和兼容路径契约测试通过 |
| 4. Agent 工具与 preset | 六个 preset、插件组合与 `only` 权限、mentions 限制、深度与并发限制、收件箱分诊门槛 | 每个节点复用身份；越权、mention、分诊门槛和用户审批测试通过 |
| 5. 报告与导出 | 正式报告、审批、三种格式、原子写入、SHA-256、历史与下载 | 文件缺失可生成、摘要不一致标记为不可信、路径逃逸被拒绝、导出器不可用返回 503 的测试通过 |
| 6. 五视图 UI | Dashboard、Board、List、Gantt、依赖图、详情和报告页 | Playwright 覆盖主流程；所有文案来自 locale 字典 |
| 7. 集成与文档 | Session 快照、API contract、迁移演练、README、类型与使用说明 | `build:artifacts` 后 `build:check` 通过；文档同步通过 |

阶段 1 先于阶段 2，因为服务需要稳定表结构；阶段 2 先于阶段 3 和 4，因为 HTTP 与工具都必须调用同一权威服务；阶段 5 依赖阶段 2 的报告规则；阶段 6 依赖阶段 3 的契约；阶段 7 汇总并验证全部路径。

## 12. 验证矩阵

### 12.1 单元与 schema 测试

生命周期测试逐项断言 P0 9 条边和 V1 52 条边，包含动作名称、`requires_user`、终态、可暂停态和自环。P0 状态在 V1 模式不可用，V1 状态在 P0 模式不可用。

版本测试断言新任务为 `v0`，首次成功 mutation 返回 `v1`，陈旧 `if_version` 返回 409，冲突返回最新记录，失败事务不推进版本。

任务规则测试覆盖高风险管理、拆解策略、父任务环、关系端点、claim 冲突、rollback 别名优先级、关闭前验收集和 pending proposal。

报告测试覆盖 submitted 到 approved/changes_requested、Agent 自批拒绝、请求修改评论顺序、artifact 不属于任务、self-check 非法 JSON 和空正文。

schema 测试断言 21 张表、26 个命名索引、49 个唯一触发器、16 个修订前缀、`stages_rev_after_` 命名、`task_relations_prevent_parent_cycle` 和所有 P0/V1 CHECK。

JSON 测试覆盖 mentions、artifact_ids、acceptance_self_check、`ideas.tags`、payload、changes 和 metadata 的合法与非法输入。

执行运行测试覆盖相同幂等键幂等返回、不同幂等键遇到活跃运行时返回冲突、终态只允许 `succeeded`/`failed`/`canceled`/`unknown`、旧 `terminal_session_id` 只读保留，以及 Session 缺失时历史行仍可查询。

### 12.2 迁移测试

迁移 fixture 至少包含旧 AgentOps P0、旧 AgentOps V1、当前 DSH 简化库、缺失项目引用、未知状态、非法 JSON、重复版本、缺失导出文件和不安全导出路径。

每个 fixture 断言 dry-run 不修改文件、apply 后行数和主键集合一致、可转换记录字段一致、拒绝清单可解释、合法记录不丢失；简化库 `version >= 1` 统一减一、`0` 不变、负数拒绝，fixture 覆盖版本 1/2/3；`task_stages.status = 'done'` 映射为 `committed`，未知状态拒绝。

故障注入覆盖 staging 建表失败、复制中断、外键失败、触发器缺失、磁盘写满、WAL/SHM 处置失败、atomic replace 失败和最终校验失败；每种失败都必须恢复旧主库与 sidecar 文件组，保留旧数据库可读并返回明确错误。

迁移重复执行必须幂等。目标 schema 已是当前版本时不重建业务表；高版本数据库必须拒绝。

### 12.3 API contract 测试

对 37 条迁移路由和 2 条 canonical 灵感路由逐一断言方法、路径、成功状态、错误状态和响应字段。测试静态路由优先于 `/{task_id}`，确保 `search`、`graph`、`dashboard`、`projects` 不被任务查询吞掉。

API 测试覆盖 0-based `if_version`、409 冲突返回最新记录、404 任务不存在、400 非法转移、403 用户审批要求、409 claim 冲突、409 关系环、409 `active_run_conflict`、相同幂等键返回同一运行、503 exporter 与 session binding 不可用。

读取测试断言任务详情包含当前模式、版本、阶段、事件、评论摘要和允许动作。写入测试断言每次成功 mutation 只递增一次版本并追加对应事件。

### 12.4 报告与导出测试

导出测试逐一验证 Markdown、HTML、JSON 的字段、转义、稳定 JSON 和最小自包含 HTML。HTML 不得执行报告正文中的标签或脚本。

路径安全测试覆盖 `..`、绝对路径、反斜杠、URL 编码分隔符、符号链接和报告 ID 注入，确保最终解析路径仍位于 `task_exports`。

原子性测试覆盖临时文件写入失败、摘要计算失败、备份失败、replace 失败、数据库历史插入失败和恢复失败。成功导出必须新增历史，历史成功后才删除备份；恢复失败必须报告未知状态并保留恢复材料，`verify_only` 必须不新增历史。

下载测试覆盖文件存在、文件缺失即时生成、摘要不匹配只标记不可信且不重新生成、任务与报告不匹配 404、exporter 不可用 503。

### 12.5 Session snapshot 与 UI 测试

任务工具的非平凡模型可见路径必须有 keyless recorded-session 快照，覆盖创建任务、读取详情、合法推进、用户审批拒绝、版本冲突、提交报告和工具错误输出。

Playwright 覆盖五个任务中心视图、全屏详情、执行会话入口、报告审批、请求修改、评论 mentions、验收标准、依赖环错误、导出下载，以及依赖图与列表之间的筛选同步。

UI 测试断言 P0 和 V1 状态列/动作不同，正式报告与 generated 聚合摘要明确区分，所有产品文案来自 locale 字典，窄屏布局不隐藏关键操作，依赖图节点可键盘访问。

### 12.6 构建与仓库检查

实现完成后必须运行相关单元测试、API contract、迁移 fixture、snapshot、Playwright 和文档检查。类型与构建路径使用：

```sh
pnpm run build:artifacts
pnpm run build:check
```

涉及文档、客户端文案或 slot 时同时运行对应的 `doc-sync`、locale、i18n 和客户端检查。提交前只暂存本任务文件，并执行 `git diff --cached --check`。

## 13. 验收标准

生命周期验收：P0 恰好 9 条边，V1 恰好 52 条边，动作与 `requires_user` 和旧 `status.py` 一致；P0/V1 模式不能混用状态或转移。

数据验收：目标库恰好包含 §5.1 列出的 21 张表、26 个命名索引和 49 个唯一触发器；生命周期组合 CHECK 生效；跨库引用没有 SQL 外键；`task_comments.mentions` 是 JSON 列。

版本验收：新任务为 v0；所有任务 mutation 使用 `if_version`，冲突返回 409 和最新记录；当前简化库的 `version >= 1` 统一减一，`0` 保持不变。

API 验收：37 条迁移路由全部可用，2 条 canonical 灵感路由与旧路径兼容；静态路由优先；错误码和 close/claim/rollback 行为符合第 6 节。

Agent 验收：固定六个 preset，不创建 `task_decomposer` 或 `task_monitor`；Host 全局 `maxDepth = 2`、`maxActiveSubagents = 8`；conductor 1 个控制流 / inbox 与 dispatcher 各 4 个任务执行槽位只是 AgentOps 业务队列，不是 preset 字段；`task_close` 对所有 preset 不可用；工具权限仅来自插件组合和 `only`；mentions 仅允许四个交互角色；`task_inbox` 是唯一可执行 `idea_triage` 的 preset，且只能把收件箱推到 `triaged`/`ready`。

报告验收：正式报告可提交、审批、请求修改、评论和导出；请求修改先写 review 评论再 rollback；三种格式均生成文件、SHA-256 和导出历史。

执行验收：`POST /execute` 只写 `task_runs` 的运行指针、状态与幂等键，不代理会话内容；相同幂等键返回同一运行，不同幂等键遇到活跃运行返回 409；Session 缺失时任务详情仍可读并把执行记录标为不可用；同一任务的执行与验收串行，不并行。


安全验收：报告导出路径不逃逸 workspace；HTML 内容不注入脚本；Agent 不能执行需要用户的转移；quality inspector 不能使用 bash、写文件或关闭任务。

UI 验收：五个任务中心视图、全屏详情和正式报告页恢复；依赖图使用普通依赖网络；P0/V1 状态 UI 正确；generated 聚合摘要不冒充正式报告；客户端无硬编码产品文案。

迁移验收：旧 P0、旧 V1 和当前简化库均可在备份、dry-run 和校验后迁移；行数、主键、外键、状态和导出摘要一致；失败自动回滚并保留旧库可读。

## 14. 风险与处理

旧 schema 存在多代 `CREATE TABLE IF NOT EXISTS` 和 ALTER 补列，真实数据库可能与源码 DDL 不完全一致。处理方式是以实际 PRAGMA 探测为准，未知结构拒绝迁移，不允许静默接受部分 schema。

SQLite 和文件系统不能共享一个原子事务。数据库迁移必须停止写入者，使用一致性备份或 checkpoint，在目标同一文件系统构建 staging，并把主库、WAL、SHM 作为一个文件组替换和恢复。导出文件使用同目录临时文件、旧文件备份、原子 replace、写后摘要和历史记录；历史写入失败时恢复旧文件，恢复失败时报告未知状态并保留材料。

DSH Session、Workspace、Run 可能在不同 profile 或生命周期中消失。处理方式是使用不透明弱引用和 UI 不可用状态，不建立跨库外键，不因外部对象缺失删除业务任务历史。

任务只持有 `session_id` 指针，"执行过程看不到"是主要风险：会话可能被清理、归档或属于另一个 profile。处理方式是任务详情始终显示执行记录（哪怕不可打开），并把 `task_runs` 的历史保留在任务库；不提供任何"降级到宿主 shell"的路径。


1:1 恢复容易被误解为复制旧视觉或为每个节点复制 preset。处理方式是以本规格的行为验收和五个 preset 约束为准；节点复用身份，界面使用 DSH 主题。

## 15. 交付顺序

本规格是迁移的第一份交付物。审阅通过后，先产出逐文件、逐测试的实施计划，再按第 11 节阶段实施；每个阶段完成后报告实际执行的检查命令和结果，不把未运行的检查描述为通过。

在本规格获批前，不修改任务功能代码、DDL、preset、客户端页面或导出器。

## 附录 A：修订记录

### 修订 A（2026-11-07）

1. **执行模型统一为 Session。** 删除 2 张执行载体表、9 条执行载体路由及不适用的执行载体字段，包括 `task_reports.terminal_session_id`；保留 `task_reports.session_id` 与 `task_runs.terminal_session_id`。执行过程只通过 Session 弱引用关联，观察入口复用会话回放。按最终口径，业务表 23 → 21，路由 46 → 37，任务中心视图 6 → 5。
2. **新增上游来源层。** 增加 `task_sources` 表与 4 条来源路由，`ideas.source_id` 成为分诊链路的正式引用；新增 §5.8 与来源验收项。索引 25 → 26。
3. **依赖图增加星图模式。** 新增 §9.4，把星图定义为依赖图的第二种渲染，固定布局确定性、编码规则、聚焦与降级行为；图接口补充派生的度数/子任务数/活动时间字段。
4. **执行接口改为会话绑定。** `POST /execute` 参数由 `harness`/`exec_mode` 改为 `agent_preset`/`workspace_id`，返回 `{ run_id, session_id, role }`；新增错误码 `session_binding_unavailable`。
5. **并发预算显式化。** §3.2 改为一张分配表：conductor `maxActiveSubagents = 6`、dispatcher `4`，planner / coding / inspector 不派发；全局 `maxDepth = 1`、Host 上限 `8`，任务级执行与验收串行。
6. **迁移与验收同步调整。** 执行记录只从 `task_runs` 入库；`PRAGMA` 形态识别、复制顺序、schema 断言、路由契约与 UI 验收全部按 22 表 / 26 索引 / 37 路由 / 5 视图更新。

### 修订 B（2026-11-07）

1. **移除上游来源子系统。** 删除 `task_sources`、4 条来源路由、`ideas.source_id`、来源适配器验收和来源测试；保留 `ideas.source` 与自由文本 `source_ref` 描述旧数据。
2. **移除星图。** 删除 §9.4、星团/聚焦/触摸行为、星图测试和派生字段；保留 Dashboard、Board、List、Gantt 与普通依赖网络五个视图。
3. **收紧 Session 语义。** 明确 Session 只是弱指针；预览最多 200 个事件、单事件最多 1200 字符，可能缺失、截断或跨 profile 不可用，不承诺完整过程回放。
4. **修正全局并发口径。** Host 使用 `maxDepth = 2`、`maxActiveSubagents = 8`；conductor 1 个控制流 / dispatcher 4 个任务执行槽位只是 AgentOps 业务队列；`task_close` 对所有 preset 不可用。
5. **补充运行保护。** `task_runs` 增加运行状态与幂等键，保证同一任务最多一个活跃运行；相同幂等键返回同一运行，不同键冲突；保留旧 `terminal_session_id` 只读指针。
6. **修正迁移安全。** 目标为 21 表 / 26 索引 / 49 触发器；复制 `global_revision` 并在缺失时初始化为 `(1,0)`；简化库 `version >= 1` 统一减一、`done` 映射为 `committed`；旧项目附加字段写入 metadata；WAL/SHM 整套替换与恢复；导出覆盖前备份旧文件并在历史失败时恢复。

修订后的目标口径为 21 张表、26 个命名索引、49 个触发器、37 条迁移路由和 5 个任务中心视图；本修订不保留上游来源、星图或旧执行载体。

### 修订 C（2026-11-07）

1. **收件箱取代来源层。** 撤销修订 B 的「移除来源」方向：人和自动化共用 `ideas` 作为唯一入口，不做 `task_sources`。`ideas` 增加 `channel` / `source_system` / `connector_ref` / `kind` / `title` / `raw_ref` / `content_hash` / `revision` / `captured_at`，状态扩为 `captured / triaged / ready / converted / ignored / archived`；新增 §5.8 与索引 `idx_ideas_capture`（26 → 27）。
2. **三轴分离。** 通道（`channel`）、来源系统（`source_system`）与业务类型（`kind`）是三个正交字段：`source_system` 由配置 `allowedSourceSystems` 校验而不是 CHECK 枚举，新增来源系统只改配置与展示名；`kind` 与任务的 `task_type` 是两个轴，转换时按固定映射选择。
3. **分诊独立成 preset。** 新增第六个 preset `task_inbox`，只做分诊与调度，不做分解规划；`task_inbox` 是唯一可执行 `idea_triage` 的角色，`bot` / `agent` 通道只能把记录推进到 `captured`。
4. **能力中心延后。** Skill 与 MCP/API 连接器的管理面在 OPS 侧实现，DSH 本次只保留 `connector_ref` 弱引用与 `channel = 'connector' | 'agent_extract'` 枚举，不实现连接器、不依赖其内部契约。
5. **路由与门槛。** 新增 canonical `POST /api/agentops/tasks/ideas/{idea_id}/triage`；门槛按 `kind` 收紧（`doc` 转设计文档提案、`question` 答复归档、`requirement`/`bug` 才可 `ready`）。

修订 C 的 schema、契约快照与工具实现尚未落地，按「先提交当前实现、再实施」的顺序在其后的提交中同步；届时目标为 21 张表 / 27 个命名索引 / 49 个触发器 / 37 条迁移路由 + 3 条 canonical 收件箱路由。
### 修订 D（2026-11-07）

1. **挂载方式定为 RPC 拦截。** 任务 HTTP 面通过 `ctx.connection.rpc.intercept('/api', …)` 接入共享通道：物理请求是已鉴权的 RPC 信封，`endpoint`（`/api` 之后的路径）+ payload 内的 `method` / `query` / `body` 还原成 router 调用；仅 `owner` peer 可访问，actor 取自 peer 而不是请求字段。理由是 `connection.fetch` 只接受精确路径与 `GET`/`HEAD`/`POST`（`packages/client/connection/src/rpc.ts`），而 `TaskHttpApi` 是传输无关的，保留契约即可。
2. **报告交付物改为 Markdown 文档。** 导出不再提供 `html`/`json` 下载路由，改为在 `<workspace_root>/reports/<task_id>/<report_id>.md` 生成文档并登记 `task_artifacts` 与 `task_report_exports`；`GET /export` 返回文档内容与摘要状态，不再隐式生成。`html`/`json` 渲染器保留在代码中但暂不路由。
3. **外部接口延后。** 外部 REST、SDK 与"发链接下载"不在本次范围；将来若需要，可在同一 router 之上再加一条 `connection.fetch` 前缀通道，与 RPC 通道并存，前端无需改动。
4. **验收口径。** 挂载验收以"owner peer 经 RPC 调用 37 条路由语义可用、非 owner 一律 `forbidden`"为准；导出验收以"文档生成 + artifact + 历史 + 摘要一致"为准，不再要求 HTML/JSON 文件与下载响应头。
### 修订 E（2026-11-08）

1. **恢复星图并替换依赖网络图。** 依赖图只保留星图一种渲染，不再维护普通网络布局；数据仍来自 `GET /api/agentops/tasks/graph`，度数、层深与关联数由前端派生，服务端不新增字段。
2. **布局确定性。** 项目形成星团中心，`parent` 关系决定轨道深度，同一输入产生同一坐标；节点超过 200 个时降级为简化渲染并关闭悬停动画。
3. **交互。** 悬停显示摘要卡片（标题、状态、风险、关联数、层深）；滚轮缩放（0.4–3 倍）、指针拖拽平移，点击星点打开任务详情；刷新手动触发。
