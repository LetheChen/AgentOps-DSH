# AgentOps 能力中心迁移至 DSH 的实施方案

> 状态：REVIEWED WITH OPEN BLOCKERS — 2026-11-12
> 目标仓库：`<dsh-repo>`
> 原系统：`<legacy-repo>`
> 审查账本：`agentops/reviews/REVIEW-capability-center-dsh-2026-11-12.md`
> 结论：方向成立，但必须先关闭 P0 阻断项，不能直接按“只加页面 + resolver”开工。

## 1. 目标与边界

目标不是做一个 DSH 风格的简化 CRUD 页，而是复刻原 AgentOps 能力中心的产品语义、操作路径和后端控制面：

- 能力定义：平台支持哪些能力。
- 连接器实例：本部署实际连接哪些 OA、飞书、数据库、SSH 等。
- 凭证引用：真实密钥只存服务端加密存储，实例只保存引用。
- 工具投影：能力最终投影为可调用工具；未桥接项必须明确标记不可运行。
- Agent 授权：控制哪个 Agent 可以使用哪个实例。
- 运行期校验：模型真实调用时必须按同一事实源解析实例、凭证和访问策略。

复刻口径是 **结构、信息层级、交互语义与后端能力复刻**，不是像素级复刻。若要求像素级，必须另行提供原页面基准截图、目标视口、容差和字体/间距规范。

## 2. 已验证事实

### 2.1 DSH 传输与路由

- `packages/client/connection/src/rpc-host.ts:114` 是精确 Fetch 路由注册表。
- `rpc-host.ts:211-217` 按 `url.pathname` 精确查表，不支持 `{id}` / `:id` 路径参数。
- 精确 Fetch 路由的 query 参数可以使用；把实例 ID 放 query 或 body 属于 API 设计选择，不是 DSH 强制。
- `packages/agentops/task/src/mount-rpc.ts` 已提供可复用模式：共享 `/api` RPC 通道 + 单一路由 bridge，保留动态路径、PATCH、DELETE、query 和 body 语义。

结论：能力中心不牺牲原逻辑路由，也不只做一组散装 exact route，而是采用 **RPC bridge + capability router**。浏览器只调用一个稳定 physical route，内部 router 保留原 `/api/integrations/{instance_id}` 等逻辑契约。

### 2.2 preset、Agent 与工具执行

- `packages/core/tools/src/contracts.ts:107` 的执行对象带 `agent`；`:187` 的公开输入类型仍为可选 `agent?`。
- `contracts.ts:244` 定义 `ToolRunContext`；`:391` 定义最终 `ToolGuard`。
- `packages/core/tools/src/pipeline.ts:130-138` 只有在传入 agent 时才把 agent 放进 execution。
- `packages/preset/agent-preset-registry/src/index.ts:333` 提供 `composedPreset(ctx)`。
- `packages/agentops/host/scripts/smoke-k1-k5.ts` 的冒烟结果为 5/5，但 K1b 不能证明“preset scope 排除全局工具”：测试树没有注册任何全局工具；核心测试反而证明 scoped view 会合并全局工具。
- 独立复验确认：guard 与工具 handler 都能从 `exec.agent.ctx` 读取 preset ID。

结论：preset ID 是能力授权的正确绑定键，但 `guard + handler` 不是天然覆盖所有路径。无 agent、全局工具、显式不同 preset 的子代理、DAG 节点子代理和并发竞态都必须单独测试并以 fail-closed 方式处理。

### 2.3 凭证与审计

- `packages/agentops/vault/src/crypto.ts:4` 使用 AES-256-GCM；AAD 绑定记录。
- `vault/src/store.ts:156-182` 已实现类型不可变、列表不回传明文/密文、留空密码不覆盖。
- `vault/tests/vault.test.ts` 7/7 通过。
- `vault/src/index.ts` 中保存、删除、测试操作会在 vault 写入后另开 `security.db` 连接调用 `appendAudit()`；这不是同事务。
- `packages/agentops/security/src/store.ts:101-105` 的数据库句柄是私有 `#db`，`:479-484` 的 `recordAudit()` 不加入调用方事务。
- 独立实测：外开一个 capability 事务后调用 `SecurityStore.recordAudit()` 会得到 `database is locked`；只有同一 handle 才能原子写 capability 行与 audit 行。
- 独立实测确认：现有 vault 路由在状态写入成功后若审计抛错，会返回失败，产生“状态已提交但响应失败”的窗口。

结论：现有 `SecurityStore` 不能直接复用为 capability 的事务审计 API。新方案必须明确事务所有者，不能写“同一 SQLite 事务”但实际使用两个连接。

### 2.4 原系统已有数据与能力

