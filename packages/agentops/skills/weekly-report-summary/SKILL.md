---
name: weekly-report-summary
description: 周报总结助手 — 把用户提供的周报原始内容（纯流水账文本或文档路径）直接提炼成结构化 Obsidian 周报并沉淀到 weekly-report 知识库，由当前 agent 自己动手执行，不走 workflow。**何时用**：用户说"做本周周报 / 生成周报 / 周报汇总 / 周报总结 / 周报归档 / 出本周小结 / weekly-report"且能提供周报原始内容时。**何时不用**：①查历史周报或统计趋势 → query_kb(weekly-report)；②只编辑/修补单条已有周报 → 直接改 Obsidian 文件；③用户明确要求"启动工作流执行" → trigger_workflow(workflow_id="weekly-report")。
domain: _shared
version: 2.1
depends_on: []
triggers:
  - 做本周周报
  - 生成周报
  - 周报汇总
  - 周报总结
  - 周报归档
  - 出本周小结
  - weekly-report
---

# 周报总结 Skill（直接执行版）

> 本 skill 是**执行手册**：完成"提炼 → 分类 → 分级 → 写作 → 自检 → 归档 → 沉淀"全流程。两种执行主体都适用——Manager 亲自执行，或 Manager 派发给 weekly-reporter 子 agent 执行（先看 §〇）。
> 权威规范在 `config/knowledge/weekly-report/template.md`（v2）——只引用不重抄，冲突时以它为准。
> 例外：用户明确说"启动工作流执行"时走 `trigger_workflow(workflow_id="weekly-report")`（入参契约见 `workflows/weekly-report.yaml`；注意其 `weekly_submissions` 当前是 `list[dict]` 契约，与纯文本输入不同）。

## 〇、执行模式（Manager 先选，再动手）

| 模式 | 何时用 | 做法 |
|---|---|---|
| **A. 派发执行（默认）** | 常规周报请求 | `trigger_workflow(run_mode="conversational", agent_id="weekly-reporter", initial_message=<打包：周报原文全文 + period_start/period_end + 用户特别要求>)` → **立即把 run_id 回给用户，不要当场调 collect_child_result**（collect 会阻塞本会话最长 600s，派发本身是异步的，不受影响）。用户稍后问结果 → `collect_child_result(run_id)` 收，或 `get_run_supervision` 查进度 |
| **B. 亲自执行** | 用户说"你自己做"或派发通道不可用 | Manager 按 §二 全流程自己干（工具已全部在白名单） |
| **C. workflow 流水线** | 用户明确说"启动工作流执行" | `trigger_workflow(workflow_id="weekly-report", run_mode="templated", inputs={...})`，契约见 workflows/weekly-report.yaml |

子 agent（weekly-reporter）执行的就是本手册：它收到 initial_message 后先 `read_skill` 加载本 skill，再按 §二 执行。

## 一、输入获取（第一步，缺了就反问）

| 用户给什么 | 你做什么 |
|---|---|
| 一长串纯流水账文本（无格式要求） | 直接作为原始素材，进 §二 |
| workspace 内相对路径（如 `inputs/周报草稿.md`） | 调 `read_file` 读入内容，再进 §二 |
| 什么都没给 | 反问："请把本周周报原文贴给我，或给我文档路径" |

输入是纯文本不是结构化数据——**不要**要求用户按 `{"raw_content": ...}` 格式提供，提炼整理是你的活。

## 二、执行步骤（按序，一步不跳）

1. **确定周期**：`period_start` = 本周一、`period_end` = 本周日（YYYY-MM-DD）。用户说"上周"要往回算；不确定就回问一句，别猜。
2. **提炼工作条目**：通读原始文本，提炼整理出**工作执行情况**清单——每条 = 一件事（做了什么 / 进展 / 结果），按 template.md 的条目结构组织。**不做人员归属切分**；`#src:N` 只用于素材溯源（用户整段贴文时通常只有 `#src:1`）。
3. **5 维 MECE 分类**：维度边界见 template.md §"5 维度分类边界"；模糊条目按**主要工作目的**归类，不按关键词。
4. **S/A/B/C 分级**：锚点见 template.md §"重要程度分级"与 `concepts/importance-grading.md`；C 级合并为一行 `> 另处理 N 项...`，禁止逐条平铺。
5. **生成 markdown**：按 template.md §"模板正文"的完整结构（Frontmatter + Top 3 + 五个维度 + 下周计划 + 风险与阻塞 + 跨周闭环）；提炼铁律见 §"agent 提炼规则（铁律 v2）"——去 AI 味 / 量化优先 / 保留专有名词 / 不编造 / 每条挂 `#src:N`。
6. **归档前自检**：frontmatter 完整 / 文件名日期与 period 一致 / 5 维度齐全 / SABC 分布与正文条目数一致 / 无"作者"行。失败项附加到"风险与阻塞"并标 ⚠️ 校验未通过——**不静默吞掉，也不阻断归档**。
7. **项目内归档 + 知识沉淀 + 可选 Vault 导出**：
   - `write_file`：把完整 markdown 写到当前 workspace 的相对路径 `reports/weekly-report.md`。这是必达步骤，不接受项目外绝对路径。
   - `ingest_source`：domain=weekly-report，`source_content` 传完整 markdown；不得传 `source_path` 或任何文件路径参数。
   - `obsidian_vault.write_file`：仅当 Vault 显式启用时可选导出；路径为 Vault 内相对路径 `Weekly/工作周报_<period_start>_<MM-DD>.md`。返回 `vault_disabled` 时记录 `vault_status=disabled` 并继续，不阻断项目内归档。
8. **汇报**：给用户 archive_path + S/A/B/C 分布 + Top 3 摘要，不要只回"已生成"。

## 三、反模式（做错就返工）

1. ❌ 派发模式下派发后当场调 `collect_child_result` 干等——阻塞本会话最长 600s；正确做法是立即返回 run_id，用户要结果时再收
2. ❌ 要求用户按 JSON 结构给输入
3. ❌ 编造用户没提的工作项或数字
4. ❌ frontmatter 写 `author` 或正文出现"作者：XXX"
5. ❌ C 级条目逐条平铺
6. ❌ 已有同期文件时整体覆盖
7. ❌ 没自检就归档 / 自检失败静默归档

## 四、边界

| 用户问法 | 走法 |
|---|---|
| "查 7 月第几周周报" / "去年 W31 讲了啥" | `query_kb(weekly-report)` |
| "改一下上周周报第 3 段措辞" | 直接编辑 Obsidian 已归档文件，不要重跑本 skill |
| "这周还缺谁没交周报" | `oa_affair_query(box="sent", date_from=period_start, date_to=period_end)` |
| 明确说"启动工作流执行" | `trigger_workflow(workflow_id="weekly-report")`，契约见 workflows/weekly-report.yaml |

## 五、参考

- 模板 Spec（权威源）：`config/knowledge/weekly-report/template.md`
- SABC 量化锚点：`config/knowledge/weekly-report/concepts/importance-grading.md`
- 措辞规则：`config/knowledge/weekly-report/concepts/format-rules.md`
- 可选 Vault 导出：`config/tools/obsidian_vault.yaml`（仅 OBSIDIAN_VAULT_ROOT 显式启用时）
- KB 沉淀工具：`config/tools/ingest_source.yaml`（domain=weekly-report）
