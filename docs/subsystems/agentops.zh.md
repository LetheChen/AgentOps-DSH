# AgentOps 工作区布局与工作流目录

[English](agentops.md) | 中文

AgentOps 将 Agent 与工作流产物放在调用 Session 选定的目录内。[`@agentops/dsh-workspace-layout`](../../packages/agentops/workspace-layout/README.zh.md) 拥有该布局并暴露 `ctx.workspaceLayout`。它不同于 [Workspace 注册表](workspace.zh.md)：`sessionCwd` 是一次解析使用的现有根目录，而 Workspace 注册表拥有用户可见的工作区记录。该子系统不增加模型输入或 Session 事件。

同一子系统还拥有工作流定义目录：[`@agentops/dsh-workflow-catalog`](../../packages/agentops/workflow-catalog/README.zh.md) 通过 `ctx.workflowCatalog` 暴露 YAML 定义文件。

源码：[`packages/agentops/workspace-layout/src/index.ts`](../../packages/agentops/workspace-layout/src/index.ts)

## 布局路径

返回的每个路径都会在现有绝对 `sessionCwd` 下规范化。

| 作用域 | `sessionCwd` 下的目录 |
|---|---|
| Agent | `<businessId>/agents/<agentId>` |
| 工作流运行 | `<businessId>/workflows/<workflowId>/<runId>` |
| 工作流节点 | `<businessId>/workflows/<workflowId>/<runId>/nodes/<nodeId>` |

`resolveScope()` 校验请求，只创建作用域目录，并返回 `{ dir }`。`resolve()` 执行相同的作用域解析，校验调用方提供的业务相对 `artifact`，并返回 `{ dir, file }`。它既不创建产物文件，也不创建 `dir` 下的产物父目录。

不带 `nodeId` 的工作流作用域解析到运行目录。带 `nodeId` 的工作流作用域追加上表所示的节点目录。

## 校验与包含性

解析按以下顺序检查输入和文件系统事实：

1. 对 `resolve()` 而言，产物必须是业务相对的非空路径，不能含盘符、绝对前缀、`..` 段或 NUL。
2. business id 与每个作用域 id 必须各自是一个安全的路径组件。
3. `sessionCwd` 必须是现有的绝对目录。
4. 它的规范 `realpath` 成为每个返回路径所使用的包含基准。
5. 解析最近现有祖先并针对该基准检查，然后创建目录，并再次检查其规范路径。

最近现有祖先检查使用 `lstat` 与 `realpath`。悬空符号链接会被拒绝，因为无法证明其写入目标仍在工作区内。包含性检查使用 `path.relative()`，因此字符串前缀碰撞无法通过。最终的规范化检查覆盖已创建目录；`resolve()` 还会针对该目录检查拼接后的产物路径。

这些检查之后文件系统仍可能变化。并发操作者可以在校验与后续写入之间替换父目录，因此消费方在可用时必须采用 no-follow 或安全写入语义。如果父目录在 `mkdir` 之前被替换，最终检查可以拒绝结果，但无法回滚已在工作区外创建的目录。

## 执行策略

`resolvePolicy()` 创建并返回作用域目录，然后将显式执行策略收窄到该目录。返回的 `cwd` 是规范作用域目录，同时也是 `policy.workspaceRoot`。

收窄后的策略保留基线 `mode` 与可选 Session id。它移除部署级 `additionalWritableRoots`，因此子 Agent 或工作流运行不能借 AgentOps 作用域重新获得该作用域之外的写入权限。调用方在发布依赖工作前，将返回的策略持久化到拥有它的 Session。

## 模型上下文

该服务只解析路径与策略。它不构造面向模型的内容、不发送模型请求，也不记录 Session 事件。

## 工作流目录

该目录是唯一扫描、校验、编译并写入工作流定义的组件；YAML 文件仍是事实来源。

`list()` 返回每个已存储的定义，以及每个无法读取的文件对应的一组问题。`readSource()` 返回单个文件的原始文本与摘要，即使 YAML 非法也照常返回；`read()` 在同样的文本之外还返回解析后的定义。`validate()` 校验候选 YAML 但不落盘；`validateAndCompile()` 只解析一次文本，并返回解析后的定义与生成的预览，因此预览始终描述产生它的那份定义。

