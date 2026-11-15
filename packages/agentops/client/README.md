---
description: "The AgentOps Web GUI panels: agent, workflow, collaboration, run history, schedules, vault, security, knowledge, and task views."
kind: "package-reference"
---

# @agentops/dsh-client

English | [中文](README.zh.md)

## Summary

Every AgentOps screen in the Web GUI is one panel registered by this package. Panels read `/api/agentops/*` routes directly and render the host response; the workflow panel also keeps its open workflow, YAML draft, validation state, compiled preview, Agent node library, and current canvas selection. The `agentopsWorkflows`, `agentopsRuns`, `agentopsCollaboration`, `agentopsSecurity`, `agentopsMenu`, and `agentopsTasks` locale namespaces cover English, Chinese, Japanese, Spanish, French, German, Russian, and Portuguese.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it when adding or changing an AgentOps screen; the host side lives in the sibling packages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/client/index.ts` | Slot registration, locale namespaces, and the sidebar entries driven by `menu.ts` |
| `src/client/menu.ts` | The sidebar groups and entries: one row per panel, with its dictionary namespace, key, and glyph |
| `src/client/menu-locales.ts` | Sidebar group and top-level panel labels for the eight registered languages |
| `src/client/task-locales.ts` | Task group and task panel labels for the eight registered languages |
| `src/client/collaboration-target.ts` | One-shot handoff of a run id from the run history panel to the collaboration panel |
| `src/index.ts`, `src/config.ts` | Host injection and validation of `__DSH_AGENTOPS_CLIENT_CONFIG__`; collaboration polling defaults to 3,000 ms with a range of 1–2,147,483,646 ms |
| `src/client/*-panel.tsx` | One module per screen |
| `src/client/agent-catalogue-api.ts` | Parsed Agent-directory responses for the canvas node library |
| `src/client/collaboration-api.ts` | Strict parsing of persisted-run activity and documented endpoint errors |
| `src/client/collaboration-feedback.tsx` | Application-overlay rerun Toast that outlives the requesting panel |
| `src/client/collaboration-polling.ts` | Visibility-aware, non-overlapping polling for one active run |
| `src/client/collaboration-layout.ts` | Deterministic scheduling levels from `after` dependencies only |
| `src/client/collaboration-locales.ts` | Collaboration dictionaries for the eight registered languages |
| `src/client/run-history-api.ts` | Paged run-history requests, HTTP error status, and strict list/detail response parsing |
| `src/client/run-history-locales.ts` | Run-history dictionaries for the eight registered languages |
| `src/client/security-api.ts` | Strict parsing and request errors for the four read-only security endpoints |
| `src/client/security-locales.ts` | Security dictionaries for the eight registered languages |
| `src/client/workflow-editor-api.ts` | Typed browser-fetch wrappers and strict response parsing for the catalogue, source, validation, source-only edits, CAS save, run hints, and workflow launch |
| `src/client/workflow-editor-logic.ts` | Pure source selection, request ordering, and validation helpers |
| `src/client/workflow-yaml-editor.tsx` | YAML textarea, line gutter, issue list, and issue navigation |
| `src/client/workflow-dag-canvas.tsx` | Editable SVG DAG with issue-node highlighting and node/edge selection |
| `src/client/workflow-dag-layout.ts` | Deterministic node placement and edge routing |
| `src/client/workflow-run-form.tsx` | Host-declared run inputs, typed validation, and explicit workflow launch |
| `src/client/locales.ts` | Workflow-panel dictionaries for the eight registered languages |
| `src/panel.tsx` | Shared panel shell |

The sidebar has four groups and four top-level panels. **Agent management** holds collaboration, workflows, agents, and run history; **Task management** holds the task board and task report; **Security management** holds users, roles, login sessions, and API tokens; **System settings** holds schedules and credentials. Knowledge, monitor, session replay, and generative UI stay top level. `menu.ts` is the only place that describes this layout, and it names the dictionary namespace and key behind every label, so a missing label or glyph is a compile error.

Run history and the collaboration view describe the same runs. The run history panel hands the chosen run to the collaboration panel through a one-shot handoff slot and the layout switches to the collaboration panel, which claims the run id on mount.

The workflow editor validates a changed draft after 350 ms without accepting a stale response for a newer draft. Selecting an issue moves the textarea to its one-based YAML line; a cycle issue also highlights every node in the reported cycle on the canvas. Save is compare-and-swap: a 409 preserves the draft, disables save, and requires an explicit reload from disk before another save.

The compiled tab renders generated source, zero-based scheduling layers, and the artifact digest. A successful validation replaces the preview with the artifact produced from that draft. A changed draft or failed validation keeps the last successful artifact and marks it stale. Request ordering prevents an older validation response from replacing a newer preview.

The workflow canvas combines an Agent node library, the DAG, and a node/edge inspector. Nodes and edges are selectable by pointer or Enter/Space. Schedule edges are solid; data edges are dashed and labelled with their output port. Every structural edit is applied to the current YAML draft through the host, and the returned candidate is not written until Save. A rejected edit keeps the draft, graph, and selection so the source and issue list stay aligned.

Canvas edits use the `compiled` artifact returned with the edit response and issue no extra preview request. The browser response parser rejects a successful validation or edit response when `source`, `layers`, or `digest` is missing or malformed.

The run form treats the host run hint as the authority for input names, types, defaults, and descriptions. It starts a session only after an explicit submit. A failed launch keeps the entered values visible with the host reason, so the user can correct the problem and retry.

Run history reads `GET /api/agentops/runs` with a server-side status filter, offset paging, and a matching total, then reads `GET /api/agentops/run` for node state and outputs. Browser parsing rejects unknown run or node states, negative or unsafe counts, and non-JSON output values; an HTTP failure retains its status for the caller. Refresh failures keep the current rows visible. Load more de-duplicates by run identity, and request ids prevent late list or detail responses from replacing newer state. Search covers only the loaded rows.

The collaboration panel loads run history through `GET /api/agentops/runs`, then loads the selected run from `GET /api/agentops/run-activity?id=<id>`. It polls only while the page is visible, applies the Host-injected `collaborationPollIntervalMs`, and keeps the current activity when refresh or polling fails. Structured endpoint errors use localized copy; `workflow_invalid` also shows the returned validation issues without rendering the server message.

Security management contains four independent read-only panels. Each panel requests only its own endpoint: `GET /api/agentops/security/users`, `/roles`, `/sessions`, or `/tokens`. The users page renders the assigned role ids returned with each user. The token page renders only the stored descriptor fields (`id`, `userId`, `name`, `prefix`, `createdAt`, and `revokedAt`); the endpoint exposes neither plaintext nor a hash. These panels have no create, edit, delete, issue, or revoke controls.

The dependency graph opens first and shares one node inspector with the swimlane view. A rerun opens a confirmation dialog with **Only this node** selected by default; the other option also reruns every transitive scheduling downstream node. The request reuses the selected run's `inputs` from the activity response, and the dialog, close controls, and scope options are locked while it is pending. Success closes the dialog, publishes a localized Toast through `shell.overlay`, then refreshes activity. The Toast remains after a run switch or panel unmount. Failures render only a localized error code and never copy the server `message`, `issues`, paths, or `sessionId` into the UI.

Run activity is the only source for the swimlane board, dependency graph, timeline, and Gantt. Schedule levels and solid edges use only `scheduleEdges`; dashed data edges use only `dataEdges` and never change topology. Timeline and Gantt times use persisted timestamps and durations, never the current clock.

The dependency graph accepts at most 200 nodes and shows an explicit message instead of drawing over that limit; the swimlane view still lists every activity node.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../dag/`](../dag/README.md) — the workflow editor routes
- [`../workflow-catalog/`](../workflow-catalog/README.md) — exact source reads and CAS writes

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders the AgentOps screens without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Browser fetch, not Remote** — panels call `fetch` directly, so responses have no shared typed contract and bypass per-method authorization.
- **Canvas edits are structural** — the canvas adds and removes nodes and schedule/data edges. Dragging a node template onto the canvas only selects that template; you still configure it in the node library and click **Add node**. The canvas does not edit every node field or place nodes at arbitrary positions.
- **UI tests use jsdom** — rendering and interaction are covered, but this package has no real-browser or responsive-layout assertion.
- **Run history is read-only** — it has no replay, token or cost totals, human-in-the-loop events, event timeline, or node input payloads.
- **Security screens are read-only** — they expose no mutation UI or HTTP writes. Token issuance runs through the audited `security_token_issue` Agent tool mounted by the AgentOps tools preset and deployment, and its plaintext is shown once.
- **Collaboration reads current YAML** — a run stores no workflow revision and no handoff events; activity reflects the current definition and `handoffs` stays empty.
- **Node reruns are not exclusive** — two queued Sessions can pass validation and mutate the same run because there is no run-level lock.
- **A crash can leave a rerun active** — there is no reliable atomic transition to `running`, so later reruns return `run_running` until the persisted state is repaired.
- **Rerun acceptance is not completion** — a successful response means the Session was created and the instruction was queued, not that the node or downstream work finished.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
