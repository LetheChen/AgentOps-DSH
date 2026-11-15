# Agent Note: AgentOps 智能体、工作流与协作页面迁移

Status: proposed

[English](2026-10-29-agentops-agent-management-migration.md) | 中文

## 问题

AgentOps 拥有三个管理面——智能体管理、工作流管理、协作可视化——覆盖 20 份 Agent YAML 定义与 16 份工作流 YAML 定义。这三个面目前由 AgentOps 自己的 Web 应用提供，而 DSH 侧的移植起初是逐页照搬：面板读取旧配置目录，Agent 表单既不显示权限层级也不显示工具策略，面上没有任何写回定义的路径。

逐页照搬有四个站不住的缺陷：

- **没有统一的落点。** 每个 Agent、每个工作流节点各自决定目录，产物落在定义写着的地方，而不是对话前选定的工作区里。
- **四套依赖推导。** 旧编辑器按 `after ∪ outputs` 推边，摘按 `after`，协作图按 `outputs`，调度按 `after`。同一个工作流因此有四份拓扑。
- **第二套执行模型。** DSH 把工作流当作脚本求值，YAML DAG 在那边没有原生运行器。照搬旧 DAG 引擎会让一个产品面下并存两套运行时、两套运行状态、两套取消与重试语义。
- **字段静默丢失。** `tier` 在 YAML 里是权限闸门，页面上不显示，保存时被丢掉；一次保存就可能把 Agent 提权或降权，而没有人做过这个选择。

移植还必须保持插件集合的形态。只有当 profile、bundle 或 preset 都够不到所需行为时，才允许改动 DSH 内核。

## 方案

把三个面作为本仓库的 AgentOps 插件迁移：先统一契约，再统一落点，再统一工作流执行路径，最后做页面。插件够得到的地方，DSH 内核保持不变。

### 契约持有定义模型

[`@agentops/dsh-contracts`](../../../../packages/agentops/contracts/README.zh.md) 负责两种 YAML 方言的解析与序列化。YAML 文件仍是权威源；内存类型是每个读写方共同遵守的约定，每个字段都全量往返。

`tier` 属于这份约定，因为它决定工具可达性，而不是因为它要显示。`execution: 'skill' | 'workflow'` 说明一个 Agent 自带流程还是恰好拥有一个工作流。工作流归属只在 Agent 上声明，因此反向索引由 Agent 目录派生，每处不一致都被报告，而不是被随手抹平。

依赖只来自 `after`。`outputs` 只描述数据流，不参与调度，于是旧的四种推导收敛成一个函数。

### Agent 与工作流节点是两种设计

有独立职责与工具需求的对象是 preset：一个用户在智能体管理页维护的可见身份。工作流的步骤不是 preset。每个节点只描述一跳，继承所属 Agent 的工具，从零上下文启动，只通过声明的 JSON 端口交换数据，因此只为喂给下一步而存在的步骤永远不会变成目录条目。

把每个节点都做成 preset 会让目录塞满没人寻址的条目，并让节点的工具集脱开拥有该工作流的 Agent。归属只在 Agent 上声明，工作流文件从不点名 Agent。

### 统一落点

[`@agentops/dsh-workspace-layout`](../../../../packages/agentops/workspace-layout/README.zh.md) 在 Session 选定的工作区下解析每一条产物路径：

```text
<sessionCwd>/<business>/agents/<agentId>/<artifact>
<sessionCwd>/<business>/workflows/<workflowId>/<runId>/<artifact>
<sessionCwd>/<business>/workflows/<workflowId>/<runId>/nodes/<nodeId>/<artifact>
```

调用方只能决定业务相对的产物名。服务规范化工作区，拒绝绝对前缀、盘符、`..` 段与 NUL，检查最近的既有祖先，创建 scope 目录，再复核规范化结果，使符号链接无法把落点移出工作区。`resolvePolicy()` 把部署级执行策略收窄到该 scope 并去掉部署级额外可写根，工作流节点因此无法借 AgentOps 目录重新取得外部写权限。

### 统一工作流执行路径

