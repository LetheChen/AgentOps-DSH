---
description: "Store SSH-backed log collection tasks, task ACL rows, safe tenant storage keys, and revisioned lifecycle changes."
kind: "package-reference"
---

# @agentops/dsh-log-collection

English | [中文](README.zh.md)

## Summary

This package owns the first log collection implementation slice: an SSH-backed task registry with explicit task ACL and deterministic tenant storage keys. A task references an opaque SSH instance id, stores absolute POSIX remote paths, and never stores credentials or connection fields. Updates use revisions; deletion is soft and reserves the task id.

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

Construct `LogCollectionStore` with an open SQLite database and an absolute local root. Tenant and owner-domain values must come from authenticated context. Remote paths must be absolute POSIX files; `.`、`..`, duplicate values and trailing slashes are rejected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/schema.ts` creates the versioned task and ACL tables. `src/store.ts` owns task creation, lookup, revisioned update, soft delete, ACL grants and authorization. The local directory is always `<root>/<tenant>/<task-id>` and is checked for containment.

-----

<a id="further-exploration"></a>
## Further Exploration

- The full migration design is in `agentops/LOG-COLLECTION-MIGRATION-DESIGN-v9.md`.
- The minimal implementation scope is in `agentops/LOG-COLLECTION-MVP-SCOPE.md`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package stores task records and ACL rows without constructing model input.

#### KV Cache effect

No KV-cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The root plugin, control-plane RPC, browser bridge and the capability-center tab are mounted; live MaxKB SFTP collection is verified.
- Task create/update validates the referenced SSH instance against the capability center (exists, enabled, credential present, host key pinned) before writing.
- Every manual run appends a run row (files, bytes, elapsed, error) so the page can show evidence.
- Still deferred: incremental offsets, retention/LRU cleanup, lease/receipt for concurrent pulls, and legacy AgentOps task migration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

M1 intentionally stops at the task registry so the next slice can be reviewed and tested independently.

</details>