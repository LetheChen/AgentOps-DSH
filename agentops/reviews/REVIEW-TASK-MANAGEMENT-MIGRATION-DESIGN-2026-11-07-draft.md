# REVIEW — Task Management Migration Design — 2026-11-07 (draft)

- 被审对象: `<dsh-repo>\agentops\TASK-MANAGEMENT-MIGRATION-DESIGN.md`
- 审查前 SHA-256: `D59784F61F14741E40A53D4F44FA70AF20F9F5F03F4A9890DC239EFBBBFA67D5`
- 执行层: native subagents, R1 only
- 方法: S1 静态核验 / S2 实测复算 / S3 反向重建
- 独立性: 三名 reviewer 不共享上下文、未读取既有 review 产物；模型均为宿主继承模型，模型家族同源，仅取证方法独立。
- 用户约束: 只报会造成返工、错误落地、数据风险或明显过度设计的问题；不做完备性扩架构。

## R1 收件状态

- S1 Plato: completed
- S2 Epicurus: pending
- S3 McClintock: completed

## S3 McClintock — 关键原文摘录

来源: native subagent final message, host transcript; 因宿主显示截断，以下保留完整可检索的关键判断与证据。

### 确认成立

1. “Session 提供完整执行过程可见性”不成立。设计 `:21`、`:48`、`:498`、`:810` 超过现有 DSH capability；external subagent 没有本地 Session，Session 可被移除，tool/spill 也可能不可恢复。证据 `docs/architecture.md:128,165`、`packages/subagent/subagent/README.md:69,123`、`packages/subagent/subagent/src/out-of-process.ts:196-215`、`packages/session/session-persistence-jsonl/README.md:147,167`、`packages/agentops/host/src/sessions.ts:77,109-114`。L4。
2. “TaskService 独占权威状态”目前只是目标。`packages/agentops/task/src/dsh.ts:377-383` 直接调用 store；`packages/agentops/task/src/tools.ts:54` 自行打开 SQLite；`packages/agentops/task/src/index.ts:14` 导出 store。设计 `:17`、`:35-37`。L4。
3. “API 行为等价”与修订 A 矛盾。设计 `:10`、`:19`、`:381`、`:786`、`:826-833`；旧 API/execute/六视图见 `<legacy-repo>\api\server.py:6828,7597-7625`、`<legacy-repo>\web\src\pages\TaskCenterPage.tsx:2-4,17-25`。L4。
4. 星图和上游来源层是新增功能，不是旧系统恢复。设计 `:15`、`:423-430`、`:592-610`、`:827-828`；旧系统只有网状图和 `source/source_ref`。L3。
5. 迁移复制顺序和逐条隔离落地有漏洞。`ideas.source_id` -> `task_sources` (`:229`)，但复制顺序 ideas 在 task_sources 前 (`:641`)；单条隔离未定义引用闭包 (`:686`)。L3。

### 其他关键断言

- preset 拓扑冲突: `maxDepth=1` (`:97`) 与 conductor -> dispatcher -> coding (`:89-90`) 不可同时成立。L3。
- `/execute` 无 active-run 唯一约束、幂等键、run 终态与 Session 结束判定 (`:242,496-502,792`)。L3。
- `thread_id` 同时表示执行线程和飞书 topic (`:29,49,375,478`)。L2。
- `task_sources` 的 `source_id` 是单行 PK，却要求同一 ID 返回全部 revision；普通 UNIQUE 还允许 NULL 重复 (`:230,309,363,429`)。L2/L4。
- `task_runs` 没有状态字段，无法表达执行成功/失败/未知或 Session 可用性 (`:242,578,792`)。L2/L3。

### 过度设计判断

- 推迟: 星图、力导向布局、200 节点星团、降级矩阵；旧系统只有网状图。
- 删出本次迁移: `task_sources` 表、4 条来源路由、GitHub/Feishu adapter 与 cursor；除非有独立上游同步需求。
- 推迟: `task_contributions`、`agent_profiles` 运行时声望能力；历史数据可只读归档。
- 保留: preset 按职责复用；数据库 staging/备份/atomic replace。
- 不能把 `37/22/26/49` 计数当作功能价值证明，只能作为防漂移 fixture。

