# AgentOps 体系 · 产品能力面与集成方式

- 仓库：`<dsh-repo>`（pnpm workspace，Cordis 全插件化）
- 取证方式：只读（ls / git grep / 读源码、package.json、README、cordis patch），未运行 build / test / install
- 分析对象：`packages/agentops/**`（13 个子包 + `deploy/`、`skills/`、`knowledge-base/`、`scripts/` 四个非包目录）
- 记号：`路径:行号` 一律相对仓库根；未见到的写「未验证」

---

## ① 核心结论（3 行内）

1. AgentOps 本体的对外净出口是 **21 个模型工具 + 55 条 `/api/agentops/*` 精确路由 + 16 个主面板 + 1 个右侧栏页签**，另有 2 个只给 preset 用的非工具插件（`tool-policy`、`persona-static`）；所有工具都只能在 preset 层挂载，root 行挂工具永远不生效。
2. 装载是**三层 cordis patch**：profile（`dsh.profile.bundles`）→ bundle 的 `cordis.patch.yml` / `presets/*.patch.yml` → `@deepseek-ai/dsh-agent-preset` 的 `plugins:` 列表；host↔client 之间**没有 RPC、没有 Typert、没有共享 wire 类型**，只有浏览器 `fetch('/api/agentops/*')` 直连 + 一个仅覆盖「定义解析」的共享包 `@agentops/dsh-contracts`，A2UI 协议层在 host 与 client 各存一份逐字复制的 vendored 代码。
3. 成熟度：13 个包 README 合计 **59 条 Known Limitations**；DAG 只有 `agent` 节点能在 DSH 内真正跑起来（`command` 抛错、`await_command` 在 dag 侧解析即拒），编译器只支持 `agent` 节点，且**仓库内没有任何 profile 默认挂 AgentOps bundle**（`listedByDefault: false`）。

---

## ② 能力清单

### 2.1 模型可见工具（21 个）

| 能力（工具名） | 类型 | 注册路径 | 说明 |
|---|---|---|---|
| `agentops_system_status` | 工具 | `packages/agentops/host/src/dsh.ts:61-127`（`createSystemTool`） | 只读部署快照：DSH/Node 版本、实例拓扑、DB 延迟、数据边界开关、回滚点、warnings |
| `present_content` | 工具 | `packages/agentops/host/src/surfaces.ts:499-580` | 向生成式 UI 看板发布一张卡（`content_type`+`data` 模板通道，或 `surface` A2UI 直传）；同一 `viewId` 原地更新 |
| `board_cleanup` | 工具 | `packages/agentops/host/src/surfaces.ts:590-624` | 删单卡（`viewId`）或清空看板（`all:true`），强制 `confirm:true` |
| `dag_catalog` | 工具 | `packages/agentops/dag/src/dsh.ts:501-584` | 列工作流目录：id / 名称 / 节点数 / 校验态 / 顶层输入（只读） |
| `dag_validate` | 工具 | `packages/agentops/dag/src/dsh.ts:586-630` | 校验 workflow YAML，返回执行层级 `levels`（只读） |
| `dag_run` | 工具 | `packages/agentops/dag/src/dsh.ts:632-767` | 按 `workflowId` 或 `yaml` 运行；每个 `agent` 节点派生一个子代理；返回 runId、节点状态、终端节点交付物 |
| `dag_rerun` | 工具 | `packages/agentops/dag/src/dsh.ts:769-903` | 重跑已持久化运行的某节点（默认连同全部下游，`onlyNode` 保留下游结果） |
| `list_runs` | 工具 | `packages/agentops/dag/src/dsh.ts:905-` | 列近期运行与节点状态（只读；pinned preset 只看自己的） |
| `task_list` | 工具 | `packages/agentops/task/src/dsh.ts:65-104` | 列任务，按 `status` / `projectId` 过滤 |
| `task_get` | 工具 | `packages/agentops/task/src/dsh.ts:105-141` | 读单任务 + 阶段时间线 + 事件日志 + 允许的下一步动作 |
| `task_create` | 工具 | `packages/agentops/task/src/dsh.ts:142-171` | 在 `idea` 态建任务（`riskLevel` 决定评审闸） |
| `task_advance` | 工具 | `packages/agentops/task/src/dsh.ts:172-218` | 带 `expectedVersion` 乐观锁的状态推进；`requiresUser` 边依赖 `approvedByUser` |
| `task_stage_add` | 工具 | `packages/agentops/task/src/dsh.ts:219-` | 追加阶段标记；只记进度、不改状态 |
| `security_user_create` | 工具 | `packages/agentops/security/src/tools.ts:67-109` | 建用户（入审计），本身不授权 |
| `security_user_set_status` | 工具 | `packages/agentops/security/src/tools.ts:110-161` | 改用户状态，版本过期即拒，需 `confirm` |
| `security_role_assign` | 工具 | `packages/agentops/security/src/tools.ts:162-203` | 分配角色（已持有为幂等） |
| `security_token_issue` | 工具 | `packages/agentops/security/src/tools.ts:204-` | 签发 API token，明文只返回一次 |
| `knowledge_search` | 工具 | `packages/agentops/knowledge/src/dsh.ts:86-164` | 知识库检索（BM25），要求按 chunkId/version 引用 |
| `knowledge_import_plan` | 工具 | `packages/agentops/knowledge/src/dsh.ts:165-` | 生成导入计划（action / 敏感值 / 汇总），不落库 |
| `sql_query` | 工具 | `packages/agentops/db/src/tools.ts:96-173` | 只读 SQL：单语句、仅 SELECT/WITH、schema+表白名单、缺 LIMIT 自动注入 |
| `describe_database` | 工具 | `packages/agentops/db/src/tools.ts:174-` | 描述数据源表/列，写 SQL 前必查 |

