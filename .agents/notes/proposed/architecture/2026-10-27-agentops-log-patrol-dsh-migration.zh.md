# Agent Note: AgentOps 日志巡检与 Workflow 管理迁移到 DSH

Status: proposed

[English](2026-10-27-agentops-log-patrol-dsh-migration.md) | 中文

## 问题

AgentOps 把智能审核日志巡检实现为固化的定时 Workflow。业务记录把人工录入的远程活动日志路径、本地抽取目录、日志拉取员与分析师行为、重试、运行历史和通知投递耦合在一起。

只迁移日志拉取员会让 DSH 长期保留一个临时调用方，并形成第二套幂等、完成、授权、恢复和通知语义。把 Workflow 管理留到以后，会迫使已经进入生产的业务身份与历史再次解释。

生产 MaxKB source 是 `/opt/AI_Agent_Platform/logs/app/oa_audit.log`。日志轮转意味着捕获无法承诺替换期间零丢失。首版只读取当前 `oa_audit.log`；无法证明连续性时显式记录 gap，并由业务 owner 批准对应的恢复点和最大漏检窗口。

事实来源：`<legacy-repo>\docs\00-platform\dsh-migration\DESIGN-agentops-log-patrol-with-workflow-v4.zh.md`，SHA-256 `47E2325C6058B8EFA9769888E1A4B97499AC6CBDBEF9BF373C9F850AB9A46409`。v4 取代 v3（`FD55A37A…BE62B6`），后者作为修订历史与审核输入留在 AgentOps；两版都不构成生产 schema、RPC 或切流基线。

本 Note 是决策摘要与验收边界，不替代 v4 的协议、schema、WBS、测试矩阵或 runbook，也不能关闭审核账本中未解决的代码缺陷或缺失的外部证据。

## 方案

把日志巡检与 AgentOps Workflow 管理作为一个项目迁移，使用统一跨服务契约和分阶段交付：

```text
Phase 0: external evidence, business decisions, and signed acceptance criteria
Phase A: Host secure-execution loop
Phase B: Workflow management loop
Phase C: workflow asset migration
Phase J: joint fault injection, shadow, recovery, and rollback rehearsal
```

任何阶段都不能单独承接生产流量。release set 通过 A/B/C/J 门禁后，按 `source_id` 逐个提升。首个 canary 只认领 MaxKB source；所有未认领 Workflow 资产保持 disabled。

### 服务与事务协议

即使 Host 与 Workflow Manager 共用一个 SQLite 文件，它们仍是两个服务边界。共享存储不会把两个服务调用变成一个原子事务。每次执行遵循：

```text
W1 -> H1 -> Capture -> W2 -> Hfinal -> Projector
```

- W1：Workflow 在同一事务中 claim `schedule_occurrence`、插入 logical trigger、`workflow_run`、`workflow_attempt`、`dispatch_intent` 和 `workflow_event`，并持久化 `request_id`、`request_fingerprint_sha256`、`payload_sha256` 与 `attempt_fence`。只有本地提交后才能开始派发。
- H1：Host 取得 source lease 与 fence，创建 `host_run`，预分配非空且不可变 `capture_generation_id`，并创建 `source_observation_intent`；不创建 observation。
- Capture：Host 使用 H1 预留的不可变 `capture_generation_id`，以 no-follow 方式打开稳定对象，读取并哈希活动文件，只发布一次该 generation，然后插入不可变 `source_observation`。
- W2：Workflow 硬校验已提交且不可变的 `source_observation`、observation hash、已发布 capture generation、完整 Host run identity 和 dispatch intent。仅有 `source_observation_intent` 时返回 `SOURCE_OBSERVATION_NOT_READY`；通过后 W2 只能写入经校验的 `host_run_identity` 与 dispatch `acknowledged`。
- Hfinal：Host 在同一本地事务写入终态、不可变 completion receipt 和 `projection_pending`。
- Projector：Hfinal 后 `host_run_ref` 的唯一写入者；以 `projection_fence + projector_runtime_epoch` CAS 取得写权、校验 receipt，并在一个 Workflow 本地事务中投影 attempt/run、incident/episode、workflow event 和 notification outbox。