每次写入都是针对文件摘要的 compare-and-swap。`create()` 拒绝替换已存在的文件，`save()` 拒绝调用方从未见过的摘要，因此过期编辑器无法静默覆盖更新的定义。被拒绝的候选抛出 `CatalogInvalidError`，过期写入抛出 `CatalogConflictError`，目标已存在抛出 `CatalogCreateConflictError`。

源码：[`packages/agentops/workflow-catalog/src/index.ts`](../../packages/agentops/workflow-catalog/src/index.ts)

## 任务域

`@agentops/dsh-task` 负责任务持久化与任务接口。业务数据集中在一个库（`$DSH_HOME/agentops/agentops.db`，`SCHEMA_VERSION = 1`），包含 21 张表、收件箱与 Agent 档案目录；`security.db`、`credentials.db`、`knowledge.db` 与 DSH Session 存储保持独立。

`TaskService` 是唯一写入口：生命周期转移、`if_version` 乐观锁、认领、验收门禁、报告审批与导出历史都经过它。库缺失或为空时按目标版本初始化；其他结构一律显式报错，必须用 `pnpm migrate:task --db <path>` 迁移。

插件把同一个传输无关的 router 挂两次：Connection 共享 `/api` 通道上的拦截器，以及浏览器面板调用的精确路由 `POST /api/agentops/task-rpc`。两者都走 `TaskHttpApi`，且只允许 owner peer。`AGENTOPS_TASK_DB` 覆盖库路径，`exportRootDir` 指定 Markdown 报告文档位置。

模型工具在 `@agentops/dsh-task/tools-v1`，按 Agent preset 挂载。收件箱（`ideas`）把通道、来源系统与业务类型分开；`task_inbox` 是唯一允许分诊的 preset，bot 与 agent 通道的记录停在 `captured`，直到用户确认。

生命周期边来自 `src/lifecycle/p0.ts`（9 条）与 `src/status.ts`（V1 52 条）。`contracts/task-contracts.v1.json` 是生成快照，由 `pnpm contracts:check` 与源码比对。
## 类型

```ts type-equiv
/** Stable failure categories returned by workspace layout resolution. */
type LayoutErrorCode =
  | 'ARTIFACT_PATH_REJECTED'
  | 'BUSINESS_ID_REJECTED'
  | 'SCOPE_ID_REJECTED'
  | 'SESSION_CWD_REJECTED'
  | 'ESCAPES_WORKSPACE'
```

```ts type-equiv
/** Path components that identify an AgentOps scope. */
type LayoutScopeField = 'agentId' | 'workflowId' | 'runId' | 'nodeId'
```

```ts type-equiv
/** One artifact request within a selected workspace. */
interface LayoutRequest {
  /** Session workspace selected before the conversation starts. */
  readonly sessionCwd: string
  readonly businessId: string
  readonly scope:
    | { readonly kind: 'agent'; readonly agentId: string }
    | {
        readonly kind: 'workflow'
        readonly workflowId: string
        readonly runId: string
        readonly nodeId?: string
      }
  /** A file name or restricted relative path chosen by the caller. */
  readonly artifact: string
}
```

```ts type-equiv
/** A selected workspace and AgentOps scope without an artifact. */
type LayoutScopeRequest = Omit<LayoutRequest, 'artifact'>
```

```ts type-equiv
/** A created AgentOps scope directory. */
interface LayoutScope {
  /** Canonical absolute directory, created by the resolver. */
  readonly dir: string
}
```

```ts type-equiv
/** A created target directory and its artifact path. */
interface Layout {
  /** Canonical absolute directory, created by the resolver. */
  readonly dir: string
  /** Absolute path formed from the canonical directory and artifact. */
  readonly file: string
}
```

```ts type-equiv
/** One explicit execution policy derived from a workspace baseline. */
interface LayoutPolicyRequest {
  readonly scopeRequest: LayoutScopeRequest
  readonly baselinePolicy: SandboxExecutionPolicy
}
```

