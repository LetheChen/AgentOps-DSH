# REVIEW — Task Management Migration Design — 2026-11-07

## 1. 审查元信息

| 项目 | 内容 |
|---|---|
| 被审对象 | `<dsh-repo>\agentops\TASK-MANAGEMENT-MIGRATION-DESIGN.md` |
| 审查前 SHA-256 | `D59784F61F14741E40A53D4F44FA70AF20F9F5F03F4A9890DC239EFBBBFA67D5` |
| 修订后 SHA-256 | `7C89714D3DAB93DB77A99AC17C0665ABFFE8E9C7CA6E32B94B787B95CA586907` |
| 原始摘录账本 | [REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07-draft.md](REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07-draft.md) |
| 审查日期 | 2026-11-07 |
| 执行层 | native subagents，R1 |
| 审查者 | S1 Plato：静态核验；S2 Epicurus：真实旧库只读查询与临时 SQLite 实测；S3 McClintock：反向重建 |
| 投递方式 | native subagent 独立任务；未使用 CLI session id |
| 成本 | 三次 native R1；宿主会话内记账，未取得独立可核验的扣费数据 |

独立性声明：S1/S2/S3 使用独立上下文和不同取证方法，未读取既有 review 产物，未共享最终结论。三者的真实模型均为宿主继承模型，模型家族同源；独立的是取证方法，不是模型家族。本报告不把“三家都提到”当作跨模型独立确认。

draft 中的 `S2: pending` 是中途状态。最终状态以本报告为准：S1/S2/S3 全部完成。

用户约束：只报告会造成返工、错误落地、数据风险或明显过度设计的问题；不做完备性扩架构，不为审查新增产品能力。

## 2. 总体结论与结论强度

结论：设计已经完成证据支持的最小修订，可以进入实施计划阶段。

结论强度：**可执行（仅限设计修订；不证明目标实现）**。

已确认的文档错误均已落到设计中，包括 Session 能力过度承诺、TaskService 现状误述、API 等价范围过宽、Host 深度/并发冲突、运行幂等缺失、迁移文件组替换、真实旧指针丢失和导出失败不可恢复。reviewer 的若干超范围指控已排除；上游来源同步与星图已移出本次迁移。

本结论不证明以下对象已经存在或通过验证：目标 21 表 schema、`TaskService`、37 条 HTTP 路由、导出器和迁移器。这些仍是待实现部分，证据等级为 L0。

## 3. R1 账本

| 轮次 | R | E | C | S | K |
|---|---:|---:|---:|---|---:|
| R1 | 0 | 12 | 0 | 否 | 0 |

- `R=0`：R1 后没有仍以相互冲突证据保留的未解决争议。已排除的 reviewer 误报记在 §7，不计为未解决争议。
- `E=12`：按来源指纹去重后有 12 个新增证据单元，见 §5。
- `C=0`：未执行 R2，没有 reviewer 在追加轮次中主动撤回或修正；本报告由主持人根据一手证据裁决。
- `S=否`：没有剩余争议需要判断双方证据是否同源。
- `K=0`：没有影响本次设计修订的“无法核验、需登记等待”的争议。§8 限制是实施前证据缺口，不是未裁决的审查指控。

## 4. 未执行 R2 的理由

1. 用户没有要求多轮对抗；本任务按默认单轮 R1 执行。
2. R1 没有产生需要交叉质证的同源争议。S1/S2/S3 的方法不同，关键冲突已由真实旧库、真实源码或可重跑实验直接判定。
3. 已确认问题都能用最小修订收口；继续追问只会扩大文档范围，违反“不要过度设计”。
4. 没有把“三家同源模型都提到”当作独立确认；因此也没有用 R2 伪装跨模型收敛。

## 5. 证据等级与 R1 证据单元

