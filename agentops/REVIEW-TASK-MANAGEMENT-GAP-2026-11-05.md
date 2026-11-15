# REVIEW — AgentOps 任务管理差距分析（对抗性审核）

| 项 | 内容 |
|---|---|
| 被审文档 | [`TASK-MANAGEMENT-GAP-ANALYSIS.md`](./TASK-MANAGEMENT-GAP-ANALYSIS.md) |
| 对照基准 | [`TASK-MANAGEMENT-MIGRATION-DESIGN.md`](./TASK-MANAGEMENT-MIGRATION-DESIGN.md)、`<legacy-repo>`、`packages/agentops/**` |
| 日期 / 分支 | 2026-11-05 / `agentops/main`（HEAD `仓库基线` + 268 项未提交变更） |
| 执行层 | native subagent（未点名外部 harness），三家非 fork、互不可见 |
| 轮次 | R1 独立审查 1 轮 + 主持人逐条复验（用户未指定轮次） |
| 审查者 | S1 静态核验 · S2 实测执行 · S3 反向重建 |
| 独立性声明 | 三家提示词不同、取证方法互斥；同模型家族，"多视角"来自方法差异而非模型差异。所有指控一律由主持人重跑取证后才计入 |
| 结论强度 | **仅供参考**（事实层可用；度量层与三条判断需降级；见 §5 分歧与登记） |

## 1. 总体结论

文档的事实骨架（生命周期 parity、缺表/缺路由/缺工具、schema 无版本无约束、preset 与工具面断裂、单测不进 vitest、旧库 46 路由 / 23 表）经三家与主持人复验**成立**；但三类内容必须改：

1. **三处会被下游直接消费的数字错了**：旧库表数（56/33）、未注册工具名清单（19，且成员错）、覆盖率门禁定性（"不进 test:coverage"）。
2. **两条判断证据不足**：把 P0 说成"并行的一等模式"；把"store 兼任领域"单列为任务域设计缺陷（兄弟包同一模式）。
3. **基线声明失效**：工作区有 268 项变更、`deploy` 装配已与 `bundle` 漂移，"对 HEAD 与工作区同时成立""两条装配路径是同一份"不成立。

## 2. 二次复核表