### S3 局限

- 未完成 SessionController 创建/复用 API 逐项核验。
- 未做运行时并发复现。
- 未测旧 Coding 终端与贡献/声望真实使用频率。
- 未运行测试或迁移 fixture。

## S1 Plato — 关键原文摘录

### 确认成立

1. Session 保存模型调用和工具结果、`task_runs.session_id` 弱指针方向成立；但现有 replay 不是完整过程。
2. Host `maxDepth=1`、`maxActiveSubagents=8`、`allowedAgentPresets` 均真实存在。
3. 当前简化库 `tasks.id` / `parent_id` / create 时 `version=1` 与 `1 -> 0` 映射成立。
4. P0 9 边、V1 52 边与旧 `status.py` 匹配。
5. `task_list_design_notes` 确实没有注册 GET，排除于 37 路由成立。
6. 22/26/49/37 的内部表格计数自洽，但不证明旧系统等价。

### 问题清单

1. `maxActiveSubagents` 被错误设计成按 preset 分配的业务队列。实际是 Host 单一 volatile 配置 (`packages/subagent/subagent/src/index.ts:185-198`)；达到容量直接 `ACTIVATION_LIMIT_REACHED`，不排队 (`packages/subagent/subagent/README.md:55-57`)。设计 `:83-102`。
2. 迁移先复制 ideas 后复制 task_sources，违反立即外键 (`:229,271,641`)。
3. 当前简化库允许 `task_stages.status='done'` (`packages/agentops/task/src/dsh.ts:227,244-246`)，目标只允许 pending/running/committed/failed (`:228`)，迁移规则未映射 (`:665`)。
4. `task_sources.source_id` 单行 PK 与“同一来源全部 revision”不兼容 (`:230,363,429`)；且“只追加不可变”与归档更新 status 冲突。
5. `thread_id` 双重语义 (`:29,49,375,478`)。
6. `task_reports.session_id` 与附录“删除 task_reports 执行载体字段”不一致 (`:235,508,826`)。
7. Workspace 不等于授权机制 (`packages/workspace/workspace/README.md:73-79`)；设计 `:52,273,496,680` 使用“工作区授权”过度解释。
8. DAG 节点身份未定义：关系只连接 task，stage 只是执行记录 (`:110-114,231`)。
9. `task_close` 暴露范围矛盾：preset 表说五角色不关闭，tool 边界只排除 coding/inspector (`:69-73,554`)。
10. 设计笔记称由详情访问，但详情契约没有其数组 (`:439,747`)。
11. 适配器 cursor/etag/last_seen 无持久化落点 (`:374,221-246`)。
12. 现有 `/session-log` 只返回前 200 事件、每事件 1200 字符 preview (`packages/agentops/host/src/sessions.ts:77,109-114`)；“完整过程”不成立 (`:21,498`)。
13. §1 的不参与 revision 清单漏了 `design_notes` (`:39,339`)，与 16 前缀/49 触发器冲突。
14. 37 路由未完成旧 server 全量差异核验。
15. 来源层与星图扩大迁移验收，建议拆分阶段。
16. “工具白名单”应明确为 preset 插件组合/现有 `tool-policy`，不是不存在的逐子级工具名过滤器 (`docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md:19`)。

## 待复核

- S2 复算结果。
- S1/S3 共有的 `maxActiveSubagents`、迁移顺序、Session replay、thread_id、task_sources revision、task_close、design notes、adapter cursor。
- S3 独有的 API 等价、TaskService 独占写入口、审批伪造、active-run 幂等、Dag 节点身份。
- 过度设计项必须有需求/旧行为证据，不能用“文档新增”本身证明应删除。

## S2 Epicurus — 原始报告

来源: native subagent final message, host transcript。执行层 native，取证方法为真实旧库只读查询与临时 SQLite/文件系统实测。

### 实测环境

