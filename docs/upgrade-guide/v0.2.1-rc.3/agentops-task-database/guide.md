---
kind: upgrade-guide
description: "The AgentOps task plugin stores everything in one agentops.db and no longer serves the legacy task endpoints or tools."
---

# AgentOps task database and surface

English | [中文](guide.zh.md)

## Change

`@agentops/dsh-task` now opens `$DSH_HOME/agentops/agentops.db` (`SCHEMA_VERSION = 1`) instead of `tasks.db`. The 21 task tables, the inbox and the agent profile catalogue live in that one database; `security.db`, `credentials.db`, `knowledge.db` and DSH session storage stay separate. `AGENTOPS_TASK_DB` still overrides the path, and `exportRootDir` now defaults to `<database directory>/reports`.

The `schemaMode` option, the three-table store, the five read/advance endpoints (`/api/agentops/tasks`, `/task`, `/task-report`, `/activity`, `/task-advance`) and the `@agentops/dsh-task/tools` entry were deleted. The plugin always mounts the versioned router: an interceptor on Connection's shared `/api` channel plus the exact `POST /api/agentops/task-rpc` bridge that the panels call. Model tools are mounted per preset from `@agentops/dsh-task/tools-v1`.

Both connections open with `PRAGMA foreign_keys = ON`, so the schema's reference and cascade rules now apply. A database whose `user_version` is not `SCHEMA_VERSION` is refused at load; a missing or empty file is initialised.

## Migration

1. Stop the profile that mounts the AgentOps bundle. If the old `tasks.db` holds data worth keeping, run `pnpm migrate:task --db <old tasks.db path>`; the migrator backs up the main file plus `-wal`/`-shm` before replacing it. Otherwise start with no `agentops.db` and let the plugin initialise one.
2. Remove `schemaMode` from any `cordis.yml` row or overlay that set it; it is no longer a valid field.
3. Replace callers of the removed endpoints with `POST /api/agentops/task-rpc` carrying `{ endpoint, method, query, body }`, or with the RPC channel. Both reach the same router and admit only owner peers.
4. Replace `@agentops/dsh-task/tools` imports and preset rows with `@agentops/dsh-task/tools-v1`. `task_stage_add` has no counterpart: stages are recorded through `task_advance` and formal reports.
5. Regenerate generated presets with `node --import tsx agentops/scripts/gen-agent-presets.ts --write` if a deployment keeps its own copies.
6. Start the profile: the plugin creates or accepts `agentops.db` and refuses any other structure with a schema-version error naming both values.
7. Open the board, the report page and the monitor: all three read through the bridge and list data without calling the removed endpoints.
8. Capture one inbox record and triage it to `ready` with a project; a `doc` or `question` record must still be refused.