```ts type-equiv
/** A scope directory and the explicit execution policy narrowed to it. */
interface LayoutPolicy {
  /** Canonical scope directory; also the policy workspace root. */
  readonly cwd: string
  /** Explicit policy without deployment-wide extra writable roots. */
  readonly policy: SandboxExecutionPolicy
}
```

```ts type-equiv
/** One listed workflow, cheap enough to render in a list. */
interface CatalogEntry {
  readonly workflowId: string
  readonly version: number
  readonly businessId?: string
  readonly nodeCount: number
  /** SHA-256 of the file bytes; the token `save()` compares against. */
  readonly digest: string
}
```

```ts type-equiv
/** A workflow that failed to parse, kept visible instead of dropped. */
interface CatalogIssue {
  readonly file: string
  readonly issues: readonly ValidationIssue[]
}
```

```ts type-equiv
/** Listing result: valid entries plus every file that could not be read. */
interface CatalogListing {
  readonly entries: readonly CatalogEntry[]
  readonly issues: readonly CatalogIssue[]
}
```

```ts type-equiv
/** Exact source text and digest for a workflow file, without parsing it. */
interface WorkflowSource {
  readonly text: string
  readonly digest: string
}
```

```ts type-equiv
/** A validated workflow definition together with its generated preview. */
interface CompiledValidationResult {
  readonly ok: true
  readonly value: WorkflowDefinition
  readonly issues: readonly ValidationIssue[]
  readonly compiled: CompileResult
}
```

```ts type-equiv
/** A rejected workflow candidate with no generated preview. */
type CompiledValidationFailure = Extract<
  ValidationResult<WorkflowDefinition>,
  { readonly ok: false }
>
```

```ts type-equiv
/** Compilation inputs that are not part of the workflow definition. */
interface CompileOptions {
  /** Emitted as `provider` and `model` on every `agent()` call. */
  readonly model?: { readonly provider: string; readonly id: string }
}
```

```ts type-equiv
/** A compiler outcome: either an executable artifact or structured blockers. */
type CompileResult =
  | { readonly ok: true; readonly value: CompiledWorkflow }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }
```

```ts type-equiv
/** A whole workflow as the workflow management page sees it. */
interface WorkflowDefinition {
  readonly workflowId: string
  readonly name: string
  readonly description?: string
  readonly version: number
  /** Business-relative prefix used by the workspace layout. */
  readonly businessId?: string
  readonly inputs: readonly WorkflowRunInputDefinition[]
  readonly nodes: readonly WorkflowNode[]
  readonly widgets: readonly WorkflowWidgetDefinition[]
}
```

```ts type-equiv
/**
 * Result of parsing one definition.
 *
 * `value` is present only when `ok` is true. Successful results still carry
 * `issues` for non-fatal coercions, such as falling back to `T2` when `tier`
 * is missing or unknown.
 */
type ValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly ValidationIssue[] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilityruntime--capabilityruntimeservice"></a>

### `ctx.capabilityRuntime` — `CapabilityRuntimeService`

Root-owned runtime repository shared with preset-scoped tools.

```ts cordis-catalog
/**
 * Resolve one preset's configured binding state and enabled capability instances.
 * @param agentPreset - preset bound to the executing Agent.
 * @param capabilityId - capability family requested by the tool.
 * @returns configured state plus enabled runtime instances.
 */
resolveSet(agentPreset: string, capabilityId: string): CapabilityToolResolution

/**
 * Resolve one authorized runtime instance.
 * @param agentPreset - preset bound to the executing Agent.
 * @param capabilityId - capability family requested by the tool.
 * @param requestedInstanceId - optional explicit instance id or alias.
 * @returns the authorized instance and its opened credential.
 */