工具名清单另有单一事实源（`only` 过滤的白名单）：`host/src/tools.ts:23`、`dag/src/dsh.ts:50`、`task/src/tools.ts:25`、`security/src/tools.ts:45`、`knowledge/src/tools.ts:30`、`db/src/tools-mount.ts:25`。

### 2.2 HTTP 端点（55 条，全部注册在 `ctx.connection.fetch.register`）

host（18 条，`@agentops/dsh-host`）：

| 路径 | 方法 | 注册路径 |
|---|---|---|
| `/api/agentops/agents` | GET | `packages/agentops/host/src/agents.ts:228` |
| `/api/agentops/agents/detail` `…/create` `…/update` `…/delete` | POST | `host/src/agents.ts:235,246,257,268` |
| `/api/agentops/archive` | GET | `host/src/archive.ts:95` |
| `/api/agentops/domains` `/api/agentops/actors` | GET | `host/src/catalog.ts:139,148` |
| `/api/agentops/models` | GET | `host/src/models.ts:106` |
| `/api/agentops/schedules` | GET | `host/src/schedules.ts:72` |
| `/api/agentops/sessions` `/api/agentops/session-log` | GET | `host/src/sessions.ts:91,101` |
| `/api/agentops/surfaces` | GET | `host/src/surfaces.ts:439` |
| `/api/agentops/surfaces/remove` `/clear` | POST | `host/src/surfaces.ts:449,461` |
| `/api/agentops/surfaces/views` `/latest` | GET | `host/src/surfaces.ts:472,479` |
| `/api/agentops/tools` | GET | `host/src/tool-catalog.ts:110` |

dag（13 条，`@agentops/dsh-dag`）：

| 路径 | 方法 | 注册路径 |
|---|---|---|
| `/api/agentops/workflows` | GET | `packages/agentops/dag/src/workflows.ts:132` |
| `/api/agentops/workflow-run` | POST | `dag/src/dsh.ts:328` |
| `/api/agentops/workflow-run-hint` | GET | `dag/src/dsh.ts:336` |
| `/api/agentops/workflow-rerun` | POST | `dag/src/workflow-rerun.ts:226` |
| `/api/agentops/runs` `/run` `/run-activity` | GET | `dag/src/runs.ts:196,203,223` |
| `/api/agentops/workflow-source` | GET | `dag/src/workflow-editor.ts:27`（注册 `:98`） |
| `/api/agentops/workflow-validate` `…-create` `…-save` `…-edit` `…-delete` | POST | `dag/src/workflow-editor.ts:28-32`（注册 `:116,148,172,197,247`） |

task（5 条，`@agentops/dsh-task`）：`/api/agentops/tasks` GET `task/src/dsh.ts:273`、`/task-report` GET `:291`、`/activity` GET `:330`、`/task` GET `:342`、`/task-advance` POST `:361`。

security（7 条，全 GET，`packages/agentops/security/src/http.ts`）：`/security/users` `:26`、`/security/roles` `:34`、`/security/sessions` `:35`、`/security/tokens` `:36`、`/security/usage` `:37`、`/security/audit` `:38`、`/api/agentops/monitor` `:40`（模块头 `:5` 声明「Every route here is a GET」）。

knowledge（6 条，全 GET，`packages/agentops/knowledge/src/http.ts`）：`/knowledge` `:67`、`/knowledge/search` `:76`、`/knowledge/documents` `:115`、`/knowledge/document` `:139`、`/knowledge/ask` `:293`、`/knowledge/lint` `:304`。

db（1 条）：`/api/agentops/datasources` GET `packages/agentops/db/src/dsh.ts:86`。

vault（5 条，`packages/agentops/vault/src/index.ts`）：`/connections` GET `:58`、`/connections/save` POST `:69`、`/connections/remove` POST `:105`、`/connections/audit` GET `:124`、`/connections/test` POST `:134`。

> 计数口径：`path: '/api/agentops…'` 字面量 49 个（`host`/`dag`/`task`/`security`/`knowledge`/`db`/`vault` 的 `src`）＋ `dag/src/workflow-editor.ts:27-32` 的 6 个常量 = **55**，去重后仍是 55（无重复路径）。

### 2.3 UI 面板（16 个主面板 + 1 个右侧栏页签）

主面板全部在 `packages/agentops/client/src/client/index.ts` 里 `ctx.slots.register({name:'main', key})`，侧栏行由 `client/src/client/menu.ts:117-230` 的 `AGENTOPS_MENU_ROWS` 驱动。