[`@agentops/dsh-workflow-compiler`](../../../../packages/agentops/workflow-compiler/README.zh.md) 把已校验的定义转成工作流运行时求值的那份脚本。分层来自契约包的 `topoLayers()`，每层生成一个 `phase()`，含多个节点的一层生成一个 `parallel([...])` 屏障。`compileWorkflow` 返回 `{ source, layers, digest }`；编辑器预览的就是这段源码，所以被预览的程序与被执行的程序是同一个字符串。环在编译期失败，运行尚不存在，而不是跑到一半才失败。

选 `parallel` 是因为它是屏障。`pipeline` 没有阶段屏障，会破坏层序。

`runNode()` 补上 DSH 没有的节点级重试与超时。续跑被有意排除：运行没有 journal，重启的工作流从头开始，而不是假装接着跑。

[`@agentops/dsh-workflow-catalog`](../../../../packages/agentops/workflow-catalog/README.zh.md) 是唯一扫描、校验、编译与写入定义的组件。每次写入都是针对文件摘要的比较并交换，`create()` 拒绝覆盖既有文件，`validateAndCompile()` 只解析一次，因此编译预览描述的永远是被返回的那份定义。

### 页面经目录写回

智能体管理通过 agent 路由编辑 Agent YAML：列表、详情、新建、更新、删除。保存先按契约校验，非法即整份拒绝，因此部分写入不可能丢掉 `tier` 或 `outputFiles`。

权限页签维护 Agent 上的允许与禁止工具名。禁止名通过生成进 preset 的 [`agentops-tool-policy`](../../../../packages/agentops/host/src/tool-policy.ts) guard 行到达运行时，既不是 `restrict` 规则，也不是对 `plugins` 的设置表单编辑。页面根本不编辑 preset 插件行：[`agentops/scripts/gen-agent-presets.ts`](../../../../agentops/scripts/gen-agent-presets.ts) 从 Agent YAML 生成它们，重新生成的 preset 只对新会话生效。

工作流管理用实时校验编辑 YAML，用 DAG 画布经目录的摘要比较并交换回写，预览编译脚本，渲染声明的运行输入，并列出运行历史。协作可视化只从持久化运行事件投影泳道、分层开发者 DAG 与时间线；节点重跑接收 `{ runId, workflowId, nodeId, onlyNode, inputs }`，使目标节点或经 `after` 可达的全部下游节点失效，并报告已入队这一判断，而不是它观察不到的完成。

### 交付顺序

1. 契约、落点与统一边推导。
2. 工作流编译、目录，以及节点重试与超时。
3. 工作流管理页。
4. 协作可视化与节点重跑。
5. 智能体管理页及其写回路径。
6. 打包、测试归属与剩余门禁。

第 1–5 批已建成；第 6 批是「风险」一节列出的未完成工作。

## 备选方案

**逐页移植，之后再适配。** 被取代的第一版方案走的就是这条路：它忽略既有的 `packages/agentops` 移植，规划了十个新 PR，端点表 17 行里错 13 行。否决理由：页面形状跟着旧后端走，而不是跟一份契约走。

**保留旧 DAG 引擎作为运行器。** 否决理由：它会与 DSH 工作流运行时并存，自带运行状态、取消与遥测，并绕开 DSH 的会话、沙箱与用量核算。

**用 `pipeline` 表达分层。** 否决理由：`pipeline` 没有阶段屏障，第 *n* 层的慢节点会与第 *n+1* 层重叠。

**给每个节点单独的工具白名单。** 本次迁移否决：`agent()` 接受闭集选项，工作流节点继承所属 Agent 的工具。做节点级白名单需要改工作流包，owner 已表示不做。

**从智能体管理页经 `settings` 编辑 preset 插件行。** 否决理由：`plugins` 不是 volatile 字段，`update()` 必然抛错。页面编辑 Agent 定义；preset 行由生成器产出。

**用 `tools.restrict()` 实现 `denied_tools`。** 否决理由：`restrict()` 只过滤继承来的工具，且点名本 scope 已注册的工具会抛错，从而打挂 preset、阻塞新会话。`guard()` 在调用方的 scope 内按调用拒绝。