W2、Host、dispatcher、notifier 和旧 Projector 创建或修改 `host_run_ref` 必须失败。身份匹配但没有 Hfinal receipt 不构成 ref 许可。重复或冲突 receipt 必须失败关闭并保留对账证据。

`runtime_epoch` 标识 control-store 状态根 / 唯一 writer 代际，`projector_runtime_epoch` 标识 Projector claim 代，二者不可互换。迟到的 `lost -> success` receipt 必须进入 `INTEGRITY_CONFLICT` 与 `needs_attention`，绝不能静默覆盖既有终态。

### Source 身份与本地目录

运维人工录入、审批并版本化每个远程活动文件路径。模型不得生成、推断或覆盖 host、port、path、credential reference 或 approval hash。source revision 绑定业务身份、connection、endpoint、路径审批、capture policy 和 host-key pin revision；每个请求必须携带当前已批准 `source_revision`，否则失败关闭。

部署只配置 `DSH_HOME` 和默认 snapshot root。运行目录推导为：

```text
$DSH_HOME/agentops/log-snapshots/<business_id>/<workflow_run_id>/<host_run_id>/
```

默认根是 `$DSH_HOME/agentops/log-snapshots`；运维不逐业务录入本地绝对目录。`DSH_HOME` 缺失、为相对路径或权限不安全时启动失败，不得回退到当前工作目录。run ID 与 generation ID 由服务生成，不接受模型输入。

### 日志捕获、文件身份与存储

捕获只读取当前活动文件，固定 end offset，发布完整行前缀，并把每个被省略或不确定的字节记录为显式 gap。它不读取轮转归档，也不承诺零丢失。仅凭 `end_offset`、`size + mtime` 或路径审批不能构成稳定文件身份。

strict observation 记录 source revision、规范化路径、inode/file ID、device、size、mtime 及其精度、文件类型、link count，以及有界 `prefix_anchor_length` 与 `prefix_anchor_sha256`。固定前缀锚点用于发现同 inode 的 `copytruncate` 或重写，永不变成跨运行 closed offset。身份字段缺失、mtime 精度不足、短读、替换、截断或内容变化都使 strict capture 不能 `completed`。

本地发布使用 no-follow 打开、读取前后身份校验、同文件系统 staging、no-clobber rename、文件与目录 fsync 和不可变 manifest。写入前必须原子预留配额，至少覆盖最大捕获、索引、manifest、findings、报告、临时文件和恢复 headroom。control DB/WAL/SHM 与 artifact 同卷时按最坏增量合并校验；`ENOSPC`、inode 耗尽、预留失败或父目录不安全统一失败关闭为 `DISK_FULL`，不得留下可见半代。

Windows 只用于研发，必须拒绝 UNC、驱动器相对路径、备用数据流、junction/reparse point、硬链接异常、大小写折叠冲突和父目录替换。Linux 生产等价证据必须覆盖 SFTP、no-follow 读取、文件身份、目录持久性、权限、崩溃恢复、磁盘耗尽和轮转替换；Windows 结果不能替代这些证据。

### Host-key 与凭证顺序

MaxKB owner 通过带外渠道确认每个 SSH endpoint 与 jump host。pin 存储在受控、只读、版本化的 trust store 中，绑定键为 `connection_id + endpoint_ref + hop_index`；只有 trust-admin control plane 可写。每个 SSH hop 都必须独立匹配自己的 approved active-pin set；source revision、request identity、Host run、receipt 和 control-socket 复用均绑定 approved set ID/revision、实际 matched `pin_id`/revision、算法、canonical hop identity、proxy-chain digest 与 transport kind。禁止首次自动学习、`AutoAddPolicy`、`StrictHostKeyChecking=no`、warning 后继续和 mismatch 降级。

pin 生命周期为 `staged -> approved active-pin set membership -> approved overlap window -> retired / revoked`。轮换绑定 `rotation_from_pin_id` 与 `rotation_not_before/after`；启用、重叠、退役和撤销都审计。撤销立即生效，使所有匹配的 SSH master/control socket 失效，并让验证或 token 消费失败关闭。