| 面板（slot key） | 组件 | 注册路径 | 侧栏分组 |
|---|---|---|---|
| `agentops` | `AgentOpsPanel`（任务看板） | `client/src/client/index.ts:268` | 任务管理 `menu.ts:153` |
| `agentops-task-report` | `TaskReportPanel` | `index.ts:360` | 任务管理 `menu.ts:160` |
| `agentops-knowledge` | `KnowledgePanel` | `index.ts:273` | 顶层 `menu.ts:118` |
| `agentops-collaboration` | `CollaborationPanel` | `index.ts:346` | Agent 管理 `menu.ts:125` |
| `agentops-workflows` | `WorkflowsPanel` | `index.ts:278` | Agent 管理 `menu.ts:132` |
| `agentops-agents` | `AgentsPanel` | `index.ts:288` | Agent 管理 `menu.ts:139` |
| `agentops-runs` | `RunHistoryPanel` | `index.ts:303` | Agent 管理 `menu.ts:146` |
| `agentops-replay` | `SessionReplayPanel` | `index.ts:371` | Agent 管理 `menu.ts:202` |
| `agentops-a2ui` | `A2uiPanel` | `index.ts:377` | Agent 管理 `menu.ts:209` |
| `agentops-schedules` | `SchedulesPanel` | `index.ts:298` | 系统设置 `menu.ts:216` |
| `agentops-vault` | `VaultPanel` | `index.ts:365` | 系统设置 `menu.ts:223` |
| `agentops-monitor` | `MonitorPanel` | `index.ts:341` | 顶层 `menu.ts:167` |
| `agentops-security-users` | `SecurityUsersPanel` | `index.ts:317` | 安全管理 `menu.ts:174` |
| `agentops-security-roles` | `SecurityRolesPanel` | `index.ts:323` | 安全管理 `menu.ts:181` |
| `agentops-security-sessions` | `SecuritySessionsPanel` | `index.ts:329` | 安全管理 `menu.ts:188` |
| `agentops-security-tokens` | `SecurityTokensPanel` | `index.ts:335` | 安全管理 `menu.ts:195` |
| 右侧栏页签 `@agentops/dsh-client-surface-screen` | `SurfaceScreen` | `client/src/client/surface-screen/register.ts:46-95`（`index.ts:443` 条件注入） | 非侧栏；轮询 `/surfaces/latest` 自动开页签 `register.ts:77,93` |

### 2.4 preset 专用非工具插件（2 个，改变模型行为但不在工具表里）

| 插件 | 注册入口 | 作用 |
|---|---|---|
| `agentops-tool-policy` | `packages/agentops/host/src/tool-policy.ts:40-45` | `ctx.tools.guard()` 按 scope 拒绝 `deny` 列表里的工具（旧 `denied_tools` 的落地方式） |
| `agentops-persona-static` | `packages/agentops/host/src/persona-static.ts:41-48` | 占用保留 section `deployment:persona-prefix` 写入旧 `system_prompt`，`interpolate:false`（不做 `{{…}}` 插值） |

---

## ③ 装载与集成方式

### 3.1 三层装载（profile → bundle → preset）

| 层 | 文件 | 事实 |
|---|---|---|
| profile | `packages/agentops/deploy/bootstrap-profile.mjs:69-78` | 生成 `dsh-profile-agentops`，`dsh.profile.bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@agentops/dsh-bundle']`；同时把 13 个 `@agentops/dsh-*` 以 junction/symlink 放进 profile 的 `node_modules`（`:91-102`） |
| 容器装载 | `packages/agentops/deploy/bootstrap.mjs:24,42-58` | 先 `dsh --profile web --dump-config` 建 profile，再链接包，再 `dsh web --port 3080 --patch /etc/agentops/agentops.patch.yml --patch …/presets/agents.generated.patch.yml` |
| bundle 清单 | `packages/agentops/bundle/package.json`（`dsh.bundle.patch` + `listedByDefault:false`） | 依次应用 `cordis.patch.yml` → `presets/agentops-tools.patch.yml` → `presets/agents.generated.patch.yml` |
| root 行 | `packages/agentops/bundle/cordis.patch.yml:19-77` | 9 个 root 行：`agentops-system`(host)、`agentops-knowledge`、`agentops-dag`、`agentops-task`、`agentops-vault`、`agentops-db`、`agentops-security`、`agentops-workflow-catalog`、`agentops-client`；`:80-83` 额外覆盖 `skill-filesystem.customSkillDirs` 指向 `packages/agentops/skills` |
| 工具行（preset） | `packages/agentops/bundle/presets/agentops-tools.patch.yml:10-41` | 一条 `@deepseek-ai/dsh-agent-preset`（`id: agentops`, `order: 20`），`plugins:` 里挂 `@agentops/dsh-host/tools`、`dag/tools`、`task/tools`、`security/tools`、`db/tools`、`knowledge/tools` |
| 业务 Agent preset | `packages/agentops/bundle/presets/agents.generated.patch.yml` | 由 `agentops/agents/*.yaml` 生成的 20 条 preset（`:6,39,71,107,…,630`），每条挂 `persona-static` + `tool-policy` + 对应 `*/tools` + DSH 原生工具（`tool-fs`/`tool-pwsh`/`tool-subagent`/`tool-todo`…） |
| 部署补丁（另一条路） | `packages/agentops/deploy/agentops.patch.yml:7-66` | 直接用绝对路径 `/app/packages/agentops/*/lib/index.js` 挂 root 行 + 内联 `preset-agentops`，供 `--patch` 使用 |