| # | 指控 | 提出方 | 我的复验（一手） | 判定 |
|---|---|---|---|---|
| 1 | 旧库表数应为 65（非 56），非任务表 42（非 33） | S2（S1 主张 54 不同名） | 实库 `<legacy-repo>/audit.db` 只读打开：**65 表 / 105 索引 / 52 触发器 / `user_version=93`**；`audit/store.py` 内 58 条建表语句、54 个不同名（`global_revision`/`projects`/`task_stages`/`tasks` 各两份） | **采纳**（S1 的 54 是源码口径，不完整但不冲突） |
| 2 | 未注册工具名 19 个，且名单有误 | S1（改 17）· S2（改 19 换名单 / 并集 25） | 按 `permissions.allowed_tools` 精确求差 = **21 个**：`list_tasks`、`task_advance_stage`、`task_approval`、`task_auto_evolve`、`task_claim`、`task_close`、`task_commit_stage`、`task_conductor_scan`、`task_create_project`、`task_decompose_apply`、`task_decompose_decide`、`task_detail_get`、`task_dispatch_execute`、`task_dispatch_scan`、`task_execute_coding`、`task_link_run`、`task_relations_complete`、`task_rollback`、`task_submit_idea`、`task_submit_report`、`task_validate` | **部分采纳**：17 与 19 均错；文档原名单把 `task_comment`/`task_report`（产物名词）算作工具、漏了 6 个真实声明；改为 21 |
| 3 | 规格"24 基础索引"不实，旧库去重仅 22，3 个索引不存在 | S3 | 旧库实库核对：规格 §5.4 的 **25 个索引名全部存在（25/25）**；源码任务域索引去重恰 24，`idx_task_report_exports_report` 由 `task/exporter.py` 建 | **驳回**（S3 计数漏了 design/ideas 族索引；`idx_doc_proposals_task`、`idx_doc_changes_doc` 均真实存在） |
| 4 | 覆盖率门禁并非"不覆盖"，而是已纳入且 0% | S2 · S3 | 复跑 `vitest run packages/agentops/client/tests/menu.client.spec.ts --coverage --coverage.include="packages/agentops/task/src/**"` → 0%（203 stmts / 224 branches / 65 funcs / 176 lines），逐文件 `does not meet threshold (100%)`，exit 1；`coverage.include` 无 agentops 例外 | **采纳**：原文"不进 test:coverage 门禁"错，实际是"在门禁集合内、当前零覆盖" |
| 5 | `audit/store.py` 的 91 索引/53 触发器 ≠ 实库 | S2 | 实库 105/52；源码 91/53 | **采纳**，改为实库口径 |
| 6 | 旧 `task/` 约 182 KB、组件 11 个、SHA-256 在 285-289 | S1 · S2 | 182,223 B；`components/task` 11 个 `.tsx`（含 `WorkReview.tsx`）；`_sha256_bytes`@285 | **采纳** |
| 7 | 行号是工作区口径；§2.5 漏 `panel.tsx`；"没有功能性改动"不实 | S1 · S3 | `git status --porcelain` = **268 条**；`git show HEAD:<p> \| .Count`：store 285/325、status 148/172、dsh 409/414、panel 288/293；`panel.tsx` 13+/8- | **采纳**（重写 §2.5 + 头部口径） |
| 8 | §3.4「根插件只装存储与只读路由」与写路由矛盾 | S1 · S3 | `dsh.ts:358-387` 在根插件调用的 `registerTaskRoute` 里注册 `POST /task-advance` | **采纳** |
| 9 | §3.2「一律 409」不实；详情 404 在 348 非 297 | S1 | `dsh.ts:369,375` 返回 400；297 属 task-report，348 才是详情 | **采纳** |
| 10 | §5.7 对 `panel.tsx:229`「页面直接写库」的指控不成立 | S1 | 面板先 `window.confirm` 再 POST，语义成立 | **撤回**；改记 119 行「推进任务走 `task_advance` 工具」（实际走路由） |
| 11 | 看板是数据驱动，不是"静态"；且 `canceled`/`abandoned` 无列不可见 | S3 | `panel.tsx:92` 按 `lane.statuses.includes` 过滤；`LANES` 4 列未含这两个终态 | **采纳**（原文漏了这个真实缺陷） |
| 12 | P0 不是"并行一等模式"，是部署级回退开关 | S3 | `api/server.py:211` `TASK_V1_ENABLED` 默认 `1`；`audit/store.py:2111` `task_v1_enabled: bool = False`；旧库无 `lifecycle_mode` 列，模式为进程级 | **采纳**（原文 §2.2 表述错） |
| 13 | "store 兼任领域"是任务域特有缺陷（双标） | S3 | `security/src/store.ts:1-7`（同事务审计）、`dag/src/run-store.ts:1-9`、`vault/src/store.ts:1-6` 同为 `DatabaseSync` + DDL + 语义同文件 | **部分采纳**：不是风格违规；真实缺口是**跨表事务编排**与审批归属 |
| 14 | `requires_user` 绕过缺威胁模型取证 | S3 | 路由经 `ctx.connection.fetch.register` → `BrowserAuth`/`PeerAdmission`（`packages/client/connection/src/index.ts:13,154-163`），仅已认证 peer 可达；但 `approvedByUser` 与 `actor` 都取自 body（`dsh.ts:380-381`） | **采纳降级**：改为"任一已认证浏览器 peer 可自批且无归属审计" |
| 15 | 整个 agentops client 未过 i18n 门禁 | S3 | `pnpm exec tsx scripts/verify-client-ui-i18n.ts` → exit 1，含 `task-report-panel.tsx` 多条 | **采纳**（原文把硬编码写成任务模块独立缺陷） |
| 16 | `agent_profiles`/`task_contributions` 在旧 api/web 零调用 | S3 | `grep` 命中 0 | **采纳**（覆盖率分母含无消费方条目） |
| 17 | A0「半天、无风险」低估 | S3（与我自查 F5 一致） | 见 #4 的 224 分支实测 | **采纳**（改成本与前置决策） |
| 18 | preset 断裂是"生成器失控" | S3 修正我 | `agentops/mappings/tool-map.yaml` 对未映射工具标 `mapped: null`，`tests/gen-agent-presets.test.ts` 断言只告警、不生成挂载行 | **采纳**：是"迁移未完成 + 显式告警"，不是静默失效 |

