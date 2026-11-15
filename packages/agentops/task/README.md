---
description: "The AgentOps task domain: a fourteen-state lifecycle, gated transitions, event history, and five tools."
kind: "package-reference"
---

# @agentops/dsh-task

English | [中文](README.zh.md)

## Summary

Tasks move through a fixed fourteen-state lifecycle. Each transition is a conditional update guarded by an optimistic version, and every transition appends an event so history can be replayed. The package exposes five routes and five model tools over the same store.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it to drive task state; anything that needs task history reads the event table. The plugin mounts the versioned surface over the authenticated `/api` RPC channel and the owner-only browser bridge; a missing or empty database is initialised at `SCHEMA_VERSION`, and any other structure fails loudly, so run `pnpm migrate:task --db <path>` first. `exportRootDir` moves the Markdown report documents and `allowedSourceSystems` widens inbox capture. Run `pnpm contracts:check` after changing tables, indexes, triggers, routes or lifecycle edges; it compares `contracts/task-contracts.v1.json` with the snapshot derived from source. `pnpm migrate:task --db <path> [--dry-run]` plans a legacy or simplified database, and a real run backs it up before replacing the main file plus `-wal`/`-shm`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/store.ts` | Lifecycle, transitions, and event history |
| `src/http.ts` | Task routes |
| `src/tools.ts` | Model-facing task tools |
| `src/contracts.ts` | Contract snapshot: 21 tables, 27 indexes, 49 triggers, 37 routes, P0/V1 edges |
| `src/schema.ts` | Versioned DDL for those tables, indexes and triggers (`SCHEMA_VERSION = 1`) |
| `src/migrate.ts` | Plan, staging rebuild, verification and file-group replacement for an existing store |
| `src/service.ts` | `TaskService`: single-transaction lifecycle, version, claim, rollback, close gates, comments, criteria, reports, relations, run idempotency and inbox capture/triage |
| `src/http.ts` | Transport-agnostic router over the service: all 37 migrated routes plus both canonical idea routes |
| `src/reports.ts` | Markdown report documents: atomic write, SHA-256, artifact registration and export history |\n| `src/mount-rpc.ts` | Mounts the task surface on the authenticated `/api` RPC channel (owner-only) |`n| `src/tools-mount-v1.ts` | Preset entry that mounts the service-backed tools on a `SCHEMA_VERSION` database |`n| `src/tools-v1.ts` | Service-backed model tools: task list/get/create/advance/claim/comment/validate/report/rollback and idea capture/list/triage |
| `src/lifecycle/p0.ts` | The five P0 statuses and nine P0 edges |
| `contracts/task-contracts.v1.json` | Generated snapshot checked in for review and drift detection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../client/`](../client/README.md) — the task panel

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exposes routes and storage for the AgentOps screens without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One store only** — the three-table legacy store and its five endpoints were deleted; `TaskService` is the only writer, and older databases must be migrated with `pnpm migrate:task`.
- **The router is mounted over RPC, not Fetch** — `connection.fetch` accepts exact paths and only `GET`/`HEAD`/`POST`, so `mount-rpc.ts` uses the shared `/api` channel with owner-only admission. The plugin does not mount it yet: the five legacy endpoints remain until the panel switches to the RPC transport.
- **The `task_inbox` preset is generated but no profile mounts it yet** — it references `@agentops/dsh-task/tools-v1`; the other presets still use the legacy `@agentops/dsh-task/tools`, so the v1 tools are only reachable after a deployment wires the preset.
- **Legacy import keeps pointers, not payloads** — a legacy run's `terminal_session_id` survives in `task_runs`, but report-level terminal pointers have no target column: they are returned in `MigrationResult.manifest.droppedTerminalReportPointers` instead of being dropped silently. Nothing writes that manifest to disk yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