**关键约束（写进三处注释）**：`tools` 是 Agent 作用域服务，root 行写 `inject:['tools']` 会永远 pending 且**静默不生效**，因此「注册工具的那一半」只能出现在 preset 的 `plugins:` 列表里 —— `host/src/dsh.ts:45-50`、`host/src/tools.ts:1-7`、`bundle/cordis.patch.yml:10-12`。仓库内**没有任何 shipped profile 引用 `@agentops/dsh-bundle`**：`git grep agentops/dsh-bundle` 只命中 `deploy/bootstrap-profile.mjs`（运行期自建 profile）、`bundle/` 自身、`packages/agentops/README*.md`、`docs/config-catalog*.md`；`packages/bundle/*` 的 shipped bundle（base / web-app / headless / sdk-* ）一个都没引用它，且 bundle 自身声明 `listedByDefault:false`。

### 3.2 host ↔ client 的对齐机制

| 维度 | 实际机制 | 证据 |
|---|---|---|
| 传输 | **HTTP 精确路由**，不是 RPC：host 侧 `ctx.connection.fetch.register({path, methods, requestBody, fetch})`，client 侧浏览器自行 `fetch('/api/agentops/…',{credentials:'include'})` | `host/src/tool-catalog.ts:108-117`；`client/src/client/page-api.ts:49-59,72-89` |
| `/api` 桥 | 由 `@deepseek-ai/dsh-client-connection` 提供：Web carrier 独占 `/api` 路由 + Fetch 桥 + 浏览器鉴权 + Host/Origin 校验 | `packages/client/connection/README.md`（Summary / Use this package 段） |
| 共享契约 | 只有 `@agentops/dsh-contracts`，且**只用于定义解析与少量校验**（`client/src/client/agent-form.ts` 导入 `isRelativeArtifactPath` / `isSafeAgentId`）；HTTP 响应体在 client 侧按 `unknown` 收窄，**没有共享响应类型** | `client/src/client/agent-form.ts`、`page-api.ts:1-9` 注释「Responses are wire data…」 |
| 自述缺口 | client README Known Limitations 第 1 条：**「Browser fetch, not Remote — panels call `fetch` directly, so responses have no shared typed contract and bypass per-method authorization」** | `packages/agentops/client/README.md` |
| A2UI 协议层 | **复制而非共享**：`host/src/a2ui-schema/`（10 文件，`index.ts` 顶部 `// @ts-nocheck` + 「Vendored…Do not edit here」）与 `client/src/client/a2ui/lib/`（同 10 文件）中 6 个文件字节完全相同（`a2ui.ts`/`artifact-uri.ts`/`index.ts`/`json-value.ts`/`runtime.ts`/`validation.ts`），4 个内容不同（`reducer.ts`/`schemas.ts`/`types.ts`/`view-spec.ts`） | SHA-256 比对（本次只读执行）；`host/src/surfaces.ts:15` 导入 `./a2ui-schema/validation.ts` |
| 浏览器侧配置注入 | host 半（`@agentops/dsh-client` 根导出）通过 `webserver/index-inject` 推一个全局 `__DSH_AGENTOPS_CLIENT_CONFIG__` | `client/src/index.ts:18-25`；浏览器读回 `client/src/client/index.ts:264-267` + `client/src/config.ts:28-38` |
| 客户端 bundle 契约 | `package.json` 的 `dsh.client.inject`（layout / primitives / sidebar / slots / locale / store）+ `"platform": "web"` | `client/package.json` |

> A2UI 两份副本差异：`reducer.ts`、`schemas.ts`、`types.ts`、`view-spec.ts` 内容不同（`schemas.ts` 48557 vs 48552 字节，`types.ts` 12164 vs 12157）。哪一侧是权威上游 **未验证**（文件头只说「fix upstream and re-copy」，未给出上游仓库/版本）。

### 3.3 其它集成面

- `@agentops/dsh-host` 还向其它 AgentOps 包导出纯函数与 service（`host/src/index.ts:11-23`），`@agentops/dsh-workflow-catalog` 注册 `ctx.workflowCatalog` 服务（`workflow-catalog/src/index.ts:58-166`，`declare module` 于 `:31-35`），`@agentops/dsh-workspace-layout` 注册 `ctx.workspaceLayout`（`docs/subsystems/agentops.md`）。
- `db` 包反向 import `vault` 的源码：`db/src/dsh.ts:…` / `db/src/tools-mount.ts` 里 `await import('@agentops/dsh-vault/src/store.ts')`（README 自述为 limitation）。
- `dag` 依赖 host 之外的 DSH 服务：`connection`、`llm`、`sessionQuery`、`sessionController`、`subagents`、`workflowCatalog`（`dag/src/dsh.ts:294-320`、`host/src/dsh.ts:169-203`）。

