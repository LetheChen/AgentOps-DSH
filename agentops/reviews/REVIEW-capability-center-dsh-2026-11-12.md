# REVIEW-capability-center-dsh-2026-11-12

> 审查对象：`agentops/PLAN-capability-center-dsh.md`
> 审查日期：2026-11-12
> 结论强度：**可进入修订，不可直接实施**
> 未修改业务代码；审查期间仅新增本 REVIEW 与修订后的 PLAN 草案。

## 1. 审查覆盖

| 视角 | 执行层 | 取证方法 | 结果 | 独立性 |
|---|---|---|---|---|
| 实测复核 | native subagent（Ampere） | S2：重新跑命令、临时 SQLite/工具链实验 | 完成 | 独立，不读取其他审查产物 |
| 反向重建 | native subagent（Darwin） | S3：攻击隐含前提、失败路径、并发/事务/迁移 | 完成 | 独立，不读取其他审查产物 |
| 静态核验 | native subagent | S1 | 受 429 限流未完成 | 未形成可计入结论 |
| 外部 CLI | codex exec read-only | 外部红队 | 因宿主 sandbox helper 锁失败，未产出 | 不计入结论 |
| 主持人复核 | 本会话 | 一手源码、命令输出、SQLite 只读数据 | 完成 | 对上述独立意见做裁决，不把他人结论当证据 |

## 2. 最终裁决

### 2.1 保留的结论

1. 能力中心应复刻，而不是用 DSH 的简化页面替代。
2. DSH preset 是 Agent 运行真相，绑定键必须是 preset ID。
3. 能力定义、实例、凭证、工具目录、preset 绑定和运行期解析是完整能力单元，不能只做 UI。
4. AES-256-GCM 可继续使用，旧 Fernet 不应进入 DSH 运行时。
5. UI 可以复刻原三层信息架构与核心交互，但应定义为结构/交互复刻。

### 2.2 必须修正的结论

| 原表述 | 裁决 | 证据 | 等级 |
|---|---|---|---|
| “DSH 强制实例 ID 放 body” | 部分成立。路径参数不支持，但 query 可用；采用 RPC bridge 是为保留原逻辑路由，不是协议强制 body | `rpc-host.ts:211-217`；现有 route 测试以 query 成功 | L4 |
| “K1b 证明 preset scope 排除全局工具” | 不成立。测试树无全局工具；核心测试证明 scoped view 会合并全局工具 | `smoke-k1-k5.ts`；`packages/core/tools/tests/scoped.spec.ts:73-82` | L4 |
| “SecurityStore 可直接复用 capability 同事务审计” | 不成立。私有连接与私有审计方法；外开事务调用出现 `database is locked` | `security/src/store.ts:101-105,479-484`；S2 临时 SQLite 实测 | L4 |
| “先写凭证、再写 security.db、失败补偿删除即可” | 不成立。存在孤儿凭证、补偿误删、并发覆盖、崩溃窗口 | `vault/src/index.ts` 保存/删除路径；`vault/src/audit.ts:49-77` | L4/L3 |
| “DB 工具只改参数即可接 capability instance” | 不成立。TargetResolver 无 ToolRunContext，datasource key 是静态事实源，解密错误被吞 | `db/src/tools.ts:18-19,130-145`；`db/src/tools-mount.ts:51-70` | L4 |
| “P0 当前可跑数据库” | 不成立。当前仅支持 sqlite/mysql；原现场 DB 实例包含 2 个 PostgreSQL | `db/src/datasources.ts:20-27`；只读旧库实例数据 | L4 |
| “P0 默认新库、Fernet 迁移后置不阻塞复刻” | 成立但会阻断生产接管。原现场有 8 实例、8 绑定、15 凭证 | `credential_store.py:23-30`；旧库只读统计 | L4 |
| “Client 只有 vault/schedules” | 作为整页表述不成立。全菜单 17 项；仅系统设置分组只有这两项 | `client/src/client/menu.ts` | L2/L4 |
| “新增 i18n 零违规即可视为 P0 门禁通过” | 部分成立。全量 CI gate 仍失败，必须分别记录 baseline 与增量 | `scripts/verify-client-ui-i18n.ts`；`scripts/run-gates.ts` | L4 |

## 3. P0 阻断项

### B1：单一事实源缺失

- 页面按 capability instance 绑定。
- DB handler 仍按 datasource key。
- 结果可能“绑定 A，实际查 B”。

处置：实现 `preset binding -> instance -> config + secret + access_policy -> handler` 唯一链；datasource 只作显式 legacy 分支。

### B2：DB runtime 契约不可实现

现有签名不支持 preset/exec，且 PostgreSQL 缺失、解密异常吞错、datasource 加载覆盖配置。