- 原 schema 内置能力：OA、飞书文档、飞书机器人、企业微信、天眼查、GitHub、浏览器、数据库、SSH、日志采集。
- 能力表：`capability_definitions`、`integration_instances`、`agent_capability_bindings`、`skill_packs`、`skill_versions`、`agent_skill_bindings`。
- 原系统逻辑路由覆盖能力、实例、数据库探测、凭证、测试、绑定和 Skill 管理。
- 本机只读核验：旧 `audit.db` 有 8 个实例、8 条显式绑定、4 个数据库实例（2 MySQL + 2 PostgreSQL）；旧 `credentials.db` 有 15 条凭证，其中 3 条 `integration:*`，另有 mysql/pg/ssh 凭证。

结论：如果目标是接管原系统真实部署，旧 Fernet 数据迁移不能简单推迟到 P3；否则 P0 打开后能力中心为空，真实查询也无法使用原凭证。

### 2.5 当前 DSH DB 工具断点

- `packages/agentops/db/src/tools.ts:18-19` 的 `TargetResolver` 只接收 `DatasourceConfig`，没有 Agent、preset、instance 或 `ToolRunContext`。
- `db/src/tools.ts:130-145` 与 `:200-208` 以 `database` datasource key 查静态 datasource；请求实例 ID 会得到“未知数据源”。
- `db/src/tools-mount.ts:56-62` 把解密异常吞成 `password = null`，不是 fail closed。
- `db/src/datasources.ts:20-27` 和 `query.ts` 仅支持 `sqlite | mysql`，目前没有 PostgreSQL 驱动。
- `db/src/dsh.ts:47-54` 读取/解析 datasources 失败会覆盖成 SAMPLE，可能掩盖配置错误。

结论：P0 不能只加一个 capability resolver。必须统一 DB 工具的运行时签名、实例参数语义、PostgreSQL 支持、解密失败语义和访问策略来源。

## 3. 最终架构决策

### 3.1 唯一事实源

运行期只允许一条解析链：

```text
preset binding
  -> capability instance
  -> runtime config + encrypted secret
  -> access policy / table whitelist
  -> handler target
  -> tool execution
```

页面显示、guard 判断、handler 解析都必须读同一版本的 binding/instance 快照。静态 `datasources.yml` 只作为显式 legacy 兼容路径，不允许隐式回退。

### 3.2 包结构

新增 `packages/agentops/capability/`：

- `schema.ts`：能力、实例、绑定、审计 outbox、schema version。
- `store.ts`：能力目录、实例 CRUD、绑定、写意图和事务。
- `runtime.ts`：按 preset + tool + instance 解析唯一 runtime。
- `router.ts`：原逻辑 API 路由，transport 无关。
- `mount-rpc.ts`：共享 `/api` RPC 与浏览器 bridge。
- `tools.ts`：preset scope guard。
- `index.ts`：公开导出。

能力包不负责 UI 组件；UI 继续放 `packages/agentops/client`。

### 3.3 传输契约

采用与 task 相同的 transport adapter：

- internal: `connection.rpc.intercept('/api', ...)`，owner-only。
- browser bridge: `POST /api/agentops/capability-rpc`，载荷 `{ endpoint, method, query, body }`。
- capability router 保留原逻辑路径：
  - `GET /api/capabilities`
  - `GET /api/capabilities/{capability_id}`
  - `GET /api/capability-tools`
  - `GET/POST /api/integrations`
  - `PATCH/DELETE /api/integrations/{instance_id}`
  - `POST /api/integrations/database/probe`
  - `PUT /api/integrations/{instance_id}/credential`
  - `POST /api/integrations/{instance_id}/test`
  - `GET/PUT /api/capability-bindings`
  - Skill、日志、计划路由在 P1/P2 增加，P0 不注册未实现页面。

这样复刻原逻辑契约，同时遵守 DSH 物理路由限制。

### 3.4 存储与事务所有者

采用 **capability 自有数据库 + 本地控制面审计 + security audit outbox**：

```text
$DSH_HOME/agentops/capabilities.db
  capability_definitions
  integration_instances
  agent_capability_bindings
  capability_secret_entries
  capability_control_audit
  capability_write_intents
  capability_audit_outbox
```

原因：

- 能力状态、实例配置、加密凭证和本地控制面审计在一个 SQLite 事务内，避免 credentials.db 与 security.db 的跨库原子性要求。
- `capability_secret_entries` 使用现有 vault 的 AES-256-GCM 加密函数与主密钥，不复制加密算法实现。
- `capability_audit_outbox` 与状态写入同一事务，保证审计“不会丢”；后台 publisher 以 event id 幂等写入 `security.db.audit_events`。发布失败保留 pending，不伪造成功。
- 现有 `security.db` 继续作为全局审计查询面；现有 vault 连接继续保留，后续再决定是否迁移到能力包统一存储。

