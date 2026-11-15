# AgentOps 任务管理模块：现状盘点与迁移差距分析

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-05（2026-11-07 同步规格修订 A） |
| 分支 / 基线 | `agentops/main`；HEAD `仓库基线` + 268 项未提交变更（见 §2.5） |
| 行号口径 | 本文所有 `文件:行` 均为**工作区**口径。HEAD 版本更短：`store.ts` 285（工作区 325）、`status.ts` 148（172）、`dsh.ts` 409（414）、`panel.tsx` 288（293）；跨版本定位请按符号名搜索 |
| 对照规格 | [`TASK-MANAGEMENT-MIGRATION-DESIGN.md`](./TASK-MANAGEMENT-MIGRATION-DESIGN.md)（修订 A：执行统一走 Session、加星图与上游来源；22 表 / 26 索引 / 37 路由 / 5 视图） |
| 迁移来源 | `<legacy-repo>`（Python / FastAPI 旧系统） |
| 覆盖范围 | `packages/agentops/task`、`packages/agentops/host`、`packages/agentops/client`、`packages/agentops/bundle`、`packages/agentops/deploy`、`agentops/agents` |
| 方法 | 静态源码取证 + 可复跑命令；一手实测项标「实测」，静态清点项标「清点」 |
| 审查 | 已经 S1 静态核验 / S2 实测执行 / S3 反向重建对抗审查，修订记录见 [`REVIEW-TASK-MANAGEMENT-GAP-2026-11-05.md`](./REVIEW-TASK-MANAGEMENT-GAP-2026-11-05.md) |
| 本文性质 | 只读分析。按规格 §15，规格未获批前不改任务功能代码、DDL、preset、客户端页面或导出器 |

## 1. 结论摘要

**当前实现是一个可演示的纵向切片（vertical slice），不是可迁移的任务管理系统。** 它证明了「DSH 插件 → SQLite → 只读 HTTP → React 面板 → 模型工具」这条链路能跑通，但规格定义的业务域（项目、上游来源、依赖、评论、验收、报告、导出、双生命周期、迁移器）中只有生命周期表和事件表真正落地。

下表是**条目计数**，各行的分母口径不同（表/索引/触发器按 DDL 条目，路由按 HTTP 端点，工具按可调用工具，视图按页面），**不可相互加权或相加**；它回答"差多少件"，不回答"还差多少工作量"。

| 规格契约（§5/§6/§8/§9） | 目标 | 现状 | 条目覆盖 |
|---|---:|---:|---:|
| 业务表 | 22 | 3（`tasks`、`task_stages`、`task_events`） | 3/22 |
| 命名索引 | 26 | 2 | 2/26 |
| 修订/环检测触发器 | 49 | 0 | 0/49 |
| 迁移路由 + 新增来源 + canonical | 37 + 4 + 2 | 5（非 REST 形态，见 §3.2） | 5/43 |
| 生命周期 | V1 52 条边 + P0 9 条边 + 行级 `lifecycle_mode` | V1 规则表 52/52 有数据与执行；P0 0/9；模式列为 0 | 规则表 100%，双模式 0% |
| 模型工具 | ≈19（10 读 + 9 写，含受限 `task_close`） | 5 | 5/19 |
| 正式报告与导出（md/html/json、SHA-256、历史） | 完整子系统 | 0（只有前端聚合视图） | 0 |
| 任务中心视图 | 5 + 全屏详情 + 报告页 | 1 看板 + 1 报告摘要 | 2/7 |
| 任务 preset | 5（planner/dispatcher/conductor/coding/inspector） | 5 个角色各有 YAML（另有规格禁止的 `task_decomposer`、`task_monitor`），但引用的工具面断裂（§5.6） | 5/5 身份，0/21 工具可用 |
| 旧库迁移器（预检/备份/staging/dry-run） | 完整 | 0 | 0 |

三句话概括差距：

1. **数据层差一个数量级**：3 张表 vs 22 张表，且没有 schema 版本号与迁移能力，旧库进来就会撞上「结构不匹配但静默接受」的失败模式。
2. **缺的是编排层，不是"又一份实现"**：规格要求 `TaskService` 在单事务里串起状态、版本、门禁与副作用；现状只有一处在执行转移规则（`store.ts:177-217`），HTTP 与工具都调它，但**跨表副作用（评论/验收/报告/来源分诊）无处编排**，且审批归属取自请求体（§5.2）。
3. **业务广度几乎为零**：项目、上游来源、灵感、依赖关系、评论、验收标准、正式报告、导出、活动、产物、贡献、Agent 档案全部缺失；UI 只有看板一屏，且文案未进字典（整个 agentops client 未过 i18n 门禁，见 §5.7）。

**唯一达标的硬契约**：V1 十四条状态与 52 条边与旧 `task/status.py` 逐条一致（实测，见 §2.2）。注意这是**规则表**层面的达标：执行链、双模式、门禁审计都还没跟上。

## 2. 取证方法与已测事实

### 2.1 度量口径

本文只报**条目计数**（表、索引、触发器、路由、工具、页面各按自身单位），不折算成百分比：这些分母不同源，有的条目在旧系统从未被调用（`agent_profiles`、`task_contributions`），有的是规格新增而非旧行为（行级 `lifecycle_mode`、导出索引），加权求和会给出误导性的"完成度"。需要排期时请用 §4 的定性档位 + §7 的工作包，不要用 §1 的比值。

实测算术如下（可复算）：表 `3/22`、索引 `2/26`、触发器 `0/49`、路由 `5/43`（37 迁移 + 4 来源 + 2 canonical）、工具 `5/≈19`、视图 `2/7`、迁移器 `0`。生命周期单独说明：规则表 `52/52`、P0 `0/9`、行级模式列 `0/1`。

标注约定：本文把当次实跑命令得到的结论标为「实测」，把只读源码/数据库清点标为「清点」。

