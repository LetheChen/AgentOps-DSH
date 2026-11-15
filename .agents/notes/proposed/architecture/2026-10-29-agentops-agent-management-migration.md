# Agent Note: AgentOps agent, workflow, and collaboration pages migration

Status: proposed

English | [中文](2026-10-29-agentops-agent-management-migration.zh.md)

## Problem

AgentOps owns three management surfaces — Agent management, Workflow management, and Collaboration visualisation — over 20 Agent YAML definitions and 16 workflow YAML definitions. Its own web application serves them today, and the DSH port started as a page-by-page copy: panels read the legacy configuration directory, the Agent form showed neither the permission tier nor the tool policy, and nothing on the surface could write a definition.

Four defects make a page-by-page copy unsound:

- **No single output location.** Each Agent and each workflow node chose its own directory, so artifacts landed wherever a definition said, not inside the workspace the user selected before the conversation.
- **Four dependency derivations.** The legacy editor derived edges from `after ∪ outputs`, the summary from `after`, the collaboration graph from `outputs`, and the scheduler from `after`. One workflow therefore had four topologies.
- **A second execution model.** DSH evaluates a workflow as a script; a YAML DAG has no native runner there. Copying the legacy DAG engine would leave two runtimes, two run states, and two sets of cancellation and retry semantics under one product page.
- **Silent field loss.** `tier` is a permission gate in YAML, was absent from the page, and was dropped on save; a save could therefore promote or demote an Agent without anyone choosing that.

The port must also stay a plugin set. A DSH core change is acceptable only where no profile, bundle, or preset can reach the behaviour.

## Proposal

Migrate the three surfaces as AgentOps plugins in this repository: shared contracts first, then one workspace layout, then one workflow execution path, then the pages. DSH core stays unchanged where a plugin suffices.

### Contracts own the definition model

[`@agentops/dsh-contracts`](../../../../packages/agentops/contracts/README.md) parses and serializes both YAML dialects. The YAML files remain the source of truth; the in-memory types are the agreement every reader and writer shares, and every field round-trips.

`tier` is part of that agreement because it gates tool access, not because it is displayed. `execution: 'skill' | 'workflow'` states whether an Agent carries its procedure itself or owns exactly one workflow. Workflow ownership is declared only on the Agent, so the reverse index is derived from the Agent catalogue and each inconsistency is reported rather than resolved.

Dependencies come from `after` alone. `outputs` describes data flow and takes no part in scheduling, so the four legacy derivations collapse into one function.

### Agents and workflow nodes stay different designs

An Agent with its own duties and tool needs is a preset: a user-visible identity the Agent management page maintains. A workflow's steps are not presets. Each node describes one hop, inherits the owning Agent's tools, starts with no parent context, and exchanges data only through declared JSON ports, so a step that exists only to feed the next one never becomes a catalogue entry.

Making every node a preset would fill the catalogue with entries nobody addresses and would let a node's tool set drift from the Agent that owns the workflow. The owning Agent declares the workflow, and the workflow file never names an Agent.

### One workspace layout

[`@agentops/dsh-workspace-layout`](../../../../packages/agentops/workspace-layout/README.md) resolves every artifact path under the Session's selected workspace:

```text
<sessionCwd>/<business>/agents/<agentId>/<artifact>
<sessionCwd>/<business>/workflows/<workflowId>/<runId>/<artifact>
<sessionCwd>/<business>/workflows/<workflowId>/<runId>/nodes/<nodeId>/<artifact>
```

The caller chooses only the business-relative artifact. The service canonicalizes the workspace, rejects absolute prefixes, drive letters, `..` segments, and NUL, checks the nearest existing ancestors, creates the scope directory, and re-checks the canonical result so a symlink cannot move the target outside the workspace. `resolvePolicy()` narrows a deployment execution policy to the scope and drops deployment-wide extra writable roots, so a workflow node cannot use an AgentOps directory to reacquire writes elsewhere.

### One workflow execution path

[`@agentops/dsh-workflow-compiler`](../../../../packages/agentops/workflow-compiler/README.md) turns a validated definition into the script the workflow runtime evaluates. `topoLayers()` in the contracts package supplies the layers, each layer becomes one `phase()`, and a layer with several nodes becomes one `parallel([...])` barrier. `compileWorkflow` returns `{ source, layers, digest }`; the editor previews that source, so the previewed program and the executed program are the same string. A cycle fails compilation, before a run exists, instead of failing mid-run.

`parallel` is used because it is a barrier. `pipeline` has no stage barrier and would break layer ordering.

`runNode()` adds the per-node retry and timeout that DSH does not provide. Resumption is deliberately absent: a run has no journal, so a restarted workflow starts over rather than pretending to continue.

[`@agentops/dsh-workflow-catalog`](../../../../packages/agentops/workflow-catalog/README.md) is the only component that scans, validates, compiles, and writes definitions. Every write is compare-and-swap on the file digest, `create()` refuses to replace an existing file, and `validateAndCompile()` parses once so the compiled preview always describes the definition it returned.

### The pages write through the catalogue

Agent management edits Agent YAML through the agent routes: list, detail, create, update, and delete. A save is validated against the contract and rejected whole, so a partial write cannot drop `tier` or `outputFiles`.

The permission tab maintains allowed and denied tool names on the Agent. Denied names reach the runtime as an [`agentops-tool-policy`](../../../../packages/agentops/host/src/tool-policy.ts) guard row generated into the preset, not as a `restrict` rule and not as a settings-form edit of `plugins`. The page does not edit preset plugin rows at all: [`agentops/scripts/gen-agent-presets.ts`](../../../../agentops/scripts/gen-agent-presets.ts) generates them from Agent YAML, and a regenerated preset reaches only new sessions.