- 时间：2026-11-07
- 平台：Windows，PowerShell
- Python：3.12.1
- Node：v25.8.0
- pnpm：11.28.5
- SQLite：3.43.1
- 旧库：`<legacy-repo>\audit.db`
  - 主库：57,589,760 bytes
  - `audit.db-wal`：6,109,992 bytes
  - `audit.db-shm`：32,768 bytes
  - `PRAGMA user_version = 93`
  - `PRAGMA journal_mode = wal`
- 当前 DSH 简化库：`<user-home>\.dsh\agentops\tasks.db`
  - 36,864 bytes
  - `PRAGMA user_version = 0`
  - `PRAGMA journal_mode = delete`
  - 当前 0 行
- 所有源库查询均使用只读 URI，并执行 `PRAGMA query_only = ON`；临时 SQLite 实验仅写入 `%TEMP%`。
- 目标 22 表 schema、`TaskService`、报告/导出实现、迁移器在 `packages/agentops` 中未找到。以下凡涉及这些部分，均标为“设计待实现”，不冒充已实现功能。

证据等级：

| 等级 | 含义 |
|---|---|
| L4 | 真实旧库只读查询、真实代码执行或临时 SQLite 实测 |
| L3 | 真实源码、测试、当前 DSH 源码直接核对 |
| L2 | SQLite 语义或设计内部一致性 |
| L1 | 代码/数据推断，尚未执行完整迁移 |
| L0 | 目标实现不存在，仅设计文字 |

### 确认成立点

#### 1. 旧 P0/V1 状态机数量成立

直接导入 `<legacy-repo>\task\status.py`：

```text
p0 9 v1 52
p0 terminals ['closed']
v1 terminals ['abandoned', 'canceled', 'closed']
v1 pausable ['in_progress', 'validating']
```

对应源码：

- `<legacy-repo>\task\status.py:50-64`：P0 9 条边
- `<legacy-repo>\task\status.py:109-177`：V1 52 条边
- `<legacy-repo>\tests\test_task_status.py:27-29`：P0 长度断言
- `<legacy-repo>\tests\test_task_status_v1.py:41-44`：V1 长度断言

**判定：成立，L4。** 旧真实库是 V1 形态，3 条任务状态分别为：

```text
[('task_20260915_163411_647845', 3, 'validating'),
 ('task_20260915_163641_507184', 0, 'discussing'),
 ('task_20260915_163729_444161', 0, 'idea')]
```

P0 仅有源码和测试证据，没有真实 P0 数据库夹具。

#### 2. 22 张目标表的总数成立，但复制清单不完整

旧任务域表：

```text
21 张：acceptance_criteria, agent_profiles, agent_styles,
design_doc_changes, design_docs, design_notes, doc_change_proposals,
global_revision, ideas, projects, task_activities, task_artifacts,
task_comments, task_contributions, task_events, task_relations,
task_report_exports, task_reports, task_runs, task_stages, tasks
```

旧库另有 `terminal_sessions`、`terminal_layouts`。因此旧任务相关表共 23 张；删除两张执行载体表，新增 `task_sources` 后为 22。

设计第 5.1 节的 22 张表目标集合与“旧 21 张任务域表 + `task_sources`”一致。但设计 `:641` 的复制顺序只列了 21 张表，缺少 `global_revision`。

**判定：数量成立，复制清单不成立；L4。**

#### 3. 37 条迁移路由与设计表逐项一致

用 Python AST 解析 `<legacy-repo>\api\server.py` 中所有 `/api/tasks` 路由：

```text
task routes 46
terminal carrier 9
remaining 37
sources 0
```

将设计表中的 `/api/agentops/tasks/...` 规范化到 `/api/tasks/...` 后比较：

```text
old nonterminal 37
design table 37
missing in design []
extra in design []
duplicates old 0
duplicates design 0
```

**判定：37 条迁移路由成立；但 4 条来源路由不是旧路由，旧库实测为 0。L4。**

#### 4. 旧 UI 确为 6 个视图，目标为 5 个成立

旧 `TaskCenterPage.tsx`：

```text
dashboard, board, list, gantt, graph, coding
```

`coding` 是 Coding 终端视图，对应被删除的终端执行载体。目标保留 Dashboard、Board、List、Gantt、依赖图，故 6 → 5。

