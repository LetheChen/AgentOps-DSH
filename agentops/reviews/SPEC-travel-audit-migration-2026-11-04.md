# 差旅报销智能审核迁移方案（SPEC）

日期：2026-11-04
来源：`<legacy-ai-platform>\sub_projects\oa_audit`（下称 legacy）
目标：在 DSH 上重建这条审核链路，判定口径不退化，运维与治理交给 DSH。

---

## 0 摘要（结论先行）

| # | 结论 | 一句话理由 |
|---|---|---|
| 1 | **判定层一次性批处理，不逐项建节点** | legacy 已是「1 次文本模型调用审 6 项」；逐项拆节点会把 1 次调用变成 6 次、把同一份单据数据在 6 个 prompt 里重复。 |
| 2 | **并行放在工具/服务内部，不放在工作流图里** | 审一次单据的墙钟瓶颈是模型调用与附件识别；图级并行只增加调用数与 token，不减少关键路径。 |
| 3 | **确定性项继续确定性** | `invoice_check`、`cross_trip_check` 在 legacy 是 `output_target: direct`，不进 prompt。迁移后仍由工具出结论，模型不得改写。 |
| 4 | **规则分三层：代码 / 规则 YAML / 制度 KB** | 规则要可 diff、可回滚（YAML）；制度要可增长、可检索（KB）；只有制度能覆盖「预设审核项之外」的科目。 |
| 5 | **出入参数留在适配层，DSH 只做判定与编排** | 致远 OA 的 token、附件下载、视觉识别、PDF、严格 3 字段回调都是既有资产，搬进 DSH 只增风险不增价值。 |
| 6 | **工具粒度按「一次会话回合」设计** | 一个工具一次返回全部素材（表单+附件+识别+确定性结论+制度依据），把 k 次往返压成 1 次。 |

模型调用预算（审一张单据）：

| 方案 | 文本模型调用 | 说明 |
|---|---|---|
| legacy 现状 | 1 次（Step6）+ N 次视觉（Step4） | 视觉调用在 doc_parser 服务内部并发 3 |
| 朴素迁移（8 项各一节点） | 8～16 次 | 每节点重复送同一份表单；规则交叉项互相看不见事实 |
| **本方案** | **3 次**（prepare / judge / submit 各 1 回合） | 素材与制度依据在工具内备齐，模型只做判定与措辞 |

---

## 1 现状（事实）

### 1.1 九步流水线

执行体是 `src/api/audit_api.py` 的 `_run_audit_pipeline`（`audit_api.py:556`），九段顺序代码 + 九次 `insert_step_log`，**没有依赖图**：

| 步 | 名称 | 输入 → 输出 | LLM | 工具 |
|---|---|---|---|---|
| 1 | `step1_fetch_oa_data` 数据预处理 | summary_id → `oa_data` | 否 | OA HTTP |
| 1.5 | 子表抽取（`sub_table_multi`） | 商旅统付 5 张子表 → `oa_data.corporate_travel` | 否 | — |
| 2 | `step2_activate_items` 激活审核项 | `oa_data` → `active_items` / `inactive_items` | 否 | — |
| 3 | `step3_dispatch_tools` 调度工具 | `active_items` → `tool_result.*` / `audit_results.*` | 否 | 是 |
| 4 | `step4_parse_attachments` 附件识别 | 附件路径 → `attachment_parsed.{rule}` | **视觉** | doc_parser |
| 5 | `step5_prepare_and_assemble` 数据组装 | `oa_data` + 附件 → `item_data` + `assembled_prompt` | 否 | — |
| 6 | `step6_batch_audit` 统一模型审核 | prompt → `llm_result` | **文本（唯一一次）** | — |
| 7 | `step7_split_results` 结果拆分 | `llm_result` → `item_results` | 否 | 进程内 checker |
| 8 | `step8_aggregate_decision` 汇总决策 | `item_results` → 整体结论 | 否 | — |
| 9 | `step9_report_and_callback` 报告与回调 | 结论 → PDF + OA 回调 | 否 | PDF、OA HTTP |

`workflow_engine.py` 的 `WorkflowEngine` / `ActionRegistry` 在仓库内**没有调用点**，是死代码；`workflow.yaml` 里的 `steps:` 段也没有消费者。真正的「流程」就是上面九段 Python。

### 1.2 八个审核项

