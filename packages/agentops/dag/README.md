---
description: "The AgentOps workflow engine: legacy YAML validation, layered scheduling, workflow editor and node rerun routes, and one subagent per node."
kind: "package-reference"
---

# @agentops/dsh-dag

English | [中文](README.zh.md)

## Summary

The DAG package turns a legacy workflow YAML file into an execution plan and runs it. Validation rejects duplicate ids, unknown dependencies, dangling output targets, and cycles; execution groups nodes into layers, runs each layer concurrently, and gives every node its own subagent run with a JSON-only handoff. It also exposes the source, live-validation with compiled preview, source-only edit, and CAS-save routes used by the workflow editor, paged run-history and run-detail routes, a queue-only node rerun route, and a projection from persisted runs to collaboration views.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it to validate or run an AgentOps workflow; the management routes build on it.

### Model-facing tools

| Tool | Behaviour |
|---|---|
| `dag_catalog` | List the configured workflows with identity, description, declared inputs, node count, and validation state |
| `dag_validate` | Validate one YAML source and return its execution levels; read-only |
| `dag_run` | Run a workflow by identity or YAML; every agent node spawns one subagent |
| `dag_rerun` | Rerun one node of a persisted run, optionally preserving downstream results |
| `list_runs` | List recent runs with node statuses; read-only |

An Agent preset that owns a workflow mounts this plugin with `ownedWorkflowId` and `ownerAgentPreset` set. That pins execution: `dag_run` resolves the configured workflow and ignores a model-supplied `workflowId`, and every node subagent is forced to that Agent's preset. A node that cannot resolve an owner preset fails instead of inheriting the caller's composition. The generated row also sets `only: ['dag_run', 'list_runs']`, because cataloguing and authoring belong to operators rather than to the Agent under test.

### Run attribution

`dag_run` records the owning Agent, the executing session, and each node's business role. The run row is written before the first node settles and updated on every settlement, so supervision can show live progress instead of only a terminal snapshot. `list_runs` reads that record, which is how a dispatcher verifies that a workflow actually started rather than inferring it from a reply.

### Workflow editor routes

| Route | Behaviour |
|---|---|
| `GET /api/agentops/workflow-source?id=<id>` | Return the exact YAML text and its SHA-256 digest without parsing it |
| `POST /api/agentops/workflow-validate` | Validate `{ text }` and return issues, the scheduling graph, and the compiled preview when valid |
| `POST /api/agentops/workflow-save` | Save `{ workflowId, text, expectedDigest }` through compare-and-swap |
| `POST /api/agentops/workflow-edit` | Apply one source-only edit to `{ text, operation }` and return the candidate text with its validated graph and compiled preview |