Workflow management edits YAML with live validation and a DAG canvas that writes back through the catalogue's digest CAS, previews the compiled script, renders declared run inputs, and lists run history. Collaboration visualisation projects lanes, a layered developer DAG, and a timeline from persisted run events only; its node rerun accepts `{ runId, workflowId, nodeId, onlyNode, inputs }`, invalidates the target node or every downstream node reachable through `after`, and reports the queueing decision rather than a completion it cannot observe.

### Delivery order

1. Contracts, workspace layout, and the unified edge derivation.
2. Workflow compilation, the catalogue, and node retry and timeout.
3. Workflow management page.
4. Collaboration visualisation and node rerun.
5. Agent management page and its write path.
6. Packaging, test membership, and the remaining gates.

Batches 1–5 are built; batch 6 is the open work named under Risks.

## Alternatives considered

**Port page by page and adapt later.** The superseded first plan took this route: it ignored the existing `packages/agentops` port, planned ten new pull requests, and its endpoint table was wrong in 13 of 17 rows. Rejected because the page shapes followed the legacy backend rather than one contract.

**Keep the legacy DAG engine as the runner.** Rejected because it would run beside the DSH workflow runtime with its own run state, cancellation, and telemetry, and would bypass DSH session, sandbox, and usage accounting.

**Represent layers with `pipeline`.** Rejected because `pipeline` has no stage barrier; a slow node in layer *n* would overlap layer *n+1*.

**Give each node its own tool whitelist.** Rejected for this migration: `agent()` accepts a closed option set and workflow nodes inherit their Agent's tools. A per-node whitelist would require changing the workflow package, which the owner declined.

**Edit preset plugin rows from the Agent management page through `settings`.** Rejected because `plugins` is not a volatile field and `update()` throws. The page edits Agent definitions; preset rows are generated.

**Implement `denied_tools` with `tools.restrict()`.** Rejected because `restrict()` filters only inherited tools and throws when it names a tool the same scope registered, which breaks the preset and blocks new sessions. `guard()` denies at call time within the caller's scope.

**Keep the legacy `command` node.** Rejected because it executed shell and evaluated code directly, outside DSH tool policy and sandbox confinement.

**Forward the legacy HTTP endpoints unchanged.** Rejected because their mutation, revision, and permission semantics were undefined. Namespaced services replace paths, and consumers migrate explicitly.

**Copy the AgentOps migration directory into DSH.** Rejected because AgentOps owns the old-system facts and review evidence while DSH owns the current contracts, tests, and deployment. A copy would create two owners for one fact.

## Acceptance criteria

- Layout tests reject traversal, absolute paths, drive letters, NUL, dangling symlinks, and a swapped parent, and prove that a resolved artifact stays under the canonical workspace; policy narrowing removes deployment-wide extra writable roots.
- Compiler tests prove that a cycle fails before a run, layers follow `after`, `outputs` never affects topology, and the digest is stable; the editor's preview text equals the executed source.
- `runNode` tests prove attempt count, backoff order, timeout, and that cancellation wins over a pending retry.
- Catalogue tests prove create/save compare-and-swap, that a stale digest is refused, and that an unreadable file stays visible with its issues instead of disappearing from the list.
- Agent write tests prove every field round-trips, including `tier`, `execution`, `workflow`, and `outputFiles`, and that an invalid definition is rejected whole.
- A denied tool name produces a denial at call time for that Agent only, and an Agent without the guard row is unaffected.
- Workflow page tests prove canvas edits round-trip to YAML, that compile preview matches the saved definition, and that run history filters and pages on the server.
- Collaboration tests prove all three views derive from persisted run events with no mock data, that rerun invalidates exactly the chosen scope, that a `running` run or node is refused, and that error copy is localized while the queued outcome is not reported as completion.
- AgentOps tests run under `pnpm run test` and count toward the per-file coverage gate.
- Client-visible copy goes through the locale dictionaries, and the Windows and Web build smokes pass on the affected packages.

## Risks

**The compiler becomes a second source of truth.** A preview that drifts from what runs would recreate the legacy defect. Both come from one parse and one emitted string, and the digest is the comparison token.

**YAML cannot express every script feature.** The compiler supports the contract's node primitives only. An unsupported construct must fail compilation with a structured issue; silent degradation would reintroduce the behaviour differences this migration removes.

**Tests sit outside the repository gates.** `packages/agentops/*` suites are `tests/*.test.ts` run by each package's `node --test` script, while `pnpm run test` and the coverage gate collect `tests/**/*.spec.{ts,tsx}` under `packages/*/*/src`. Until those suites join the gate, a regression here is not blocked by CI.

**Rerun reads the current definition.** Run records do not store the workflow revision, so editing or deleting a definition makes an old run's rerun unreproducible.

**No run-level lock.** Two sessions can pass the not-running check concurrently and compete to modify the same run. A crash can also leave `running` behind, and later reruns then keep returning `run_running` until the persisted state is repaired.

**Queued is not completed.** The rerun route returns after creating a Session and queueing the instruction. Node execution and run-state write-back finish inside an Agent turn, so a caller that treats HTTP 200 as completion will be wrong.

**Preset changes do not reach running sessions.** A regenerated preset applies to new sessions; the page must not imply otherwise. An Agent locked to a preset stays on it for the session's first turn onward.

**Packaging rows are repeated.** Bundle patch rows, deploy patch rows, bootstrap plugin links, package peer and dev dependencies, and generated presets are maintained separately; the single target manifest that would validate them together remains deferred ([bundle README](../../../../packages/agentops/bundle/README.md)).

**Verification is Windows-only so far.** Filesystem containment, ACL handling, and path casing have not been proved on Linux, where the product will run.
