# AgentOps 体系工程健康度（测试覆盖 / 类型与不变式 / 可观测性 / 已知债务）

> 只读分析。所有数字均来自本次实际执行的只读命令（`git ls-files` / `git grep` / `Get-Content`），未运行 `pnpm test` / `pnpm build` / `pnpm install`。
> 分析对象为 `packages/core/`、`packages/subagent/`、`packages/preset/`、`packages/workflow/` 四个编排包组；按委托人补充要求，`packages/agentops/` 本体作为**独立一节（附录 A）**纳入取证，两者结论不混用。

---

## ① 核心结论

1. **编排四包不是"缺测"，而是"闸门极严 + 竞态臂不可调度"**：116 个源码文件（28,186 行）由 135 个 `.spec.ts`（60,960 行，测试/源码行比 ≈ 2.16:1）覆盖在 CI 的 per-file 100% 覆盖率闸门下，且四个包**零覆盖豁免**；真正的薄弱点是 98 处 `v8 ignore`（manager.ts 独占 8 处）所标记的 re-entrancy / dispose-vs-send 窗口，测试在构造上无法确定性调度。
2. **可观测性是这四个包最强的一环**：一次委派可在 session log 中完整重建（版本化 `subagent/descriptor` v3 + `subagent/catalog` v0/v1/v2 + 子 Session + 结算消息携带 diagnostic），失败原因有结构化错误码（`WorkflowErrorCode` 11 个、`SessionQueryErrorCode` 17 个、`SubagentError`）；唯一断点是 `subagent/start|end` 是进程内 ctx 事件而非 session 事件，`stopReason` 只能从子 Session 的 `turn/end` 反推。
3. **真正的健康度缺口在 `packages/agentops/` 本体**：43 个 `node:test` 套件（306 个 `test()`，其中 dag 124、host 66）不被 `pnpm run test`、`check:ci:coverage` 或任何 `run-gates` 通道收集；A2UI 链路（host `a2ui-schema/` 5,412 行 + client 7 个渲染组件）无任何直接测试；`SurfaceStore` 每次构造执行破坏性 DELETE，且 SQLite 句柄全仓无 `close()` 调用点。

---

## ② 五问逐条回答

### 2.1 四个核心包各有多少测试文件、覆盖了哪些行为？哪些关键路径明显缺测？

**测试文件分布（`git ls-files` 统计，全部位于 `<pkg>/tests/`，仓库约定 `src/` 内不放测试）**

| 包组 | 包 | 源码文件 | `.spec.ts` | `.e2e.ts` | 主要覆盖行为（取自实际 spec 名） |
|---|---|---|---|---|---|
| core | `agent` | 8 | 6 | 0 | initiator 作用域、archive 准入、consumed work、`model-selection` |
| core | `agent-loop` | 6 | **27** | 1 | cancel、inbox、loop、interception、resume、shutdown-drain、request-reconstruction、tool-order、resource-lifecycle、`properties`（fast-check） |
| core | `session` | 10 | **20** | 0 | canonical-envelopes、fork、repair、seq-ranges、surface、tool-history、`properties`、`gen-persistence-catalog`（生成门自校验） |
| core | `tools` | 9 | 9 | 1 | schema DSL、json-schema 子集、batch、execution-mode、`properties` |
| core | `tool-executor-ptc` | 10 | 4 | 0 | ptc、ptc-calls、py-types、ts-types |
| core | `scope` / `system-prompt` / `agent-default-model` / `agent-tool-presentation` | 2/1/1/1 | 2/3/1/1 | 0 | 作用域存储、prompt 组装、默认模型、工具呈现 |
| core | `tool-executor-native` | 1 | **0** | 0 | 无直接 spec；35 行薄适配器，由 `agent-loop`/compose 套件间接执行（未验证具体哪个 spec 命中） |
| **subagent** | `subagent`（核心） | 22 | **24** | 0 | 激活容量池、`SubagentRuntime.interrupt`（8 例）、continuation 冷恢复、settlement 投递、teardown 森林、`structured`（1005 行）、catalog/descriptor fold、list-children/descendants、external activation |
| subagent | `tool-subagent` | 6 | 8 | 0 | 模型选择、preset 选择、depth 上下文、scripted provider |
| subagent | `subagent-acp` / `-claude-code` / `-codex` / `-dsh-sdk` | 2/3/3/2 | 1/2/3/1 | 2/2/2/2 | 三个外部后端含 `real-product.spec.ts` + `loader-composition.e2e.ts` |
| subagent | `subagent-fork-in-process` | 1 | 2 | 0 | 含 `multi-subagent.spec.ts` |
| subagent | `subagent-spawn-in-process` / `tool-subagent-control` | 1/2 | 1/2 | 1/0 | spawn 后端、`list-agents` |
| **preset** | `agent-preset-registry` | 8 | 6 | 0 | 修订代际保留/回收、mount 失败诊断、`composition-inventory`、scoped tool-executor、session 投影 |
| preset | `agent-preset` | 1 | 1（`skills.spec.ts`） | 0 | **只测随包 skill 内容**，不测 `src/index.ts`（30 行 Config 声明） |
| preset | `persona` | 1 | 1 | 0 | scope 阴影/插值/卸载还原 |
| **workflow** | `workflow-ptc`（JS 扇出引擎实现） | 9 | **8** | 2 | guest 六全局 API、combinator、VM 超时、取消/dispose/straggler 收割、host 回调校验、`realm` 跨 VM 值物化（145 行 15 例）、meta 校验、egress 凭据隔离 |
| workflow | `workflow`（Service Definition） | 3 | 1 | 0 | 只测接口契约：错误码、`emitWorkflowEvent` 监听器隔离（4 例）、HMR 注销 |
| workflow | `tool-workflow`（模型面工具） | 3 | 1 | 0 | 725 行：durable record 4 事件、cancel、background job、渲染截断、PTC 组合 |