| 等级 | 含义 |
|---|---|
| L4 | 真实旧库只读查询、真实代码执行、临时 SQLite/文件系统实测 |
| L3 | 真实源码、测试、当前 DSH 源码的直接核对与可审计推论 |
| L2 | SQLite 语义或设计内部一致性 |
| L1 | 尚未执行完整迁移的代码/数据推断 |
| L0 | 目标实现不存在，仅设计文字 |

| ID | 新增证据单元 | 等级 |
|---|---|---|
| E1 | 旧库结构实测：任务域 23 张表（含 2 张终端表）、24 个任务域命名索引、49 个触发器、`global_revision=(1,21)` | L4 |
| E2 | 唯一 `task_runs` 行：`run_id=NULL`、`session_id=NULL`、`terminal_session_id` 非空 | L4 |
| E3 | 唯一 `task_reports` 行：`session_id=NULL`、`terminal_session_id=NULL` | L4 |
| E4 | 唯一 `projects` 行：`binding_state='needs_review'`，其余附加字段为 NULL | L4 |
| E5 | 旧 `/api/tasks` 路由解析：46 条，扣除 9 条终端载体路由后为 37 条；旧来源路由为 0 | L4 |
| E6 | 旧 UI `ViewKey`：dashboard/board/list/gantt/graph/coding，共 6 个；删除 coding 后为 5 个 | L4 |
| E7 | 旧 `status.py`：P0 9 条边、V1 52 条边 | L4 |
| E8 | 当前 DSH 简化库：3 张表、2 个索引、0 行、`user_version=0`；源码创建版本为 1、mutation 递增、允许 `done` | L4 |
| E9 | Session 预览实现：最多 200 个事件、单事件最多 1200 字符 | L4 |
| E10 | subagent / preset 源码：Host 默认 `maxDepth=1`、`maxActiveSubagents=8`，没有 preset 级 6/4 队列 | L3 |
| E11 | 临时 SQLite WAL/SHM 实验：仅替换主库而保留旧 sidecar 仍读到旧数据 | L4 |
| E12 | exporter 故障注入：替换目标文件后历史插入失败，目标文件已为 NEW、历史为 0，旧实现不可恢复 | L4 |

补充复算：37 条旧非终端路由和设计表一致；26 个命名索引应为“旧 24 + 新增 2”，不是“23 + 3”；49 个触发器为 16×3 + 1。

## 6. 已确认问题与最小处置