resolve(agentPreset: string, capabilityId: string, requestedInstanceId?: string): CapabilityRuntime
```

Source: [`packages/agentops/capability/src/runtime.ts`](../../packages/agentops/capability/src/runtime.ts)

<a id="ctxdeployment--deploymentruntime"></a>

### `ctx.deployment` — `DeploymentRuntime`

Root-owned deployment journal and capability store.

Source: [`packages/agentops/deployment/src/dsh.ts`](../../packages/agentops/deployment/src/dsh.ts)

<a id="ctxlogcollection--logcollectionruntime"></a>

### `ctx.logCollection` — `LogCollectionRuntime`

Root-owned log collection service consumed by Agent-scoped tools.

Source: [`packages/agentops/log-collection/src/dsh.ts`](../../packages/agentops/log-collection/src/dsh.ts)

<a id="ctxworkflowcatalog--workflowcatalogservice"></a>

### `ctx.workflowCatalog` — `WorkflowCatalogService`

Workflow definitions: list, read, validate, compile, and save.

```ts cordis-catalog
/**
 * List every stored definition.
 * @returns every valid definition plus one issue group per unreadable file.
 */
list(): Promise<CatalogListing>

/**
 * Read one definition's raw source.
 * @param workflowId - definition identity.
 * @returns exact file text and its SHA-256 digest, even when YAML is invalid.
 */
readSource(workflowId: string): Promise<WorkflowSource>

/**
 * Read one definition with its parsed form.
 * @param workflowId - definition identity.
 * @returns text, parsed definition, and digest.
 */
read(workflowId: string): Promise<{ text: string; definition: WorkflowDefinition; digest: string }>

/**
 * Compile one stored definition.
 * @param workflowId - definition identity.
 * @param options - model hint for the compiler.
 * @returns the compiled artifact or structured blockers.
 */
compile(workflowId: string, options: CompileOptions = {}): Promise<CompileResult>

/**
 * Validate candidate YAML without storing it.
 * @param text - candidate YAML.
 * @returns the parsed definition, or every issue found.
 */
validate(text: string): ValidationResult<WorkflowDefinition>

/**
 * Validate candidate YAML and compile it when it is valid.
 * @param text - candidate YAML.
 * @returns the parsed definition and generated preview, or only validation issues.
 */
validateAndCompile(text: string): CompiledValidationResult | CompiledValidationFailure

/**
 * Store a new definition, refusing to overwrite an existing one.
 * @param workflowId - definition identity.
 * @param text - complete YAML document.
 * @returns the digest written.
 */
create(workflowId: string, text: string): Promise<{ digest: string }>

/**
 * Compile an already parsed definition.
 * @param definition - validated workflow definition.
 * @param options - model hint for the compiler.
 * @returns the compiled artifact or structured blockers.
 */
compileDefinition(definition: WorkflowDefinition, options: CompileOptions = {}): CompileResult

/**
 * Overwrite a definition, refusing a stale edit.
 * @param workflowId - definition identity.
 * @param text - complete YAML document.
 * @param expectedDigest - digest the edit was based on, or null to create.
 * @returns the digest written.
 */
save(workflowId: string, text: string, expectedDigest: string | null): Promise<{ digest: string }>

/**
 * Delete one stored definition.
 * @param workflowId - definition identity.
 */
remove(workflowId: string): Promise<void>
```

Source: [`packages/agentops/workflow-catalog/src/index.ts`](../../packages/agentops/workflow-catalog/src/index.ts)

<a id="ctxworkspacelayout--workspacelayout"></a>

### `ctx.workspaceLayout` — `WorkspaceLayout`

Resolve AgentOps artifact paths within the Session workspace.

```ts cordis-catalog
/**
 * Create and return the canonical directory and file path for one artifact.
 * @param request - selected workspace, AgentOps scope, and relative artifact.
 * @returns canonical absolute directory and file paths.
 */
async resolve(request: LayoutRequest): Promise<Layout>

/**
 * Create and return the canonical directory for one AgentOps scope.
 * @param request - selected workspace, business id, and AgentOps scope.
 * @returns the canonical absolute scope directory.
 */
async resolveScope(request: LayoutScopeRequest): Promise<LayoutScope>

/**
 * Create a scope directory and narrow an execution policy to it.
 * @param request - scope inputs and the deployment policy to narrow.
 * @returns the canonical scope directory and explicit execution policy.
 */
async resolvePolicy(request: LayoutPolicyRequest): Promise<LayoutPolicy>
```

Source: [`packages/agentops/workspace-layout/src/index.ts`](../../packages/agentops/workspace-layout/src/index.ts)
<!-- END GENERATED cordis-surface -->