**关键路径缺测 / 覆盖薄点（按证据排列）**

- **并发派发：覆盖充分，但有构造性盲区。** `subagent/tests/continuation.spec.ts` 的 `continuable activation capacity` 组覆盖"slots 在 sibling/provider/嵌套子间共享"、"异步创建前预留末位并在失败后归还"；`snapshots/session/subagent-parallel/` 用真实组合 + 屏障 fixture（`execution-order.mjs`）固定双激活并存与 id 顺序。**但** `manager.ts` 有 8 处 `v8 ignore` 明确写着"no test can schedule deterministically"（L663 所有权边竞态、L1278/L1294 send-vs-dispose cutoff、L1308 同步重入 teardown）——这些就是并发链路的不可测臂。
- **中断：只有单元级覆盖，无录制会话场景。** `continuation.spec.ts` 的 `SubagentRuntime.interrupt` 有 8 例（durable abort、只中断目标、祖先授权、self/sibling/stale 拒绝、dispose 竞态）；但 `git ls-files` 中 158 个 snapshot 场景**没有任何名称含 `interrupt|cancel|abort`**，也没有编排类场景度量人工中断。是否被其他场景间接覆盖：**未验证**。
- **失败回传：覆盖较厚，但 `workflow` 组合子语义相对 11 个 fatal 错误码偏薄。** `guest.spec.ts` 中以 `parallel|pipeline` 出现的断言共 14 处、`workflow-ptc.spec.ts` 3 处，其中专门的组合子用例只有"keeps combinator functions inside the VM and maps ordinary stage failures to null"。`AGENT_CAP`/`ITEM_CAP`/`RESULT_UNSERIALIZABLE` 等码在 `workflow-ptc.spec.ts` 有对应用例，`isFatalWorkflowError` 的分支判据只在 `workflow.spec.ts` 有 1 例。
- **节点路由：不在 `packages/workflow/`。** 委托方已澄清并已核实：`packages/workflow/workflow/src/index.ts`（203 行）只是 Service Definition（抽象 `start()` + 事件 + 错误码），JS 脚本扇出在 `workflow-ptc`；**DAG 节点路由在 `packages/agentops/dag/src/{engine,expr,validate}.ts`**，见附录 A。
- **工作流后台运行无录制会话场景（包内自述债）。** `packages/workflow/tool-workflow/README.md` 的 Known Limitations 原文：`No recorded-session scenario replays a background run yet` —— 只有单元与真实引擎组合套件覆盖，快照树只钉了 schema 与 prompt 文本。
- **`tool-executor-native` 无包内 spec**（1 个源码文件，0 个测试文件），由消费方 suite 间接覆盖。

### 2.2 哪些是只靠类型保证、没有运行时校验的薄弱点？哪些属于合理豁免？

**先确认闸门存在（这是判断"薄弱"的前提）**

- `as unknown` 双转型有基线门：`scripts/no-unknown-casts.baseline.json` + `scripts/verify-no-unknown-casts.ts`（`scripts/verify-no-unknown-casts.spec.ts`）。四个编排包 `src/` 命中 14 行 / 13 处真转型（另 1 处是错误消息里的字符串 `descriptor.ts:122`），分布在 `inbox.ts`(2)、`session/src/index.ts`(2)、`scope/src/index.ts`(1)、`system-prompt/src/index.ts`(1)、`tools/src/schema.ts`(1)、`subagent/src/catalog.ts`(2)、`subagent/src/internal.ts`(2)、`subagent/src/projection.ts`(1)、`tool-subagent/src/index.ts`(1)。即：**没有新增空间，只能减少**。

**真正只靠类型保证的一处（非豁免）**

- `packages/subagent/subagent/src/internal.ts:74` 与 `:102`：
  ```ts
  return (runtime as unknown as HostPromptDeliverer)[deliverSubagentPrompt](parent, childId, content, source, signal, 'queue')
  ```
  `deliverSubagentPrompt = Symbol.for('dsh.subagent.deliverPrompt')`。这是一个**符号键内部协议**，跨"打包入口 / 未打包内部子路径"两个模块实例共享。类型系统在此处无法保证实现存在：runtime 若未安装该符号方法，调用会抛 `TypeError: ... is not a function`，而非 `SubagentError`。它绕开了包自身"结构化错误"的规范，是四个包里唯一"类型声明即契约、运行时零校验"的接口。

**其余"类型即保证"的点，按仓库约定属合理豁免**

