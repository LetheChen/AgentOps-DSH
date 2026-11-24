---
description: "Define AgentOps capabilities, connector instances, and Agent-preset bindings; seal credentials and resolve one authorized runtime instance."
kind: "package-reference"
---

# @agentops/dsh-capability

English | [中文](README.zh.md)

## Summary

Use this package to operate the AgentOps capability center and resolve the connector instance a tool may use. Definitions describe capabilities; instances hold deployment configuration, access policy, and sealed credentials; preset bindings authorize instances. The tool catalogue separates wired runtime handlers from interface-only declarations. Database bindings require an allowed table, and runtime resolution rejects missing, ambiguous, disabled, mismatched, or undecryptable instances. Control-plane state changes, audit, and outbox rows commit together.

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
| `src/probe.ts` | Real SQLite/MySQL/PostgreSQL, SSH, webhook, Feishu docs, and Seeyon OA connection probes |
| `src/ssh2.ts` | Named access to the `ssh2` CommonJS exports, including `Server` |
| `src/mount-rpc.ts` | Authenticated `/api` RPC channel and exact browser bridge |
| `src/runtime.ts` | Root-owned runtime service and preset-scoped resolution helpers |
| `src/auth.ts` | Vendor-neutral token-endpoint declaration: per-parameter request locations, subject sources, invalid values, extraction and expiry |
| `src/token-broker.ts` | Token minting, caching by instance, credential generation and request subject, and scoped invalidation |
| `src/rest.ts` | Authenticated REST transport with one re-mint-and-retry on a rejected token |
| `src/feishu-tools.ts` | Preset-scoped Feishu cloud-drive listing and document-reading tools |
| `src/notify-tools.ts` | Preset-scoped Feishu and WeCom group notification tools |
| `src/oa-affairs.ts` | Seeyon OA identity, route, response normalization, pagination and client-side filters |
| `src/oa-tools.ts` | Preset-scoped Seeyon OA affairs tool |

A capability instance declares an `auth` block that says how to mint an access token, which request subject to bind, and how to present it. The declaration is vendor-neutral: token parameters may travel in JSON, form data, or the query string; sources may read the sealed credential, instance configuration, or a request subject such as `subject.memberCode`; and declared invalid token values are rejected before caching. The broker caches by instance, credential generation, authentication declaration, and subject, so changing the queried user cannot reuse another user's token. The REST transport presents the token and re-mints it once for the same subject on a rejected request before failing. Tokens never reach a model: the tools read the vendor's response, not the credential.

Instance tests use the same authentication and transport path as runtime tools where a probe exists; the OA probe obtains a token and reads one pending row, and the Feishu docs probe mints a tenant token and reads one drive page through an official Feishu or Lark API origin. These probes report an unbound identity, missing token endpoint, unauthorized account, or invalid app credential before an Agent uses the instance. Capability kinds without a runtime probe return an explicit unsupported result instead of a fabricated success. The tool catalogue distinguishes `runtime_tool` rows from `interface` rows; `runtime_available` is true only where this repository owns a callable handler. The built-in definition catalogue is idempotently synchronised on every open, but deployment data is never part of that refresh. Instance writes, credential ciphertext, audit and outbox commit together. Browser rows never contain a credential reference or ciphertext. Runtime resolution rejects missing, ambiguous, disabled, mismatched, and undecryptable instances; the list form opens each enabled authorized instance and skips disabled rows. Binding replacement also rejects enabled database instances without an allowed table.
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

Indirectly, through the preset-scoped OA affairs, Feishu cloud-document, and notification tools plus the profile-level DSH browser-use provider.

#### KV Cache effect

The preset-scoped tools and DSH browser provider own their model-visible arguments and rendered results; capability storage and the control plane add no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Legacy migration is deferred** — AgentOps Fernet credentials and existing `audit.db` rows require a separate migration slice.
- **Runtime coverage is partial** — database query tools, the OA affairs tool, and Feishu cloud-document list/read consume preset-scoped capability instances; DSH browser-use is provided profile-wide through `@agentops/dsh-browser`. Tianyancha, Feishu spreadsheet, and document-write adapters still need wiring.
- **Runtime token endpoints are declared, not discovered** — runtime REST tools state where their token comes from; OA and Feishu docs have bridged authentication-and-business probes.
- **The OA tool covers collaboration affairs only** — pending and done. Official documents (`edoc`), form reading, and the affairs boxes that need a single-sign-on ticket are not reachable through it.
- **OA permissions are selected by instance** — create one OA capability instance per REST credential or upstream permission profile; a preset binding chooses which one its tools may resolve.
- **Delete does not drain active turns** — an instance can be removed while another session already resolved a snapshot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