禁止方案：capability 自行开一个 `security.db` 连接，然后声称与 `SecurityStore` 同事务。

### 3.5 跨库写操作

凭证与能力状态在同一个 `capabilities.db` 事务内写入，因此不存在“先写 credentials.db、失败再删除”的跨库补偿问题。

如果后续需要把凭证继续放回 `credentials.db`，必须改为持久化 saga：

- `write_intent` 记录 `preparing / credential_written / committed / failed / compensating / compensated`
- 每个 intent 有 operation id 和幂等键
- 启动 reconciler 扫描残留状态
- 补偿删除必须带所有权和版本，防止误删并发写入

P0 推荐避免这条跨库路径。

### 3.6 DB runtime 契约

P0 必须改造 DB 包：

- `DatasourceConfig.driver` 增加 `postgres`。
- 增加 PostgreSQL 驱动依赖与 `query.ts` 分支。
- `createDbTools` 接收带 `ToolRunContext` 的 resolver。
- DB 工具参数语义固定：`database` 是 capability instance ID 或显式别名；legacy datasource key 只走显式兼容分支。
- resolver 必须返回结构化结果：
  - `{ ok: true, target, policy }`
  - `{ ok: false, code: 'CREDENTIAL_MISSING' | 'CREDENTIAL_DECRYPT_FAILED' | 'INSTANCE_DISABLED' | 'INSTANCE_AMBIGUOUS', message }`
- resolver 不得把解密异常吞成空密码。
- 访问策略从 capability instance 的 `access_policy` 生成，不再同时依赖静态 datasource whitelist 作为主事实源。

### 3.7 运行期覆盖矩阵

guard 与 handler 双校验必须覆盖：

1. 有 `exec.agent` 的正常 preset 工具调用。
2. 没有 `exec.agent` 的调用必须 fail closed。
3. 全局 scope 注册的同名工具不得绕过 capability policy。
4. 显式选择不同 preset 的子代理按自己的 preset 授权。
5. DAG 节点子代理按节点 owner preset 授权。
6. 实例停用/删除与运行中 Turn 的竞态。
7. 多实例歧义、凭证轮换、绑定替换与并发调用。
8. guard 拒绝时 handler body 不执行。
9. 绕过 guard 直接调用 handler 时 handler 仍拒绝。

P0 先接入真实 handler：

- `sql_query`
- `describe_database`

其余能力在 P0 显示为“仅登记元数据”，并统一在能力卡片、工具表、实例测试按钮三处标记不可运行。

## 4. P0 范围

P0 只交付“能力与连接器”：

- 能力目录与能力卡片。
- 连接器实例三视图。
- 数据库实例配置、测试连接、表范围选择。
- 凭证写入与轮换。
- Agent preset 实例授权。
- `sql_query` / `describe_database` 真实运行期接入。
- MySQL、SQLite、PostgreSQL 查询支持。
- 控制面审计与 outbox。
- 旧数据迁移 dry-run 和正式迁移。

P0 不交付：
- Skill 安装/发布/上传。
- 日志采集执行。
- SSH/OA/飞书/企业微信/GitHub/浏览器真实 handler。
- 定时计划 CRUD。

这些入口在 P0 不显示为可用页面；可以隐藏，或显示“P1/P2 未实现”且不可点击。不得用空页面冒充已交付功能。

## 5. 数据模型

```sql
capability_definitions(
  capability_id TEXT PRIMARY KEY,
  name, category, provider, description,
  transports_json, config_schema_json,
  risk_level, authorization_capability_id,
  supports_instances, builtin,
  created_at, updated_at
);

integration_instances(
  instance_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  access_policy_json TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  status TEXT CHECK(status IN ('enabled','disabled','error')),
  version INTEGER NOT NULL DEFAULT 1,
  last_test_status, last_test_at, last_test_error,
  created_at, updated_at
);

agent_capability_bindings(
  agent_preset_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at, updated_at,
  PRIMARY KEY(agent_preset_id, capability_id, instance_id)
);

capability_secret_entries(
  credential_ref TEXT PRIMARY KEY,
  cipher TEXT NOT NULL,
  cipher_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

capability_control_audit(
  event_id TEXT PRIMARY KEY,
  actor, action, target, result,
  detail_json, at
);

capability_write_intents(
  operation_id TEXT PRIMARY KEY,
  kind, status, instance_id, credential_ref,
  version, request_hash, error, created_at, updated_at
);

capability_audit_outbox(
  event_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  published_at TEXT
);
```

能力定义种子与原系统保持：oa、feishu-docs、feishu-bot、wecom、tianyancha、github、browser、database、ssh、log-collection。`log-collection.authorization_capability_id = ssh`，`supports_instances = 0`。