| 位置 | 为何豁免 |
|---|---|
| `SubagentProvider` 全部方法（`types.ts:313-355`） | 同进程可信实现，AGENTS.md 明确"Trust TypeScript at typed same-process boundaries"；仓内已用"调用方先校验 capability 再 start"把它变成显式前置条件 |
| `SubagentStopReasonMap` 合并可扩展 → `continuation-messages.ts:123-127` 的 `default` 臂 | 合并可扩展联合**要求**有文档化 default 分支（AGENTS.md），该臂已带 `v8 ignore` + 理由，且行为是"记为未完成而非成功"，方向安全 |
| `SubagentRun.result` 子级失败不 reject（`types.ts:290-297`） | 契约把"模型/传输失败 → `stopReason:'error'`"与"基础设施故障 → reject"分开，`run-settlement.spec.ts` 用多字节 diagnostic 截断用例钉住边界 |
| `agent-preset/src/index.ts:22` `plugins: z.array(z.any()).required()` | 这是 **config 边界**，但注释交代了分工："Cordis owns individual plugin schemas; the registry validates entry structure"，`agent-preset-registry/tests/registry.spec.ts` 有"validates malformed child YAML at the declaring plugin and retains diagnostics"用例。README 坦承"Presets are not security sandboxes"——属已声明的能力边界 |
| `SubagentResult.structured: unknown` | 值由 provider 按调用方给出的 `outputSchema` 校验，seam 必须保持 schema-agnostic；校验发生在 `assertObjectJsonSchema` 子集侧，`structured.spec.ts`（1005 行）逐条钉住 |

**反向确认：真正应该校验的边界确实在校验**（这是健康而非薄弱）

- durable/file 边界：`catalog.ts` 用 zod 逐字段 `.strict()`（v0/v1/v2 四态联合 + `stateVersion: 6`），`descriptor.ts` 手写 `parseSubagentDescriptor` 做版本判定 + **未知字段一律拒绝**（`assertKnownKeys`）+ 类型逐字段断言，`foldSubagentDescriptor` 注释明确"current-version 不匹配则 throw"。
- VM/跨 realm 边界：`workflow-ptc/src/realm.ts` 的 `materializeFromRealm` 拒绝函数/symbol/bigint/非有限数/`__proto__` 原型污染/环/稀疏数组/异种原型，`realm.spec.ts` 15 例逐条覆盖。
- 模型/tool JSON 边界：`meta.ts` 的 `validateMeta` 一次抛出**全部**违规（"names EVERY violation in one throw"），并对未知字段按名拒绝。

### 2.3 可观测性：编排过程能通过会话日志重建到什么程度？失败原因是否可追溯？有无结构化错误类型？

**能重建到什么程度：可以完整重建，且事件词汇表被生成式闸门钉死。**

- 词汇表层：`packages/core/session/src/known-event-types.ts`（GENERATED by `scripts/gen-persistence-catalog.ts`，由 `pnpm run verify-persistence-catalog` 纳入 `doc-sync` 校验新鲜度）共 **62** 个事件类型（`KNOWN_SESSION_EVENT_TYPES` 的 Set 成员数，`known-event-types.ts:23-84`）。其中编排贡献 8 个：`subagent/catalog`、`subagent/descriptor`、`subagent/model-selection-policy`、`agent-preset/selected`、`tool-workflow/{run-start,agent-start,agent-end,run-end}`。
- 版本化：`SUBAGENT_DESCRIPTOR_VERSION = 3`（descriptor.ts:48）、`SUBAGENT_CATALOG_VERSION = 0` + 外部执行版 2 + unknown 版 1（catalog.ts:21/148）、catalog 投影 `stateVersion: 6`。工具侧 `tool-workflow/*` 四个事件带 `runId/seq/label/phase/childId/outcome/stopReason`，`run-end` 明确"after its live resources reach quiescence"。
- 读侧工具层齐全：`packages/session-query/session-query/src/tracing.ts` 提供 `SessionLineageTrace`（`ancestors` + 递归 `descendants` + `complete:true|false` 与 `unresolvedParentId`）与 `SessionEventTrace`（`replacedBy` / `replacementChain` / `replacedEventSeqs` / `sourceEventSeqs` / `derivedEventSeqs`）。委派树、表面替换、事件因果都能从日志单向推导。

**失败原因可追溯性：可追溯，但有一个明确的断点。**

- 可追溯部分：`subagent/end` 携带 `stopReason` + `lastAssistantMessage`（types.ts:98-115）；provider 的 `diagnostic` 经 `MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096` 截断并附 `[diagnostic truncated]`（out-of-process.ts:18-41），且**会进入模型可见/日志可见的结算用户消息**（`continuation-messages.ts:163`：`terminal.diagnostic !== undefined ? [{ type:'text', text: terminal.diagnostic }] : []`）——符合"Model-visible ⟺ logged"。
- 断点：`subagent/start` / `subagent/end` 是 **Cordis ctx 事件（observe-only），不是 `SessionEventMap` 成员**（types.ts:117-133 注释 "Lifecycle events are observe-only"）。因此单纯读日志拿不到 `runId → stopReason` 的直接映射，必须折子 Session 的 `turn/end` 或父侧 `tool/result` 的 `isError` 才能对齐。这是一处**需要两跳推导的诊断路径**，也是 `subagent/end` 后续若要加决策能力必须先落成 session 事件的已知前置债。

**结构化错误类型：齐备，且是闭合联合。**

| 类型 | 位置 | 码数 |
|---|---|---|
| `HarnessError`（基类） | `@deepseek-ai/dsh-llm` | — |
| `SubagentError` | `subagent/src/error.ts`（15 行） | 开放字符串，仓内实际码见 `DRAINING`/`UNAUTHORIZED`/`ACTIVATION_TEARDOWN_FAILED` 等 |
| `WorkflowError` + `WorkflowErrorCode` | `workflow/workflow/src/index.ts:108-139` | **11**：`SCRIPT_PARSE`/`META_INVALID`/`INVALID_ARGUMENT`/`UNSUPPORTED_OPTION`/`UNSUPPORTED_SCHEMA`/`AGENT_CAP`/`ITEM_CAP`/`AGENT_START`/`AGENT_RESULT`/`RESULT_UNSERIALIZABLE`/`CANCELLED`；`fatal` 标志区分"组合子重抛"与"逐项 null" |
| `SessionQueryError` + `SessionQueryErrorCode` | `session-query/src/config.ts:29-57` | **17**（闭合，`declare readonly code: SessionQueryErrorCode` 收窄） |

