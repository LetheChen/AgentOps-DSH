---
description: "Define AgentOps capabilities, connector instances, and Agent-preset bindings; seal credentials and resolve one authorized runtime instance."
kind: "package-reference"
---

# @agentops/dsh-capability

English | [中文](README.zh.md)

## Summary

Use this package to operate the AgentOps capability center and resolve the exact connector instance a tool may use. Definitions describe the platform's available capabilities; instances hold deployment configuration, access policy, and sealed credentials; preset bindings decide which instances an Agent may call. Database bindings require at least one table in the instance access policy; the repository rejects an eligible-looking database instance whose allowlist is empty. A static tool catalogue separates tools with wired runtime handlers from declaration-only MCP / CLI / REST / Webhook interfaces, so the UI never implies an unbridged interface is callable. Reopening an existing database refreshes built-in definitions in place while preserving instances, bindings, credentials and audit rows. The package also records control-plane audit and outbox rows in the same SQLite transaction as each state change.

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

Mount the root plugin. It publishes `capabilityRuntime`; preset-scoped tools resolve their executing Agent's preset through that service. Use `resolveCapabilityForTool` for a single authorized instance.

### When to choose it

Choose it for AgentOps connector instances, sealed credentials, Agent-preset bindings, and runtime instance resolution. Use `@agentops/dsh-vault` instead when the task is only generic connection storage and probing.

### Minimal configuration

```yaml
- id: agentops-capability
  name: '@agentops/dsh-capability'
```

| Field | Default | Meaning |
|---|---|---|
| `dbPath` | `$DSH_HOME/agentops/capabilities.db` | Capability control-plane database. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/schema.ts` | Versioned SQLite tables for definitions, instances, bindings, audit and outbox |
| `src/store.ts` | Transactional writes, credential-safe projections, binding replacement and runtime resolution |
| `src/http.ts` | Transport-neutral capability, instance, real connection-test, SSH host-key, database table listing, binding, tool-catalogue and audit routes |
| `src/probe.ts` | Real SQLite/MySQL/PostgreSQL connection probes, database table listing and credential-free SSH host-key fingerprint reads |
| `src/ssh2.ts` | Named access to the `ssh2` CommonJS exports, including `Server` |
| `src/mount-rpc.ts` | Authenticated `/api` RPC channel and exact browser bridge |
| `src/runtime.ts` | Root-owned runtime service and preset-scoped resolution helpers |

Instance tests decrypt the saved credential and connect to the real database; capability kinds without a runtime probe return an explicit unsupported result instead of a fabricated success. The tool catalogue distinguishes `runtime_tool` rows from `interface` rows; `runtime_available` is true only where this repository owns a callable handler. The built-in definition catalogue is idempotently synchronised on every open, but deployment data is never part of that refresh. Instance writes, credential ciphertext, audit and outbox commit together. Browser rows never contain a credential reference or ciphertext. Runtime resolution rejects missing, ambiguous, disabled, mismatched, and undecryptable instances; the list form opens each enabled authorized instance and skips disabled rows. Binding replacement also rejects enabled database instances without an allowed table.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../vault/`](../vault/README.md) — AES-256-GCM sealing reused by capability credentials
- [`../db/`](../db/README.md) — database tools that consume authorized runtime targets
- [`../client/`](../client/README.md) — the broader AgentOps Web GUI

-----

<a id="model-experience"></a>
## Model Experience

None, as this package projects control-plane rows and resolves handler data without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

- **Legacy migration is deferred** — AgentOps Fernet credentials and existing `audit.db` rows require a separate migration slice.
- **Runtime coverage is partial** — database query tools now consume preset-scoped capability instances; browser, notification, SSH, and external HTTP adapters still need their own resolver adoption.
- **Delete does not drain active turns** — an instance can be removed while another session already resolved a snapshot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