`travel_agent/workflow.yaml:9-17` 引用 8 项，定义分散在 `sub_agents/common/`（4 项）与 `sub_agents/travel_agent/audit_items/`（4 项）：

| item_id | 中文名 | 触发条件 | 判定方式 |
|---|---|---|---|
| `common/invoice_check` | 发票上传审核 | `subtable_not_empty('personal_expenses')` | **工具直出** |
| `common/hotel_check` | 酒店住宿审核 | 子表含「住宿费」 | LLM |
| `common/ride_hailing_check` | 网约车审核 | 子表含「网约车」 | LLM |
| `common/fuel_mileage` | 自驾加油费审核 | 子表含「汽车费用-加油费」 | LLM |
| `travel_agent/cross_trip_check` | 差中差审核 | 行程起止日期均非空 | **工具直出** |
| `travel_agent/allowance_amount` | 补助金额审核 | 子表含「差旅补助」或三个补助字段非空 | LLM |
| `travel_agent/allowance_time` | 补助天数审核 | 同上 | LLM |
| `travel_agent/trip_closure` | 行程闭环审核 | `field_not_empty('行程开始日期')` | LLM |

`hotel_time` 是孤儿目录：不在 `audit_item_refs` 里，仍用旧式 `data_extraction/checks/aggregation`，且没有 `audit_prompt`。迁移时**不要复活**它（`hotel_check` 已覆盖同一业务面）。

### 1.3 两类判定架构并存

- **程序直出**：`output_target: direct`。结论写在 `context.audit_results.{tool_id}`，不进 prompt，Step7 直接取 `decision`（`result_splitter.py:340-384`）。
- **LLM 批量**：其余 6 项的规则文本拼进同一个 prompt，一次调用返回数组。

两项直出的失败语义不对称，迁移时要照抄再决定是否修正：
- `invoice_check` 只用 PASS/REJECT，**从不返回 manual**（无明细或全 0 元行即 pass）——附件缺失的单据会被判通过，这是现有口径。
- `cross_trip_check` 有完整降级：缺申请人/缺日期/`oa_db` 不可用/SQL 异常一律 `manual`。

迁移若只保留 LLM 路径，这 2 项会退化成「让模型看有没有附件」，属于明确的质量倒退。

### 1.4 提示词组装与输出契约

`PromptAssembler._build_prompt`（`prompt_assembler.py:279-314`）四段：