**缺口**：四个编排包内**没有任何 OTel / telemetry / patrol 集成**（`packages/telemetry/` 与 `packages/session/session-telemetry-otel` 存在但不在编排链路上）。仓库里唯一的"日志巡检"是**提案**而非实现：`.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.md`（Status: proposed，文末自述 `R4: NOT PASS / R5: NOT PASS / R6: NOT PASS / Phase 0: OPEN`）。

### 2.4 债务与风险分布：TODO/FIXME 有多少、主题是什么，哪些集中在编排链路？

**命令与结果（四个编排包，`git grep -n -E "\b(TODO|FIXME|XXX)\b"`）：全仓共 2 命中，只有 1 条是真债务标记。**

| 位置 | 内容 | 判定 |
|---|---|---|
| `packages/core/tool-executor-ptc/src/ptc.ts:101` | `'Examples: "Count TODO markers across packages"; '` | **假命中**：模型可见 prompt 里的示例文本 |
| `packages/subagent/subagent/src/assistant-output.ts:68` | `// TODO: this folds the complete suffix once per run/epoch settlement. If a` | **真债务**：每个 run/epoch 结算都重折完整后缀，长会话为 O(n²) 风险（未给出触发阈值） |

对比基数：`git grep -h -E "\b(TODO|FIXME|XXX)\b" -- "packages/**/src/**"` = **43**，即编排四包占 1/43。**标记式债务在本体系几乎为零**——债务不以注释形式存在，而以**已文档化的能力上限**存在。

**真正的债务分布在 README 的 `## Known Limitations and Deferred Work`（有 `scripts/verify-package-readme-limitations.ts` 强制覆盖）：**

| 包 | 条数 | 集中在编排链路的条目 |
|---|---|---|
| `subagent/subagent` | 10 | 5/10：**Wake gap during cancellation convergence**（interrupt 后 idle 前接受的 follow-up 会滞留）、**No replay of accepted-but-unlogged messages**（崩溃丢已接受未落盘 prompt）、**Process-local residency**（无跨进程 mailbox/lease）、**No durable parent mailbox**、**Pending injected context retains an Activation** |
| `workflow/workflow` | 5 | 4/5：**Foreground collection only**（无后台/轮询/spill 句柄）、**No journaling or resume**（重启不能续跑）、**No saved or nested workflows**（无递归编排）、**Runs are holder-owned, not service-tracked**（引擎卸载不发现活句柄） |
| `workflow/workflow-ptc` | 6 | 3/6：**Workflow caps are cooperative**（helper 计数器不是 host 强制配额，无 token 预算）、**No overall elapsed deadline**、**Cross-realm errors fail `instanceof Error`** |
| `workflow/tool-workflow` | 5 | 2/5：后台运行无录制场景、`args` 必须为对象 + Native 结果文本有界 |
| `core/agent` | 5 | 3/5：**Initiator scope is process-local**、**cancel() 默认清空 inbox**（无 step-only abort） |
| `core/agent-loop` | 6 | 3/6：**Root shutdown 可能丢最终 `turn/end` 落盘**、**No built-in turn budget**、**Classification is unary**（兄弟比较型调用必须独占） |
| `preset/agent-preset-registry` | 1 | 1/1：preset 不是安全沙箱，YAML/plugins 可执行 Host 代码 |

**风险主题归并**：编排链路债务几乎全部收敛到同一族——**进程内/内存态的所有权（residency、holder-owned run、process-local initiator）+ 缺少 durable 邮箱/journaling**。这不是散落缺陷，而是一个已被明确记录、等待具体 consumer 才动手的单一边界决策。

### 2.5 量化指标表

见 ③。

---

## ③ 量化指标表

### 3.1 四个编排包组