凭证访问只能由单个全链验证结果解锁：

```text
verify all SSH hop and proxy-endpoint identities independently
  -> require every hop to match its approved active-pin set
  -> atomically insert one immutable host_run_hop_trust_verification snapshot
  -> mint one single full-chain verification token from that snapshot
  -> Host-only SecretAccessor atomically consumes the entire token in one CAS
  -> read the Vault password
  -> invoke the SSH password callback
```
单个全链 verification token 绑定完整有序 hop 数组、`hop_count`、`hop_trust_canonicalization_version`、`approved_hop_trust_expectation_sha256`、`host_run_hop_trust_verification_id`、`hop_trust_identity_sha256`、每跳 approved set ID/revision、实际 matched pin ID/revision、revocation generation，以及 `request_id`、`host_run_id`、issuer、audience、issue time、expiry 和一次性 nonce。issuer 只能是 Host verifier，audience 只能是 Host-only SecretAccessor，TTL 必须短于一次连接尝试。SecretAccessor 以单次 CAS 消费整个 token，并在同一校验中重读每跳 current set revision 与 revocation generation。 缺 pin 返回 `HOST_KEY_PIN_MISSING`，mismatch 返回 `HOST_KEY_MISMATCH`，trust 不可用或无法验证返回 `HOST_KEY_UNVERIFIABLE`。上述失败，以及 token 过期、重放、set revision 失效、revocation generation 变化，或任一 hop 缺失、重复、乱序、只被部分消费，都使整个 token 无效：Vault read = 0、password callback = 0。H1 只保存 approved expectation，绝不预填 matched pin；完整不可变全链快照存在前，Capture 不得打开文件或读取 secret。

“MaxKB password 已录入”只等于 `stored`，不能推出 `authorized`、`host_key_verified`、`connection_tested` 或 `production_eligible`。secret view 不可复制、不可序列化，Session、模型请求、日志、SSE、manifest、报告、错误、fixture、通知和恢复包共用同一个 redaction sink。

### 分析师 findings 与投影

分析师接收有界不可信日志数据，不能写终态、改动 coverage、调用任意文件系统或通知工具，也不能读取其他 run。确定性 scanner 与模型在闭合 schema 下产生 findings，字段至少包括 `findings_schema_version`、枚举 severity、有界文本、evidence references 和 coverage ledger。

模型只能产生 `finding_state=hypothesis`；只有 Host 规则和 schema validator 能 verified finding、赋予最终严重度或决定业务 incident。未知 `findings_schema_version` 必须拒绝，不能 best-effort 解析。空 findings、partial coverage、scanner 失败或 analyst 失败都映射为 `unknown` 或 `needs_attention`，绝不映射为健康。

completion receipt 记录完整 Host run identity、source observation 与 generation、终态、finding schema version、coverage 和 receipt hash。Projector 在创建 `host_run_ref` 或投影业务结果前，必须拒绝任何 identity、hash、generation、receipt 或 terminal-epoch mismatch。

### Workflow 管理与消费者

Workflow Manager 拥有不可变 Workflow revision、schedule、occurrence、workflow run、attempt、dispatch intent、receipt projection、取消、重试和唯一业务 notification outbox。新 schedule 使用显式 IANA 时区，不继承旧解析器的隐式 UTC 行为。

旧 `/api/agent/workflows` 不能作为兼容层直接转发。其消费者必须显式迁移：

- `WorkflowsPage` 使用 list/get/validate/create/save-draft/archive，并区分草稿与不可变 revision。
- `DagEditorModal` 删除硬编码 `yaml_round_trip=true`，改用 validator capability；不支持的 round trip 变为只读或拒绝。
- `SchedulesPage` 只列出已发布 revision，修改必须具有 publisher 权限。
- `AuditReplayPage` 加载 run 保存的 `workflow_revision_id`，不读取当前 revision。
- `workflow-author` 使用 validate/publish API，拓扑修改后不再要求重启后端。
- Manager Agent 只获得窄 list/get/trigger/status/cancel/retry/report 工具，不拥有 host、path、credential、SQL、schedule 修改或 publish 权限。
- 未知或动态构造的旧客户端必须在退役 endpoint 前完成登记、测试或停用。

