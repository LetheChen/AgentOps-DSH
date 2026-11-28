---
description: "AgentOps Web GUI 面板：Agent、工作流、协作、运行历史、调度、Vault、安全、知识与任务视图。"
kind: "package-reference"
---

# @agentops/dsh-client

[English](README.md) | 中文

## 概述

Web GUI 里的每个 AgentOps 界面都是本包注册的一个面板。面板直接读取 `/api/agentops/*` 路由并渲染宿主响应；工作流面板还保存当前打开的工作流、YAML 草稿、校验状态、编译预览、Agent 节点库与当前画布选择。`agentopsWorkflows`、`agentopsRuns`、`agentopsCollaboration`、`agentopsSecurity`、`agentopsMenu` 与 `agentopsTasks` locale 命名空间覆盖英语、中文、日语、西班牙语、法语、德语、俄语和葡萄牙语。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

新增或修改 AgentOps 界面时使用；宿主侧在同级包里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/client/index.ts` | 槽位注册、locale 命名空间与由 `menu.ts` 驱动的侧栏条目 |
| `src/client/menu.ts` | 侧栏分组与条目：每个面板一行，标注其字典命名空间、键与图标 |
| `src/client/menu-locales.ts` | 八种已注册语言的分组与顶级面板文案 |
| `src/client/task-locales.ts` | 八种已注册语言的任务分组与任务面板文案 |
| `src/client/collaboration-target.ts` | 运行历史面板向协作面板移交运行标识的一次性交接槽 |
| `src/index.ts`、`src/config.ts` | 宿主注入并校验 `__DSH_AGENTOPS_CLIENT_CONFIG__`；协作轮询默认 3,000 ms，范围为 1–2,147,483,646 ms |
| `src/client/*-panel.tsx` | 每个界面一个模块 |
| `src/client/agent-catalogue-api.ts` | 画布节点库使用的 Agent 目录响应解析 |
| `src/client/collaboration-api.ts` | 持久化运行活动与已记录端点错误的严格解析 |
| `src/client/collaboration-feedback.tsx` | 生命周期长于发起面板的应用浮层重跑 Toast |
| `src/client/collaboration-polling.ts` | 针对单个活动运行、感知页面可见性且不重叠的轮询 |
| `src/client/collaboration-layout.ts` | 仅依据 `after` 依赖计算确定性调度层级 |
| `src/client/collaboration-locales.ts` | 八种已注册语言的协作面板字典 |
| `src/client/run-history-api.ts` | 运行历史分页请求、HTTP 错误状态与列表/详情严格响应解析 |
| `src/client/run-history-locales.ts` | 八种已注册语言的运行历史字典 |
| `src/client/security-api.ts` | 四个只读安全端点的严格解析与请求错误 |
| `src/client/security-locales.ts` | 八种已注册语言的安全页面字典 |
| `src/client/workflow-editor-api.ts` | 读取目录与源码、校验、仅源码编辑、CAS 保存、运行指令和工作流启动的浏览器 fetch 包装与严格响应解析 |
| `src/client/workflow-editor-logic.ts` | 源码选择、请求顺序与校验的纯函数 |
| `src/client/workflow-yaml-editor.tsx` | YAML 文本框、行号栏、问题列表与问题跳转 |
| `src/client/workflow-dag-canvas.tsx` | 可编辑 SVG DAG，支持问题节点高亮与节点/边选择 |
| `src/client/workflow-dag-layout.ts` | 确定性节点布局与边路由 |
| `src/client/workflow-run-form.tsx` | 宿主声明的运行输入、类型校验与显式工作流启动 |
| `src/client/locales.ts` | 八种已注册语言的工作流面板字典 |
| `src/panel.tsx` | 共享面板外壳 |

侧栏有四个分组和四个顶级面板。**智能体管理**包含协作可视化、工作流管理、Agent 管理与运行历史；**任务管理**包含任务看板与任务报告；**安全管理**包含用户管理、角色与权限、登录会话与 API Token；**系统设置**包含定时计划与凭证管理。知识库、监控中心、会话回放与生成式 UI 保持顶级。生成式 UI 面板渲染 A2UI 表面，包括安全 HTTP(S) 图片和 通过 `present_content` 的 `content_type: "image"` 发布、由宿主服务的内容寻址图片卡片。卡片可用鼠标直接拖动调整顺序，顺序会持久化；重发同一张卡片保持原位置，新卡片追加到末尾。`menu.ts` 是描述这套布局的唯一位置，并标注每条文案背后的字典命名空间与键，因此缺少文案或图标会变成编译错误。

运行历史与协作可视化描述的是同一批运行。运行历史面板通过一次性交接槽把所选运行交给协作面板，布局同时切换到协作面板，该面板在挂载时认领运行标识。

工作流编辑器在草稿变化 350 ms 后校验，并拒绝让旧响应覆盖较新的草稿。选择问题会把文本框移到对应的一基 YAML 行；环问题还会在画布上高亮环里的全部节点。保存使用比较后写入：409 会保留草稿、禁用保存，并要求显式重新加载磁盘源码后才能再次保存。

编译页展示生成的执行脚本、从 0 开始的调度层级与产物指纹。校验成功时，预览替换为由该草稿编译出的产物。草稿变化或校验失败时保留上次成功产物并标记为过期。请求顺序保证较旧的校验响应不会覆盖较新的预览。

工作流画布由 Agent 节点库、DAG 与节点/边检查器组成。节点和边可用鼠标或 Enter/Space 选择。调度边为实线；数据边为虚线并标注输出端口。每次结构编辑都通过宿主应用到当前 YAML 草稿，返回的候选文本在保存前不会写盘。编辑被拒绝时保留草稿、依赖图与选择，使源码和问题列表保持对应。

画布编辑直接使用编辑响应里的 `compiled` 产物，不额外请求预览。成功校验或编辑响应缺少 `source`、`layers`、`digest` 或字段格式错误时，浏览器响应解析器会拒绝该响应。

运行表单以宿主返回的运行提示为输入名称、类型、默认值与说明的权威来源。只有显式提交后才会创建会话。启动失败时保留已输入的值并显示宿主给出的原因，便于用户修正后重试。

运行历史通过 `GET /api/agentops/runs` 使用服务端状态筛选、offset 分页与匹配总数，再通过 `GET /api/agentops/run` 读取节点状态与输出。浏览器解析拒绝未知的运行或节点状态、负数或不安全计数以及非 JSON 输出值；HTTP 失败会保留状态码。刷新失败时保留当前行。加载更多按运行标识去重，请求编号阻止迟到的列表或详情响应覆盖较新的状态。搜索只覆盖已加载的行。

协作面板通过 `GET /api/agentops/runs` 读取运行历史，再通过 `GET /api/agentops/run-activity?id=<id>` 读取所选运行。它只在页面可见时轮询，使用宿主注入的 `collaborationPollIntervalMs`，并在刷新或轮询失败时保留当前活动。结构化端点错误使用本地化文案；`workflow_invalid` 还会展示返回的校验问题，但不渲染服务端消息。

安全管理包含四个相互独立的只读页面。每个页面只请求自己的端点：`GET /api/agentops/security/users`、`/roles`、`/sessions` 或 `/tokens`。用户页渲染随用户返回的角色标识。Token 页只渲染已保存的描述字段（`id`、`userId`、`name`、`prefix`、`createdAt` 与 `revokedAt`）；该端点不暴露明文或哈希。这些页面不提供新增、编辑、删除、签发或撤销控件。

依赖图默认打开，并与泳道图共用一个节点检查器。重跑会打开确认弹窗，默认选择**仅当前节点**；另一个选项还会重跑全部传递调度下游节点。请求复用活动响应中该运行的 `inputs`；提交期间，弹窗、关闭控件与范围选项均不可操作。成功后会关闭弹窗、通过 `shell.overlay` 发布本地化 Toast，再刷新活动。切换运行或卸载面板后，Toast 仍然存在。失败只渲染本地化错误码，绝不把服务端 `message`、`issues`、路径或 `sessionId` 复制到界面。

运行活动是泳道图、依赖图、时间线与甘特图的唯一数据源。调度层级与实线边只使用 `scheduleEdges`；虚线数据边只使用 `dataEdges`，且绝不改变拓扑。时间线与甘特图的时间只使用持久化时间戳与时长，不使用当前时钟。

依赖图画布最多接受 200 个节点；超过上限时显示明确提示而不绘图，泳道图仍列出全部活动节点。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../dag/`](../dag/README.zh.md) — 工作流编辑器路由
- [`../workflow-catalog/`](../workflow-catalog/README.zh.md) — 精确源码读取与 CAS 写入

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包渲染 AgentOps 界面，不构造模型输入。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **用浏览器 fetch 而非 Remote** — 面板直连 `fetch`，响应没有共享类型契约，也绕过了按方法鉴权。
- **画布编辑只覆盖结构** — 画布可增删节点及调度/数据边。将节点模板拖到画布只会选择该模板；仍需在节点库中填写配置并点击“添加节点”。画布不编辑所有节点字段，也不支持自由摆放节点。
- **UI 测试使用 jsdom** — 已覆盖渲染与交互，但没有真实浏览器或响应式布局断言。
- **运行历史只读** — 不提供回放、Token 或费用合计、人工介入事件、事件时间线或节点输入载荷。
- **安全页面只读** — 不提供变更界面或 HTTP 写接口。Token 签发通过 AgentOps tools preset 与部署挂载的受审计 `security_token_issue` Agent 工具完成，明文只显示一次。
- **协作读取当前 YAML** — 运行存储不保存 workflow revision 与 handoff 事件；活动反映当前定义，`handoffs` 始终为空。
- **节点重跑没有互斥** — 两个已入队 Session 都可能通过校验并修改同一次运行；当前没有运行级锁。
- **进程崩溃可能让重跑停留在运行中** — 当前没有可靠的原子转换到 `running`，因此在修复持久化状态前，后续重跑都会返回 `run_running`。
- **重跑受理不等于完成** — 成功响应只表示 Session 已创建且指令已入队，不表示节点或下游工作已经完成。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