---

## ④ contracts schema 要点（`@agentops/dsh-contracts`）

模块划分：`types.ts`（纯类型）、`schema.ts`（解析/边规则/分层/序列化）、`catalog.ts`（Domain 与 Actor Profile）、`ownership.ts`（workflow↔agent 归属索引）、`index.ts`（导出面 `index.ts:7-58`）。

### 4.1 关键类型与字段集

| 类型 | 位置 | 字段 |
|---|---|---|
| `AgentDefinition` | `contracts/src/types.ts:48-90` | `agentId` `displayName` `domain` `description?` `harness` `model`(或 `'auto'`) `systemPrompt?` `tier` `execution`(`skill`\|`workflow`) `workflow?` `permissions{allowedTools,deniedTools}` `knowledgeBases?` `timeoutSeconds?` `maxConcurrentRuns?` `costLimitPerRun?` `outputFiles{name→业务相对模板}` |
| `WorkflowDefinition` | `types.ts:194-204` | `workflowId` `name` `description?` `version` `businessId?` `inputs[]` `nodes[]` `widgets[]` |
| `WorkflowNode` | `types.ts:145-181` | `id` `type` `displayName?` `agentRef?` `inlineAgent?` `rolePrompt` `businessRole?` `harness?` `model?` `after[]` `inputs[]` `outputs{port→targets}` `timeoutMs?` `condition?` `branches?` `body?` `continueIf?` `maxIterations?` `skipIf?` `joinStrategy?` `cancelOnFirstFail?` `gatewayKind?` `commandConfig?` `awaitCommandConfig?` `whileConfig?` `rawFields?` |
| `WorkflowNodeType` | `types.ts:104-110` | **6 种**：`agent` `command` `await_command` `gateway` `parallel_branch` `while` |
| `WorkflowRunInputDefinition` | `types.ts:116-122` | `name` `type`(`string`\|`integer`\|`number`\|`boolean`\|`array`) `required` `default?` `description?` |
| `AwaitCommandConfig` | `types.ts:130-135` | `targetActors[]` `commandPort` `expirySeconds` `maxCommands` |
| `WorkflowWidgetDefinition` | `types.ts:184-191` | `id` `type` `title` `emitOnNode` `emitOnEvent` `props?` |
| `DomainDefinition` / `ActorVisualProfile` | `types.ts:259-268` / `295-299` | 业务域默认 harness/model/权限；Actor 可发布视图白名单（`ActorSurfaceView`+`ActorSurfaceField`） |
| `ValidationIssue` / `ValidationResult` | `types.ts:207-231` | `path` `message` `kind?` `line?` `column?` `nodeIds?` `cycle?` |

### 4.2 字段语义要点（务必注意的实际规则）

- **`after` 是唯一调度边**：`scheduleDependencies(node) === node.after`（`schema.ts:1112-1114`）；`topoLayers()` 只吃它。
- **`outputs` 是唯一数据边，永不参与调度**：`dataEdges()`（`schema.ts:1122-…`）；`README.md:56` 明确「a data edge never delays execution」。
- **端口目标规范化**：`outputs` 的值可为字符串、字符串数组、`{to: string|string[]}`（`schema.ts:376-381`），目标串会剥掉 `.in:…` / `.out:…` 后缀并去重（`schema.ts:383-387,406-419`）。
- **YAML 键名是 `agent`，内存字段是 `agentRef`**：`schema.ts:444` 读 `value.agent`；`agent` 与 `inline_agent` **互斥**（`:454-456`），`agent` 类型节点必须二选一（`:451-453`）。
- **超时双写法互斥且换算**：`timeout_ms`/`timeoutMs` 与 `timeout_seconds` 都存在；`timeout_ms = timeout_ms ?? timeout_seconds*1000`（`schema.ts:464-473`）；dag 侧则**同写两者即报错**（`dag/src/load.ts:274-279`）。
- **`gateway` 必须有 `condition` + 至少一个输出端口**（`schema.ts:498-501`）；`parallel_branch` 必须有非空 `branches`（`:507-509`）；`while` 必须有非空 `body` + `continue_if` + 正整数 `max_iterations`（`:525-531`）；`command` 必须 `command_config.cli_template`（`:483-489`）；`await_command` 必须 `await_command_config`（`:490-492`）。
- **未建模字段不丢**：`rawFields` 收所有不在 `knownFields` 里的 YAML 键（`schema.ts:569-579`），供可视化编辑无损回写。
- **`tier` 缺失/非法降级为 `T2` 并记 issue**（不失败）——`schema.ts:139-158`，`README.md:91`。
- **两套键拼写**：解析接受 snake_case 与 camelCase（`readAlias`，`schema.ts:309-311`），序列化一律写 snake_case（`serializeAgentDefinition`，`:1208`）。

### 4.3 校验入口（实际存在 5 处，不是 1 处）