**判定：成立，L4。**

#### 5. 49 个任务域触发器成立，但 48 个修订触发器依赖 `global_revision`

旧库任务域实测：

```text
49 个触发器
16 张参与修订的表 × 3 个触发器 = 48
task_relations 额外 1 个 parent 环检测触发器
合计 49
```

**判定：49 总数成立；但 `global_revision` 单行初始化和迁移复制缺失。L4。**

#### 6. 旧 exporter 的格式、路径、摘要和历史基本行为成立

源码确认：

- 支持 `md/html/json`：`<legacy-repo>\task\exporter.py:38-44`
- 路径为 `<workspace>/task_exports/<task_id>/<report_id>.<ext>`：`:8`
- 写临时文件后 `tmp.replace(target)`：`:325-327`
- 替换后重新计算 SHA-256 和大小：`:329-331`
- 插入 `task_report_exports` 并提交：`:296-306`

但真实旧库 `task_report_exports` 为 0 行，未发现真实导出文件夹具；真实导出文件行为只能以源码和临时合成测试证明。

**判定：格式与基本历史行为成立，L3；失败原子性不成立，见 S4。**

#### 7. 当前 DSH 简化库只有 3 表，目标 schema 尚未实现

真实简化库：

```text
tables: tasks, task_stages, task_events
indexes: tasks_project, tasks_status
user_version: 0
journal_mode: delete
tasks: 0
task_stages: 0
task_events: 0
```

源码证据：

- `packages/agentops/task/src/store.ts:14-57`
- `packages/agentops/task/src/tools.ts:24-25`：只有 `task_list/get/create/advance/stage_add` 5 个工具
- `packages/agentops/task/src/store.ts:27`：`version INTEGER NOT NULL DEFAULT 1`
- `packages/agentops/task/src/store.ts:130-136`：创建时写入 `version=1`
- `packages/agentops/task/src/store.ts:206-210`：mutation 执行 `version = version + 1`

在 `packages/agentops` 中搜索 `TaskService`、`task_sources`、`global_revision`、`task_report_exports`、`SCHEMA_VERSION` 未发现目标实现。

**判定：当前实现只有简化 3 表；22 表 schema、TaskService、报告/导出和迁移器均为“设计待实现”，L0。**

### 数字复算表

| 数字 | 设计口径 | 实测 | 判定与口径差异 | 等级 |
|---|---|---|---|---|
| 旧库总表数 | 未直接声明 | 65 表、0 视图 | 旧库实际 65 表；与 22 张目标业务表不是同一分母 | L4 |
| 22 张目标表 | 22 | 旧任务域 21 + `task_sources` = 22 | **总数成立**；复制清单仅 21 项 | L4 |
| 旧任务相关表 | 23 → 22 | 旧任务域 21 + 2 张 terminal 表 = 23 | **成立**，删 2 加 1 | L4 |
| 26 个索引 | 23 基础 + 3 新增 = 26 | 旧 24 个命名索引 + `idx_ideas_source` + `idx_sources_identity` = 26 | **总数成立，组成错误**；`idx_task_report_exports_report` 旧库已存在 | L4 |
| 49 个触发器 | 49 | 16×3 + 1 = 49 | **成立**；48 个是修订触发器，1 个是 parent 环检测 | L4 |
| 37 条迁移路由 | 37 | 46 - 9 terminal = 37 | **成立**；4 来源路由和 2 canonical 路由是额外新增 | L4 |
| 4 条来源路由 | 新增 4 | 旧 `/sources` 路由 = 0 | **成立为“新增”**；不能表述为旧 4 条迁移 | L4 |
| 5/6 视图 | 6 → 5 | 旧 UI `ViewKey` 6 个 | **成立**；删除的是 `coding` 终端视图 | L4 |
| 9/52 边 | P0 9、V1 52 | 直接导入为 9、52 | **成立** | L4 |
| 6/4/8 并发 | conductor 6、dispatcher 4、Host 8 | Host 全局 `maxActiveSubagents` 默认 8；`maxDepth` 默认 1；6/4 不是 Host/preset 配置字段 | **仅 8 成立**；6/4 是未实现业务调度口径，且深度路径冲突 | L3 |
| 旧版本 | 旧 AgentOps 0-based | 旧任务版本实际有 0 和 3 | **成立** | L4 |
| 简化库版本迁移 | 1 → 0 | 源码创建为 1，每次 mutation +1；当前库为空 | 只能证明 1→0 起点；2/3→1/2 未规定 | L3/L4 |
| `global_revision` | 单行 | 旧库实际 `(1,21)` | 旧值存在；目标复制清单未包含 | L4 |

