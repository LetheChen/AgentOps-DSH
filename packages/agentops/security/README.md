---
description: "The AgentOps security domain: users, roles, sessions, API tokens, usage, audit, and read-only routes."
kind: "package-reference"
---

# @agentops/dsh-security

English | [中文](README.zh.md)

## Summary

This package stores principals, roles, sessions, API token descriptors, usage records, and audit events, and serves seven read-only GET routes for the AgentOps security, usage, audit, and monitor surfaces. Mutations stay in separately mounted guarded tools. The authorization decision lives with the caller, so a route that forgets to check a permission is not caught here.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it for security-domain reads and storage; authorize callers at the route or tool and mount writes separately.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/store.ts` | Principals, roles, sessions, usage, and audit tables |
| `src/http.ts` | Seven read-only GET routes, including the four security pages and monitor |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../vault/`](../vault/README.md) — the connection registry the profile shares

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exposes routes and storage for the AgentOps screens without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **HTTP security surface is read-only** — the users, roles, sessions, and tokens pages have no mutation UI or HTTP write route. User creation and status changes, role assignment, and token issuance use guarded Agent tools; `security_token_issue` is mounted by the AgentOps tools preset and deployment and returns plaintext once.
- **Role creation and session lifecycle have no production writer** — role assignment exists as a guarded tool, but only tests create roles or start and end sessions.
- **Parallel identity model** — these tables duplicate DSH identity rather than extending it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