| 入口 | 位置 | 用途 |
|---|---|---|
| `parseWorkflowDefinition` / `parseWorkflowGraph` | `contracts/src/schema.ts:1088-1106` | 严格/尽力两档解析；`loadWorkflowDefinition`/`loadWorkflowGraph` 做 YAML 文本层（`:1248,1278`，含行号定位 `locateIssues` `:836`） |
| `parseAgentDefinition` / `loadAgentDefinition` | `contracts/src/schema.ts:160,1239` | Agent YAML / API 值 |
| `parseWorkflowYaml`（dag 自己的解析器） | `packages/agentops/dag/src/load.ts`（类型白名单 `:20`，`normalizeNode` `:223-…`） | `dag_run`/`dag_validate`/运行历史投影实际用的解析器 |
| `validateWorkflow` | `packages/agentops/dag/src/validate.ts:23-95` | 语义校验 + 计算 `levels`（重复 id、悬空依赖/数据边、自依赖、gateway/parallel/while 专项、`while` body 越界依赖、环） |
| `WorkflowCatalog.validate/validateAndCompile` | `packages/agentops/workflow-catalog/src/catalog.ts`（服务面 `index.ts:115-126`） | 编辑器侧：先校验再编译，`/api/agentops/workflow-validate`（`dag/src/workflow-editor.ts:116`） |

**两套解析器不等价（重要边界）**：

| 维度 | `contracts` 解析器 | `dag` 解析器（`dag/src/load.ts`） |
|---|---|---|
| 节点类型 | 6 种（含 `await_command`） | 5 种（`load.ts:20`，**无 `await_command`**）→ 该类 YAML 在 dag 侧 `:241` 直接抛 `节点 … 的 type 不支持` |
| 键拼写 | snake + camel | 仅 snake_case（例：`timeout_ms`/`timeout_seconds` `:274-279`） |
| `inline_agent` | 允许（`schema.ts:448-450`） | **一律拒绝**（`load.ts:229-238`，两条不同错误信息），理由是权限归属 |
| 与 Agent 归属 | 不判断 | `agent` 节点必须有 `agent` 引用（`load.ts:243-248`） |

结论：**「定义能否保存」由 contracts 决定，「能否运行」由 dag 解析器再决定一次**；`await_command` 与 `inline_agent` 是两套判定明确分歧的两个特性。

---

## ⑤ dag 引擎能力边界

### 5.1 节点类型与运行期可执行性

引擎侧 `NodeType = 'agent' | 'command' | 'gateway' | 'parallel_branch' | 'while'`（`dag/src/types.ts:3`）。

| 节点类型 | 引擎内处理 | 在 DSH 内是否真能执行 | 证据 |
|---|---|---|---|
| `agent` | 调 `NodeExecutor` → 派生一个子代理 | ✅ 能 | `dag/src/engine.ts:272`；`dag/src/dsh.ts:202-263` |
| `gateway` | 求值 `condition` 后选端口（字符串→按端口名；布尔→`ports[0]`/`ports[1]`）；未声明端口即抛错 | ✅ 能（无子代理） | `engine.ts:229-245` |
| `parallel_branch` | 只聚合 `branches` 的输出，**不并行派生**；`joinStrategy` 完全不读 | ✅ 能（语义弱） | `engine.ts:223-227`；`validate.ts:49-55` |
| `while` | 按 `continueIf` + `maxIterations` 迭代执行 `body` 节点 | ✅ 能（串行） | `engine.ts:247-270` |
| `command` | 走到执行器即抛错 | ❌ **不可执行** | `dsh.ts:210-212`：`command 节点 … 尚未在 DSH 中执行；请改用原生工具（如 sql_query）` |
| `await_command` | dag 解析层就拒绝（不在类型白名单） | ❌ **解析即失败** | `dag/src/load.ts:20,240-242` |
| 任何非 `agent` 且非上述类型 | 执行器抛「没有子代理执行器」 | ❌ | `dsh.ts:213-215` |

补充：`workflow-compiler` 也只支持 `agent` 节点，其余类型返回 `kind:'unsupported'` 而不静默降级（`workflow-compiler/src/compile.ts:65-72`）。

### 5.2 并发与重试

- **并发**：按 `validateWorkflow().levels` 分层，层内 `runLevel()` 用固定 worker 池拉取（`engine.ts:328-345`），默认 `concurrency = 4`（`engine.ts:152`；`DEFAULT_CONFIG`/patch 里都是 4，`bundle/cordis.patch.yml:50`）。层间是硬屏障。
- **重试**：**没有重试语义**。`NodeState.attempts` 只在开始执行时 `+1`（`engine.ts:172`），失败即 `status:'failed'`（`:183-189`），没有 backoff/重试循环；`attempts` 的作用是 resume 时保留历史（`:150`）。
- **节点超时**：在**执行器层**实现（`AbortSignal.timeout(node.timeoutMs)` + `AbortSignal.any`，`dsh.ts:220,283-287`），引擎本身不判超时。
- **取消**：`RunOptions.signal` 在层边界检查（`engine.ts:155,193`），取消后未开始节点置 `skipped`（`:347-354`）。取消只发生在节点之间，跑着的节点靠 signal 透传。
- **失败传播**：上游 `failed`/`skipped` 会让下游 `skipped`（`engine.ts:288-293`）；gateway 未选中端口对应的目标也 `skipped`（`:300-314`）。