### 2.2 生命周期 parity（实测通过）

```powershell
cd packages/agentops/task
node --import tsx scripts/parity-status.ts
```

输出：`legacyTransitions: 52`、`tsTransitions: 52`、`missing: []`、`extra: []`、`terminalMatches: true`、`pausableMatches: true`。

同时核对旧 `<legacy-repo>\task\status.py`：

- `P0_TRANSITIONS` 恰为 9 条（`status.py:50-64`），DSH 侧**完全没有实现**。
- `TRANSITIONS` 的注释写「45 条转移」（`status.py:98`），实际可执行条目 52 条 —— 规格 §4.1 的判断成立，迁移必须以可执行表为准。
- P0 在旧系统是**部署级回退开关**，不是与 V1 并行的任务级模式：`api/server.py:211` 用 `TASK_V1_ENABLED`（默认 `1`）决定建哪一代 schema，`audit/store.py:2111` 的 `task_v1_enabled` 默认 `False`，旧库没有 `lifecycle_mode` 列。规格 §4.1 才把模式升级为**每行一列**——这是一个新增设计，不是对旧行为的复刻。

### 2.3 数据层（源码清点）

`packages/agentops/task/src/store.ts:14-57` 的 `SCHEMA` 常量就是全部持久化结构：`tasks`、`task_stages`、`task_events`，索引 `tasks_status`、`tasks_project`，无触发器、无 `PRAGMA user_version`、无 `CHECK` 约束、无 `global_revision`。`store.ts:106` 的 `this.#db.exec(SCHEMA)` 无条件执行这段带 `CREATE TABLE IF NOT EXISTS` 的 DDL，即"打开即接受任意旧结构"。

### 2.4 路由与工具（源码清点）