| # | 已确认问题 | 证据 | 最小处置 |
|---:|---|---|---|
| 1 | “Session 提供完整执行过程可见性”超出实际能力 | E9；external subagent 没有本地 Session，Session 可清理、可缺失 | 改成弱指针和截断预览，明确最多 200 个事件、1200 字符，不承诺完整回放 |
| 2 | “TaskService 独占权威状态”被写成现状 | 当前 `dsh.ts` 直接写 store、`tools.ts` 独立打开 SQLite、`index.ts` 导出 store | 改成实施退出条件：所有 write path 收敛、停止导出 store、删除旁路写后才可宣称独占 |
| 3 | “API 行为等价”范围过宽，与删除终端载体冲突 | E5、E6；旧执行接口和 Coding 视图依赖终端载体 | 限定为“保留功能上的行为等价”，删除 9 条终端路由和 coding 视图 |
| 4 | 上游来源和星图属于新增功能，不是旧系统恢复 | E5；旧系统没有来源路由，旧视图只有普通 graph | 删除 `task_sources`、4 条来源路由、adapter/cursor、星图和派生星图字段 |
| 5 | Host `maxDepth=1` 与 conductor→dispatcher→coding 冲突 | E10；6/4 不是 Host/preset 字段 | Host 全局 `maxDepth=2`、`maxActiveSubagents=8`；6/4 只作 AgentOps 业务队列 |
| 6 | `/execute` 缺少幂等键、活跃运行唯一约束和运行终态 | 旧运行表无状态；设计原先无并发保护 | 增加 `status`、`idempotency_key`、单任务单活跃运行、`active_run_conflict`，终态限定为 succeeded/failed/canceled/unknown |
| 7 | 删除旧执行指针会丢失真实旧记录定位信息 | E2；`task_reports.terminal_session_id` 另需保留原值到 manifest | 保留 `task_runs.terminal_session_id` 只读指针；报告中删除的终端指针写入迁移 manifest；保留 `task_reports.session_id` |
| 8 | 只替换旧主库、保留旧 WAL/SHM 会继续读到旧数据 | E11；源库当前为 WAL | 停写、获取一致性备份或 checkpoint，主库/WAL/SHM 作为文件组替换和恢复 |
| 9 | 复制顺序漏 `global_revision`，且外键依赖顺序有风险 | E1；临时实验证明缺失 singleton 时触发器不会推进 revision | 复制并初始化 `global_revision`，先复制被引用表，再启用索引/触发器 |
| 10 | 旧 `projects` 附加字段有真实值，原设计会静默丢失 | E4：`binding_state='needs_review'` | 原值写入 `projects.metadata.legacy_project`，并在 manifest 记录映射 |
| 11 | 导出覆盖目标后历史写入失败不可恢复 | E12；旧实现没有 replace 前备份 | replace 前备份旧文件；历史失败时恢复；恢复失败返回 `details.state=unknown` 并保留材料 |
| 12 | 简化库只处理 `1→0`，未覆盖 2/3；`done` 未映射；目标版本未固定 | E8；源码允许递增版本和 `done` | 所有 `version>=1` 减一，0 不变，负数拒绝；`done→committed`；固定 `SCHEMA_VERSION=1` |
| 13 | 索引计数和 revision 排除清单口径不一致 | E1；`design_notes` 不在修订清单中 | 26 索引改为“旧 24 + 新增 2”；`design_notes` 明确不参与 revision |
| 14 | `thread_id` 双重语义、Workspace 被误当授权、`task_close` 暴露范围矛盾 | 设计条款及当前 DSH 源码 | `thread_id` 仅表示不透明会话线程；Workspace 只解析路径；`task_close` 对所有 preset 不可用 |

## 7. Reviewer 误报与非问题

| 项 | 结论 |
|---|---|
| P0 9 条边、V1 52 条边 | 成立，不是误报；用于验证状态机计数 |
| 46 − 9 = 37 条路由 | 成立，旧任务路由扣除终端载体路由 |
| 旧 UI 6 个视图，删除 coding 后为 5 个 | 成立，不属于范围扩大 |
| 49 = 16×3 + 1 | 成立，48 个修订触发器加 1 个 parent 环检测 |
| DAG 节点需要额外节点表 | 误报；节点身份由 tasks/task_stages/task_relations 数据定义 |
| 历史 `task_contributions`、`agent_profiles` 表本身是过度设计 | 误报；本次只需迁移历史数据，运行期声望功能可推迟 |
| `task_reports.session_id` 应删除 | 误报；它是有效的 Session 弱引用，删除的是终端指针 |
| 计数 fixture 能证明产品价值 | 误报；只能作为防漂移夹具，不能替代行为验收 |
| preset 复用、数据库 staging/备份、Session 弱指针、历史表保留 | 合理，不删除 |
| `task_sources` 的 PK、NULL 去重和只追加矛盾 | 在删除来源子系统后失效，不进入本次范围 |

## 8. 未解决或有限证据项

- 没有跨模型家族的独立确认；三家 reviewer 均继承宿主模型，只有取证方法独立。
- 目标实现不存在，属于 L0；本报告只证明设计修订可执行。
- 没有真实旧 P0 数据库，仅有源码和测试证据；真实旧库当前是 V1。
- 旧库样本很小：3 个任务、1 条运行、1 条报告、0 条导出历史，不能证明完整生产分布。
- WAL/SHM 结论来自临时 SQLite 实验，没有对正在使用的生产库执行替换。
- 未做真实并发复现；`/execute` 的并发结论是设计约束和源码推论，不是压测结果。
- SessionController 创建/复用 API 未逐项核验。
- 目标 21 表 schema、TaskService、HTTP API、导出器和迁移器尚未实现，因而没有对应实现测试通过。
- 旧库可能在活动，最终复核时主库为 57,683,968 bytes；前一次 reviewer 记录为 57,589,760 bytes。所有查询均使用只读 URI 和 `PRAGMA query_only=ON`，未借此写入源库。

