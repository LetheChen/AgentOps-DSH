---
description: "The AgentOps credential vault: SQLite connection metadata with AES-256-GCM sealed secrets bound by AAD."
kind: "package-reference"
---

# @agentops/dsh-vault

English | [中文](README.zh.md)

## Summary

Connection metadata lives in SQLite; passwords are sealed with AES-256-GCM and bound to their record through AAD, so copying a cipher onto another row fails to open instead of silently working. Reads never return the cipher: a caller asks for a secret explicitly and gets a throwaway string for the current operation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it to store or read a connection secret; never log or serialize the returned value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/store.ts` | Connection records and secret reads |
| `src/crypto.ts` | Key loading, sealing, and opening |
| `src/probe.ts` | Connection probes for the credential screen |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../security/`](../security/README.md) — the security domain sharing this profile

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exposes routes and storage for the AgentOps screens without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Key file beside the database** — the master key protects a copied database file, not a reader with access to the whole home directory.
- **AAD is `kind:id:password`** — endpoint, username, and credential version are not bound yet; an AAD v2 migration is deferred.
- **Fallback path resolution differs by package** — this package and the task/knowledge packages resolve a missing home differently, so an unset `DSH_HOME` can silently split state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
