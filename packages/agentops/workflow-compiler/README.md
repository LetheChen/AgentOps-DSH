---
description: "Compiles an AgentOps workflow definition into the DSH workflow script the PTC runtime evaluates."
kind: "package-library"
---

# @agentops/dsh-workflow-compiler

English | [中文](README.zh.md)

## Summary

DSH runs a workflow as a JavaScript script, while AgentOps stores workflows as YAML. This package bridges the two: it takes a validated definition and emits the script the PTC runtime evaluates, grouping nodes by `after` into `phase()` calls and turning a multi-node layer into one `parallel([...])` barrier. Choosing it keeps one compiler decision — a workflow that cannot be compiled fails before a run starts, not during one.

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

Compile a definition that `parseWorkflowDefinition` already accepted:

```ts
import { compileWorkflow } from '@agentops/dsh-workflow-compiler'
import type { WorkflowDefinition } from '@agentops/dsh-contracts'

declare const definition: WorkflowDefinition

const compiled = compileWorkflow(definition, { model: { provider: 'minimax', id: 'MiniMax-M2.7' } })
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
// compiled.value.source  → evaluated by workflow-ptc
// compiled.value.layers  → node ids per layer, for the editor preview
// compiled.value.digest  → stable fingerprint for CAS and parity checks
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| [`src/compile.ts`](src/compile.ts) | Layer walk, source emission, digest |
| [`src/index.ts`](src/index.ts) | Public exports |

Layering comes from `topoLayers()` in the contracts package, so the compiler cannot disagree with validation about what a dependency is. The generated body is:

```js
phase("layer-0")
const node_scan = await agent("扫描日志", { label: "scan", phase: "layer-0" })
phase("layer-1")
const [node_left, node_right] = await parallel([
  () => agent("left", { label: "left", phase: "layer-1" }),
  () => agent("right", { label: "right", phase: "layer-1" }),
])
return { "scan": node_scan, "left": node_left, "right": node_right }
```

`parallel` is a barrier, which is exactly the layered scheduler's "wait for the whole layer" semantics.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../contracts/`](../contracts/README.md) — the definition types and edge rules this compiler consumes.
- [`../dag/`](../dag/README.md) — the layered scheduler the generated script is meant to replace.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package emits script text and never constructs a model request.

#### KV Cache effect

None; no model request passes through this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No data flow between nodes** — the script returns every node result, but does not feed an upstream `outputs` value into a downstream prompt; port wiring is still deferred.
- **Retry and timeout exist but are not wired yet** — `runNode()` adds a bounded retry with exponential backoff and a per-attempt timeout, yet the generated script still calls `agent()` directly; emitting the wrapper is a follow-up.
- **`outputs`-only dependencies run in parallel** — a node that declares a dependency through `outputs` alone lands in the same layer as its producer, which is the intended contract but reads as surprising in a YAML file.
- **Model hint is global** — one `provider`/`model` pair applies to every call; per-node models need the workflow definition to carry them.
- **Not yet wired into `workflow-ptc`** — the compiler produces source; nothing schedules it until the integration step lands.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The compiler exists because DSH rejected YAML-or-nothing: the runtime evaluates a script, so a YAML editor has to compile. Keeping the compiler in its own package lets the editor show `digest` and `layers` before a run without importing the engine.

</details>