Outbox 状态严格为 `held`、`ready`、`claimed_not_sent`、`send_started`、`sent` 和 `failed`。永久失败或完整性失败保持 `failed + failure_class`，run 进入 `needs_attention` 并由人工处置；`dead_letter`、`suppressed` 和 `cancel_requested` 只是标签或事件，不是状态。Outbox 唯一键是 `(destination_ref, effect_kind, notification_kind, effect_key, cutover_epoch)`，投递语义为 at least once。

`runtime_epoch` 标识 control-store 状态根 / 唯一 writer 代际，`cutover_epoch` 标识单 source 的生产通知所有权代，`notifier_epoch` 标识单 source notifier claim 代。只有 claim、cutoff 和 epoch 都仍为当前值时，notifier 才能发送。

### 包、PR-0 与文档所有权

PR-0 是阻断性前置条件。它建立版本化 `target manifest`，作为 bundle 与 deploy root 插件、preset 行、必需 peer 依赖、bootstrap 链接、路径映射、README 生成或校验、profile 启动参数和 smoke 断言的单一事实源。这项仍未落地：bundle patch 有 9 个 AgentOps root 行加 1 个技能目录行，deploy patch 有 7 个 root 行和 1 个含 6 条工具行的 preset 行，这些行、bootstrap 链接、package peer/dev 依赖与生成的 preset 各自维护。manifest 出现之前，删掉一条必需行或依赖不会让任何门禁变红。

扩展 `packages/agentops/host` 承担安全捕获、分析师协调、finding 校验、报告和 receipt。新增版本化 contracts、唯一可写 control store 和 Workflow Manager 包。扩展 AgentOps client 以支持 source、Workflow revision、schedule、run 详情、证据和审计。现有只读数据库包只允许执行审批过的查询。

AgentOps 继续拥有旧系统事实、历史分析、v1/v2 设计、原始审核证据和归档材料。DSH 成为当前实现契约、schema、测试、部署、runbook、当前迁移状态和升级规则的 owner。不得把 AgentOps 迁移目录整体复制到 DSH。

## 已考虑的替代方案

**先只迁移日志拉取员。** 拒绝，因为临时调用方会固化 Workflow 管理以后必须替换的幂等、完成、通知和授权语义。

**一次实现全部 Workflow 并全局切流。** 拒绝，因为资产保真度和业务验收因 Workflow 而异。统一契约不等于统一部署开关。

**让 Manager 或日志拉取员模型负责定时完成。** 拒绝，因为模型 turn 不是持久状态转换，也不是安全恢复权威。

**把共享 SQLite 当作一个跨服务事务。** 拒绝，因为各本地提交仍是独立可恢复事实。对账必须使用不可变身份和条件写入。

**原样转发旧 Workflow API。** 拒绝，因为它暴露未定义的修改、revision、权限和 round-trip 语义，并会静默保留旧文件与重启权威。

**为轮转中的活动文件保存跨运行 closed offset。** 首版拒绝，因为轮转、截断和替换使跨运行连续性无法证明。Host 捕获有界 generation 并记录 gap。

**接受模型输出作为业务 finding。** 拒绝，因为模型生成的 hypothesis 不是已验证证据；只有 Host 校验和确定性 coverage 才能产生业务结果。

## 验收标准