## 9. 过度设计：删除与推迟

| 项 | 处置 | 原因 |
|---|---|---|
| `task_sources`、4 条来源路由、GitHub/Feishu adapter、cursor/etag/last_seen | 删除出本次迁移 | 旧系统没有来源路由；属于独立上游同步能力 |
| 星图、力导向布局、200 节点星团、聚焦/触摸和星图派生字段 | 删除出本次迁移 | 旧系统只有普通依赖网络图 |
| 逐子级工具名白名单 | 拒绝 | 现有机制是 preset 插件组合和任务插件 `only`，不新增过滤器 |
| 为每个 DAG 节点创建独立 preset | 拒绝 | 节点复用 preset，执行期用独立 Session 隔离上下文 |
| 运行期声望/贡献计算 | 推迟 | 只迁移历史数据，不把声望系统并入本次恢复 |
| 计数 fixture | 保留但降级为防漂移 | 计数不证明功能价值，不能替代行为验收 |

## 10. 实际复现事实与命令

旧库只读查询的核心口径：

```powershell
# Python sqlite3 使用 mode=ro；连接后执行 PRAGMA query_only=ON
SELECT * FROM global_revision;                    -- (1, 21)
SELECT * FROM task_runs;                          -- run_id/session_id 为 NULL，terminal_session_id 非空
SELECT * FROM task_reports;                       -- 唯一行两个执行指针均为 NULL
SELECT * FROM projects;                           -- binding_state = needs_review
```

结构复算结果：

```text
旧任务域命名索引 = 24（不含 terminal 表的 idx_terminal_sessions_task）
旧任务域触发器 = 49
旧 /api/tasks 路由 = 46；终端载体 = 9；非终端 = 37
旧 UI ViewKey = dashboard/board/list/gantt/graph/coding = 6
P0 转移 = 9；V1 转移 = 52
```

当前简化库：

```text
<user-home>\.dsh\agentops\tasks.db
user_version = 0
journal_mode = delete
tables = tasks/task_stages/task_events
indexes = tasks_project/tasks_status
rows = 0/0/0
```

临时实验记录在 draft：WAL 实验证明主库-only replace 仍返回旧行；exporter 故障注入证明历史插入失败后目标文件已变为 NEW。两者均未写入旧生产库或仓库文件。

文档检查命令：

```powershell
git diff --check -- agentops/TASK-MANAGEMENT-MIGRATION-DESIGN.md agentops/reviews/REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07.md
Get-FileHash -Algorithm SHA256 agentops/TASK-MANAGEMENT-MIGRATION-DESIGN.md
Get-FileHash -Algorithm SHA256 agentops/reviews/REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07.md
```

本任务是设计审查，未运行产品单测、构建或迁移器测试；未把未运行检查描述为通过。

## 11. Reviewer 原始摘录

完整摘录保留在 [draft](REVIEW-TASK-MANAGEMENT-MIGRATION-DESIGN-2026-11-07-draft.md)，未删除或改写。

- S3：“Session 提供完整执行过程可见性”不成立；现有 replay 不是完整过程。
- S1：`maxActiveSubagents` 是 Host 单一 volatile 配置，达到容量直接 `ACTIVATION_LIMIT_REACHED`，不是 preset 级业务队列。
- S2：真实唯一执行记录只有 `terminal_session_id` 非空，`run_id` 和 `session_id` 均为 NULL；仅保存 `run_id/session_id` 会丢失旧记录定位。
- S2：旧 `projects.binding_state='needs_review'`；目标 schema 不保留该列时必须写入 metadata，不能静默丢弃。

## 12. 处置表