### 5.3 run 的可恢复性（resume / invalidate）

| 能力 | 位置 | 语义 |
|---|---|---|
| `RunOptions.resume` | `dag/src/types.ts:135`；`engine.ts:128-151` | 已完成节点不重跑（复用其 `outputs`），其余（failed/skipped/中断）回到 `pending`，`attempts` 保留 |
| `invalidateRunForNode()` | `engine.ts:49-99` | 克隆 run；目标节点复位为 `pending`；默认把**全部传递下游**（含 `parallel_branch` 分支依赖）一并复位；`onlyNode=true` 时保留下游结果；清除时间戳/error/端口/outputs |
| 拒绝条件 | `engine.ts:55-66` | `run_running`（运行中）/ `workflow_mismatch`（`runId` 与 `workflow.id` 不匹配且不以 `workflow.id@` 开头）/ `unknown_node` |
| 唯一可达路径 | `dag/src/dsh.ts:846-866`（`dag_rerun` 先 `invalidateRunForNode` → `store.save(resumed)` → `DagEngine.run({resume})`）；HTTP 版 `dag/src/workflow-rerun.ts:226`（queue-only） | 没有「整体断点续跑」的对外入口，只有节点级重跑 |
| 持久化 | `dag/src/run-store.ts`（`node:sqlite`，见文件头注释）；`beginRun`/`saveNode`/`save` 让活跃运行也有进度行（`dsh.ts:715-743`） | run 表不存 workflow 版本 |

已知不可靠点（`dag/README.md` Known Limitations）：**无 run 级锁**（两个会话可同时通过校验改同一 run）、**崩溃可把 run 留在 `running`**（之后一律 `run_running` 直到手工修状态）、**重跑读当前 YAML**（不存版本）、**「受理 ≠ 完成」**。

### 5.4 其它边界

- **递归深度闸**：`delegationDepthOf(exec.agent) > 1` 时 `dag_run` 直接拒绝（`dsh.ts:697-699`；函数来自 `@deepseek-ai/dsh-subagent`，导入于 `dsh.ts:18`），防止节点再启工作流。
- **pinning**：preset 可置 `ownedWorkflowId`/`ownerAgentPreset`，使 `dag_run` 只跑该工作流、且节点子代理强制继承所属 Agent preset（`dsh.ts:58-80,684-703`；无 owner 时抛「拒绝按调用方权限继承执行」`dsh.ts:227-230`）。
- **端口输出协议**：节点声明了 `outputs` 就生成严格 JSON Schema 校验子代理结构化输出（`nodeOutputSchema` `dsh.ts:152-…`，校验 `:251-257`）。
- **终端交付物**：只取「无出边」节点的端口输出，按节点字符预算截断（`terminalOutputs`，`dsh.ts:1069-1082`）。
- **`workflow-run` HTTP 端点不执行工作流**：它只创建一个 `agentPreset:'agentops'` 会话并把固定提示「请用 dag_run 工具运行…」入队（`dag/src/workflow-run.ts:120-173`，reason 文案 `:36-37`）。

---

## ⑥ 成熟度标记统计与清单

### 6.1 计数

| 标记类别 | 数量 | 说明 |
|---|---|---|
| `TODO` / `FIXME` / `XXX` 注释（`*/src`，排除 locales） | **0** | 本次只读 grep 全 `packages/agentops/*/src` 无命中；限制不写在代码里，写在 README |
| `@ts-nocheck` 文件 | **16** | 全部是 vendored A2UI：`host/src/a2ui-schema/*`（10）+ `client/src/client/a2ui/components/*`（6） |
| `as unknown` 断言 | **56** | 分布在 host/dag/client 等（与仓库「no unknown casts」约定冲突） |
| README「Known Limitations」条目 | **59** | bundle 3、client 9、contracts 3、dag 9、db 3、host 5、knowledge 4、security 3、task 2、vault 3、workflow-catalog 6、workflow-compiler 5、workspace-layout 4 |
| 显式「未实现 / 不支持」抛错（throw） | **5** | 见 6.2 |
| 显式「不支持」降级返回（不抛错） | **7** | 见 6.3（3 个未迁移 `content_type` + 4 个 A2UI 校验拒绝） |
| 前端显式「尚未接入/尚未上报」占位 | **3** | 见 6.4 |
| `private: true` 的包 | **13/13** | 全部 AgentOps 包均 private，且不在 `scripts/product-package-policy.ts` 的分类里（grep 无命中） |

### 6.2 显式未实现抛错（5 处）

| # | 位置 | 文案要点 |
|---|---|---|
| 1 | `dag/src/dsh.ts:211` | `command` 节点「尚未在 DSH 中执行；请改用原生工具（如 sql_query）」 |
| 2 | `dag/src/dsh.ts:214` | 非 `agent` 节点「没有子代理执行器」 |
| 3 | `dag/src/load.ts:229-233`、`:234-238` | `inline_agent` 两种形态均拒绝（权限归属） |
| 4 | `dag/src/load.ts:241` | 节点 `type` 不支持（覆盖 `await_command`） |
| 5 | `workflow-compiler/src/compile.ts:70` | 「执行器当前只支持 agent 节点，… 是 …」→ `kind:'unsupported'` |