- Phase 0 为 RPO 与最大漏检窗口公式、轮转丢失容忍度、远程路径审批、连接权威、逐跳 host-key 证据来源独立性与轮换、凭证访问、通知目的地、Workflow 所有权、回滚和 Linux 验证记录 owner、证据路径、日期与签字。
- Host 测试证明 host-key 验证先于 SecretAccessor、Vault 读取和 password callback；缺 pin、mismatch、无法验证、同源确认、token 过期/重放、set 失效和 revocation 变化场景中 Vault read 与 callback 都为 0。
- 捕获测试证明 H1 预分配非空且不可变 generation、generation 只发布一次，并在 Linux 证明 no-follow 读取、稳定文件身份、固定前缀 copytruncate 检测、有界重叠摘要连续性核对、结束边界、不可变 manifest、串行 run 目录、崩溃恢复、原子配额、显式轮转 gap 和 `continuity_unprovable`。
- Workflow 测试证明 occurrence claim 与 logical trigger 同事务、revision 不可变、IANA 调度、occurrence 唯一、attempt fence、receipt projection、取消竞争、重试分类，以及唯一 outbox 的键包含 `notification_kind`。
- 负向测试证明 W2、Host、dispatcher、notifier 和旧 Projector 不能创建 `host_run_ref`；只有一个 Projector 能通过当前 `projection_fence + projector_runtime_epoch` CAS；迟到的 `lost -> success` receipt 进入 `INTEGRITY_CONFLICT` 与 `needs_attention`。
- 分析师测试证明闭合 `findings_schema_version` schema、未知版本拒绝、模型只产生 `finding_state=hypothesis`、Host-only 校验、coverage 强制、单行/单 fragment/单工具返回上限、控制字符处置，以及空 findings/partial/失败分析不映射健康。
- 消费者测试覆盖 Workflow 迁移矩阵每一行，包括回放 revision 绑定、published-only schedule、真实 round-trip capability 和未知旧客户端。
- 资产迁移从冻结来源复现已接受 Workflow definition，解释每个 definition diff，并保持未认领资产 disabled。
- `PR-0a` 测试证明 target manifest 机械校验 bundle patch、deploy patch、依赖、bootstrap、preset、README 与 profile smoke；移除任一必需 root 或依赖都会使门禁失败。`PR-0b` 独立证明 SQLite authorizer 拒绝未授权表和查询形式。
- 任何 primary 切流前，运维都能在 Linux 完成 release set 备份、恢复、对账和回滚。Shadow 与 canary 对拍覆盖 findings、gap、报告、目的地和通知计数，切流不产生双生产通知。

## 风险

**轮转丢失。** 两次观测之间替换活动文件可能丢失字节。业务必须接受恢复点和最大漏检窗口，run 必须暴露 gap。

**凭证与 host-key 泄露。** host 验证降级可能泄露 MaxKB password。trust anchor 必须只读、轮换需审批，任何 mismatch 都在凭证访问前失败关闭。

**跨服务状态分叉。** W1、H1、Capture、W2、Hfinal 和 Projector 之间崩溃会留下部分状态。未知结果必须对账并显式进入 attention，不能猜测成功。

**Workflow 资产保真度。** 旧 loader 与 serializer 不保留每个字段。兼容需要冻结哈希、fixture、expected output 和每个 definition diff 的 owner 处置。

**通知重复或丢失。** 投递语义是 at least once。目的地幂等能力、cutover 与 notifier epoch、失败处置和运维 owner 必须明确。

**日志内容成为攻击路径。** 日志可能包含提示注入、控制字符、secret 和畸形记录。分析师只接收有界不可信数据，不能修改完成状态，也不能调用任意通知或文件系统工具。

**当前状态。** 这是 proposed 设计，不是实现或生产放行。v4 关闭了 R6 的 16 条设计与文档 finding，并合入 2026-10-28 的生产只读实测；代码级 R6-09～13 与需外部证据的 R6-18/20/23 仍未关闭。三家独立红队随后于 2026-10-29 审核 v4——静态核验、实测执行与反向重建——给出 9 项阻断和 12 项严重，因此 `R6: NOT PASS / R7: NOT PASS / Phase 0: OPEN / G0 未通过` 仍然生效。Phase 0 证据、Linux 生产等价验证、A/B/C/J 联合门禁、PR-0a 与 PR-0b、显式 canary 决策和未关闭 finding 的关闭都仍未完成。审核账本是 `<legacy-repo>\docs\00-platform\dsh-migration\REVIEW-agentops-log-patrol-with-workflow-2026-10-28.md`，v4 审核为其中的 `REVIEW-R7-design-v4-2026-10-29.md`。生产 schema、RPC 和切流权威均未冻结。