## 6. 数据迁移

旧数据迁移是 P0 的生产接管门槛，不是可选后置项。

输入：
- 旧 `audit.db` 的 capability 表和绑定。
- 旧 `~/.agentops/credentials.db` 的 Fernet 密文。
- 旧 master key。

流程：
1. 只读扫描旧库并生成迁移清单：实例数、绑定数、凭证 ref、数据库引擎分布。
2. 校验实例 ID、capability 类型、credential ref 和绑定目标。
3. 用 Python migration tool 解密 Fernet 明文，立即使用 DSH AES-256-GCM 重新加密写入新库；不得落明文中间文件。
4. 生成迁移报告，逐项核对实例、绑定、凭证可读性和 AAD 绑定。
5. 先 dry-run，再写目标库；源库只读，失败不修改源库。
6. 提供回滚点和重复执行幂等语义。

本机只读基线：8 实例、8 绑定、4 DB 实例（2 MySQL + 2 PG）、15 凭证。该数字只作为现场验收基线，不作为仓库常量。

## 7. UI 复刻

### 7.1 能力与连接器

保留原三视图：

- 连接器实例
- 工具与接口
- Agent 授权

保留原核心交互：
- hero 统计
- 搜索、分类、能力筛选
- 能力卡片
- 实例表与测试/编辑/启停/删除
- 动态配置表单
- 数据库测试并加载表
- 表搜索、全选、清空
- 加密凭证输入
- preset 实例勾选
- 运行策略说明卡

### 7.2 i18n 与视觉验收

- 新增 `capability-locales.ts`，中文文案尽量逐字沿用。
- 新增 Client 文件用 `findUiI18nViolations` 定向扫描，要求 0 违规。
- 全量 `verify-client-ui-i18n` 当前仍失败，基线为 737 条 scanner violations；G3 必须分别记录“全量仍失败”和“新增 0 违规”，不得合并为门禁通过。
- 视觉验收固定为目标视口、关键组件、断点截图和人工对比；不承诺像素级一致，除非另有基准与容差。

## 8. 验收闸门

### G0：方案与迁移预检

- 本方案和 REVIEW 已归档。
- 旧库只读迁移清单生成成功。
- P0 的 capability 包、DB 包、preset guard 改造范围冻结。

### G1：控制面与数据

- 能力、实例、绑定、凭证、审计 outbox 单测通过。
- 同事务写入、强制审计失败回滚、outbox 重试测试通过。
- 旧数据 dry-run 和正式迁移对拍通过。
- 不出现明文/密文通过 HTTP 回传。

### G2：运行期

- preset guard 覆盖矩阵通过。
- handler 解析与 guard 使用同一事实源。
- MySQL/SQLite/PostgreSQL 查询路径通过定向测试。
- 解密失败、实例停用、多实例歧义全部稳定错误码拒绝。
- guard 拒绝时 handler body 调用次数为 0。

### G3：UI

- 原三视图、实例弹窗、数据库表范围和 preset 授权可操作。
- Playwright 实际走查并留存截图。
- 新增 Client 文件 i18n 0 违规。
- 未实现入口不伪装成可用。

### G4：回归

- `pnpm --filter @agentops/dsh-client typecheck`
- `pnpm --filter @agentops/dsh-vault test`
- `pnpm --filter @agentops/dsh-host test`
- `pnpm exec vitest run packages/client/connection/tests/fetch-routes.host.spec.ts`
- 新增 capability、DB runtime 和 RPC adapter 测试。
- 一次真实 preset + 真实 DB 工具 + 真实实例绑定集成测试。

## 9. 当前未关闭项

1. capability 自有库与现有 vault 的长期边界需要正式架构裁决；P0 仅确保加密函数复用和凭证不双写。
2. outbox publisher 的触发频率、失败告警和积压阈值待实现时确定。
3. 旧数据迁移需要原 master key 和现场权限；缺失时只能做空库验收，不能宣称真实接管。
4. Skill、日志采集、SSH 和定时计划 handler 尚未迁移，P0 不提供假入口。
5. 全量 i18n 737 条存量违规仍未清理；P0 只保证不新增。
6. Playwright 浏览器验收尚未执行，P0 实现完成后必须补跑。

## 10. 结论

原方案方向可保留，但以下四项是开工前硬条件：

- 统一运行期事实源，不允许页面按实例、handler 按 datasource。
- DB 包完成 runtime context、PostgreSQL 和 fail-closed 改造。
- 事务所有者明确，禁止跨连接伪事务和裸补偿删除。
- P0 范围与未实现入口明确，不把部分交付包装成完整能力中心。

满足以上条件后再进入 P0 编码。