补充口径：

- `37` 只统计旧 `/api/tasks` 路由扣除 9 条终端载体路由。
- `4` 条来源路由是目标新增，不属于旧 46 条。
- 另有 2 条 canonical 灵感路由，因此目标总路由量为 `37 + 4 + 2`，不能混入 37。
- `26` 是“命名索引”数量，不是 SQLite 全部索引对象数量。

### 问题清单

#### B1. WAL/SHM 与主库替换顺序会读到旧数据或破坏恢复

**等级：L4**

设计在 `:629` 预检 WAL/SHM、`:633` 备份主库和 WAL/SHM、`:645` 关闭连接后把 staging 主库原子重命名到目标路径，但没有规定 staging checkpoint、目标旧 WAL/SHM 处置、一致性快照获取或整套恢复。

真实源库存在 `audit.db-wal` 6,109,992 bytes 与 `audit.db-shm` 32,768 bytes。临时实测只替换主库、保留旧 WAL/SHM：

```text
before replace:                       rows [('old',)]
after main-only replace with old wal: rows [('old',)]
after removing wal/shm:               rows [('new',)]
```

**最小修订：** 停止写入方，用 SQLite 一致性备份或 checkpoint 后关闭；staging 使用 rollback journal 或关闭前 `wal_checkpoint(TRUNCATE)`；替换前移走目标旧 sidecar；失败恢复必须恢复主库、WAL、SHM 整套；staging 与目标同文件系统。

#### B2. `global_revision` 未被复制/初始化，所有客户端修订号可能永远不推进

**等级：L4**

设计 `:225` 要求单行，`:335` 触发器更新该行，但 `:641` 复制清单只列 21 表，没有 `global_revision`。旧库有 `(singleton=1, revision=21)`；临时 SQLite 实测没有 singleton 行时触发器的 `UPDATE` 影响 0 行。

**最小修订：** 复制 `global_revision` 或在目标初始化 `max(0, 旧 revision)`；在创建触发器前确认 singleton 行存在；增加真实 mutation 后 revision 递增断言。

#### B3. 删除 `terminal_session_id` 会丢掉真实旧执行记录的唯一定位指针

**等级：L4**

目标 `task_runs` 只有 `run_id/session_id`。真实唯一执行记录只有 `terminal_session_id` 非空，`run_id` 和 `session_id` 均为 NULL。设计一边要求详情始终显示执行记录，一边删除唯一非空指针。

**最小修订：** 至少保留 `task_runs.terminal_session_id` 作为 legacy/只读执行指针；或把原值完整保存到 manifest/`task_events.payload` 并显示“旧终端记录不可打开”；不得仅保存 `run_id/session_id`。

#### B4. `maxDepth=1` 与 dispatcher→coding 路径冲突

**等级：L3**

DSH 实际实现中 `maxDepth` 默认 1、`maxActiveSubagents` 默认 8，二者是 Host 全局配置。设计同时写 conductor 可启动 dispatcher/coding、dispatcher 可启动 coding、全局 `maxDepth=1`。调用链 conductor（depth 0）→ dispatcher（1）→ coding（2）在 maxDepth=1 时拒绝；6/4 被写成 preset 级 Host 上限也不存在。

**最小修订：** 保留 dispatcher→coding 则设 `maxDepth=2`；坚持 `maxDepth=1` 则删除 dispatcher→coding；6/4 只能是 AgentOps 业务调度队列，不是 DSH preset 字段；保留 Host 全局 8。

#### S1. 简化库版本只规定 `1 → 0`，没有覆盖已推进记录