| 指标 | 数值 | 统计命令 |
|---|---|---|
| 编排包组数 | 4（core / subagent / preset / workflow） | `Get-ChildItem packages/core,packages/subagent,packages/preset,packages/workflow -Directory` |
| `core` 子包数 | 10 | 同上 |
| `subagent` 子包数 | 9 | 同上 |
| `preset` 子包数 | 3 | 同上 |
| `workflow` 子包数 | 3 | 同上 |
| 源码文件数（四包组，`.ts/.tsx`，排除 `.d.ts`） | **116** | `git ls-files "packages/<g>/*" \| ? { $_ -match '/src/' -and $_ -match '\.(ts\|tsx)$' -and $_ -notmatch '\.d\.ts$' }`（逐组求和：49+42+10+15） |
| 源码行数 | **28,186** | 对上述文件逐个 `(Get-Content $_).Count` 求和（14,562+10,102+1,188+2,334） |
| 单元测试文件数（`*.spec.ts`） | **135** | `git ls-files "packages/<g>/**/*.spec.ts"`（73+44+8+10） |
| 单元测试行数 | **60,960** | 同上逐文件 `(Get-Content $_).Count` 求和（34,131+22,659+1,142+3,028） |
| 测试/源码行比 | **2.16 : 1** | 60,960 ÷ 28,186 |
| e2e 测试文件数（四包组） | **13** | `git ls-files "packages/<g>/**/*.e2e.ts"` |
| 仓库 e2e 文件总数 | 86 | `git ls-files \| Select-String -Pattern '^packages/[^/]+/[^/]+/tests/.*\.e2e\.ts$'` |
| 快照场景总数 | **158** | `git ls-files \| Select-String -Pattern '^snapshots/session/[^/]+/snapshot\.yml$'` |
| 编排相关快照场景数 | **21** | 同上，过滤 `subagent\|workflow\|product-subagent\|team-` |
| 覆盖率闸门（per-file） | `statements/branches/functions/lines = 100`，`perFile: true` | `vitest.config.ts:402-410` |
| 编排四包在覆盖率 exclude 中的条目 | **0** | `vitest.config.ts:243-397` 与 `scripts/coverage-exempt.ts` 均无 `core/*`、`subagent/*`、`preset/*`、`workflow/*` |
| `v8 ignore` 注释数（源码内，即 100% 闸门上的显式豁免） | **98**（core 50 / subagent 36 / preset 2 / workflow 10） | `git grep -h "v8 ignore" -- "packages/<g>/**/src/**" \| Measure-Object` |
| 其中 `subagent/src/manager.ts` | **8**（全部带具体理由，多为不可确定性调度的竞态臂） | `git grep -c "v8 ignore" -- "packages/subagent/subagent/src/manager.ts"` |
| `TODO/FIXME/XXX` 命中数（四包组） | **2**（1 假命中 + **1 真债务**） | `git grep -n -E "\b(TODO\|FIXME\|XXX)\b" -- "packages/{core,subagent,preset,workflow}/**"` |
| 仓库 `packages/**/src` 内 `TODO/FIXME/XXX` 总数 | 43 | `git grep -h -E "\b(TODO\|FIXME\|XXX)\b" -- "packages/**/src/**" \| Measure-Object` |
| `as unknown` 真转型数（四包组 `src/`） | **13**（14 行命中，1 行为错误消息字符串） | `git grep -n "as unknown" -- "packages/<g>/**/src/*.ts"`；基线 `scripts/no-unknown-casts.baseline.json` |
| `assertNever` 使用文件数 / 次数 | 10 个文件 / 21 处 | `git grep -c "assertNever" -- "packages/<g>/**/src/*.ts"`（2+2+1+2+4+3+2+2+1+2） |
| `SessionEventMap` 全局 `KNOWN_SESSION_EVENT_TYPES` 成员数 | 62 | `packages/core/session/src/known-event-types.ts:22-85` |
| 编排贡献的 session 事件类型数 | 8 | 同上（`subagent/*` 3 个 + `agent-preset/selected` + `tool-workflow/*` 4 个） |
| 结构化错误码总数 | `WorkflowErrorCode` 11 + `SessionQueryErrorCode` 17 = **28** | `workflow/workflow/src/index.ts:108-119`、`session-query/src/session-query/src/config.ts:29-46` |

### 3.2 `packages/agentops/` 各子包（附录 A 用表）

| 子包 | 源码文件数（`src/`，ts+tsx） | 测试文件数 | 测试目录 | 测试运行时 | 是否被 CI 收集 |
|---|---|---|---|---|---|
| `bundle` | 3 | 4 | 有 | `node:test` | **否** |
| `client` | 62 | 30（`*.client.spec.ts(x)`） | 有 | vitest jsdom | 是 |
| `contracts` | 3 | 1 | 有 | vitest | 是 |
| `dag` | 16 | 10 | 有 | `node:test` | **否** |
| `db` | 7 | 1 | 有 | `node:test` | **否** |
| `deploy` | 0（9 个部署资产） | 0 | 无（由 `bundle/tests/deploy.test.ts` 覆盖 `seed-agentops.mjs` 与 `agentops.patch.yml`） | — | 随 bundle（否） |
| `host` | 25 | 13 | 有 | `node:test` | **否** |
| `knowledge` | 12 | 7 | 有 | `node:test` | **否** |
| `knowledge-base` | 0 | 0 | 无 | — | — |
| `scripts` | 0 | 0 | 无 | — | — |
| `security` | 8 | 5 | 有 | `node:test` | **否** |
| `skills` | 0 | 0 | 无 | — | — |
| `task` | 5 | 2 | 有 | `node:test` | **否** |
| `vault` | 5 | 1 | 有 | `node:test` | **否** |
| `workflow-catalog` | 2 | 1 | 有 | vitest | 是 |
| `workflow-compiler` | 3 | 2 | 有 | vitest | 是 |
| `workspace-layout` | 3 | 1 | 有 | vitest | 是 |
| **合计** | **154** | **78**（35 vitest spec + 43 `node:test`） | | | 8/18 子包未被收集 |

统计命令：
```powershell
git ls-files "packages/agentops/*/src/*" | ? { $_ -match '\.(ts|tsx)$' -and $_ -notmatch '\.d\.ts$' } | Measure-Object
git ls-files "packages/agentops/*/tests/*" | ? { $_ -match '\.spec\.(ts|tsx)$' } | Measure-Object   # 35
git ls-files "packages/agentops/*/tests/*" | ? { $_ -match '\.test\.ts$' } | Measure-Object        # 43
foreach ($p in 'dag','host',...) { (Select-String -Path packages/agentops/$p/tests/*.test.ts -Pattern "\btest\(").Count }
```

---

## ④ 缺测与债务清单（按严重度排序）