处置：P0 同时改造 `DatasourceConfig`、`TargetResolver`、`createDbTools`、`tools-mount`、`query.ts`、`dsh.ts`。

### B3：事务所有者未定义

先写凭证后写实例、再补偿删除不保证一致性。

处置：采用 capability 自有库，让实例状态、加密凭证、控制面审计和 outbox 在同一事务；跨库发布使用持久化 outbox。

### B4：guard/handler 覆盖矩阵不足

无 agent、全局工具、不同 preset 子代理、DAG 节点和运行中 Turn 竞态未覆盖。

处置：P0 的 G2 必须建立覆盖矩阵，任一路径未通过不得进入 UI 验收。

### B5：生产接管缺失

若目标部署已有原系统数据，P0 新空库会显示空能力中心且旧凭证不可用。

处置：P0 包含只读 dry-run、Fernet -> AES-GCM 迁移、对拍、幂等与回滚。若缺原 master key，只能按“空库安装”验收。

## 4. 采纳的设计修订

1. 传输改为共享 `/api` RPC + 单一 capability bridge，保留原逻辑路由和 PATCH/DELETE。
2. capability 状态、实例配置、加密 secret、控制面审计放同一 `capabilities.db` 事务。
3. 全局审计走持久化 outbox，不把“另开 security.db 写审计”当原子操作。
4. DB runtime 使用实例 ID/别名作为主语义，显式保留 legacy datasource 兼容。
5. P0 增加 PostgreSQL，不得把原系统 PG 实例显示为可运行。
6. P0 只开放“能力与连接器”；Skill/日志/计划入口隐藏或明确置灰。
7. P0 包含旧数据迁移；如果没有原 master key，则严格降级为“空库安装”，不能宣称接管。
8. UI 定义为结构/交互复刻，G3 使用固定视口、断点和截图。

## 5. 未关闭项

- capability 自有库与现有 vault 的长期边界仍需正式裁决；P0 仅复用加密函数，不双写凭证。
- outbox publisher 的调度、告警和积压阈值待实现。
- 旧 Fernet 数据的字段映射、ID 冲突和迁移回滚尚未实测。
- 真实 DSH profile、真实 preset、真实 MySQL/PostgreSQL 查询尚未执行。
- Playwright UI 验收尚未执行。
- 全量 i18n baseline 737 仍失败，P0 只能保证新增 0 违规。
- 原 S1 静态审查与外部 CLI 审查未能完成；结论由 S2、S3 与主持人一手复核支撑，不能标记为“三方静态一致”。

## 6. 关键证据原文摘录

```text
packages/agentops/db/src/datasources.ts:17  readonly key: string
packages/agentops/db/src/datasources.ts:21  readonly driver: 'sqlite' | 'mysql'
packages/agentops/db/src/tools.ts:19  export type TargetResolver = (datasource: DatasourceConfig) => Promise<Target | null>
packages/agentops/db/src/tools.ts:131  const datasource = findDatasource(configs, args.database ?? configs[0]?.key ?? '')
packages/agentops/db/src/tools.ts:145  const target = await resolveTarget(datasource)
packages/agentops/vault/src/audit.ts:54-76  appendAudit opens `new DatabaseSync(path)` and closes it in `finally`
```

```text
packages/agentops/security/src/store.ts:101  readonly #db: DatabaseSync
packages/agentops/security/src/store.ts:479-484  recordAudit() -> #audit() on the private handle
packages/agentops/security/src/store.ts:139-148  BEGIN -> state write -> #audit -> COMMIT
```

```text
packages/core/tools/src/contracts.ts:187  readonly agent?: Agent
packages/core/tools/src/pipeline.ts:130-138  agent is copied into execution only when present
packages/core/tools/src/contracts.ts:244  export interface ToolRunContext extends ToolExecution
```

## 7. 可复现证据

```text
node --import tsx packages/agentops/host/scripts/smoke-k1-k5.ts
  结果：5/5，但 K1b 不证明全局层隔离

pnpm exec vitest run packages/client/connection/tests/fetch-routes.host.spec.ts
  结果：5 passed；query 可用，pathname 精确匹配

pnpm --filter @agentops/dsh-vault test
  结果：7 passed；AAD/不回传/类型不可变

pnpm --filter @agentops/dsh-client typecheck
  结果：exit 0

pnpm --filter @agentops/dsh-host test
  结果：75 passed

node --import tsx scripts/verify-client-ui-i18n.ts
  结果：737 scanner violations，exit 1
```

旧库只读统计：

```text
audit.db: integration_instances=8, agent_capability_bindings=8, database instances=4 (2 mysql + 2 pg)
credentials.db: 15 entries; integration=3, mysql=2, pg=1, ssh=2, plus unprefixed/legacy entries
```