Workflow ids must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`. Source text is limited to 1 MiB of UTF-8 bytes. A missing source returns 404, an invalid request returns 400, an oversized source returns 413, and invalid YAML returns 422 with issues. A stale digest returns 409 with `actualDigest`; the route never adopts that digest or overwrites the newer file. Unexpected filesystem failures return a generic 500 without a host path.

The edit route accepts `add-node`, `remove-node`, `add-schedule-edge`, `remove-schedule-edge`, `add-data-edge`, and `remove-data-edge`. YAML remains authoritative: the route splices only the affected source range and returns a candidate without writing it, while `workflow-save` remains the only write path. Successful validation and edit responses include `compiled: { source, layers, digest }`; a 422 response contains issues and no `compiled` artifact. A rejected edit also returns no candidate text.

### Run history routes

| Route | Behaviour |
|---|---|
| `GET /api/agentops/runs?limit=&offset=&status=&workflowId=` | Return `{ runs, total }` with newest runs first; limit defaults to 50 and must be 1–200 |
| `GET /api/agentops/run?id=<id>` | Return one run with its workflow identity, root error, node timings, attempts, chosen port, and outputs |
| `GET /api/agentops/run-activity?id=<id>` | Return one persisted run's business lanes, nodes, schedule and data edges, timeline, and handoffs |

The list route accepts `running`, `completed`, `failed`, or `cancelled` as its status filter and combines it with an exact workflow identity filter. Invalid paging or status parameters return 400. An unknown detail identity returns 404.

`GET /api/agentops/run-activity?id=<id>` returns `invalid_query` (400) for a missing id, `unknown_run` (404) for an unknown run, `workflow_missing` (404) for absent current YAML, `workflow_mismatch` (409) when the YAML id differs from the run identity, `workflow_invalid` (422) for unparsable or invalid YAML, and `internal_error` (500) for unexpected failures. The endpoint reads the workflow's current YAML; because runs store no definition revision, a deleted or edited file cannot be reconstructed from the run alone.

### Node rerun route

| Route | Behaviour |
|---|---|
| `POST /api/agentops/workflow-rerun` | Queue one `dag_rerun` instruction in a new `agentops` Session |

The request is `{ runId, workflowId, nodeId, onlyNode, inputs }`. The route validates the persisted run, current workflow, node, run status, and declared inputs before creating the Session. `onlyNode: true` reruns only the target node; `onlyNode: false` also reruns every transitive scheduling downstream node. A 200 response means the Session was created and the instruction was queued, not that the node finished.

Failures are `invalid_request` (400), `unknown_run` (404), `workflow_mismatch` (409), `node_missing` (404), `run_running` (409), `workflow_invalid` (422), `invalid_inputs` (422), `session_unavailable` (503), and `internal_error` (500). A `session_unavailable` response after Session creation can include the internal `sessionId`; the browser client does not render it.

`dag_rerun` resumes the original `runId` with the requested inputs. It invalidates the target and, unless `onlyNode` is true, every transitive scheduling downstream node. Completed outputs remain available to the resume, and the settled state is written back to run history.

### Collaboration activity projection

`projectAgentActivity({ record, workflow })` combines one `RunRecord` with its workflow definition for the business-lane, developer-DAG, and timeline views.

- `nodes` preserves workflow declaration order, applies `businessRole → agentRef → node id` fallback for lanes, and displays `displayName ?? id`.
- Run nodes absent from the definition are ignored; definition nodes absent from the run appear as `pending` with zero attempts.
- `scheduleEdges` comes only from `after`. `dataEdges` comes only from `outputs`, and empty output targets are omitted.
- `timeline` contains only run and node lifecycle events backed by persisted timestamps. Equal timestamps use lifecycle priority and workflow order.
- `handoffs` is always empty until DSH persists handoff events.

The YAML loader preserves optional node metadata from `name`, `agent`, `business_role`, `harness`, and `model` fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/validate.ts` | Structure checks, cycle detection, and layer computation |
| `src/engine.ts` | Layered scheduler, per-node subagent runs, cancellation |
| `src/run-store.ts` | Run and node persistence, filtered paging, and full run records |
| `src/activity.ts` | Deterministic run-to-collaboration projection for lanes, nodes, edges, and lifecycle events |
| `src/runs.ts` | Paged run-history and run-detail routes |
| `src/load.ts` | YAML loading and normalisation |
| `src/workflow-edit.ts` | Source splices for adding and removing nodes and schedule/data edges |
| `src/workflow-editor.ts` | Source, validation, edit, and CAS-save routes |
| `src/workflow-rerun.ts` | Persisted-run validation and the queue-only rerun Session route |

The editor routes register through `ctx.effect()` and require both `connection` and `workflowCatalog`. They return contract validation issues unchanged so the client can locate YAML lines and highlight cycle nodes. The edit route validates the candidate, then compiles the validated in-memory definition instead of parsing the candidate source again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../contracts/`](../contracts/README.md) — the shared validation and edge rules this engine consumes
- [`../workflow-catalog/`](../workflow-catalog/README.md) — exact source reads and CAS persistence

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dag_validate`, `dag_run`, and `dag_rerun`, which expose workflow inputs and upstream node outputs to node Agents.

#### KV Cache effect

Prompt content varies with run inputs and upstream node outputs; this package manages no KV-cache key.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No node-level timeout or retry** — a stalled node can only be cancelled as part of the whole run.
- **Four node primitives are incomplete** — gateway always takes the first port, `await_command` times out, `while` does not loop, and `parallel_branch` ignores `join_strategy`.
- **`command` nodes execute through a shell** — template values are substituted without escaping and `parse_stdout` evaluates an expression; treat workflow write access as host execution.
- **Node reruns have no exclusion** — two queued Sessions can pass validation and mutate the same run; there is no run-level lock.
- **A crash can leave a run as `running`** — there is no reliable atomic transition to `running`, so later reruns return `run_running` until the persisted state is repaired.
- **Reruns read the current YAML** — the run store keeps no workflow revision, so a deleted or edited definition cannot be reconstructed and a rerun uses the file currently on disk.
- **Rerun acceptance is not completion** — a successful route or tool response only means the rerun instruction was queued or executed by that tool call, not that downstream work has finished.
- **Collaboration projection has no handoff or conversation history** — run storage has neither handoff events nor a run-to-session link, so `handoffs` is empty and the timeline contains no chat messages.
- **Collaboration projection reads the current definition** — the run store does not persist the workflow revision used by a run, so a deleted or edited file cannot be reconstructed from the run alone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
