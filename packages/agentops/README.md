---
description: "The AgentOps package group: the ported capabilities under packages/agentops/, for readers choosing or navigating the family."
kind: "package-group"
---

# agentops/ — AgentOps capabilities ported as DSH plugins

English | [中文](README.zh.md)

## Summary

AgentOps business capabilities run inside DSH as ordinary plugins. Runtime, model providers, and model credentials use DSH native features, so there is no duplicate AgentOps runtime page or API; the remaining business screens keep the legacy layout and interaction. Each capability is one package here, and `@agentops/dsh-bundle` assembles them for a profile.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Owns |
|---|---|
| [`@agentops/dsh-contracts`](contracts/README.md) | Agent and workflow definition parsing, validation, serialization, and the only edge rules |
| [`@agentops/dsh-workspace-layout`](workspace-layout/README.md) | Canonical artifact directories under a Session cwd, with containment checks |
| [`@agentops/dsh-host`](host/README.md) | Agent catalogue, schedule, archive, surface, session-replay, and tool-catalogue routes |
| [`@agentops/dsh-dag`](dag/README.md) | Workflow validation, layered scheduling, and one subagent per node |
| [`@agentops/dsh-db`](db/README.md) | Read-only audit queries behind a table allowlist |
| [`@agentops/dsh-knowledge`](knowledge/README.md) | Knowledge spaces, chunking, BM25 retrieval, and a model tool |
| [`@agentops/dsh-security`](security/README.md) | Users, roles, sessions, usage, and audit streams |
| [`@agentops/dsh-task`](task/README.md) | Fourteen-state task lifecycle with event history and tools |
| [`@agentops/dsh-vault`](vault/README.md) | Connection registry with AES-256-GCM sealed secrets |
| [`@agentops/dsh-deployment`](deployment/README.md) | Local artifact builds and SSH-backed production releases with image backup, journal, health checks, and rollback |
| [`@agentops/dsh-client`](client/README.md) | The Web GUI panels for every capability above |
| [`@agentops/dsh-browser`](browser/README.md) | Optional profile bundle that mounts DSH browser-use with Chrome DevTools MCP |
| [`@agentops/dsh-bundle`](bundle/README.md) | The patch set a profile mounts |
| [`deploy/`](deploy/README.md) | Container build, compose file, and the deployment patch |

<a id="related-documentation"></a>
## Related documentation

- [AgentOps artifact layout](../../docs/subsystems/agentops.md) — the workspace directory contract these packages share.
- [Migration decision](../../.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.md) — accepted constraints and acceptance plan.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The group is mid-migration. `contracts` and `workspace-layout` are new and follow the current doc and test gates; the older packages were ported before those gates existed, so several still carry hardcoded Chinese copy, no UI tests, and browser `fetch` calls instead of Remote invocations.

</details>