**等级：L3**

源码允许创建 `version=1`，每次 advance 加一，因而也存在 2、3。设计只对 1 减一。**最小修订：** 对所有 `version >= 1` 统一减一，0 不处理，负数拒绝，fixture 覆盖 1/2/3。

#### S2. `ideas` 在 `task_sources` 之前复制，外键开启时会失败

**等级：L4**

设计 `:229` 有 `ideas.source_id -> task_sources.source_id`，而 `:641` 先复制 ideas 再复制 task_sources。临时 SQLite 插入实测 `FOREIGN KEY constraint failed`。**最小修订：** task_sources 移到 ideas 之前；不优先采用关闭外键的更大窗口。

#### S3. `task_sources.external_id NULL` 使唯一索引无法幂等去重

**等级：L4**

`external_id` 可空，唯一索引 `(source_type, external_id, content_hash)` 在 SQLite 中允许多行 NULL。临时实测两行 NULL duplicate 均成功。**最小修订：** `external_id NOT NULL`，manual 来源生成稳定键，或 expression unique index 归一化 NULL。

#### S4. exporter 覆盖文件后历史插入失败不可恢复，设计没有旧文件备份

**等级：L4**

实际执行旧 exporter 并注入历史插入失败后，目标文件已为 `NEW`，历史 0 行。设计 `:755` 要求覆盖该故障，但当前实现和设计文本都没有 replace 前的旧文件备份/恢复。

**最小修订：** replace 前原子备份旧目标；历史成功删除备份；历史失败恢复；恢复失败报告未知状态并保留恢复材料。

#### S5. 旧 `projects` 的额外字段被静默丢弃，其中 `binding_state` 已有真实值

**等级：L4**

旧 projects 另有 `owner_user_id`、`root_subpath`、`binding_state`、`deleted_at`；真实唯一项目行 `binding_state='needs_review'`，其余三项 NULL。目标 schema 和映射均没有这些字段。**最小修订：** 保留字段，或映射进 `projects.metadata` 并在 manifest 记录，明确归属和生命周期。

#### G1. 26 个索引总数正确，但基础数量错误

**等级：L4**

旧任务域已有 24 个命名索引，包括 `idx_task_report_exports_report`。正确组成是“旧 24 + 新增 `idx_ideas_source` + 新增 `idx_sources_identity` = 26”，不是“23 + 3”。**最小修订：** 改正分解口径；保留索引归旧库，不把既有索引算作新增。

#### G2. `task_sources` 的“只追加、不可变”与可变 `status` 矛盾

**等级：L2/L3**

`status` 可更新为 triaged/converted/archived，但表被描述为“只追加、不可变”。**最小修订：** 明确证据字段只追加、status 是管理字段；或归档通过新 revision 表达。

#### G3. 目标 `SCHEMA_VERSION` 数值未规定

**等级：L1/L0**

旧库 user_version=93，简化库 0，设计未固定目标版本。**最小修订：** 固定目标版本，列出 93/0/目标版本识别矩阵，明确旧 93 不得误判。

#### G4. 摘要不一致时下载行为与旧实现不一致

**等级：L3**

旧 GET 只在文件不存在时生成，不检查摘要。设计 `:757` 要求摘要不匹配重新生成，属于行为变化。**最小修订：** 等价优先时仅报告不可信；若要改进，先 verify 再明确重生成并记录升级说明。

### 局限

- 旧真实库当前是 V1 形态，P0 只有源码和测试证据。
- 旧真实库只有 3 条任务、1 条执行记录、1 条报告；样本不足。
- `task_report_exports` 真实为 0 行，未发现真实导出文件夹具。
- 当前 DSH 简化库为空，version=2/3 的实际记录不存在；版本问题依据源码允许值推断。
- 目标 22 表 schema、TaskService、报告/导出、迁移器尚未实现。
- WAL/SHM 结论来自临时实验，未对正在使用的源库执行替换实验。
- 目标 SCHEMA_VERSION 未给出。
- 本次未使用任何红队审查产物作为证据；证据仅来自旧 AgentOps 的真实数据库/源码和当前 deepseek-harness 实现。