| 位置 | 原表述 | 修订为 | 来源/证据等级 |
|---|---|---|---|
| §1、§6.6 | Session 提供完整过程 | 弱指针；最多 200 事件、单事件 1200 字符；可能缺失或截断 | S3/S1；E9，L4 |
| §2 | TaskService 已是唯一权威 | 目标是唯一写入口，迁移完成前是实施退出条件 | S3；当前源码，L4 |
| 标题、§1 | API 行为等价未限范围 | 保留功能上的等价；终端载体和 Coding 视图除外 | S3/S2；E5/E6，L4 |
| §1、§3.2、§9 | 保留来源与星图 | 删除来源层、星图和来源路由 | S3/S1；旧系统反证，L3 |
| §3.2 | preset 级 6/4，全局 maxDepth=1 | Host maxDepth=2、maxActive=8；6/4 仅为业务队列 | S1/S3；E10，L3 |
| §5.1、§6.5 | 运行表无状态和幂等键 | 增加 status/idempotency；单任务单活跃运行；终态明确 | S3；设计内部与源码，L3 |
| §5.1、§10.5 | 删除所有终端指针 | 保留 task_runs.terminal_session_id；报告终端值写 manifest；保留 session_id | S2；E2/E3，L4 |
| §14 | 只替换主库 | 主库/WAL/SHM 整组替换和恢复 | S2；E11，L4 |
| §10.3 | 复制清单漏 global_revision、外键顺序不明确 | 先复制 global_revision 和引用表，再创建触发器 | S2；E1，L4 |
| §10.5 | 旧 project 附加字段丢弃 | 写入 projects.metadata.legacy_project 并记录 manifest | S2；E4，L4 |
| §7.4 | 覆盖后历史失败不可恢复 | replace 前备份；失败恢复；恢复失败标 unknown | S2；E12，L4 |
| §5.1、§5.7、§10.4 | 只映射 1→0，未固定版本 | SCHEMA_VERSION=1；所有 version>=1 减一；done→committed | S1/S2；E8，L4 |
| §5.4、§5.6 | 索引组成错误，design_notes 漏出排除清单 | 旧 24 + 新增 2；design_notes 明确不参与 revision | S1/S2；E1，L4 |
| §3.2、§6.4、§6.5 | thread_id/Workspace/task_close 语义矛盾 | thread_id 仅会话线程；Workspace 只解析；task_close 全部 Agent 不可用 | S1；设计条款与源码，L3 |

## 13. 已实施与未实施验证

| 检查项 | 结果 |
|---|---|
| Session 能力表述 | 已落地：§1、§6.6 |
| TaskService 实施退出条件 | 已落地：§2 |
| 21 表 / 26 命名索引 / 49 触发器口径 | 已落地：§5、§12、附录 B |
| SCHEMA_VERSION=1 | 已落地：§5.7 |
| 旧 terminal_session_id 只读保留 | 已落地：§5.1、§10.5 |
| task_reports.session_id 保留 | 已落地：§5.1、§10.5 |
| global_revision 初始化与复制顺序 | 已落地：§10.3 |
| WAL/SHM 文件组替换与恢复 | 已落地：§14 |
| done→committed、version>=1 减一 | 已落地：§10.4 |
| 旧 project 附加字段映射 | 已落地：§10.5 |
| 导出备份和失败恢复 | 已落地：§7.4 |
| maxDepth=2 / maxActive=8 / 业务队列 6/4 | 已落地：§3.2 |
| task_close 对全部 preset 不可用 | 已落地：§3.2、§8、§12 |
| 来源与星图移出范围 | 已落地：§1、附录 B |

未实施：目标 schema、`TaskService`、HTTP 路由、导出器、迁移器、并发测试和真实迁移演练。以上为后续实施计划与测试的验收对象，不是本报告的已完成项。

## 14. 审查完成声明

- S1 Plato：完成。
- S2 Epicurus：完成。
- S3 McClintock：完成。
- 三家均完成 R1；本报告不声称 R2 或跨模型家族独立确认。