| # | 严重度 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| D1 | **P0** | `packages/agentops/` 8 个子包的 **43 个 `node:test` 套件（306 个 `test()`）不被任何配置的测试通道收集**。它们的文件名是 `*.test.ts`，而 vitest `testIncludes` 只匹配 `packages/*/*/tests/**/*.spec.{ts,tsx}`；各包只有自己的 `pnpm --filter ... test` 脚本，CI 与 `run-gates` 都不调用 | `vitest.config.ts:128-133`（`testIncludes`）；`git grep -n "node --test\|node:test" -- package.json .github/workflows` 只命中 `.github/review-ownership/*.test.mjs` 与 `native/system`；`scripts/run-gates.ts:750` 的 `label:'test'` = `vitest run` | dag 引擎节点路由（124 例）、host 的 SurfaceStore/工具注册（66 例）、security/knowledge/vault 全部**只在开发者本机手动执行**；CI 绿灯不代表它们通过。覆盖率闸门 `include: ['packages/*/*/src/**/*.{ts,tsx}']` 又**未排除** `packages/agentops/*/src`，闸门是否因此为红：**未验证（禁止运行 gate）** |
| D2 | **P0** | `SurfaceStore` 在**每个 preset scope 的 `apply()` 里 `new` 一次**，构造器内无条件执行表级破坏性 DELETE，且全仓无 `close()` 调用点 | 见附录 A §A.2.1 / §A.2.2（成立） | 共享 SQLite 文件上句柄数随 preset 修订代际 + connection 重载单调增长；每个新 scope 都重放一次 `DELETE ... WHERE id NOT IN (SELECT MAX(id) ... GROUP BY view_id)` |
| D3 | **P1** | A2UI 链路无直接测试：host `a2ui-schema/` 10 文件 5,412 行（`schemas.ts` 1,371、`a2ui.ts` 1,184、`runtime.ts` 675）无任何测试 import；client 7 个 A2UI 组件（`a2ui-panel.tsx` 236、`A2uiRenderer.tsx` 162、`A2uiDag.tsx` 172 等）无任何测试 import | `git grep -n "a2ui-schema" -- packages/agentops` 只命中 `surfaces.ts:15`；`git grep -h "from '\.\./src" -- packages/agentops/client/tests/` 的 31 个 specifier 中无 `a2ui` | 唯一被间接触达的是 `validation.ts`（经 `surfaces.ts`）；`reducer.ts` 的事务应用、`view-spec.ts`、`json-value.ts`、`artifact-uri.ts` 与全部渲染分支零覆盖 |
| D4 | **P1** | `client` 21 个源码模块无测试引用，其中含 `agents-editor.tsx`（**1,588 行**）、`workflow-dag-canvas.tsx`（352）、`surface-screen/{definition,register,ScreenBody}`、6 个 panel（knowledge/monitor/schedules/session-replay/task-report/vault）、`agent-editor-logic.ts`、`styles/all.ts` | 同上 import specifier 对照（62 个 src 模块中 31 个被 import） | 编排前端的"编辑 → 校验 → 发布"主路径（agents-editor + workflow-dag-canvas）没有自动化保护 |
| D5 | **P1** | `subagent/src/manager.ts` 8 处 `v8 ignore` 标记的是 re-entrancy / dispose-vs-send 竞态臂，理由均为"no test can schedule deterministically" | `manager.ts:663, 977, 1278, 1294, 1308, 1467, 1511` | 这些正是并发派发/中断/失败回传的最坏路径；100% 覆盖率闸门在此处**不再提供信号**，只剩代码审查 |
| D6 | **P1** | 工作流**后台运行**无录制会话场景（包内自述） | `packages/workflow/tool-workflow/README.md` Known Limitations | 后台 job 的 durable record 与 job 生命周期只有单元级证据 |
| D7 | **P2** | 无任何名称含 `interrupt/cancel/abort` 的录制会话场景；人工中断委派子 Agent 只有单元级证据 | `git ls-files \| Select-String '^snapshots/session/[^/]+/snapshot\.yml$' \| ? { $_ -match 'interrupt\|cancel\|abort' }` → 空 | 中断-落盘-恢复的端到端一致性未由快照钉住 |
| D8 | **P2** | `assistant-output.ts:68` 的 TODO：每次 run/epoch 结算重折完整后缀 | 见 2.4 | 长会话的结算开销随日志长度线性累加，O(n²) 总量 |
| D9 | **P2** | `subagent/src/internal.ts:74/102` 的符号键内部协议以 `as unknown as` 断言，运行时无校验，失败形态是 `TypeError` 而非 `SubagentError` | 见 2.2 | 打包/未打包双实例场景下的诊断质量下降 |
| D10 | **P2** | `subagent/start`、`subagent/end` 是 observe-only ctx 事件而非 session 事件，`runId → stopReason` 需两跳（子 Session `turn/end` 或父 `tool/result`）推导 | `subagent/src/types.ts:117-133`；`known-event-types.ts` 无这两个类型 | 日志侧无法一次查询拿到终态；包内已自述等待具体 consumer |
| D11 | **P3** | `core/tool-executor-native` 无包内 spec（1 源文件 35 行） | `git ls-files "packages/core/tool-executor-native/*"` 无 `tests/` | 薄适配层，风险低 |
| D12 | **P3** | `preset/agent-preset` 唯一的 spec 只测随包 skill 内容，不测 `src/index.ts` 的 Config 注册路径 | `packages/preset/agent-preset/tests/skills.spec.ts` 全 6 例均关于 skill/模板 | 30 行声明式插件，风险低 |

---

## ⑤ 摘要（≤150 字）

