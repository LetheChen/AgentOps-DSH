---
description: "The workflow definition catalogue: list, read, validate, compile, and compare-and-swap save AgentOps workflow YAML."
kind: "package-reference"
---

# @agentops/dsh-workflow-catalog

English | [中文](README.zh.md)

## Summary

Workflow YAML stays the source of truth, and this service is the only writer. It lists definitions for the management page, validates before anything reaches disk, compiles through the shared compiler so the editor can preview what the runtime would evaluate, and saves with compare-and-swap on the file digest. `validateAndCompile()` parses one candidate once and returns the validation result with the preview compiled from that same definition, so the editor never validates one document while displaying another. Choosing it means a stale editor receives a conflict instead of silently overwriting a newer definition.

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

### When to use

Inject `ctx.workflowCatalog` from the workflow management routes or the editor:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@agentops/dsh-workflow-catalog'

declare const ctx: Context
declare const nextText: string

const listing = await ctx.workflowCatalog.list()
const { text, digest } = await ctx.workflowCatalog.readSource('log-patrol')
const compiled = await ctx.workflowCatalog.compile('log-patrol')
await ctx.workflowCatalog.save('log-patrol', nextText, digest) // CAS
```

`readSource()` returns the exact file text and SHA-256 digest without parsing it, so the editor can repair a temporarily invalid YAML document. A missing definition propagates `ENOENT`, which the management route maps to 404.

`validateAndCompile(text)` returns `{ ok: true, value, issues, compiled }` for valid text and only `{ ok: false, issues }` for invalid text. The successful artifact contains generated `source`, scheduling `layers`, and its `digest`. `compileDefinition(definition)` compiles an already validated definition; the editor routes use it after source-only edits instead of parsing the candidate text again.

`save()` takes the digest the edit was based on, or `null` to create. A changed file raises `CatalogConflictError` carrying both digests; an unparsable document raises `CatalogInvalidError` with every issue.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| [`src/catalog.ts`](src/catalog.ts) | Directory scan, source reads, parse-once validation and compilation, atomic CAS save |
| [`src/index.ts`](src/index.ts) | The `workflowCatalog` service |

Writes go through a staging file and `rename`, so a reader never observes a half-written definition. Invalid files stay visible in `list().issues` instead of disappearing from the page.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../contracts/`](../contracts/README.md) — the definition types and validation this service applies.
- [`../workflow-compiler/`](../workflow-compiler/README.md) — the compiler behind `compile()`.
- [`../dag/`](../dag/README.md) — the engine that runs a workflow.

-----

<a id="model-experience"></a>
## Model Experience

None, as this service reads and writes definition files without constructing model input.

#### KV Cache effect

None; no model request passes through this service.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No run history here** — runs belong to the DAG engine's store; this service owns definitions only, so the page reads two sources.
- **No revision history** — `save()` replaces the file; there is no draft, publish, or rollback yet.
- **One file per workflow** — a definition must live at `<workflowId>.yaml`, and a mismatched inner `workflow_id` is rejected.
- **Digest is text-level** — CAS compares raw bytes, so a whitespace-only reformat is a conflict even when the meaning is identical.
- **Compiled preview coverage is incomplete** — data ports are not yet injected into downstream prompts, retry/timeout is not yet written into the generated source, and the compiler is not yet connected to `workflow-ptc`. YAML remains authoritative, and previewing an artifact never writes back to the definition.
- **The boot smoke is a script, not a gate test** — under vite the Loader's dynamic import resolves a second copy of @deepseek-ai/cordis, so `boot.get('workflowCatalog')` is undefined even when the boot succeeded; `scripts/smoke-boot.mts` runs it through tsx instead.

The service is reached through Cordis' proxy, so `this` inside a method is the proxy: a private field throws `Cannot read private member`. State therefore lives in a public property the proxy forwards.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The compare-and-swap was deliberately deferred until this service existed: adding a `compiled_sha256` column without a writer is a speculative API. The digest here is the same one the compiler emits, so a later definition store can persist it without a second notion of identity.

</details>