## 3. 讨论轮次账本

| 轮 | 投给谁 | 各方表态 | R_t | E_t | C_t | S_t | K_t |
|---|---|---|---:|---:|---:|---|---:|
| R1 | S1/S2/S3 并行 | 三家独立出报告（18 条 P0/P1 指控） | 18 | 18 | 0 | 否 | 2 |
| 主持人复验 | — | 采纳 14、部分采纳 2、驳回 1（S3 索引）、撤回 1（S1 反驳成功） | 0 | 6（我的复算新增） | 3 | 否 | 2 |

主持人复验新增的一手证据（计 6 条）：实库 65 表/105 索引/52 触发器/`user_version=93`；规格 25 索引在旧库 25/25 存在；任务域索引源码去重 24；未注册工具 21 个（脚本求差）；覆盖率探针 0%+exit 1；268 项工作区变更。

已登记（K_t=2，无法完全判定，不计入"已解决"）：

1. **默认 `test:coverage` 是否在无 include 覆盖时也报告这些文件**：探针改变了 include；全量跑超时未完成。两种可能（门禁已红 / 未加载文件不报告）都指向同一处置：A0 必须先决定豁免或补覆盖。
2. **未注册工具名的"权威并集"**：21（`allowed_tools` 口径，可复现）与 25（并入 prompt 产物名词与 patrol 定时任务名）都可辩护；文档采用 21 并注明口径。

收敛判定：R_t=0 且 K_t=2 → 按"登记后结束"处理，结论强度降为 **仅供参考**（非"全部一致"）。

## 4. 处置清单（已全部落地到被审文档）