**保留旧 `command` 节点。** 否决理由：它直接执行 shell 并求值代码，绕开 DSH 工具策略与沙箱约束。

**原样转发旧 HTTP 端点。** 否决理由：其变更、版本与权限语义未定义。带命名空间的服务取代路径，消费者显式迁移。

**把 AgentOps 迁移目录复制进 DSH。** 否决理由：AgentOps 拥有旧系统事实与审核证据，DSH 拥有当前契约、测试与部署；复制会让同一事实出现两个 owner。

## 验收标准

- 落点测试拒绝穿越、绝对路径、盘符、NUL、悬空符号链接与被替换的父目录，并证明解析后的产物仍在规范化工作区内；策略收窄会去掉部署级额外可写根。
- 编译器测试证明环在运行前失败，分层只跟 `after`，`outputs` 不影响拓扑，摘要稳定；编辑器预览文本等于被执行的源码。
- `runNode` 测试证明尝试次数、退避次序、超时，以及取消优先于待执行的重试。
- 目录测试证明新建与保存的比较并交换，过期摘要被拒绝，不可读文件带着问题留在列表里而不是消失。
- Agent 写入测试证明每个字段全量往返，含 `tier`、`execution`、`workflow` 与 `outputFiles`，且非法定义整份被拒。
- 被禁止的工具名只对挂了该 guard 行的 Agent 在调用时拒绝，未挂的 Agent 不受影响。
- 工作流页测试证明画布编辑经 YAML 往返，编译预览与已保存定义一致，运行历史在服务端筛选与分页。
- 协作测试证明三个视图都来自持久化运行事件、不含 mock 数据，重跑只使所选范围失效，运行或节点处于 `running` 时被拒绝，错误文案本地化，且入队结果不被报成完成。
- AgentOps 测试在 `pnpm run test` 下运行，并计入逐文件覆盖率门禁。
- 客户端可见文案经 locale 字典，受影响包的 Windows 与 Web 构建冒烟通过。

## 风险

**编译器成为第二真相。** 若预览与实际执行漂移，就会重现旧缺陷。两者出自同一次解析与同一个输出字符串，摘要即比对凭据。

**YAML 表达不了脚本的全部能力。** 编译器只支持契约的节点原语。不支持的构造必须以结构化问题编译失败；静默降级会把本次迁移要消除的行为差异重新引入。

**测试在仓库门禁之外。** `packages/agentops/*` 的用例是 `tests/*.test.ts`，由各包自己的 `node --test` 脚本运行，而 `pnpm run test` 与覆盖率门禁收集的是 `packages/*/*/src` 下的 `tests/**/*.spec.{ts,tsx}`。这些用例并入门禁之前，此处回归不会被 CI 拦下。

**重跑读取当前定义。** 运行记录不保存工作流版本，编辑或删除定义会让旧运行的重跑无法复现。

**没有运行级锁。** 两个 Session 可以同时通过「非 running」检查并竞争修改同一运行。崩溃还可能遗留 `running`，此后重跑持续返回 `run_running`，直到持久化状态被修复。

**入队不等于完成。** 重跑路由在创建 Session 并排队指令后即返回。节点执行与运行状态回写在一个 Agent 回合内完成，把 HTTP 200 当成完成的调用方会判断错。

**preset 变更不影响运行中的会话。** 重新生成的 preset 只作用于新会话，页面不得暗示相反；锁定到某 preset 的 Agent 在会话首轮之后继续沿用该 preset。

**打包行重复维护。** bundle 补丁行、deploy 补丁行、bootstrap 插件链接、包的 peer 与 dev 依赖，以及生成的 preset 各自维护；能把它们一并校验的唯一目标清单仍然待做（[bundle README](../../../../packages/agentops/bundle/README.zh.md)）。

**验证目前只在 Windows 上。** 文件系统约束、ACL 处理与路径大小写尚未在 Linux 上验证，而产品将运行在那里。
