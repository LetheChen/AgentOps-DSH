# AgentOps workspace layout and workflow catalogue

English | [中文](agentops.zh.md)

AgentOps places Agent and workflow artifacts inside the directory selected by the calling Session. [`@agentops/dsh-workspace-layout`](../../packages/agentops/workspace-layout/README.md) owns that layout and exposes `ctx.workspaceLayout`. It is distinct from the [Workspace registry](workspace.md): `sessionCwd` is the existing root for one resolution, while the Workspace registry owns user-visible workspace records. This subsystem adds no model input or Session event.

The same subsystem owns the workflow definition catalogue: [`@agentops/dsh-workflow-catalog`](../../packages/agentops/workflow-catalog/README.md) exposes `ctx.workflowCatalog` over the YAML definition files.

Source: [`packages/agentops/workspace-layout/src/index.ts`](../../packages/agentops/workspace-layout/src/index.ts)

## Layout paths

Every returned path is canonicalized under an existing absolute `sessionCwd`.

| Scope | Directory under `sessionCwd` |
|---|---|
| Agent | `<businessId>/agents/<agentId>` |
| Workflow run | `<businessId>/workflows/<workflowId>/<runId>` |
| Workflow node | `<businessId>/workflows/<workflowId>/<runId>/nodes/<nodeId>` |

`resolveScope()` validates the request, creates only the scope directory, and returns `{ dir }`. `resolve()` performs the same scope resolution, validates a caller-supplied business-relative `artifact`, and returns `{ dir, file }`. It creates neither the artifact file nor artifact parent directories below `dir`.

A workflow scope without `nodeId` resolves to the run directory. A workflow scope with `nodeId` appends the node directory shown above.

## Validation and containment

Resolution checks these inputs and filesystem facts in order:

1. The artifact, for `resolve()`, must be a non-empty business-relative path with no drive, absolute prefix, `..` segment, or NUL.
2. The business id and every scope id must each be one safe path component.
3. `sessionCwd` must be an existing absolute directory.
4. Its canonical `realpath` becomes the containment base returned in every path.
5. The nearest existing ancestors are resolved and checked against that base, the directory is created, and its canonical path is checked again.

The nearest-existing-ancestor check uses `lstat` and `realpath`. A dangling symlink is rejected because its write target cannot be proved to remain inside the workspace. Containment uses `path.relative()`, so a string-prefix collision cannot pass. A final canonical check covers the created directory; `resolve()` also checks the joined artifact path against that directory.

The filesystem can change after these checks. A concurrent actor can replace a parent between validation and a later write, so consumers must use no-follow or secure-write semantics where available. If a parent is replaced between validation and `mkdir`, a post-check can reject the result but cannot roll back a directory created outside the workspace.

## Execution policy

`resolvePolicy()` creates and returns the scope directory, then narrows an explicit execution policy to it. The returned `cwd` is the canonical scope directory and also `policy.workspaceRoot`.

The narrowed policy retains the baseline `mode` and optional Session id. It removes deployment-wide `additionalWritableRoots`, so a child or workflow run cannot use an AgentOps scope to reacquire writes outside that scope. Callers persist the returned policy in the owning Session before publishing dependent work.

## Model context

This service resolves paths and policies only. It constructs no model-facing content, sends no model request, and records no Session event.

## Workflow catalogue

The catalogue is the only component that scans, validates, compiles, and writes workflow definitions; the YAML files stay the source of truth.

`list()` returns every stored definition plus one issue group per file that could not be read. `readSource()` returns one file's exact text and digest even when the YAML is invalid, and `read()` returns the same text with its parsed definition. `validate()` checks candidate YAML without storing it, and `validateAndCompile()` parses the text once and returns the parsed definition together with the generated preview, so the preview always describes the definition that produced it.

Every write is compare-and-swap on the file digest. `create()` refuses to replace an existing file, and `save()` refuses a digest the caller never saw, so a stale editor cannot silently overwrite a newer definition. A rejected candidate raises `CatalogInvalidError`, a stale write raises `CatalogConflictError`, and an existing target raises `CatalogCreateConflictError`.

Source: [`packages/agentops/workflow-catalog/src/index.ts`](../../packages/agentops/workflow-catalog/src/index.ts)

## Task domain

`@agentops/dsh-task` owns task persistence and the task surface. One business database (`$DSH_HOME/agentops/agentops.db`, `SCHEMA_VERSION = 1`) holds the 21 task tables, including the inbox and the agent profile catalogue; `security.db`, `credentials.db`, `knowledge.db` and DSH session storage stay separate.

`TaskService` is the only writer: lifecycle transitions, optimistic `if_version`, claims, acceptance gates, report approval and export history all go through it. A missing or empty database is initialised at the target version; any other structure fails loudly and must be migrated with `pnpm migrate:task --db <path>`.

The plugin mounts a transport-agnostic router twice: as an interceptor on Connection's shared `/api` channel, and as the exact `POST /api/agentops/task-rpc` bridge the browser panels call. Both reach the same `TaskHttpApi`, and only owner peers are admitted. `AGENTOPS_TASK_DB` overrides the database path and `exportRootDir` moves the Markdown report documents.

Model tools live in `@agentops/dsh-task/tools-v1` and are mounted per Agent preset. The inbox (`ideas`) separates channel, source system and business type; `task_inbox` is the only preset allowed to triage, and bot or agent captures stop at `captured` until a user decides.

Lifecycle edges come from `src/lifecycle/p0.ts` (9 edges) and `src/status.ts` (52 edges for V1). `contracts/task-contracts.v1.json` is the generated snapshot that `pnpm contracts:check` compares against the source of truth.
## Types

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
