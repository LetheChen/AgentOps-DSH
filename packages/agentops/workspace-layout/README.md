---
description: "Canonical AgentOps workspace directories and containment checks for Agent and workflow artifacts under a selected Session cwd."
kind: "package-reference"
---

# @agentops/dsh-workspace-layout

English | [中文](README.zh.md)

## Summary

A Cordis service and plain resolver for placing AgentOps artifacts under a selected Session workspace. It checks the artifact path, business id, scope ids, and canonical `sessionCwd`, creates the Agent or workflow run directory, and rejects any resolved path outside that workspace. Callers receive canonical absolute `dir` and `file` paths. The resolver creates scope directories only; secure artifact writes and no-follow guarantees remain with the consumer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this service when Agent or workflow execution must derive a stable artifact location from a Session cwd. Callers should not join business ids or artifact templates themselves.

### When to choose it

Choose it for the canonical AgentOps artifact layout and its containment checks. It is not a general temporary-directory service and does not write artifact contents.

### Minimal configuration

```yaml
- name: '@agentops/dsh-workspace-layout'
```

The service has no configuration fields. `LayoutRequest` carries the artifact request; `LayoutPolicyRequest` additionally carries the baseline execution policy to narrow. Every deployment-varying choice therefore remains explicit at the call site.

### Resolve one artifact

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@agentops/dsh-workspace-layout'

declare const ctx: Context
declare const sessionCwd: string

const { dir, file } = await ctx.workspaceLayout.resolve({
  sessionCwd,
  businessId: 'acme',
  scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1', nodeId: 'build' },
  artifact: 'logs/build.txt',
})
```

| Scope | Created directory under the canonical `sessionCwd` |
|---|---|
| Agent | `<businessId>/agents/<agentId>` |
| Workflow run | `<businessId>/workflows/<workflowId>/<runId>` |
| Workflow node | `<businessId>/workflows/<workflowId>/<runId>/nodes/<nodeId>` |

`resolveScope()` creates only the canonical scope directory and returns `{ dir }`; `resolve()` adds the artifact `file`. `resolvePolicy()` sets the policy root to that directory and returns `{ cwd, policy }`, with `cwd === policy.workspaceRoot`. The returned policy retains the baseline mode and optional Session id, and omits deployment-wide extra writable roots. Persist the policy in the owning Session before publishing a child or workflow run.

Validation runs in this order:

1. The artifact must be a non-empty business-relative path with no drive, absolute prefix, `..` segment, or NUL.
2. The business id and every scope id must be one safe path component.
3. `sessionCwd` must be an existing absolute directory.
4. Its canonical `realpath` becomes the containment base returned in every path.
5. Existing ancestors and the created directory are checked against that base.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The resolver inspects the nearest existing ancestor with `lstat` and `realpath` before creating directories. A dangling symlink is rejected because its write target cannot be proved safe. After `mkdir`, it canonicalizes the directory again and checks both `dir` and `file` with `path.relative()`, so string-prefix collisions cannot satisfy containment.

| File | Responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | Layout request, result, error code, and scope field types |
| [`src/layout.ts`](src/layout.ts) | Validation, canonicalization, directory creation, containment checks, and policy narrowing |
| [`src/index.ts`](src/index.ts) | Cordis service registration and public exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent and workflow contracts](../contracts/README.md) — owns `isRelativeArtifactPath()` and the artifact templates accepted here.
- [AgentOps migration decision](../../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.md) — records the workspace-layout acceptance scope and sandbox follow-up.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package resolves and validates artifact paths without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The returned paths and containment checks are stable within the stated validation order; the filesystem can still change afterward.

- **TOCTOU remains possible** — consumers must use no-follow or secure-write semantics where available; a concurrent actor can replace parents between validation and a later write.
- **Post-check rejection cannot undo side effects** — if a parent is replaced between validation and `mkdir`, the resolver can reject the returned path but cannot roll back a directory created outside the workspace.
- **Only scope directories are created** — artifact files, nested artifact parents, and their write guarantees belong to the consumer.
- **The workspace root must already exist** — `sessionCwd` is validated as an existing absolute directory and is never created.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