四个编排包测试极厚（135 spec / 60,960 行，2.16:1），全部在 per-file 100% 闸门下且零豁免；债务以文档化能力上限而非 TODO 存在（仅 1 条真 TODO）。可观测性最强：委派可完整从 session log 重建，失败有 28 个结构化错误码。真正缺口在 `packages/agentops/`：43 个 `node:test` 套件（306 例）不被任何 CI 通道收集，A2UI 5,412 行与前端编辑主路径零直接测试，`SurfaceStore` 每 scope 重建且不 close。

---

## 附录 A：`packages/agentops/` 本体体检与委托疑点独立验证

### A.1 结论先行

- **dag 引擎（16 源文件 / 10 套件 / 124 个 `test()`）是 agentops 里测试最扎实的子包**：10 个测试文件 import 了 16 个源模块中的 15 个（唯一未 import 的是 `src/index.ts` 插件入口）。薄弱点不在"有没有测"，而在**用例形态**：全部是 `node:test` + 直接函数调用，**没有一条走 Loader 真实组合**，与 `packages/AGENTS.md` 要求的"Product-visible plugins require a non-unit REAL-composition test"不对齐（`host/tests/plugin-mount.test.ts` 只断言 `toolsName === 'agentops-system-tools'` 这一个字符串）。
- **host（25 源文件 / 13 套件 / 66 个 `test()`）源文件级无遗漏**（13 个测试 import 覆盖了除 `types.ts` 外全部模块），但 **`a2ui-schema/`（10 文件 5,412 行）不在其中**——只有 `surfaces.ts` 间接触达 `validation.ts`。
- **client（62 源文件 / 30 spec）是覆盖最薄弱的一层**：31/62 源模块被 spec import，A2UI 与"DAG/Agent 编辑器"两条主路径完全没有直接测试。

### A.2 疑点 1 独立验证：每个 preset scope 都 `new SurfaceStore(path)`，且未注册关闭句柄

**结论：成立。**

证据链（`packages/agentops/host/src/tools.ts` 全文 63 行）：

```
54: export function apply(ctx: Context, config: Config = {}): void {
55:   const reg = onlyRegistrar(ctx, config.only, TOOL_NAMES)
...
58:   const path = resolveSurfaceDbPath()
59:   if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
60:   const surfaces = new SurfaceStore(path)
61:   reg(createPresentContentTool(surfaces))
62:   reg(createBoardCleanupTool(surfaces))
63: }
```

1. **"每个 Agent preset scope 一次"成立，且比该描述更强——还有第二个构造点。**
   - 文件头注释自述：`System-status tool, mounted inside an Agent preset. / The registry is Agent-scoped, so this half cannot live at the root.`（tools.ts:1-7）
   - 装载证据：`packages/agentops/bundle/presets/agentops-tools.patch.yml:1-5` 原文 `these rows live in a preset 'plugins' list and are mounted for each Agent built from this preset`，第 17 行 `- id: agentops-system-tools` 就在 `preset-agentops` 的 `plugins` 下；`packages/agentops/deploy/agentops.patch.yml:49` 同构。
   - preset 注册表按**代际**保留 scope（`packages/preset/agent-preset-registry/README.md` + `tests/registry.spec.ts` 的 `retains a replaced revision for existing scopes and their children, then releases it`），所以修订更换会产生**新的 scope → 新的 `SurfaceStore`**。
   - 第二个构造点：`packages/agentops/host/src/dsh.ts:169-173`
     ```ts
     ctx.inject(['connection'], (connectionCtx) => {
       const surfacePath = resolveSurfaceDbPath()
       if (surfacePath !== ':memory:') mkdirSync(dirname(surfacePath), { recursive: true })
       registerSurfaceRoutes(connectionCtx, new SurfaceStore(surfacePath))
     ```
     即每次 connection 注入（含重载）再 new 一个。
   - 全仓 `new SurfaceStore` 共 3 处生产路径之外只有一个清理脚本：`git grep -n "new SurfaceStore" -- packages/agentops` → `host/scripts/clean-surfaces.ts:16`、`host/src/dsh.ts:173`、`host/src/tools.ts:60`、两个测试。
2. **"未注册 `ctx.effect` 关闭句柄"成立，且比该描述更强——`close()` 全仓无调用点。**
   - `git grep -c "ctx.effect" -- packages/agentops/host/src/tools.ts` → **0 命中**（该文件仅 63 行）。
   - `git grep -n "\.close()\|close()" -- packages/agentops/host/src` → **只命中 `surfaces.ts:316` 的定义本身**（`close(): void { this.#db.close() }`）。
   - 反证该文件并非"风格如此"：同一 `host/src` 目录下 `agents.ts`(5)、`archive.ts`(1)、`models.ts`(1)、`schedules.ts`(1)、`sessions.ts`(1)、`persona-static.ts`(1) 都用了 `ctx.effect(() => ctx.connection.fetch.register(...))`；`surfaces.ts` 的 5 个路由注册也**都**包在 `ctx.effect` 里。所以缺的是**资源**（`DatabaseSync` 句柄）的 disposal，不是注册的 disposal。
   - 附带风险：`path === ':memory:'` 时每个 scope 拿到**各自独立的空库**，`present_content` 写入的卡片与其他 scope / 路由侧读到的库不是同一个。

### A.3 疑点 2 独立验证：构造器执行破坏性 DELETE；`put()` 为非事务 DELETE+INSERT

**结论：两条都成立。**

**(a) 构造器里的无条件破坏性 DELETE —— 成立，`surfaces.ts:310-312` 原文：**