任务域 HTTP 只有 5 条，全部注册在 `packages/agentops/task/src/dsh.ts:270-388`：

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/agentops/tasks` | 列表（`status` / `projectId` 过滤） |
| GET | `/api/agentops/task?id=` | 详情 + 阶段 + 事件 + 允许动作 |
| GET | `/api/agentops/task-report?id=` | 派生摘要（`generated: false`） |
| GET | `/api/agentops/activity` | 全局事件流 |
| POST | `/api/agentops/task-advance` | 唯一写路由 |

模型工具 5 个（`dsh.ts:64-258`）：`task_list`、`task_get`、`task_create`、`task_advance`、`task_stage_add`。

`packages/agentops/host` 另注册 18 条 AgentOps 路由（agents 5、surfaces 5、sessions 2、catalog 2、archive/models/schedules/tool-catalog 各 1）；连同 dag、knowledge、security、vault、db 各包，AgentOps 侧合计 50 余条路由，**其中没有任何一条属于任务管理域**（`grep '/api/agentops'` 全量结果核对）。

### 2.5 工作区未提交改动（决定本文的时效边界）

`git status --porcelain` 共 **268 项**（199 修改、68 新增、1 删除），不是"只有 JSDoc"。与本模块相关的至少四类：

- 任务三文件（`status.ts` / `store.ts` / `dsh.ts`）的改动是纯注释与类型补全；
- `client/src/client/panel.tsx` 13+/8-：页头与详情壳改版（`className`、样式结构），属**功能性可见**改动；
- `deploy/agentops.patch.yml` +18：新增 `agentops-workflow-catalog` 插件与 `agentops-db-tools` 行，路径由 `/data/...` 改为 `/data/dsh/...`；
- 新增 `client/src/client/{page-api,page-locales,registry-api}.ts`、`bundle/presets/agents.generated.patch.yml`（旧 `agentops/presets/...` 被删除）。

因此本文结论**只对当前工作区成立**：行号、装配描述、`bundle` 与 `deploy` 是否同构都会随下一次提交漂移。复核时请以符号名搜索，不要按行号跳转。

## 3. 现状实现盘点

### 3.1 任务核心包 `packages/agentops/task`（985 行源码，不含脚本与测试）

| 文件 | 行数 | 职责 | 与规格的偏差 |
|---|---:|---|---|
| `src/status.ts` | 172（HEAD 148） | V1 状态表、终态/可暂停集、风险门禁、拆解策略纯函数 | 缺 P0 表与 `lifecycle_mode` |
| `src/store.ts` | 325（HEAD 285） | DDL + 增删改查 + 乐观锁推进 + 事件追加 | 与本包其他 store 同构（§5.1），但无跨表事务、无 schema 版本 |
| `src/dsh.ts` | 414（HEAD 409） | 5 个工具 + 5 条路由 + 配置解析 + 插件装配 | 路由非 REST 形态，缺错误码分层 |
| `src/tools.ts` | 57 | preset 内挂载工具（`only` 白名单） | 每次挂载独立打开同一 SQLite 文件；JSDoc 写的是"four task tools" |
| `src/index.ts` | 17 | 根装配 | — |
| `scripts/parity-status.ts` | 56 | 与旧 Python 表对拍 | 只比 V1；不在任何门禁中，需本地有 Python + 旧仓库 |

### 3.2 与规格 §6 的形态差异（不是缺路由，是缺协议）

规格要求的是 REST 资源路由 + 统一错误协议（`{error:{code,message,details}}`）+ 静态路由优先于 `/{task_id}`。现状是 5 条动词式精确路径，错误处理为临时约定：

- `task-advance` 把 store 的所有失败结果一律映射成 409（`dsh.ts:385`），只有请求体不是合法 JSON 或参数缺失才是 400（`dsh.ts:369,375`）；与 §6.2 的 400/403/404/409 分层不符（`not-found` 应为 404、`requires-user` 应为 403）。
- 详情与报告不存在都返回纯文本 `not found`（`dsh.ts:297` 为 task-report，`dsh.ts:348` 为详情），不是错误对象。
- 无 `if_version` 缺省语义、无 `lifecycle_mode`、无 `allowed actions` 之外的动作描述元数据。

### 3.3 客户端 `packages/agentops/client`

- `panel.tsx`（293 行）：四列看板。列定义写死在 `panel.tsx:22-27`，渲染按状态过滤（`panel.tsx:92`），因此是**数据驱动但列不可配置**；`canceled` 与 `abandoned` 不在任何列，这两类任务在看板上**完全不可见**。一次 `fetch('/api/agentops/tasks')` 后不再刷新（`panel.tsx:44-62`），无过滤器、无搜索、无分页、无轮询、无批量操作。
- `task-report-panel.tsx`：读取 `/api/agentops/task-report` 展示派生摘要，并在页面上标注「不是模型撰写的报告」（`task-report-panel.tsx:171`），符合规格 §7.1 的方向，但它不是正式报告。
- 文案：面板内中文直写字面量（`panel.tsx:70-75,110,119-120`）；`task-locales.ts` 只定义 3 个键（分组名 + 两个面板标题，8 语言齐全）。这不只是任务面板的问题——`pnpm exec tsx scripts/verify-client-ui-i18n.ts` 对整个 agentops client **exit 1**，任务面板是其中一部分。
- 页脚写「推进任务走 `task_advance` 工具」（`panel.tsx:119`），但看板的推进按钮实际调用 `POST /api/agentops/task-advance`（`panel.tsx:158`），文案与实现错位。

### 3.4 装配与部署

- 根插件 `agentops-task`（`bundle/cordis.patch.yml:53-55`、`deploy/agentops.patch.yml:28-29`）装存储 + 全部 5 条路由，**其中包含唯一写路由** `POST /api/agentops/task-advance`（`dsh.ts:358-387`，代码注释自述 "The only write route on the task surface"）。
- preset `agentops` 内挂 `@agentops/dsh-task/tools`（`bundle/presets/agentops-tools.patch.yml:36-37`、`deploy/agentops.patch.yml:61-62`）：工具仅在 agentops preset 的 Agent 可用。
- `bundle` 与 `deploy` **已经开始漂移**：`deploy/agentops.patch.yml` 新增了 `agentops-workflow-catalog` 插件与 `agentops-db-tools` 行，并把全部路径改成 `/data/dsh/...`；`bundle/cordis.patch.yml` 只有 +4 行。迁移时"改一处忘一处"只会在一半部署上生效。
- 存储层是**每处装配各开一个 `DatabaseSync`**（根插件 `dsh.ts:400-403`、每个 Agent 的工具挂载 `tools.ts:51-56`）。这不是任务域独有：`security/src/store.ts`、`dag/src/run-store.ts`、`vault/src/store.ts` 同为 `node:sqlite` 直连，全仓都没有 WAL / `busy_timeout`。同一 `tasks.db` 在多 profile 或多 Agent 下被并发写的概率未被评估。

## 4. 分阶段差距（对规格 §11）

阶段判定用定性档位（未开始 / 切片 / 部分达标 / 达标），不再给百分比——各阶段的分母不同源，百分数会误导排期（见 §1 与 REVIEW 记账）。

| 阶段 | 规格退出条件 | 现状 | 判定 |
|---|---|---|---|
| 0 契约快照 | 9 条 P0 边、52 条 V1 边、37 条迁移路由、4 条来源路由、22 张表、26 个索引、49 个触发器有 fixture 或生成清单 | V1 52 条边在源码里，并有一次性 Python 对拍脚本；P0、路由、表、索引、触发器均无清单，脚本不进 CI | 切片 |
| 1 Schema 与迁移器 | 版本化 schema、dry-run、staging 重建、备份、校验、原子替换；三类旧库 fixture 通过 | 无 `SCHEMA_VERSION` / `PRAGMA user_version`；`CREATE TABLE IF NOT EXISTS` 静默接受任意旧结构；无迁移器、无备份、无 staging | 未开始 |
| 2 TaskService | 所有 mutation 只在 TaskService 改变权威状态；并发与冲突测试通过 | 无 `TaskService`；无 claim / rollback / close / 报告 / 验收 / 来源分诊；无并发测试 | 切片 |
| 3 HTTP API | 37 条迁移路由 + 4 条来源路由 + 2 条 canonical 灵感路由、错误协议、静态路由优先 | 5 条动词式精确路由；store 层失败统一 409；无 `if_version` 缺省语义 | 切片 |
| 4 Agent 工具与 preset | ≈19 个读写工具、5 个 preset、mentions 白名单、深度与并发上限、`only` 白名单 | 5 个工具；5 个 preset YAML 已在工作区（未提交），其 `allowed_tools` 声明了 21 个未注册工具；`maxDepth` / `maxActiveSubagents` / mentions 均未落地 | 部分达标 |
| 5 报告与导出 | 正式报告、审批、md/html/json、原子写、SHA-256、导出历史与下载 | 仅有前端派生摘要（`generated: false`）；无报告表、无导出器 | 未开始 |
| 6 五视图 UI | Dashboard、Board、List、Gantt、依赖图（含星图） + 全屏详情 + 报告页；文案走字典 | 1 个四列看板 + 1 个摘要页；详情单页缺 6 个区块；文案未进字典且整包 i18n 门禁失败 | 切片 |
| 7 集成与文档 | Session 快照、API contract、迁移演练、README 与类型说明 | 有包 README 与设计规格；无 snapshot、无 e2e、README 已与代码漂移 | 切片 |

依赖顺序沿用规格 §11（不是本文推导）：阶段 1 先于 2（服务需要稳定表结构），2 先于 3/4（HTTP 与工具必须调同一权威服务），5 依赖 2，6 依赖 3。当前实现把 2 压进了 1 的存储层，因此重构不是「补表」，而是**先补跨表事务与门禁归属**。

## 5. 关键设计缺陷与缺口

以下 9 条按"修复顺序"排列。第 1 条不是风格问题（兄弟包同构），第 2 条是安全问题，其余是能力缺口。补齐功能前应先处理 1、2、4，否则新代码会复制同样的边界。

### 5.1 缺跨表事务编排（规则裁决点只有一处）

规格 §2 要求 `TaskService` 独占状态、版本、门禁与副作用顺序，`TaskStore` 只做事务与查询。现状的判断要分清两件事：

- **规则裁决点只有一处**：`SqliteTaskStore.advance()`（`store.ts:177-217`）读版本、查转移表、判 `requires_user`、更新行、追加事件；HTTP（`dsh.ts:377-386`）与工具（`dsh.ts:206-216`）只做参数解析后调它。所以"同一条规则会有 3 份实现"是**尚未发生的风险**，不是既成事实。
- **真正缺的是编排**：无法在一个事务里组合「状态 + 阶段 + 评论 + 验收 + 报告」的副作用（规格 §5.6）；`addStage()` 的「读 max(seq) → insert → appendEvent」三步也没有事务包裹（`store.ts:224-232`），并发下会产生重复 `seq`。

需要澄清一个容易误判的点：**store 同时持有 DDL 与领域判断，是本批导入的统一风格，不是任务域的违规**。`security/src/store.ts:1-7`（写入即同事务审计）、`dag/src/run-store.ts:1-9`、`vault/src/store.ts:1-6` 都是同一模式，只有 `knowledge` 拆了 `KnowledgeService`。因此引入 `TaskService` 的理由不是"风格分层"，而是迁移增量：新表需要跨表事务、审批需要归属与审计、报告与导出需要原子边界。

### 5.2 用户审批门禁的批准归属不可信（安全）

`POST /api/agentops/task-advance` 直接把 body 里的 `approvedByUser` 透传给 store（`dsh.ts:381`），store 只要看到 `true` 就放行 `requiresUser` 边（`store.ts:198`）；`actor` 也由同一份 body 自报（`dsh.ts:380`）。包 README 承认这点：「the panel only supplies it after `window.confirm`」（`task/README.md`「Known Limitations」）。

威胁面要说准：该路由经 `ctx.connection.fetch.register` 挂在 Web 服务器上，受 `BrowserAuth` / `PeerAdmission` 约束（`packages/client/connection/src/index.ts:13,154-163`），**不是公网可达**。成立的结论是：任一已认证的浏览器 peer 可以用裸 JSON 自批任意 `requires_user` 边，且批准事实没有归属与审计（`actor` 可伪造），与规格 §6.4「只能由用户操作路径执行」和 §13「Agent 不能执行需要用户的转移」冲突。Agent 走工具时反而被正确拒绝（`dsh.ts:206-212` 不传该字段）。

### 5.3 版本语义与规格不一致

- 规格要求新建任务 `version = 0`（§6.2），现状插入 `version = 1`（`store.ts:132`）。
- 规格要求 `global_revision` 单调号供客户端轮询（§5.5），现状没有；客户端也没有轮询（`panel.tsx:44-62` 只取一次）。
- 规格要求每任务 `lifecycle_mode`（`p0` / `v1`）并据此解释状态（§4.1），现状无此列，`TaskStatus` 只有 14 态并集。
- 读到未知状态时静默降级为 `idea`（`store.ts:309`），掩盖数据损坏 —— 规格 §5.7 要求「结构不匹配必须显式报错」。
- **迁移期风险未评估**：规格 §10.4 要求把简化库的首版 `1` 平移为 `0`，而版本号被客户端直接渲染（`panel.tsx:186`），也被工具当作乐观锁入参（`dsh.ts:181` 必填）。迁移会让所有历史行版本整体减一：旧客户端缓存、书签、自动化脚本用 v1 打请求会稳定收到 409。这需要在迁移器里做兼容窗口，而不只是一次 UPDATE。

### 5.4 Schema 无版本、无约束、无触发器

`SCHEMA`（`store.ts:14-57`）只有列定义与 2 个索引：没有 `CHECK`（`status IN (...)`、`risk_level IN (...)`、`type IN (...)`），没有跨表引用规则（`project_id` 无引用表），没有 16 张修订表的 49 个触发器，没有 `parent` 环检测触发器。`store.ts:106` 无条件 `exec(SCHEMA)`，而这段 DDL 全是 `CREATE TABLE IF NOT EXISTS`——规格 §5.7 明确禁止用它静默接受旧结构。

### 5.5 业务数据模型缺失 19 张表

规格 §5.1 的 22 张表里，现有等价物只有 `tasks`、`task_stages`、`task_events`（且列名/语义按简化库口径，见 §6）。缺失：`projects`、`task_sources`、`ideas`、`task_relations`、`task_activities`、`task_artifacts`、`task_reports`、`task_comments`、`acceptance_criteria`、`design_docs`、`doc_change_proposals`、`design_doc_changes`、`agent_styles`、`task_runs`、`design_notes`、`task_contributions`、`agent_profiles`、`task_report_exports`、`global_revision`。这些不是可选装饰：评论是任务的需求真源、验收标准是关闭门禁的输入、`task_runs` 是「任务 ↔ 执行」的唯一关联（执行绑定全靠它）、`task_sources` 是上游追溯的起点、`global_revision` 是客户端一致性的基础。

需要标注的是，其中 `agent_profiles` 与 `task_contributions` 在旧系统的 `api/` 与 `web/src/` 里**零调用**（`grep` 命中 0），属于"规格有、旧系统未使用"的条目；迁移时可以先建表不接 UI，但不应把它们算成用户可见能力。

### 5.6 preset 与工具面断裂

`agentops/agents/*.yaml` 的 `permissions.allowed_tools` 里，**21 个任务工具名在 DSH 侧未注册**：`list_tasks`、`task_advance_stage`、`task_approval`、`task_auto_evolve`、`task_claim`、`task_close`、`task_commit_stage`、`task_conductor_scan`、`task_create_project`、`task_decompose_apply`、`task_decompose_decide`、`task_detail_get`、`task_dispatch_execute`、`task_dispatch_scan`、`task_execute_coding`、`task_link_run`、`task_relations_complete`、`task_rollback`、`task_submit_idea`、`task_submit_report`、`task_validate`。实际注册的只有 `task_list`、`task_get`、`task_create`、`task_advance`、`task_stage_add`。

复算口径与边界：以上按 `allowed_tools` 求差（可复跑，见 REVIEW 的复算命令）。若把 prompt 正文里的产物名词（`task_comment`、`task_report`）与 patrol 定时任务名（`task_conductor_schedule`、`task_dispatcher_schedule`）也算进来，并集上界为 25；它们不是可调用工具。

这**不是静默失效**：`agentops/mappings/tool-map.yaml` 对未映射工具标 `mapped: null`，`agentops/tests/gen-agent-presets.test.ts:49-51` 断言未映射工具只产生 warning、不生成挂载行。所以它是"迁移未完成 + 生成器已告警"的状态。直接后果：这些 Agent 一上手就调不存在工具；`only` 白名单会对未知名抛错（`task/src/tools.ts:33-38`，名单在 `:25`），无法用别名兜底。另外 `task_decomposer` / `task_monitor` 两个 preset 与规格 §3.1「折叠进 planner / conductor，不得新增别名 preset」冲突，需要取舍。

### 5.7 客户端：视图单一、文案未进字典

- 规格 §9.1 五个视图，现有 Board 与报告摘要两屏；Dashboard / List / Gantt / 依赖图（含星图）全部缺失。
- 全屏详情（§9.2）现有 `TaskDetail`（`panel.tsx:133-252`）只展示标题/描述、阶段时间线、允许动作与事件表；缺评论、正式报告、验收标准、关系、产物、活动与执行记录 6 个区块。
- 看板列定义写死（`panel.tsx:22-27`）且**不含 `canceled` / `abandoned`**，这两类任务在任何列里都不显示。
- 文案未进字典（§3.3）。注意这不只是任务面板：整个 agentops client 的 i18n 门禁实测失败，`task-locales.ts` 只有 3 个键。
- 无响应式处理（看板用 `grid-template-columns: repeat(4, minmax(0,1fr))` 固定四列，`panel.tsx:90`），窄屏会挤压。

### 5.8 测试网缺失，且现有单测既不被收集、又在覆盖率门禁内

- **不被收集**：`packages/agentops/task/package.json` 的 `test` 是 `node --import tsx --test tests/*.test.ts`，文件名 `*.test.ts`；仓库 `vitest.config.ts` 的 include 只有四条（`packages/*/*/tests/**/*.spec.*`、`apps/*/tests/**/*.spec.*`、`scripts/**/*.spec.ts`、`website/tests/**/*.spec.ts`），不含 `.test.ts`。实测 `pnpm exec vitest run packages/agentops/task` 输出 `No test files found`（exit 1）；包内 13 个测试本地全绿（`pnpm test`，约 0.4 s）。
- **但覆盖率门禁把它们算进去了**：`coverage.include = packages/*/*/src/**/*.{ts,tsx}`、`perFile: true`、四项 100，且无 agentops 例外。定向探针 `--coverage.include="packages/agentops/task/src/**"` 实测：这些文件 **0%**（203 statements / 224 branches / 65 functions / 176 lines），逐文件 `does not meet threshold (100%)`，exit 1。也就是说，问题不是"没接进门禁"，而是"在门禁集合内、当前零覆盖"。
- 同一模式（`.test.ts`）存在于 **8 个包**：`task` 及 `bundle` / `dag` / `db` / `host` / `knowledge` / `security` / `vault`；`client` / `contracts` / `workflow-catalog` / `workflow-compiler` / `workspace-layout` 用 `.spec.ts`，会被收集。
- 单测范围窄：只有 store 与工具主路径（`tests/task.test.ts` 92 行 + `tests/dsh.test.ts` 88 行），无并发、无 schema 断言、无 P0、无路由错误码。
- API contract：无。迁移 fixture：无。Playwright：`apps/web/tests` 内没有任何任务中心用例（grep `任务管理` 只命中 `plugin-manager.e2e.ts:1103` 的一条无关文案）。
- Session snapshot：无任务工具调用快照，而规格 §12.5 要求覆盖创建、读取、合法推进、用户审批拒绝、版本冲突、提交报告与工具错误输出。
- 生命周期对拍脚本存在但不在任何门禁中，且依赖本机 Python 与 `<legacy-repo>`，换机器即失效。

### 5.9 文档漂移

- `task/README.md` 的文件表写着 `src/http.ts`（不存在，路由在 `src/dsh.ts`），并称「five routes and five model tools」，路由数虽对，但把 HTTP 与工具职责写混。
- `task/src/tools.ts:47` 的 JSDoc 写「Register the four task tools」，实际注册 5 个。
- `docs/subsystems/agentops.md` 完全没有任务管理章节（grep `task`/`任务` 零命中），而代码已是产品面的一部分。
- `task/README.md` 的已知限制只写了两条，缺少「无 schema 版本」「无报告/验收/评论」等更大的限制。

## 6. 与旧系统（`<legacy-repo>`）的对比

### 6.1 旧系统规模（实测）

| 部分 | 事实 | 证据 |
|---|---|---|
| 领域模块 | `task/` 下 9 个 Python 模块，合计 182,223 B（约 178 KiB） | `task/{status,store,exporter,orchestrator,terminal_exec,terminal_host,terminal_session,agent_style}.py` |
| 最大单文件 | `orchestrator.py` 47.7 KB、`store.py` 47.9 KB | 同上 |
| 表结构（实库） | `audit.db` 只读打开：**65 张表 / 105 个索引 / 52 个触发器 / `PRAGMA user_version = 93`**；其中任务域 23 张（22 张业务表 + `task_report_exports`） | `python sqlite3` 直查 `sqlite_master`，见 REVIEW 复算命令 |
| 表结构（源码） | `audit/store.py` 内 58 条 `CREATE TABLE`、54 个不同表名（`global_revision`/`projects`/`task_stages`/`tasks` 在 P0、V1 两代 DDL 各定义一次）；`task/exporter.py:183-192` 另建导出历史表 | 与规格的 23 张吻合 |
| 索引 / 触发器（源码） | `audit/store.py` 内 91 条 `CREATE INDEX`（去重 88）、53 条 `CREATE TRIGGER`（去重后触发器名 49，与规格一致） | `audit/store.py` |
| 路由 | `api/server.py` 中 `/api/tasks*` 恰好 46 条 | 逐条列出核对，与规格 §6.1 一致 |
| 前端 | `TaskCenterPage.tsx` 33.9 KB、`TaskDetailPage.tsx` 31.1 KB、`TaskReportPage.tsx` 34.1 KB + `components/task/` 下 **11** 个组件（Dashboard / Gantt / List / ProjectGraph / DependencyGraph / Relations / CodingTerminal / TerminalPane / TerminalPanel / CommentThread / WorkReview） | `web/src/pages/`、`web/src/components/task/` |
| 导出器 | `<workspace_root>/task_exports/<task_id>/<report_id>.<ext>`，三种格式（md / html / json），SHA-256（`exporter.py:285-289`）+ `task_report_exports` 历史 | `task/exporter.py:8,38-39,183-192,285-289` |
| 终端 | 依赖 `psmux` / `tmux` 外部后端，语义对齐 `tmux capture-pane` | `task/terminal_exec.py:38,181-183`；`task/terminal_host.py:92` |

### 6.2 规格数值抽检：旧库分母准确，修订 A 后目标口径已变

按旧库实测核对：46 条路由、23 张任务域表、P0 9 条边、V1 52 条边（注释误写 45）、25 个索引（旧库 24 个基础索引 + 新增 `idx_task_report_exports_report`，实库 25/25 全部存在）、49 个触发器（源码 53 条、去重 49）、导出三格式与 SHA-256、终端依赖 psmux/tmux。**旧库侧的数字可信**，问题不在取证，在执行度。

修订 A 之后，目标契约与旧库不再一一对应：旧库的 9 条执行载体路由与 2 张执行载体表**不进入目标**（执行记录只由 `task_runs` 承载），并新增 `task_sources` 表与 4 条来源路由，因此目标是 **22 表 / 26 索引 / 37 迁移路由 + 4 来源路由 / 5 视图**。差异是设计决定，不是遗漏；比对时不要把旧库的 46/23/25 当成目标值。

另外需要注明：规格的 22 表 / 26 索引 / 49 触发器是**目标库**口径，不是旧库现状（旧库实际 65 表 / 105 索引 / 52 触发器，含 run、session、security、boundary 等非任务表）。

### 6.3 规格未明确、迁移前必须补的四项

1. **单库拆分的处置。** 旧库把任务域与其他模块放在同一个 65 表的 SQLite 文件里，跨表还有手写外键。规格 §10 定义了行级字段映射，但没有定义「其余 42 张非任务表怎么办」：保留原库只复制任务子集？双写过渡？旧库继续被其他模块并发使用时的锁争用？迁移器需要这条决定才能开工。
2. **旧库自身的多代惰性迁移。** 旧 `audit/store.py` 里同时存在 `_TASK_SCHEMA_P0` / `_TASK_SCHEMA_V1` / `_TASK_SCHEMA_V3` 三代 DDL：`task_v1_enabled`（`TASK_V1_ENABLED`，`api/server.py:211` 默认 `"1"`）为真且 `tasks` 缺 `approved` 列时，会 **`DROP TABLE task_stages; DROP TABLE tasks;`** 后重建，再 ALTER 补 5 列，最后补 terminal 表与 `task_comments.mentions`。迁移器必须以「旧进程可能再次启动并改写该文件」为前提设计（停旧进程、备份、staging 校验、原子替换缺一不可），否则一次误启动就能清空任务。
3. **`orchestrator.py` 的行为重写。** 47.7 KB 的编排/派发/自动演进逻辑，规格用 5 个 preset + workflow 表达（§3）。这是**重写**而非迁移，也是风险最高的一块：当前 5 个 preset 的 `allowed_tools` 声明了 21 个不存在的工具（§5.6），等于重写尚无骨架。
4. **Markdown → HTML 转换归属。** 旧导出器自带手写转换器（`exporter.py:71-170`）。规格要求「最小自包含 HTML、内容先转义」，需明确是沿用旧转换器（保证导出 parity）还是接 DSH 已有渲染（避免两套转义规则产生安全差异）。

另有一处需确认：旧 `TaskCenter` 的关系视图（`TaskRelationsView`）、评论线程（`TaskCommentThread`）与 `WorkReview` 是独立组件；规格 §9 只列五个视图 + 详情页，未说明这些是并入详情页还是保留独立入口。

## 7. 重构路线建议

原则：**先补门禁与事实来源，再补跨表事务，最后填业务**。按当前形态直接补 19 张表和 36 条路由，会把 §5 的边界问题复制到每一张新表。

### 批次 A：契约与地基（对应规格阶段 0 + 1）

| 工作包 | 内容 | 落点 | 退出条件 |
|---|---|---|---|
| TM-A0 | 处置覆盖率门禁：agentops 的 `src/**` 已在 `coverage.include` 内且当前 0%，接入测试前必须先决定「补齐到每文件 100%（实测 224 个分支）」还是「登记 coverage 豁免并写明理由」 | `vitest.config.ts`、`packages/agentops/*/tests/` | 决策落地后 `pnpm exec vitest run packages/agentops/task` 非空且 `test:coverage` 不因新增文件变红 |
| TM-A1 | 契约快照：P0 9 边、V1 52 边、37 迁移路由 + 4 来源路由、22 表、26 索引（23 基础 + 3 新增）、49 触发器生成 JSON 清单 + 断言测试；对拍脚本退役或改为「可选 `--legacy` 复算」 | 新增 `packages/agentops/task/src/lifecycle/{p0.ts,v1.ts,index.ts}`、`tests/contracts/` | 清单与旧 `status.py` / 旧 DDL / 旧库 `sqlite_master` 逐项一致；错误注释（45 条）不进入清单 |
| TM-A2 | Schema v1：`SCHEMA_VERSION` + `PRAGMA user_version`，22 表 / 26 索引 / 49 触发器、全部 CHECK、`PRAGMA foreign_keys=ON`；含 `task_sources` 与 `ideas.source_id` | 新增 `src/schema.ts`、`src/migrate.ts`；`store.ts` 只保留 SQL 与行映射 | schema 测试断言表/索引/触发器数量与命名，且表集合恰为规格 §5.1 的 22 张；不再使用 `CREATE TABLE IF NOT EXISTS` 打开未知库 |
| TM-A3 | 旧库迁移器：预检、备份、staging 重建、`--dry-run` / `--apply`、原子替换、manifest 与隔离清单；把「旧进程可能再次启动」写进前置条件 | 新增 `src/migrate-legacy.ts`、`scripts/migrate-task-db.ts`、`tests/fixtures/{p0,v1,simplified}` | 三类 fixture 通过；dry-run 零写入；失败保留旧库可读 |

### 批次 B：权威服务与协议（对应规格阶段 2 + 3）

| 工作包 | 内容 | 落点 | 退出条件 |
|---|---|---|---|
| TM-B1 | `TaskService`：单事务 mutation（读版本 → 校验 `if_version` → 校验状态/权限 → 写业务行 → 追加事件/活动 → 提交），统一 `TaskError` 联合类型与 HTTP 映射。理由是跨表事务与审批归属，不是"分层风格" | 新增 `src/service.ts`、`src/errors.ts`；`store.ts` 只暴露事务原语 | 没有任何路由或工具直接调 store 的写方法；多表失败回滚有测试 |
| TM-B2 | 双生命周期：`lifecycle_mode` 列、P0 5 态 / V1 14 态隔离校验、创建即定模式且不可原地切换 | `src/lifecycle/`、`src/service.ts` | P0 状态在 V1 任务不可用，反之亦然；9 + 52 边逐条测试 |
| TM-B3 | 业务命令补全：`claim`（thread 绑定与 `thread_conflict`）、`rollback`（别名优先级）、`close`（验收集 + pending 提案门禁）、`comment`（review/decision/mention 白名单）、`criteria`、`reports`、`relations`（环检测）、`projects`、`ideas`，以及来源入库/分诊（`task_sources` 幂等写入、来源转 idea） | `src/service.ts` + 各域模块 | 关闭门禁、claim 冲突、关系环、mention 非法、重复来源幂等的测试全绿 |
| TM-B4 | HTTP：37 条迁移路由 + 4 条来源路由 + 2 条 canonical 灵感路由，静态路由优先，`{error:{code,message,details}}` 协议，`if_version` 缺省 0，409 返回最新记录 | `src/http.ts`（从 `dsh.ts` 拆出） | 路由 contract 测试逐条覆盖方法与状态码 |
| TM-B5 | 工具面补全与审批归属改造：新增 `task_claim`、`task_report_submit`、`task_comment`、`task_validate`、`task_rollback`、`task_close`（受限）；`requires_user` 改由服务端「待用户确认动作」记录 + 用户会话确认令牌执行，**删除请求体 `approvedByUser`** | `src/tools.ts` + `src/service.ts` | Agent 调 `task_advance` 到 `requires_user` 边必然被拒；HTTP 无法用请求体伪造批准 |
| TM-B6 | 执行绑定：`POST /execute` 改为创建/复用子 agent 会话并把 `session_id`（与可得 `run_id`）写入 `task_runs`，详情页提供"打开执行会话"深链；任务模块**只写会话指针，不代理会话内容** | `src/execute.ts`、`task_runs` 读写、客户端详情页 | 任务可列出多次执行；Session 缺失时任务仍可读并标为不可用；任务包不依赖任何执行载体 |

### 批次 C：交付面（对应规格阶段 5 + 6 + 7）

| 工作包 | 内容 | 落点 | 退出条件 |
|---|---|---|---|
| TM-C1 | 正式报告与导出：`task_reports` 真源、审批评论、md/html/json 渲染、同目录临时文件 + 原子 replace + SHA-256 + 历史 | 新增 `src/reports/{render,export,service}.ts` | 路径逃逸、摘要不一致、导出器不可用、原子性失败注入全部覆盖 |
| TM-C2 | 五视图 + 全屏详情 + 报告页 + **星图模式**：拆出客户端包 `@agentops/dsh-client-tasks`，按 DSH 主题与 slot 规范；星图作为依赖图的第二种渲染（确定性布局、轨道=父链、聚焦与聚合，见规格 §9.4）；文案进 typed 字典（8 语言）。前置：整个 agentops client 当前 `verify-client-ui-i18n` 失败，需要先有全局处置方案，否则新包只是多一处绿灯 | 新增 `packages/agentops/client-tasks/`（含 `task-star-layout.ts`）；`client/src/client/panel.tsx` 与 `task-report-panel.tsx` 迁移或删除 | Playwright 覆盖五视图、星图/网状切换、详情、审批、导出下载；星图两次渲染坐标一致；`verify-client-ui-i18n` 对新包通过 |
| TM-C3 | preset 收敛：固定 5 个 preset，prompt 引用的工具名与注册表一致；`task_decomposer` / `task_monitor` 按规格折叠或删除；`maxDepth` / `maxActiveSubagents` / mentions 白名单落地 | `agentops/agents/*.yaml`、`bundle/presets/agents.generated.patch.yml` | preset 引用的每个工具名都能在注册表找到；越权/深度/mention 测试通过 |
| TM-C4 | 测试网：contract、迁移 fixture、Playwright、keyless snapshot（创建/推进/拒绝/冲突/报告/错误） | `packages/agentops/task/tests/`、`apps/web/tests/`、`snapshots/` | 规格 §12 的验证矩阵逐项有对应用例 |
| TM-C5 | 文档：包 README 重写（去掉 `src/http.ts` 等漂移）、`docs/subsystems/agentops.md` 增任务章节、升级指南（若改持久化格式） | 文档树 | `pnpm run doc-sync`、`pnpm run test:docs` 通过 |
| TM-C6 | 上游来源适配器（按能力接）：先「粘贴链接入库」，再 GitHub issue（轮询 + cursor），最后飞书文档与话题；凭据缺失显式禁用 | 新增 `packages/agentops/intake/`（adapter 契约 + store） | 重复投递幂等；游标持久化；未配置时 UI 显示"未配置"而非空列表 |

顺序约束：A0 先做（它决定后面所有新代码有没有门禁，且需要一次豁免/补覆盖的决策）；A2 必须早于 B1（服务需要稳定表结构）；B1 必须早于 B4/B5；C1 依赖 B1 的事务边界；C2 依赖 B4 的契约，并且要先解决整包 i18n 失败。

## 8. 验收矩阵（可执行命令）

| 批次 | 命令 | 说明 |
|---|---|---|
| A0 | `pnpm exec vitest run packages/agentops/task`、`pnpm test:coverage` | 前者目前返回 `No test files found`；后者是判定"补覆盖还是申请豁免"的依据 |
| A2 | `pnpm test:coverage` | 新增 `packages/agentops/task/src/**` 需满足每文件 100%（当前实测 203 statements / 224 branches） |
| A3 | `node --import tsx packages/agentops/task/scripts/migrate-task-db.ts --dry-run --db <fixture>`（脚本随 A3 新建） | 三类 fixture 各跑一次 |
| B | `pnpm run test:snapshot -t task` | 模型可见路径快照 |
| C2 | `pnpm run build:artifacts && pnpm run build:check`、`pnpm --filter @agentops/dsh-client-tasks test`、`pnpm exec tsx scripts/verify-client-ui-i18n.ts` | 构建、客户端测试与 i18n 门禁 |
| 全部 | `pnpm run typecheck`、`pnpm run lint`、`pnpm run duplication` | 仓库级门禁 |

## 9. 需要拍板的开放问题

1. **P0 要不要升级为行级模式？** 旧系统的 P0 是部署级回退开关（`TASK_V1_ENABLED`），规格 §4.1 把它改造成每行 `lifecycle_mode`。做，意味着再加一套状态校验、UI 分支与迁移分支；不做，则需要明确「旧 P0 数据只读展示」。当前代码两者都没有。
2. **并发预算默认值**：规格 §3.2 给出 conductor 6 / dispatcher 4 / 其余 0，全局 `maxDepth = 1`、Host 上限 8。实际部署是否需要下调（例如单机 4 核、模型限流 2 路）？这决定调度队列的排队策略。
3. **版本号 `1 → 0` 的迁移窗口**：规格要求平移，但版本被客户端渲染、被工具当乐观锁入参；需要定义兼容期（拒绝旧版本 vs 接受并换算）。
4. **审批归属落在哪一层？** 文档 B5 提出的"用户会话确认令牌"依赖身份层；DSH 侧的 `connection` peer 身份是否可用作批准主体、`actor` 如何取证，规格与本文都未定义。这是架构决策，不是改字段。
5. **`task_decomposer` / `task_monitor` 两个 preset 怎么处理？** 规格要求折叠且不得留别名；它们已在工作区，需要决定删除还是改造为 workflow 节点。
6. **预设与工具的绑定时机**：先固化成 5 个 preset 再补工具，还是先补工具再改 preset？建议后者 —— 工具注册表是唯一事实来源，preset 应生成而非手写。
7. **上游来源的接入优先级与凭据**：先做"粘贴链接入库"（零凭据），GitHub 与飞书适配器排在 B 批次之后还是并行？飞书话题同时是后续反馈的归属键，越早接上，"追问回到原负责人"这条链路越早成立。
8. **报告导出根目录**：规格写 `<workspace_root>/task_exports`，DSH 的 workspace 语义与旧系统不同，需要确认落点与权限。

## 10. 建议的下一步

1. 审阅本分析与规格 §11 的阶段划分，确认 §9 的 8 个决策。
2. 先做 A0 的**决策**（补覆盖还是豁免），再动手接入测试；不要按"改名即完成"推进（实测会把 224 个分支的覆盖缺口暴露成 CI 红灯）。
3. 并行起草 TM-A1 契约清单与 TM-A2 schema 设计评审；契约清单同时对齐旧库 `sqlite_master`（65 表 / 105 索引 / 52 触发器）与规格目标（22 / 26 / 49）。
4. 在 A 批次完成前，冻结 `task_planner` 等 preset 的启用（其 `allowed_tools` 有 21 个工具尚未实现，接通只会制造失败体验）。
5. 星图先出**布局函数 + 只读渲染**（确定性可测），交互（聚焦、聚合、卡片）放到 C2 的第二批；不要等五视图全做完再验证星图。
