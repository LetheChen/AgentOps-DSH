# REVIEW：Manager 调度面「编排面收敛」vs「派发面收敛」（2026-11-03）

被审对象：[SPEC-manager-dispatch-2026-11-03.md](SPEC-manager-dispatch-2026-11-03.md)
执行层：native subagent（4 家并行，取证方法互不相同）
主持人：本会话（**同时是方案一作者** → 凡驳回指向方案一的质疑，均附亲手复验的一手证据，见第 3 节）

## 1. 审查元信息

| 代号 | 取证方法 | 执行层 | 真实模型 | 主要手段 | 独立性声明 |
|---|---|---|---|---|---|
| S1 | 静态核验 | native subagent | 继承会话路由 | 逐条核对 F1–F20、符号定义、引用一致性 | 独立；未读他人产物 |
| S2 | 实测执行 | native subagent | 继承会话路由 | 13 组探针（假 `subagents` 捕获 request、深度矩阵、run DB schema、覆盖率）+ 2 个既有套件 | 独立；脚本在 `%TEMP%\s2-review\` |
| S3 | 反向重建 | native subagent | 继承会话路由 | 先倒推两方案隐含前提，再逐条攻击 | 独立；未读他人产物 |
| S4 | 边界专项 | native subagent | 继承会话路由 | 递归 / 越权 / 取消 / 失败发现 / 配额 | 独立；未读他人产物 |

四家均声明未引用他人产物；S 系方法两两不同（静态 / 实测 / 反推 / 边界），非同一方法的重复采样。

## 2. 总体结论

**推荐「派发面收敛」（方案二）+ 三条硬约束，而不是「编排面收敛」（方案一）。**

结论强度：**可执行**（决策层）。决策不依赖任何未核验项；落地前有 4 个实现细节需实测，见第 6 节 `K_t`。

一句话：Manager 只持**一把分派工具**；「走 skill 还是走工作流」由 **agent 定义声明**，不由 Manager 的 prompt 也不由业务 Agent 临场判断决定；工作流执行发生在**业务 Agent 自己的轮次里**，因此 Manager 天然不被阻塞——这是方案二唯一无法被方案一复制的能力。

## 3. 二次复核表

| # | 指控 | 提出方 | 证据位置 | 独立性 | 等级 | 我的复验 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | 服务默认 `maxDepth=1` **不约束 DAG 派生路径**，深度实为无上限 | S1/S3/S4（三方独立） | `subagent/src/index.ts:196,244-250`；`dsh.ts:203-215` 无 `maxDepth`；`child-agent.ts:49-57` | 独立 ×3 | L4 | 亲读 `createSubagentExecutor` 的 `startActivation` 入参：仅 `prompt/parent/agentPreset/agentOptions/outputSchema` | **采纳**。方案二的递归是**设计必然**，非实现疏漏 |
| 2 | 顶层 `agent:` 字段被 `parseWorkflowYaml` 静默丢弃 | S4 | `dag/src/load.ts` `parseWorkflowYaml` 返回字面量 | 独立 | L4 | 亲读：返回对象只有 `id/name/description/inputs/nodes` | **采纳**。方案一的 `workflow.agent === agent_id` 校验**当前无数据源**，是纯新增，不是免费优势 |
| 3 | 「渐进式暴露只在子代理侧」不成立：N 条 description 全量进 Manager 工具 schema | S1/S2/S3（三方独立） | `preset-selection.ts:45-51,50,64-71`；`tool-subagent/src/index.ts:235-241` | 独立 ×3 | L4 | 自测：20 个 agent 的 description 合计 **1723 字符**（S2 计 2124，含模板前缀） | **采纳**。两侧都付费；该优势不唯一 |
| 4 | 工作流清单不进 Manager 是方案二的**真实**收益 | 主持人补测 | `agentops/workflows/*.yaml` | — | L4 | 自测：16 条工作流的 description + inputs 合计 **6496 字符**，是 agent 目录的 **3.8 倍**，且每条工作流线性增长 | **成立**。用户对「别把 workflow 塞进 Manager」的直觉有量化支撑 |
| 5 | 节点无 `agentRef` 时继承调用方**整份** preset | S1/S2/S3/S4（四方一致） | `child-agent.ts:142`；`dsh.ts:209` | 独立 ×4 | L4 | 亲读 `selectedPreset ?? composedPreset(parent.ctx)` | **采纳** |
| 6 | `inline_agent` 的 `allowed_tools/denied_tools` 被静默丢弃，且**不报错** | S1（升级版） | `load.ts:223` `asString(raw.type) ?? 'agent'`；`load.ts:237` 只读 `raw.agent`；`dag/src/validate.ts` 无 agentRef 检查 | 独立 | L4 | 亲验 `validate.ts` 无 `agentRef` 命中 | **采纳**。这是「节点不能独立设权限」最危险的破口：写了不生效还不告诉你 |
| 7 | `dag_run` 同步阻塞调用方整轮，且期间**零进度持久化** | S1/S2/S3（三方独立） | `dsh.ts:532,538`；`engine.ts` 不引用 run-store；`onNodeSettled` 未传 | 独立 ×3 | L4 | 亲验 `dsh.ts` 两处 `new DagEngine().run` 的 options 均无 `onNodeSettled` | **采纳**。气泡需求的**公共**阻塞 |
| 8 | run 记录无 `agent_id` / 子会话 id / actor | S1/S2/S4 | `run-store.ts:16-37`；S2 实测 `PRAGMA table_info` | 独立 ×3 | L4 | 采信 S2 的 DB 实测输出 | **采纳**。公共成本 |
| 9 | 20 个生成的 agent preset 里 **0 个**挂 `subagent` / `dag_*` | S2 实测 + 主持人 | 计数；`tool-map.yaml` 无 `subagent`/`dag_*`/`run_workflow` 键 | 独立 | L4 | 自数：`subagent=0`、`dag_run=0`、`dag_catalog=0`、`run_workflow=0`；20 个 preset 无命中（唯一命中是 manager persona 文字） | **采纳**。挂分派工具**不是**任何一方的独有成本 |
| 10 | `allowedAgentPresets` 是闭集无通配 → 新增 agent 两方案都要重生成 Manager | S1/S2/S3（三方独立） | `preset-selection.ts:25-31,40-42`；S2 T12 实测非法 id 抛错 | 独立 ×3 | L4 | 采信 | **采纳**。「方案二零改动」不成立，除非生成器派生 |
| 11 | 方案一「节点是 Manager 直接子会话」与「不阻塞」互斥 | S3 | `dsh.ts:530`（`parentOf=()=>exec.agent`）+ `dsh.ts:532`（await） | 独立 | L4 | 亲读 | **采纳**。这是方案一最致命的隐藏前提 |
| 12 | 方案二无法区分「工作流根本没启动」与「跑完了」 | S1/S2/S3 | `continuation-messages.ts:146,155-162` | 独立 ×3 | L3 | 采信 + A2 佐证（无 run 查询工具） | **采纳**，但可修（见第 5 节约束 3） |

## 4. 关键分歧与裁决

| 分歧 | 各方立场 | 裁决 | 依据 |
|---|---|---|---|
| 主方案选谁 | S1→方案二；S2→方案一（收敛为第三方案）；S3→方案一骨架+异步，否则方案二；S4→方案一 | **方案二 + 声明式分派** | 四方提的「第三方案」内容高度重合（Manager 只持一把分派工具 + 按 agent 声明分派 + workflow 钉定），实质等同于「方案二 + 声明」。S2/S3/S4 把标签贴在「方案一」上，但去掉标签后其机制描述与方案二的自决执行无差别。**这是措辞分歧，不是实质分歧** |
| 异步是否必须 | S1 认为方案一因阻塞判负；S2/S3 认为方案一必须异步才成立 | **方案二免去异步改造** | 方案二里 `subagent` 立即返回（`tool-subagent:330-332`），业务 Agent 在自己轮次里阻塞，Manager 不受影响。**异步运行时是方案一的成本，不是公共成本** |
| 递归风险归属 | S4 认为方案二结构性不可控 | **可修，且必须修，但对两方案同等** | `delegationDepthOf` 是公开导出（`subagent/src/index.ts:113`），`dag_run` 有 `exec.agent`（`dsh.ts:526`）→ 三行闸门。S4 的担忧成立，但把它算作方案一的优势不成立 |

## 5. 定论：推荐架构

```
Manager（只持分派 + 展示 + 控制）
   │  dispatch(agent_id, task)            ← 唯一执行入口，模型看不到 workflow
   ▼
业务 Agent preset（声明 execution: skill | workflow）
   ├─ skill 型  → 按 skill 手册 + 业务工具自己执行
   └─ workflow 型 → 调自带 dag_run（workflowId 由 preset 钉死，模型不可传）
                       │  节点 agentPreset = 本 Agent（固定，不可继承）
                       ▼
                    节点 actor（business_role）—— 继承本 Agent 权限，不能自设
```

三条硬约束（缺一不可）：

1. **执行方式是声明，不是判断**：agent 定义新增 `execution: skill | workflow` + `workflow: <id>`；生成器只给 workflow 型 agent 挂 `dag_run`，且把 workflowId 编译进工具配置，不接受模型入参。

**绑定方向（修订）**：`workflow ↔ agent` 的归属**只写在 agent 定义上**，工作流 YAML 不新增 `agent` 字段。「工作流属于哪个 Agent」由 agent 注册表反向派生（`workflow id → agent id`），并在加载时校验：同一 workflow id 只允许被一个 agent 声明；没有任何 agent 声明的工作流是校验错误而非静默孤儿。方案一曾要求工作流顶层写 `agent:`，那是在「工作流是入口」前提下才成立；在本设计中入口是 agent，再写一份就是双源，与「一处事实一个家」冲突。
2. **权限闸门在执行点**：`dag_run` 在 `delegationDepthOf(agent) > 0` 时直接拒绝（防自递归）；节点一律 `agentPreset = 声明它的 agent`，**禁止回落到 `composedPreset(parent)`**；节点出现 `agent` / `inline_agent` 时校验失败（含 `type` 缺省 → 不再静默降级为 agent）。
3. **可观测性先于气泡**：`run_nodes` 增 `session_id` / `actor`，`runs` 增 `agent_id`；接线 `onNodeSettled` 做实时进度；新增 `list_runs` / `get_run` 工具，让 Manager 能自查「工作流是否真启动」（同时消解第 3 节第 12 条）。

公共必修（两方案同等，不属于任何一方的成本）：`subagent` 挂载与生成器支持、`inline_agent` 权限落地、`handoff` → 端口 JSON 契约统一、KB space 回填、per-agent skill allowlist、Manager persona 的幽灵工具与空承诺清单清理。

## 6. 已登记项（K_t = 4，落地前必验，不改变决策）

| # | 待验 | 影响 |
|---|---|---|
| K1 | 长流程是否需要超出「业务 Agent 一轮」的异步（`packages/jobs` 复用性） | 决定是否额外建 run 服务层 |
| K2 | `ui-subagent` 是否能渲染孙级会话（Manager 视图下看到节点） | 决定气泡是否需要独立面板而非会话谱系 |
| K3 | 根会话的 `composedPreset(parent.ctx)` 实际返回 id | 决定闸门 2 的回落逻辑 |
| K4 | `workflow-run.ts` 用的 `agentPreset:'agentops'` 能否被运行时解析 | 决定运行页入口是否需要一起改 |

## 7. 轮次账本

| 轮次 | 投给谁 | 摘要 | R_t | E_t | C_t | S_t | K_t |
|---|---|---|---|---|---|---|---|
| R1 | S1–S4 并行独立 | 四份报告全部返回；无 RL 轮次（单轮充分） | 1（标签分歧） | 12 条指控 + 6 条主持人复验 + 2 条主持人量化 | 1（主持人修正方案一「校验免费」） | 否 | 4 |

**收敛判定**：`R_t = 1` 且该分歧为**措辞分歧**（各方机制描述一致，仅标签不同），主持人裁定后结案；`E_t > 0`、无僵局。达到「充分」停机条件。

## 8. 可复现命令

```powershell
# 主持人量化：agent 目录 vs 工作流目录的上下文体量
cd <dsh-repo>
node --import tsx -e "<读取 agents.generated.patch.yml 统计 description 字符数>"
node --import tsx -e "<读取 agentops/workflows/*.yaml 统计 description+inputs 字符数>"

# S2 探针（临时目录，可重建）
node --import tsx %TEMP%\s2-review\probe-depth.mjs
node --import tsx %TEMP%\s2-review\probe-dag.mjs
node --import tsx %TEMP%\s2-review\probe-preset.mjs
node --import tsx %TEMP%\s2-review\probe-runs.mjs
node %TEMP%\s2-review\probe-tools.mjs
```

## 9. 实施进展（2026-11-03）

按第 5 节的定论落地，五步全部完成并有测试覆盖：

| 步骤 | 落点 | 验证 |
|---|---|---|
| ① 契约 | `AgentDefinition.execution` / `workflow`；`buildWorkflowOwnership` 反向索引与三类问题（引用不存在、重复声明、无人声明）；`updateAgent` 拒绝「未声明 execution/workflow 就覆盖工作流型 Agent」的静默降级 | `contracts` 64 测试；`host` 6 测试 |
| ② 生成器 | `subagent`（19 个业务 Agent 白名单，按目录派生）+ `subagent-control` + 钉定的 `dag-tools`（`ownedWorkflowId` / `ownerAgentPreset` / `only: [dag_run, list_runs]`） | `gen-agent-presets --check` 通过 |
| ③ 运行时 | 节点强制 `agentPreset = ownerAgentPreset ?? agentRef`，缺失直接失败；`label` 用 `business_role`；`onNodeSettled` 实时落盘；run 行在首节点前写入；`runs.agent_id/session_id` + `run_nodes.actor`；新增 `list_runs` | `dag` 119 测试 |
| ④ Manager | 只持分派与控制工具（`subagent` / `send_message` / `interrupt_agent` / `present_content` / 只读），业务工具全部进 deny；人设改为纯调度 | 生成物核对：manager 行 = persona + instructions + host-tools + fs-tools + tool-skill + subagent-tool + subagent-control-tools + tool-policy |
| ⑤ 遗留 | 6 条工作流标 `legacy:`（2 条 inline_agent 冲突、1 条多 Agent、3 条引用不存在的 Agent）；`verify-migration` 把它们记为 `legacy-workflow` / `unowned-workflow` 而非硬失败 | `agentops` 29 测试；`verify-migration` 硬失败 0 |

落地过程中修正了本审查的一处判断：决策③「节点一律 `agentPreset = 声明它的 Agent`」在实现时同时保留了对 `agentRef` 的兜底，否则 `dag_rerun` 与未钉定的运行路径会直接不可用；两条路径都要求显式 preset，不再回落到 `composedPreset(parent)`。

仍未做（属第 6 节 `K_t`）：长流程的独立 run 服务层、`ui-subagent` 孙级会话渲染、运行页 `agentPreset: 'agentops'` 的入口收敛。
