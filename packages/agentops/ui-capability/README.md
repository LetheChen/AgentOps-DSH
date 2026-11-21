---
description: "Browse and operate AgentOps capability definitions, connector instances, credentials, test results, Agent-preset bindings, log collection, business deployment, and control-plane audit."
kind: "package-reference"
---

# @agentops/dsh-ui-capability

English | [中文](README.zh.md)

## Summary

Use this plugin as a standalone AgentOps capability-center screen in the DSH Web GUI. It lists capability definitions and connector instances, shows whether a credential is configured without revealing it, supports schema-driven instance create/edit/delete/test with an advanced-JSON fallback, edits the selected Agent preset's bindings from the live preset roster, renders a searchable tool catalogue with explicit runtime-versus-interface status, and provides the log-collection, business-deployment, and control-plane-audit panels. Every row and mutation comes from the capability RPC surface.

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

Mount the plugin beside `@agentops/dsh-capability`; it registers the capability-center, log-collection, business-deployment, and control-plane-audit main panels.

### When to choose it

Choose it when a profile needs the AgentOps capability-center screen. Use `@agentops/dsh-client` for the broader AgentOps panel set when a single standalone page is not wanted.

### Minimal configuration

```yaml
- id: agentops-ui-capability
  name: '@agentops/dsh-ui-capability'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/client/index.ts` | Main panel registrations |
| `src/client/api.ts` | Typed calls over the exact capability RPC bridge |
| `src/client/panel.tsx` | Capability cards, instance table, searchable tool catalogue, forms, and bindings |
| `src/client/deployment-panel.tsx` | Business deployment and build instance configuration |`r`n| `src/client/audit-panel.tsx` | Control-plane audit table and summary |
| `src/client/style.css` | Panel layout using DSH theme tokens |

Instance configuration fields come from `configSchema`; select options constrain engine and auth values, numbers/booleans/arrays are typed before submission, and advanced JSON remains available for legacy or undeclared fields. The capability panel reloads one repository snapshot after each mutation, so instances and bindings converge through the same route; the audit panel reads the recent control-plane events separately. Bindings are grouped by capability; disabled instances and enabled database instances without an allowed table cannot be selected. A blank password field leaves the stored credential unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../capability/`](../capability/README.md) — the domain store, routes and runtime resolver
- [`../client/`](../client/README.md) — the broader AgentOps Web GUI

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders the capability-center screen without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

- **Chinese product copy is direct** — the panel does not yet use the DSH locale dictionaries.
- **Bindings are preset-global** — workflow-specific overrides are not exposed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
