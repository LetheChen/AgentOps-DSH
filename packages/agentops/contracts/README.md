---
description: "Shared Agent and workflow definition parsing, validation, serialization, and edge rules for AgentOps consumers."
kind: "package-library"
---

# @agentops/dsh-contracts

English | [中文](README.zh.md)

## Summary

When AgentOps reads or writes Agent and workflow YAML, this library is the shared definition layer. It parses snake_case YAML and camelCase API values into immutable types, reports structural issues, and exposes the only scheduling and data-edge helpers. Choosing it keeps the management API, graph views, and DAG compiler on one edge rule. `serializeAgentDefinition` writes every field, including `tier`, so saving cannot silently change an Agent's permission level.

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

### When to use it

Use it in the Agent management API, workflow editor, YAML loaders, and DAG compiler; do not re-derive dependencies from raw definitions.

### Entry point

```ts
import { parseWorkflowDefinition, scheduleDependencies } from '@agentops/dsh-contracts'

declare const rawWorkflow: string

const parsed = parseWorkflowDefinition(rawWorkflow)
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))

const firstNode = parsed.value.nodes.at(0)
const upstream = firstNode === undefined ? [] : scheduleDependencies(firstNode)
```

Hard validation failures carry paths and messages. Successful results also carry `issues` when parsing applied a non-fatal fallback. `dataEdges()` returns the separate data-flow view, and `serializeAgentDefinition()` writes the full Agent record.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`scheduleDependencies()` returns only `node.after`; `dataEdges()` returns only `node.outputs`. `topoLayers()` consumes the same `after` list, so a data edge never delays execution. Parsers validate references, cycles, and artifact templates at the YAML or API boundary.

| File | Responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | Immutable Agent, workflow, validation, and edge types |
| [`src/schema.ts`](src/schema.ts) | Parsing, edge derivation, layering, and serialization |
| [`src/index.ts`](src/index.ts) | Public module exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace layout](../workspace-layout/README.md) — resolves the business-relative artifact templates produced here.
- [AgentOps migration decision](../../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.md) — records the migration constraints and acceptance plan.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package parses and serializes Agent and workflow definitions without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package preserves legacy loading behavior while making the edge rule explicit.

- **Tier fallback is not a validation failure** — a missing or unknown `tier` becomes `T2` and adds an issue to the successful result, so callers can warn without rejecting the definition.
- **Two key spellings** — parsers accept snake_case and camelCase, while serialization always writes snake_case.
- **Unsupported node capabilities are reported** — the parser reports fields such as `condition`, `branches`, and `body`, as well as node types other than `agent`, so the editor can show the source line instead of silently treating the node as an agent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
