---
kind: upgrade-guide
description: "AgentOps 任务插件把全部数据集中到单个 agentops.db，并不再提供旧的任务端点与工具。"
---

# AgentOps 任务库与接口

[English](guide.md) | 中文

## 变更

`@agentops/dsh-task` 改为打开 `$DSH_HOME/agentops/agentops.db`（`SCHEMA_VERSION = 1`），不再使用 `tasks.db`。21 张任务表、收件箱与 Agent 档案目录都放在这一个库里；`security.db`、`credentials.db`、`knowledge.db` 与 DSH Session 存储保持独立。`AGENTOPS_TASK_DB` 仍可覆盖路径，`exportRootDir` 的默认值改为 `<库所在目录>/reports`。

`schemaMode` 选项、三表旧存储、五个读取/推进端点（`/api/agentops/tasks`、`/task`、`/task-report`、`/activity`、`/task-advance`）以及 `@agentops/dsh-task/tools` 入口均已删除。插件始终挂载版本化接口：Connection 共享 `/api` 通道上的拦截器，加上浏览器面板调用的精确路由 `POST /api/agentops/task-rpc`。模型工具改为按 preset 从 `@agentops/dsh-task/tools-v1` 挂载。

两条连接都以 `PRAGMA foreign_keys = ON` 打开，schema 中的引用与级联规则因此真正生效。`user_version` 不等于 `SCHEMA_VERSION` 的库在加载时被拒绝；文件缺失或为空则按目标版本初始化。

## 迁移

1. 停掉挂载 AgentOps bundle 的 profile。若旧 `tasks.db` 中数据需要保留，先运行 `pnpm migrate:task --db <旧 tasks.db 路径>`；迁移器在替换主文件及 `-wal`/`-shm` 前会先备份。否则不要创建 `agentops.db`，让插件自行初始化。
2. 从所有设置过 `schemaMode` 的 `cordis.yml` 行或 overlay 中删除该字段，它已不再是合法配置。
3. 把调用已删除端点的代码改为 `POST /api/agentops/task-rpc`，请求体携带 `{ endpoint, method, query, body }`，或改用 RPC 通道；两者都进入同一个 router，且只允许 owner peer。
4. 把 `@agentops/dsh-task/tools` 的导入与 preset 行换成 `@agentops/dsh-task/tools-v1`。`task_stage_add` 没有对应工具：阶段通过 `task_advance` 与正式报告记录。
5. 部署侧若保留自有的生成物，重新生成：`node --import tsx agentops/scripts/gen-agent-presets.ts --write`。
6. 启动 profile：插件创建或接受 `agentops.db`，其他结构会以同时包含两个版本号的错误被拒绝。
7. 打开看板、报告页与监控页：三者都经桥读取数据，且不再调用已删除的端点。
8. 采集一条收件箱记录并用项目把它推到 `ready`；`doc` 或 `question` 记录仍必须被拒绝。
