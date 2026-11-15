---
description: "AgentOps 任务域：十四态生命周期、受控转换、事件历史与五个工具。"
kind: "package-reference"
---

# @agentops/dsh-task

[English](README.md) | 中文

## 概述

任务沿固定的十四态生命周期流转。每次转换都是带乐观版本条件的更新，并追加一条事件，使历史可重放。本包在同一存储之上暴露五条路由与五个模型工具。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

驱动任务状态时使用；需要任务历史时读事件表。插件直接挂载版本化接口（RPC 通道 + owner-only 浏览器桥）；库缺失或为空时按 `SCHEMA_VERSION` 初始化，其他结构一律显式报错，旧库需先跑 `pnpm migrate:task --db <path>`。`exportRootDir` 指定 Markdown 报告文档位置，`allowedSourceSystems` 放宽收件箱来源。修改表、索引、触发器、路由或生命周期边之后运行 `pnpm contracts:check`，它会把 `contracts/task-contracts.v1.json` 与源码派生的快照逐字比对。`pnpm migrate:task --db <path> [--dry-run]` 会为旧库或简化库生成计划；真正执行时先备份，再整组替换主库与 `-wal`/`-shm`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/store.ts` | 生命周期、转换与事件历史 |
| `src/http.ts` | 任务路由 |
| `src/tools.ts` | 面向模型的任务工具 |
| `src/contracts.ts` | 契约快照：21 张表、27 个索引、49 个触发器、37 条路由与 P0/V1 边 |
| `src/schema.ts` | 上述表/索引/触发器的版本化 DDL（`SCHEMA_VERSION = 1`） |
| `src/migrate.ts` | 既有库的规划、staging 重建、校验与文件组替换 |
| `src/service.ts` | `TaskService`：单事务生命周期、版本、认领、回退、关闭门禁、评论、验收、报告、关系、运行幂等与收件箱采集/分诊 |
| `src/http.ts` | 与服务解耦的路由层：37 条迁移路由全部覆盖 + 2 条 canonical 灵感路由，统一错误映射 |
| `src/reports.ts` | Markdown 报告文档：原子写入、SHA-256、artifact 登记与导出历史 |\n| `src/mount-rpc.ts` | 把任务面挂到已鉴权的 `/api` RPC 通道（仅 owner） |`n| `src/tools-mount-v1.ts` | preset 内挂载服务化工具的入口，要求目标库处于 `SCHEMA_VERSION` |`n| `src/tools-v1.ts` | 由服务支撑的模型工具：task 的 list/get/create/advance/claim/comment/validate/report_submit/rollback，以及 idea 的 capture/list/triage |
| `src/lifecycle/p0.ts` | P0 五状态与九条边 |
| `contracts/task-contracts.v1.json` | 生成后入库的快照，用于评审与漂移检测 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../client/`](../client/README.zh.md) — 任务面板

-----

<a id="model-experience"></a>
## 模型体验

无。本包为 AgentOps 界面提供路由与存储，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只剩一个存储** — 三表旧存储与五个旧端点已删除；`TaskService` 是唯一写入口，旧库必须用 `pnpm migrate:task` 迁移。
- **路由挂在 RPC 上而不是 Fetch** — `connection.fetch` 只接受精确路径与 `GET`/`HEAD`/`POST`，因此 `mount-rpc.ts` 走共享 `/api` 通道并只允许 owner。插件尚未接入：面板切到 RPC 传输前仍是 5 条旧端点。
- **`task_inbox` preset 已生成但还没有 profile 挂载** — 它引用 `@agentops/dsh-task/tools-v1`；其他 preset 仍用旧的 `@agentops/dsh-task/tools`，需要部署侧接线后 v1 工具才可用。
- **旧库迁移保留指针而非载荷** — 旧运行的 `terminal_session_id` 留在 `task_runs`；报告级终端指针在目标表没有对应列，会通过 `MigrationResult.manifest.droppedTerminalReportPointers` 返回而不是静默丢弃。该 manifest 目前还没有写入磁盘。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
