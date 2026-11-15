---
description: "The AgentOps read-only query service: an allowlisted SQL surface over the audit database."
kind: "package-reference"
---

# @agentops/dsh-db

English | [中文](README.zh.md)

## Summary

This package answers read-only questions against the AgentOps audit database. It exposes an allowlisted query surface, rejects unregistered tables, and reports datasource metadata for the UI. A database resolves through the capability center first — the same store the configuration page writes decides which instance one Agent preset may query — and falls back to `datasources.yml` only for presets the capability center has never configured.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it for read-only audit queries; writes belong to the owning domain package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/guard.ts` | Table allowlist and schema checks |
| `src/instances.ts` | Capability-first instance resolution and AgentOps access-policy normalization |
| `src/query.ts` | SQLite, MySQL and PostgreSQL execution plus schema introspection |
| `src/tools.ts` | `sql_query` and `describe_database` over one resolved instance |
| `src/dsh.ts` | Plugin entry and route registration |
| `src/datasources.ts` | Legacy datasource metadata |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../vault/`](../vault/README.md) — the credential store this package reads from

-----

<a id="model-experience"></a>
## Model Experience

The preset-scoped tools expose `sql_query` and `describe_database`. Both resolve the executing Agent's live composed preset through `agentPresets.composedPreset(agent.ctx)`, so the page binding and the tool call use one fact source. A capability instance is never reachable through the legacy datasource file.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The allowlist checks schema-qualified references only** — a bare table name such as `SELECT * FROM secrets` is currently admitted; replacing the string check with a SQLite authorizer is deferred.
- **Cross-package source import** — the store reaches into the vault package source instead of a declared dependency.
- **Metadata fallback writes samples** — an unreadable datasource file is replaced by generated sample rows rather than failing loud.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
