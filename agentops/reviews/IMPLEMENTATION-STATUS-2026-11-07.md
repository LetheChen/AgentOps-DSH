# 任务管理迁移 · 实施状态（2026-11-07）

对照设计：[`../TASK-MANAGEMENT-MIGRATION-DESIGN.md`](../TASK-MANAGEMENT-MIGRATION-DESIGN.md)（修订 B，SHA-256 `7C89714D…586907`，本轮未修改）。

## 1. 完成度

| 阶段 | 状态 | 证据 |
|---|---|---|
| 0 契约快照 | 完成 | `contracts/task-contracts.v1.json` 由源码派生；21 表 / 26 索引 / 49 触发器 / 37 路由 / P0 9 + V1 52 边；`pnpm contracts:check` 通过 |
| 1 Schema 与迁移器 | 完成（导出文件迁移属阶段 5） | `src/schema.ts` + `src/migrate.ts`；P0 / V1 / 简化库三类 fixture 通过；备份 + 文件组替换 + `foreign_key_check` / `integrity_check` |
| 2 TaskService | 服务层完成，`schemaMode: v1` 可接线 | `src/service.ts`：advance/claim/rollback/close/comment/criteria/report/relations/execute/finishRun/updateTask/proposal/idea；单事务 + `if_version` |
| 3 HTTP API | 37/37 + 2 canonical，**未挂载** | `src/http.ts` + `tests/http.test.ts`；静态路由优先、错误码映射、PATCH 白名单 |
| 4 工具与 preset | 工具完成，**未挂载** | `src/tools-v1.ts`：9 个服务化工具，`requires_user` 边对 agent 一律拒绝；preset 仍指向旧工具 |
| 5 报告与导出 | 导出器与路由完成；文件迁移未做 | `src/reports.ts`：md/html/json 渲染、路径白名单、临时文件 + 原子替换 + 回滚、SHA-256、历史与校验；3 条导出路由挂载后需补真实文件流 |
| 6 五视图 UI | 未开始 | 现有看板仍是旧数据路径 |
| 7 集成与文档 | 部分 | 包 README（中英）已同步；设计未改；无升级指南 |

## 2. 验证证据（可复跑）

```powershell
cd packages/agentops/task
pnpm test            # 98 tests, 98 pass
pnpm typecheck       # clean
pnpm contracts:check # contract snapshot is current
cd ../..
pnpm exec oxlint packages/agentops/task/src/<changed files> packages/agentops/task/tests  # exit 0
```

## 3. 阻塞项（不是代码问题，是平台能力缺口）

**`TaskHttpApi` 无法按设计挂载。** `ConnectionFetchRoute` 只接受**精确路径**且方法集合是 `GET | HEAD | POST`（`packages/client/connection/src/rpc.ts:147-166`），而契约包含 `{task_id}` 段与 `PATCH`。

可选处理：

1. 给 `connection.fetch` 增加前缀路由（内部 `/api` 前缀已是这种形态），或
2. 由 AgentOps host 插件在 web server 上注册一条前缀路由并复用 `TaskHttpApi`，或
3. 收敛契约：把 `PATCH` 改为 `POST /tasks/{id}/update`、把路径参数改为查询参数（会偏离设计 §6.1）。

在选定方案前，插件继续提供原有 5 条端点，避免破坏现有面板。

## 4. 剩余工作与建议顺序

0. **修订 C 待实施**：收件箱模型（`ideas` 三轴：`channel` / `source_system` / `kind`，状态机 `captured → triaged → ready → converted`，`idx_ideas_capture`，`task_inbox` preset，`POST /ideas/{id}/triage`）。目标为 21 表 / 27 索引 / 49 触发器 / 37 迁移路由 + 3 条 canonical 收件箱路由；
1. **挂载方案**（上面三选一）→ 挂上 `TaskHttpApi`，同时保留旧端点直到阶段 6。
2. **运行时接线**：`dsh.ts` 的 `apply` 改为「打开库 → `assertSchemaVersion` → `new TaskService`」；`store.ts` 退役时一并清掉 `store.ts` / `dsh.ts` 的存量 lint 债（成员分隔符、`require-await`、多余断言）。
3. **工具与 preset**：`createServiceTaskTools` 替换 `@agentops/dsh-task/tools` 的 store 版；把 preset 里 21 个未注册工具名收敛到注册表（阶段 4 验收）。
4. **导出器已可用**：挂载后把 `GET .../export` 从 JSON 元数据改为真实文件流；旧 `task_exports` 文件迁移（设计 §10.6）仍未实现。
5. **UI**：五视图 + 详情 + 报告页；建议新建 `packages/agentops/client-tasks`，同时解决整包 `verify-client-ui-i18n` 失败。
6. **文档**：`docs/subsystems/agentops.md` 增任务章节；若改持久化格式则补升级指南。

## 5. 已知取舍

- `hasPendingProposal` 关闭门禁只检查 `status = 'pending'`；`approved` 但未应用的提案不阻塞关闭（与设计 §4.4 一致）。
- 报告审批只允许用户；agent 自批返回 403，未实现"提交者与审批者同一 agent"的更细规则。
- `convertIdea` 先建任务再回写 `converted_task_id`，两步不在同一事务；重复调用幂等，但极端崩溃会留下未回写的任务。
- 旧库 `task_runs.terminal_session_id` 作为只读指针保留；报告级终端指针只进 `MigrationResult.manifest`，尚未落盘。