### 6.3 显式「不支持」的降级返回（7 处）

| 位置 | 内容 |
|---|---|
| `host/src/a2ui-templates.ts:30` | `UNSUPPORTED_TYPES = ['media','form','dashboard']`（3 种 `content_type` 未迁移，返回 `暂未迁移` 原因 `:84`） |
| `host/src/a2ui-schema/a2ui.ts:773` | `formatString` 只允许 JSON Pointer，嵌套函数/其它表达式 not supported |
| `host/src/a2ui-schema/a2ui.ts:851` | `wantResponse=true is not supported` |
| `host/src/a2ui-schema/a2ui.ts:856` | `responsePath is not supported by the AgentOps host` |
| `host/src/a2ui-schema/a2ui.ts:878` | 非空 `event.context` not supported |

（另有 `knowledge/src/import-plan.ts:100` 的 `action:'unsupported'`（不支持的 MIME），属数据面分类而非能力缺失；`dag/src/expr.ts:246`、`contracts/src/schema.ts:441` 属正常非法输入报错。）

### 6.4 前端显式缺口（3 处）

| 位置 | 内容 |
|---|---|
| `client/src/client/knowledge-panel.tsx:247` | 标签检索 `尚未接入`（输入框占位） |
| `client/src/client/knowledge-panel.tsx:260` | 「标签检索需要 tag 索引，尚未迁移」 |
| `client/src/client/monitor-panel.tsx:452` | 「DSH 尚未上报价格」（`security/src/http.ts:56` 对应 `capabilities:{cost:false, agentRuntime:false}`） |

### 6.5 版本/实验性标记

- 未发现任何 `experimental` 字样或 `x-experimental` 标记；无 AgentOps 包被列入 `packages/experimental/`。
- 全部包版本固定 `0.1.0`、`private: true`（13 个 `package.json`）。
- 迁移不兼容清单（仓库根，非包内）：`agentops/MIGRATION-INCOMPATIBILITIES.md` 自述 **硬失败 0 项**，但列 9 类不兼容：I1 工作流引用不存在的 agent（18 处 / 4 个工作流）、I2 `command` 节点不执行（4 处 / 1 个工作流 `smart-query`）、I3 工具未迁移 **64/83**（`agentops/mappings/tool-map.yaml` 实测 `mapped: null` 64 条、`mapped:{…}` 19 条；该文档写 64/80，条目数已增长）、I4 知识库未迁移（7 个 KB 键）、I5 harness/model 改写（3 个 agent）、I6 业务分类字段下线（16 个工作流）、I7 历史运行指向已删工作流（187/189）、I8 工具映射表 v1→v3、I9 业务域/Actor 字段差异（2 个端点）。
- **仅限某 provider / 某平台**：
  - 子代理 provider 固定 `spawn`（`bundle/cordis.patch.yml:50`、`presets/agentops-tools.patch.yml:29`、`deploy/agentops.patch.yml:58`；`DEFAULT_CONFIG` 见 `dag/src/dsh.ts:102-`）。
  - 客户端平台固定 `"platform": "web"`（`client/package.json`）。
  - 节点模型可写 `provider/model`（`dag/src/dsh.ts:273-281`），但 `harness` 枚举（`local_llm`/`claude_sdk`/`codex`/`opencode`/`deterministic`，`contracts/src/types.ts:15`）在 DSH 内由 DSH 运行期接管，`MIGRATION-INCOMPATIBILITIES.md` I5 承认语义已改写。

### 6.6 文档与代码不一致（需复核，未验证哪一方为准）

`packages/agentops/dag/README.md` Known Limitations 第 2 条称「gateway always takes the first port, `await_command` times out, `while` does not loop, `parallel_branch` ignores `join_strategy`」，但 `dag/src/engine.ts:106-108` 的文件内注释明确写「Fix(es) two defects of the legacy Python engine **by construction**: a gateway evaluates its condition instead of always taking the first port」，且 `engine.ts:229-245` 确实求值 `condition`、`:247-270` 确实循环 `while`。因此该条 README 至少 gateway 与 `while` 两句是**过时描述**；`await_command` / `join_strategy` 两句与代码一致（`await_command` 解析即拒、`joinStrategy` 从未被读取）。

`sql_query` 的白名单强度在代码里比工具描述弱：`db/src/guard.ts:88-95` 只在 SQL 文本出现 `<schema>.` 前缀时才逐表校验，裸表名（如 `SELECT * FROM secrets`）不触发表白名单检查——与 `db/README.md` Known Limitations 第 1 条一致，与工具描述 "schema+table whitelist" 的措辞不完全一致。

---

## ⑦ 摘要（≤150 字）

出口 21 工具、55 条 /api/agentops/* 路由、16 面板 + 1 右栏页签；装载走 profile→bundle→preset，工具只能挂 preset；host↔client 无 RPC，仅 fetch + contracts 解析；DAG 仅 agent 节点可跑，无重试。