| # | 位置 | 原表述 | 修订为 | 来源 |
|---|---|---|---|---|
| D1 | 头部 | 仅写"仓库基线 仓库基线" | 补分支、268 项未提交变更、**行号=工作区口径**（HEAD 行数更短） | S1/S3 |
| D2 | §1 表 | 13%/8%/0%/85%/26% 等百分数并列 | 改为条目计数 + 明示"不同口径不可加权"，生命周期拆成"规则表 52/52、执行与门禁缺、双模式 0" | S3 |
| D3 | §1/§9 | "P0 并行一等模式" | 改为"旧系统 P0 是部署级回退开关（`TASK_V1_ENABLED`），规格把它升级为行级 `lifecycle_mode`" | S3 |
| D4 | §2.2 | 未标注耗时来源 | 补"13 passed ≈0.4 s""52/52 实测" | S2 |
| D5 | §2.5 | "只是 JSDoc，无功能性改动，结论对 HEAD 与工作区同时成立" | 重写：268 项变更、`panel.tsx` 13+/8-、`deploy` 新增两个插件并改路径、新增 page-api 等文件；结论只对工作区成立 | S1/S3 |
| D6 | §3.1 | 行数未标口径 | 标注工作区口径并给出 HEAD 对照 | S1 |
| D7 | §3.2 | "一律 409"、404@297 | 400/409 分开、404@348、`exec(SCHEMA)`@106 | S1 |
| D8 | §3.3 | "静态四列看板" | 改为"四列写死、按状态过滤的数据驱动渲染；`canceled`/`abandoned` 无列不可见" | S3 |
| D9 | §3.3/§5.7 | 229 行"错误注释" | 撤回；改记 119 行工具/路由错位 | S1 |
| D10 | §3.4 | "根插件只装存储与只读路由"、"两条路径同一份装配" | 改为"根插件装存储 + 5 条路由（含唯一写路由）"；补 `bundle`/`deploy` 已漂移 | S1/S3 |
| D11 | §4 | 阶段百分数（20%/5%/…） | 改为成熟度定性（未做/切片/部分/达标）+ 依赖顺序说明 | S3 |
| D12 | §5.1 | "存储兼任领域"列为方向性缺陷、"3 份实现" | 改为：兄弟包同构，属本批导入风格；真实缺口=跨表事务/审批归属/审计，服务层是为迁移增量引入 | S3 |
| D13 | §5.2 | "谁知道字段谁就能批准" | 改为"任一已认证浏览器 peer 可用裸 JSON 自批，`actor` 亦自报，批准无归属" | S3 |
| D14 | §5.3 | 只写 v1 vs v0 | 补迁移期风险：`1→0` 全局平移、旧客户端/脚本稳定 409 | S3 |
| D15 | §5.6 | 19 个工具名（名单错）、"静默失效" | 改 21 个（列全）、说明生成器已 `mapped: null` + 测试告警、`only` 白名单抛错行号 | S1/S2/S3 |
| D16 | §5.8 | "不进 test:coverage 门禁"、六个包 | 改为"在覆盖率门禁集合内且 0%"（探针 exit 1，203/224/65/176）+ 8 个包用 `.test.ts` | S2/S3 |
| D17 | §6.1 | 56 表 / 91 索引 / 53 触发器 / 约 200 KB | 实库 65/105/52/`user_version=93`；源码 58 条/54 名；182 KB；组件 11 个 | S1/S2 |
| D18 | §6.2 | "规格数值全部准确"+索引待清点 | 保留 46/23/9/52；补"25 索引在旧库 25/25、24 旧有+1 新增"；删除待清点 | 主持人 |
| D19 | §6.3 | 3 条 | 补第 4 条：旧库三代会自毁的惰性迁移（P0→V1 `DROP`、V3 `ALTER`） | 主持人 |
| D20 | §7 TM-A0 | 半天、无风险 | 改为：接入即触发 100% 覆盖门禁，需先决定豁免或补 224 分支；成本重估 | S3 |
| D21 | §7 TM-C2 | 只修任务面板 | 补：整个 agentops client 未过 i18n 门禁，需全局方案 | S3 |
| D22 | §9 | P0 是否保留问法有误 | 改为"是否把部署级回退开关升级为行级模式"；补版本 0 迁移、身份/审计、装配漂移三个决策 | S3 |
| D23 | §10 | 建议下一步 | 同步调整（先定豁免，再 A0） | 主持人 |

## 4.1 落地验证（逐条回读，非编辑回执）