1. 角色行（「你是一名专业的 OA 单据智能审核员…逐项判断」）
2. 审核数据：`json.dumps(aggregated_data, indent=2)`，**无截断、无 token 预算**
3. 每项一块：`### 审核项: {display_name}（{item_id}）` + 规则文本 + 名称约束
4. 输出格式：` ```json ` 包裹的数组，元素 `{"审核项","具体原因","审批意见"}`，长度必须等于项数

拆分靠**模型回填的中文名**四级匹配（精确名 → item_id → 归一化 → 双向包含），匹配不上落 `manual`。同名/歧义靠 `used_names` 防抢。

已知脆弱点：
- 输出被 `max_tokens` 截断时丢尾部项 → 缺项降级 `manual`（不是报错，是静默降级）
- 名称匹配失败率取决于模型是否照抄 `display_name`
- `field_not_empty` 把 `0 / False / []` 视为**有值**——迁移时若不保留这条语义，会把「补助 0 元」的单据判成未申报

### 1.5 附件管线

**路由不是按文件名或扩展名，而是按表单字段**：`attachment_rules.yaml` 两层（Layer 1 `item_id → attachment_fields + data_extraction_rule`，Layer 2 `agent_id → 业务级附件字段`），下载时在 `formContent.values` 里按 `displayName` 命中 `SUB_REFERENCE`，再到 OA MySQL 的 `ctp_attachment` 表取 `file_url/filename`（`attachment.py:190-271`）。扩展名只决定用哪个解析器，不决定业务规则。

提取只有一种实现：doc_parser——PDF 文字页抽文本 / 扫描页走 Vision、图片 OCR、docx/pptx 解析，先转 Markdown，再按 `extraction_rules/{rule}.md` 组 prompt 调模型出 JSON（`document_processor.py`）。输出 `attachment_parsed.{rule} = [{file_name, extracted_fields, extraction_confidence, error}]`。并发 3、单件超时 120s、失败置 `has_system_degradation`。

**已知缺口（迁移时不要继承）**：`attachment_rules.yaml` 声明了 20+ 个规则名，`extraction_rules/` 只有 15 个 md；`car_rental / meeting / training / labor / consulting / bid_* / office_* / entertainment` 缺失 → Step4 直接 `mode=error`。另有 `entertainment_limit` 读取的 key 与下载 key 不一致，靠 item_id 回写才对齐。

### 1.6 出入参

- 取数（REST）：`POST /seeyon/rest/token`、`GET /seeyon/rest/flow/data/{summaryId}`、`POST /seeyon/services/downloadService`
- 取数（MySQL 直连）：`oa_db` 工具（`tools/oa_db.py`）——`cross_trip_check` 查 `formmain_3140990` 历史行程、`invoice_detail` 查发票明细表、`entertainment_type` 查招待类型枚举。**这条依赖常被忽略：三个工具不是 HTTP，是 SQL。**
- 回调：`POST /seeyon/rest/nbdAiApproval/colApproval/{summaryId}/{nodeToken}`，**严格 3 字段** `{approvalResult: agree|disagree|manual, approvalComment, approvalFile:[{fileName,fileContent(base64 PDF)}]}`（`oa_client.py:170-214`）

### 1.7 现状的结构性问题（迁移要解决的）

| 问题 | 证据 | 影响 |
|---|---|---|
| 新增一个审核项要改 Python | 九段硬编码 | 迭代成本高，无法按单据类型组合 |
| 规则文本与代码同仓但无版本化边界 | `config.yaml` 的 `audit_prompt` | 规则改动无评审记录，回滚靠 git 全文 |
| 无上下文预算 | `prompt_assembler.py:295` | 大附件单据必然截断，缺项静默降级 |
| 缺项/解析失败 ≠ 失败 | `result_splitter.py:188-193` | 模型输出问题被当成「人工复核」，难发现 |
| 无步骤级重试 | `workflow_engine._retry_step` 未接入 | 单点抖动要靠整体重跑 |
| 制度依据不在链路内 | 规则之外无检索 | 未收录科目只能人工判断 |

---

## 2 迁移目标与不变量

**必须保住（不变量）**

1. 判定口径：8 项的触发条件、判定要点、结论枚举与 legacy 一致；差异必须显式记录。
2. 确定性项不可被模型改写。
3. 每条结论可溯源：哪个规则、哪段制度、哪份附件、哪条统付记录。
4. 回调契约不变（3 字段 + PDF），OA 侧零改动。
5. 同一 summaryId 重复触发幂等。

**允许改变（改进项）**

- 规则从 `config.yaml` 迁到 repo 内的规则资产，可评审可回滚。
- 制度全文进 KB，未收录科目有依据可查。
- 上下文预算显式化，超限降级为「分段判定」而不是静默丢项。
- 缺项、解析失败、制度无依据 → 一律显式 `manual` 并写明原因。

---

## 3 关键设计决策

### D1 判定层一次批处理（不逐项建节点）

**问题**：8 个审核项要不要各建一个 agent 节点？
**选项**：A 逐项节点；B 单节点批量；C 分组批量（按"行程类 / 票据类"）。
**选择**：B。
**理由**：
- legacy 的批处理不是为了省事，是因为**规则之间共享事实**：`allowance_time` 与 `trip_closure` 都判「中间日断档」，`hotel_check` 与 `trip_closure` 都判「城市衔接」。拆开后两份结论会互相矛盾，而矛盾正是人工复核最大的来源。
- 逐项节点会把同一份 `oa_data`（含统付 5 张子表）在 6 个 prompt 里各送一遍。
**代价**：单次 prompt 更长；采用 C 的触发条件是「单项素材 > 8k token 且与其它项无事实交叉」。

### D2 并行放在工具内部

**问题**：图级并行值不值？
**选择**：不值。工作流里**不出现**并行分支；并发留给 `oa_audit_prepare` 内部（附件下载 5 路、识别 3 路、工具 4 路）。
**理由**：并行减少的是墙钟时间，增加的是调用数与 token；而这里墙钟瓶颈是模型调用与视觉识别，两者都在「一次调用内部」就已经是批量的。DAG 的 `parallel_branch` 保留给「同一份输入要跑不同模型」这类场景。
**判据**：只有当「子任务需要不同模型/不同工具集/上下文装不下」时，才拆并行节点。

### D3 确定性项不进模型

`invoice_check`（查「协同票据管理」是否为空）与 `cross_trip_check`（时间区间求交）在 `oa_audit_prepare` 里算完，结论以 `fixed: true` 传给判定层。判定层的 prompt 明确写「fixed 项的结论不得修改，只能引用」。

### D4 规则三层分离

| 层 | 载体 | 谁改 | 变更生效 |
|---|---|---|---|
| 代码 | `@agentops/dsh-oa` 工具 | 工程 | 重建 + 重启 |
| 规则 | `agentops/audit/travel/items/*.yaml` → 编译进工作流 `role_prompt` | 业务 + 评审 | 改 YAML 重新生成，无需重启 |
| 制度 | KB 空间 `财务制度` | 财务 | 同步脚本，无需重启 |

规则**不进 KB**：规则要精确、要 diff、要能锁定版本；KB 是给「规则没覆盖到的东西」兜底的。

### D5 检索前置（制度依据随素材一起下发）

不在判定节点里让模型自己调 `knowledge_search`（那会多一次往返，且模型可能不查）。

`oa_audit_prepare` 在装配素材时：
1. 从单据里取出本次出现的费用类型集合（`personal_expenses.费用类型-凭证` 去重）
2. 每个类型先在「类型 → 制度章节」映射表（`agentops/audit/travel/category-map.yaml`）里查
3. 命中则取该章节；未命中则用类型名做一次 KB 检索，取 top-3 切片
4. 结果作为 `policy_basis[]` 注入判定 prompt，带 `spaceId/documentId/section/chunkId`

判定层规则：**每个结论必须引用 `ruleRef` 或 `policyRef`**；两者都没有 → `manual`。

### D6 出入参数留在适配层

**选项**：A 全部搬进 DSH（新插件做 OA HTTP + 附件 + PDF + 回调）；B 保留 Python 适配层，DSH 只做判定；C 分阶段（先 B 后 A）。
**选择**：C，目标态 A，过渡态 B。
**理由**：Seeyon 的 token 缓存、附件下载（含 `ctp_attachment` 直连 SQL）、视觉识别、PDF 生成、严格 3 字段回调都是**已经跑通的集成**；其中三条 OA MySQL 查询（历史行程、发票明细、招待枚举）在 DSH 没有任何对等能力，重写等于重建一个数据库客户端加三份业务 SQL。先让 DSH 接管判定（价值最高、风险最低），适配层留在原处。
**切换判据**：判定层稳定运行 4 周、差异率 < 2% 后，再评估把适配层并入 `@agentops/dsh-oa`。

### D7 输出契约用工具校验，不靠 prompt

判定节点不直接输出自由 JSON，而是调用 `oa_audit_record(verdicts)`：
- 入参 schema 校验（item_id 必须来自激活列表、decision 三选一、必须带 `ruleRef|policyRef`）
- 校验失败返回结构化错误 → 模型在同一节点内修正（最多 2 次，超过则整单 `manual` 并记录）

这样把 legacy「按中文名匹配、匹配不上静默降级」换成「按 item_id、失败可见」。

### D8 触发方式

三种并存，按优先级：

1. **人工发起**（M3 即可用）：Manager → `travel_audit` agent → `dag_run`
2. **服务调用**（M2 起）：`POST /api/agentops/audit/run`（`@agentops/dsh-oa` 注册的 route），入参 `AuditPackage`，出参 `AuditResult`
3. **定时轮询**（可选）：待办轮询 → 逐单触发，等价于 legacy 的被动接收

---

## 4 目标架构

### 4.1 分层

```
致远 OA  ──HTTP──▶  适配层（保留 legacy 资产）
                     · token / 取数 / 附件下载
                     · 视觉识别（doc_parser + extraction_rules）
                     · PDF 报告 / 3 字段回调
                        │  AuditPackage(JSON)
                        ▼
                 DSH · travel-audit 工作流
                     · prepare  → 归一化 + 激活 + 确定性结论 + 制度依据
                     · judge    → 6 项 LLM 判定（1 次调用）
                     · deliver  → 校验 + 组装 + present_content
                        │  AuditResult(JSON)
                        ▼
                     适配层回调
```

### 4.2 工作流（3 节点）

```yaml
workflow_id: travel-audit
inputs:
  - { name: summary_id, type: string, required: true }
  - { name: doc_id,     type: string, required: false }
  - { name: dry_run,    type: boolean, required: false, default: true }

nodes:
  prepare:                  # 1 次模型调用（1 个工具往返）
    agent: travel_audit
    role_prompt: 调 oa_audit_prepare({summary_id})，把返回的 AuditPackage 原样放到 package 端口。
    outputs: { package: [judge] }

  judge:                    # 1 次模型调用（无工具；规则与制度依据都在 package 里）
    agent: travel_audit
    after: [prepare]
    inputs: [package]
    role_prompt: |
      按 package.rules 逐项判定；fixed=true 的项直接引用其 conclusion。
      每项必须给出 ruleRef 或 policyRef；都没有则 decision=manual。
      只通过 oa_audit_record 提交，不要输出自由文本 JSON。
    outputs: { verdicts: [deliver] }

  deliver:                  # 1 次模型调用（1 个工具往返）
    agent: travel_audit
    after: [judge]
    inputs: [package, verdicts, dry_run]
    role_prompt: 调 oa_audit_submit({...})；dry_run=true 时只出报告不回写。
    outputs: { answer: "" }
```

端口契约：

| 端口 | 生产者 | 消费 | 内容 |
|---|---|---|---|
| `package` | prepare | judge, deliver | `AuditPackage` |
| `verdicts` | judge | deliver | `Verdict[]`（8 项） |
| `answer` | deliver | 终结 | markdown 审核报告 + 回调结果 |

为什么不是 4+ 节点：`prepare` 与 `deliver` 各自只做「一次工具往返 + 原样转发」，多拆一个节点就是多一次模型调用且不产生新信息。

### 4.3 数据契约

```ts
// AuditPackage：工具产出，模型只读
interface AuditPackage {
  summaryId: string
  form: { main: MainFields; expenses: ExpenseRow[] }       // 归一化后，字段名用标准名
  corporateTravel: { flights: Trip[]; trains: Trip[]; hotels: Trip[]; rideHailing: Trip[] }
  timeline: TripEvent[]                                     // 合并统付+明细后的行程时间线
  attachments: { field: string; rule: string; parsed: unknown; degraded?: string }[]
  activeItems: string[]                                     // 8 项中命中的
  fixed: Verdict[]                                          // invoice_check / cross_trip_check
  rules: { itemId: string; name: string; text: string }[]   // 规则文本（来自 YAML）
  policyBasis: { category: string; spaceId: string; documentId: string; section?: string; text: string }[]
  unmappedCategories: string[]                              // 未收录科目（D5 的产物）
  facts: {                                                 // 事实层，判定层直接引用
    tripDays: number; declaredDays?: number; gapDays: string[]
    allowanceExpected?: number; allowanceDeclared?: number; deviation?: number
  }
}

// Verdict：判定层产出，工具校验
interface Verdict {
  itemId: string
  decision: 'pass' | 'reject' | 'manual'
  opinion: string          // 审批意见（一句话结论）
  reason: string           // 具体原因（引用事实与条款）
  ruleRef?: string         // 规则编号，如 allowance_time#2
  policyRef?: string       // 制度切片，如 finance-travel#住宿标准
  evidence: string[]       // 引用到的事实键，如 ['facts.gapDays', 'corporateTravel.trains[1]']
}
```

### 4.4 模型调用预算

| 节点 | 调用 | 典型 token | 备注 |
|---|---|---|---|
| prepare | 1 次（含 1 次工具往返） | 入 ~1.5k，出 ~50 | 模型只做转发 |
| judge | 1 次 | 入 ~12k（表单+附件+规则+制度），出 ~1.5k | 主体成本 |
| deliver | 1 次（含工具往返） | 入 ~5k，出 ~1k | 组装措辞 |
| 修正回合（可选） | +0～2 次 | 小 | 只在 `oa_audit_record` 校验失败时 |

对照 legacy：1 次文本调用（入 ~10k）+ N 次视觉。**文本侧多 2 次，视觉侧持平**；换来的是可回放、可治理、制度可检索。

---

## 5 规则与知识分层

### 5.1 规则资产（新增）

`agentops/audit/travel/items/<item_id>.yaml`：

```yaml
item_id: allowance_time
name: 差旅补助天数审核
activate_when: "subtable_has('personal_expenses','费用类型-凭证','差旅补助') or (field_not_empty('差助标准-差旅补助') and field_not_empty('出差天数-差旅补助') and field_not_empty('补助合计-差旅补助'))"
data_sources: [main_table, personal_expenses, corporate_travel]
fixed: false
rules:
  - { id: allowance_time#1, text: "出差天数 = 行程结束日期 − 行程开始日期 + 1 …" }
  - { id: allowance_time#2, text: "半天处理：出发晚于 12 点 / 返程早于 12 点按半天 …" }
  - { id: allowance_time#3, text: "跨月按月拆分 …" }
outputs: [decision, opinion, reason]
```

`activate_when` **保留 legacy 的原义**，包括 `field_not_empty` 把 `0/False/[]` 视为有值这条反直觉语义——迁移不改语义，只改承载。

### 5.2 制度知识（KB）

- 空间 `finance`（财务制度）承载**制度全文**，不是规则摘要。
- 新增 `agentops/audit/travel/category-map.yaml`：`费用类型 → finance/文档#章节`。
- 未收录科目处理路径：

```
费用类型出现在表单，但没有对应规则项
  ├─ category-map 命中 → 取该章节作为 policyRef，判定层按制度判 pass/reject
  └─ 未命中 → KB 全文检索 top-3 → 有切片：作为 policyRef，判定 pass/reject
                                 └─ 无切片：decision=manual，reason="无制度依据"
```

判定层不允许在「无 ruleRef 且无 policyRef」时下 pass/reject。

### 5.3 附件识别规则（不迁）

`extraction_rules/*.md` 与 `attachment_rules.yaml` 留在适配层：它们是视觉模型的提示词，和被识别的文件、模型版本强耦合。DSH 侧只在 `AuditPackage.attachments[].rule` 里记录用了哪条规则，便于追溯。

---

## 6 DSH 侧缺口与补齐

| # | 缺口 | 补齐方式 | 工作量 |
|---|---|---|---|
| 1 | OA 域无任何工具（`tool-map.yaml` 里全是 `mapped: null`） | 新包 `@agentops/dsh-oa`：`oa_audit_prepare` / `oa_audit_record` / `oa_audit_submit` | 中 |
| 2 | 工作流无法被外部 HTTP 触发 | 在 `@agentops/dsh-oa` 注册 `POST /api/agentops/audit/run` 与 `GET /api/agentops/audit/{id}` | 小 |
| 3 | 没有「按单据装配素材」的服务 | `prepare` 服务：归一化 + 激活 + 确定性 + 制度检索（可复用 `dag` 的 `defer` 模式） | 中 |
| 4 | 审计结果无法回写 OA | `submit` 服务：意见组装 + PDF + 3 字段回调 + 幂等锁 | 中 |
| 5 | **三条 OA MySQL 查询在 DSH 无对应能力** | 优先留在适配层（`oa_db` 已跑通）；若要内置，需在 `@agentops/dsh-db` 增加 OA 数据源或改由适配层预取 | 大 |
| 6 | 规则资产无编译入口 | `agentops/scripts/gen-travel-audit-workflow.ts`：YAML → 工作流 `role_prompt` + 校验 | 小 |
| 7 | KB 缺真实制度文档 | 财务提供，落 `packages/agentops/knowledge-base/财务制度/`，`sync-knowledge.ts --write` | 小 |
| 8 | Agent preset 无此 Agent | `agentops/agents/travel_audit.yaml` + `gen-agent-presets.ts --write` | 小 |
| 9 | 附件规则覆盖缺口（20+ 声明 / 15 实现） | 迁移前补齐 8 个 `extraction_rules/*.md`，或把缺失规则改成显式 `manual` 而非 `error` | 小 |

---

## 7 迁移步骤

| 阶段 | 产出 | 验收 |
|---|---|---|
| **M0 固化口径** | 8 份规则 YAML + `category-map.yaml`；从 legacy `config.yaml` 逐字搬运 | 规则文本 diff 为零；激活条件用 20 张历史单据回放，激活集合一致 |
| **M1 契约先行** | `AuditPackage` / `Verdict` / `AuditResult` 的 TS 类型与 JSON Schema；mock 实现 | schema 单测；`oa_audit_record` 拒绝非法 verdict 的用例 |
| **M2 判定层（影子模式）** | `travel-audit` 工作流 + `travel_audit` agent；适配层把 `AuditPackage` POST 到 DSH，只收结果不回写 | 同一批历史单据，legacy 与 DSH 结论对照表；差异逐条分类（口径差异 / 模型差异 / bug） |
| **M3 人工入口** | Manager 可派发；GUI 里能看到运行拓扑与每项依据 | 演示一次端到端（含 present_content 报告） |
| **M4 灰度回写** | `dry_run=false` 对某类单据开启回写；幂等锁 + 失败告警 | 回写成功率 100%，重复回调 0 次；异常单全部进人工队列 |
| **M5 收口** | 关掉 legacy Step5-8（保留 Step1-4/9 作适配层） | legacy 只剩取数/识别/回调；DSH 成为唯一判定入口 |

每阶段都可独立回滚：M2 影子模式无副作用；M4 用 `dry_run` 开关切换。

---

## 8 验收与回归

**核心指标**

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 判定一致率（与 legacy 同单据） | ≥ 95% | 回放集 200 张 |
| 差异可解释率 | 100% | 每条差异必须归类并给证据 |
| `manual` 率 | ≤ legacy + 3pp | 逐单统计 |
| 单均文本 token | ≤ legacy × 1.3 | 运行记录 |
| 缺项/解析失败 | 0（必须显式报错或修正） | 工具校验日志 |
| 回调成功率 | 100% | 适配层 |

**必须有的对照用例**

1. 补助 0 元 / 空数组字段的单据（验证 `field_not_empty` 语义）
2. 跨月出差 + 中间日断档 + 工作所在地字段齐全（最复杂规则）
3. 主表无出发地、只能靠酒店城市衔接推断（`trip_closure` 兜底分支）
4. 附件超 30 页 / 识别超时（降级路径）
5. 制度未收录科目（验证 `policyRef` 与 `manual` 分流）
6. 同一 summaryId 重复提交（幂等）

---

## 9 风险与未决

| 风险 | 影响 | 处置 |
|---|---|---|
| DSH 侧无多模态模型 | 票据识别无法内置 | 保留 doc_parser 服务（M2 既定）；若内置需接 vision provider + PDF 渲染 |
| 无 PDF 生成能力 | 回调 `approvalFile` 缺失，OA 端可能拒收 | 保留 `pdf_reporter.py`；DSH 侧只出结构化报告 |
| 结论枚举映射错 | OA 侧状态错乱 | `pass/reject/manual ↔ agree/disagree/manual` 写死在一处并有契约测试 |
| 隐私（酒店水单姓名/手机号） | 合规 | 识别结果脱敏后入 prompt；附件不落 DSH 盘；留存期与 legacy 一致 |
| 上下文超限 | 大单据判定质量下降 | `prepare` 计算 token 预算，超限时把「附件识别摘要」压缩成事实而非原文 |
| legacy 规则文本自带的历史包袱 | 规则互相引用编号（如 trip_closure 的 11/7/8/9 条顺序错乱） | M0 搬运时**不改内容**，另开一条 issue 做规则整理，避免和迁移风险叠加 |

**需要你拍板的 6 个问题**

1. 触发方式：OA 主动调 DSH，还是 DSH 轮询待办，还是先只做人工发起？
2. 视觉识别：确认沿用现有 doc_parser 服务（推荐），还是要在 DSH 内置？
3. PDF 报告：保留 `pdf_reporter.py`，还是接受「DSH 出 Markdown + 适配层转 PDF」？
4. `invoice_check` / `cross_trip_check` 是否同意继续走确定性工具（推荐），不接受则需接受一致率下降。
5. 灰度策略：M4 先对哪类单据开回写（金额阈值？部门？），观察期多久？
6. 财务制度文档：谁提供、以什么频率更新、是否需要版本留痕？

---

## 附录 A：8 个审核项的迁移落点

| 项 | 迁移后位置 | 判定者 |
|---|---|---|
| `invoice_check` | `@agentops/dsh-oa` 的 `prepare`（确定性） | 工具 |
| `cross_trip_check` | 同上（历史行程来自适配层查询） | 工具 || `hotel_check` | 规则 YAML + judge 节点 | LLM |
| `ride_hailing_check` | 规则 YAML + judge 节点 | LLM |
| `fuel_mileage` | 规则 YAML + judge 节点（里程去重规则保留原文） | LLM |
| `allowance_amount` | 规则 YAML + judge 节点 | LLM |
| `allowance_time` | 规则 YAML + judge 节点（中间日/工作所在地全文保留） | LLM |
| `trip_closure` | 规则 YAML + judge 节点（兜底推断全文保留） | LLM |
| `hotel_time`（孤儿） | 不迁移 | — |