```ts
308:       CREATE INDEX IF NOT EXISTS surfaces_view ON surfaces(view_id);
309:     `)
310:     // One card per view: rows written before view_id existed all share 'main',
311:     // so collapse them to the newest one instead of showing a pile of pages.
312:     this.#db.exec("DELETE FROM surfaces WHERE id NOT IN (SELECT MAX(id) FROM surfaces GROUP BY view_id)")
```

- 位置确认：它在 `SurfaceStore` 的 `constructor(path)`（`:287` 起）体内，紧随 `CREATE TABLE` / 列迁移 / `CREATE INDEX` 之后，**不属于任何版本化迁移步骤**（同文件没有 schema version 表、没有 `PRAGMA user_version`）。
- 语义确认：整表 `DELETE ... WHERE id NOT IN (SELECT MAX(id) ... GROUP BY view_id)`，无 `WHERE` 限定新库/旧库，无"仅当存在 legacy 行"的条件。
- 幂等性：对已折叠过的库再执行是空操作。**因此实际风险不是重复删数据，而是**：(i) 每次构造都有一次未声明的全表写（对只读使用方也是写）；(ii) 首次折叠后每个 `view_id` 只保留 `MAX(id)`，跨 scope 时以"最新 id"为唯一判据，任何一个写入方插入的中间行都会被后构造的 scope 静默删除；(iii) 构造函数不可失败隔离——`exec` 抛错会让整个 plugin（进而该 preset scope）装载失败。

**(b) `put()` 是非事务 DELETE+INSERT —— 成立，`surfaces.ts:326-346` 原文：**

```ts
334:     this.#db.prepare('DELETE FROM surfaces WHERE view_id = ?').run(viewId)
335:     const result = this.#db.prepare(
336:       'INSERT INTO surfaces (view_id, session_id, title, surface_json, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
337:     ).run(viewId, options.sessionId ?? null, options.title, ...)
```

- 两条独立语句，中间无 `BEGIN` / `COMMIT` / `SAVEPOINT`。`git grep -n "BEGIN\|COMMIT\|ROLLBACK\|transaction" -- packages/agentops/host/src` 的命中全部落在 `a2ui-schema/reducer.ts` 的 **A2UI 文档事务**概念（上游 A2UI 协议术语），与 SQLite 事务无关——即 host 侧**没有任何 SQL 事务使用**。
- 影响面（`DatabaseSync` 是同步 API，单进程单句柄内不会交错）：真正的窗口是多句柄 —— 结合 A.2，同一 `.db` 文件存在 `N(preset scopes) + 1(connection)` 个句柄，`DELETE` 与 `INSERT` 之间若另一个句柄构造（触发 `:312` 的折叠）或执行 `removeView`/`clear`，该 view 会**瞬时消失**；进程在两句之间崩溃则该卡片永久丢失（无回滚）。
- 附带可观测缺陷：`INSERT` 依赖 `AUTOINCREMENT`，`put()` 每次发布都会得到**新的行 id**，因此"同一张卡片"的 id 不是稳定的外部标识（`views()`/`list()` 都以 id 排序）。

### A.4 委托方转述的第三条说法：不成立（已独立核对，未执行测试）

说法为"bundle 测试是红的，期望 7 而实际 6 个 root 行"。**静态核对结果：不成立。**
`packages/agentops/bundle/tests/deploy.test.ts:41,46` 断言 `rootRows.length === 7` 与 `presetRows.length === 6`；而 `packages/agentops/deploy/agentops.patch.yml` 共 **8** 个 `- id:` 行 = **7 个 root 行**（`agentops-system`、`knowledge`、`dag`、`task`、`security`、`workflow-catalog`、`client`）+ **1 个 preset 行**，该 preset 的 `plugins` 恰为 **6** 行（`agentops-system-tools`、`knowledge-tools`、`dag-tools`、`task-tools`、`security-tools`、`db-tools`）。两个断言值都与文件一致，**未发现 7 vs 6 的错配**。
（说明：本次分析禁止运行 `pnpm test`，故这是静态核对而非执行结论；该套件属于 D1 中未被 CI 收集的 `node:test` 家族，当前工作树上是否通过**未验证**。）

### A.5 agentops 侧缺测薄弱点小结

| 区域 | 现状 | 薄弱点 |
|---|---|---|
| `dag` 引擎 / 节点路由 | 124 个 `test()`，15/16 源模块被 import | 全部为直接函数调用，无 Loader 真实组合用例；`engine.ts` 的并发/重跑交互只在单元层验证 |
| `host` SurfaceStore / 工具注册 | 66 个 `test()`，`surfaces.test.ts` 11 例、`templates.test.ts` 9 例 | 无"scope 生命周期 + 句柄释放"用例；构造器破坏性 DELETE、非事务 `put()`、多句柄并发均无对应用例（与 A.2/A.3 一致）；`plugin-mount.test.ts` 只断言名字 |
| `host` `a2ui-schema/` | 5,412 行 10 文件 | **零直接测试**，仅 `validation.ts` 经 `surfaces.ts` 间接触达 |
| `client` A2UI 面板 | `a2ui-panel.tsx` 236 + 6 组件（`A2uiRenderer` 162、`A2uiDag` 172、`A2uiNode`、3 个 AoXxx 图表） | **零直接测试**；`client/tests/menu.client.spec.ts` 是唯一提到 `a2ui` 的 spec（菜单项层面） |
| `client` 编辑器主路径 | `agents-editor.tsx` **1,588 行**、`workflow-dag-canvas.tsx` 352、`surface-screen/*`、6 个 panel | 未被任何 spec import |