| 处置 | 验证方式 | 结果 |
|---|---|---|
| D1 行号口径 | grep「行号口径」「HEAD 148」 | 已落地 |
| D2 条目计数 | grep「条目计数」；全文无 13%/8%/85%/26%/30%/15% | 已落地 |
| D3 P0 定性 | grep「部署级回退开关」（§2.2、§9.1） | 已落地 |
| D4 实测耗时 | grep「约 0.4 s」 | 已落地 |
| D5 工作区规模 | grep「268 项」 | 已落地 |
| D6 行数口径 | §3.1 表格逐行「（HEAD …）」 | 已落地 |
| D7 错误码/行号 | grep「dsh.ts:348」；无「一律 409」 | 已落地 |
| D8 看板描述 | grep「`canceled`」；无「静态四列」 | 已落地 |
| D9 撤回 229、改记 119 | grep「panel.tsx:119」；「页面直接写库」已不存在 | 已落地 |
| D10 装配描述 | grep「唯一写路由」「已经开始漂移」 | 已落地 |
| D11 阶段判定 | §4 表格无百分数 | 已落地 |
| D12 store 风格 | grep「本批导入的统一风格」 | 已落地 |
| D13 威胁模型 | grep「已认证的浏览器 peer」 | 已落地 |
| D14 版本平移风险 | grep「稳定收到 409」 | 已落地 |
| D15 工具名 21 | grep「21 个任务工具名在 DSH 侧未注册」 | 已落地 |
| D16 覆盖率真相 | grep「覆盖率门禁把它们算进去了」「203 statements」 | 已落地 |
| D17 旧库实况 | grep「65 张表 / 105 个索引 / 52 个触发器」 | 已落地 |
| D18 索引 24+1 | grep「25 个索引（旧库 24」 | 已落地 |
| D19 惰性迁移 | grep「DROP TABLE task_stages」 | 已落地 |
| D20 A0 重估 | grep「处置覆盖率门禁」「224 个分支」 | 已落地 |
| D21 i18n 全局 | §7 TM-C2 与 §3.3 均含 `verify-client-ui-i18n` | 已落地 |
| D22 决策项 7 条 | grep「7 个决策」；§9 共 7 条 | 已落地 |

复验命令（可重跑）：

```powershell
cd <dsh-repo>
Select-String -Path agentops\TASK-MANAGEMENT-GAP-ANALYSIS.md -Pattern '条目计数|部署级回退开关|268 项|21 个任务工具名|覆盖率门禁把它们算进去了|65 张表 / 105 个索引 / 52 个触发器|DROP TABLE task_stages'
```

## 5. 最终分歧记录

| 分歧 | 各方立场 | 为什么未定 | 对结论的影响 |
|---|---|---|---|
| 默认覆盖率 lane 是否已红 | S2/S3：大概率红；主持人：探针证明该文件集在门禁内且 0%，但未跑全量 | 全量 `test:coverage` 超出本次时限 | 只影响"门禁现状"表述，两种可能都指向同一处置 |
| 未注册工具名的口径 | 主持人 21（`allowed_tools`）· S3 19 · S2 19/并集 25 | "工具名"边界（产物名词、定时任务名）无权威定义 | 文档写 21 并注明口径与并集上界 |
| 规格是否为"绝对目标" | S3：部分条目在旧系统无消费方（`agent_profiles`/`task_contributions`） | 迁移目标应由产品决定，非技术审查可裁定 | 文档保留规格口径，但标注"分母含无消费方条目"并登记待产品确认 |

## 6. 结论

- **事实层**：可信。三家一致确认的核心事实（52 边 parity、3 表/2 索引/0 触发器/无 CHECK/无 user_version、5 路由/5 工具、preset 引用未注册工具、单测不进 vitest、旧库 46 路由/23 任务表）均经主持人重跑验证。
- **度量层**：不可直接用于排期。百分数是多口径拼接，已改为计数 + 定性。
- **判断层**：三条结论降级——"P0 并行一等模式"（错，已改）、"store 兼领领域=设计缺陷"（双标，已改为增量需求）、"A0 无风险"（错，已改）。
- **评审方错误 1 条**：S3 的"24 索引不实/3 个索引不存在"被实库 25/25 反驳。

## 7. 后续变更（不在本次审查范围内）

2026-11-07 规格修订 A 落地：执行模型统一由 Session 承载、依赖图增加星图模式、新增上游来源层，并把并发预算显式化为一张分配表。被审分析文档与规格的计数同步改为 22 表 / 26 索引 / 37 迁移路由 + 4 来源路由 / 5 视图；本文 §2–§4 记录的是修订前的审查事实（旧库 46 路由、23 任务表、25 索引），作为历史账本保留，不再代表当前契约。
