---
description: "The AgentOps distribution bundle: the root plugin rows, preset tool rows, and deployment wiring a profile mounts."
kind: "package-bundle"
---

# @agentops/dsh-bundle

English | [中文](README.zh.md)

## Summary

This package carries no runtime API. Its substance is `cordis.patch.yml`, the patch set an `agentops` profile applies on top of `dsh-base` and `dsh-web-app`. Consumers read that file, not this module. Keeping the patch rows here means one AgentOps capability can be added or removed without touching DSH core packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it when assembling an AgentOps profile or auditing which plugins a deployment mounts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `cordis.patch.yml` | Root plugin rows, directory config, and the skill directory override |
| `presets/agentops-tools.patch.yml` | Shared Agent preset carrying model-facing AgentOps tools |
| `presets/agents.generated.patch.yml` | Agent presets generated from `agentops/agents/*.yaml` (one row per authoring file, including `task_inbox`; only `manager` is user-selectable) |
| `src/index.ts` | Empty module that gives the package a resolvable entry point |

`dsh.bundle.patch` applies the root, shared-tool, and generated-Agent layers in that order. Regenerate the Agent layer with `node --import tsx agentops/scripts/gen-agent-presets.ts --write`; `--check` verifies the committed file without editing it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../deploy/`](../deploy/README.md) — the container deployment patch that mounts this bundle

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exposes routes and storage for the AgentOps screens without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Patch-only distribution** — there is no runtime API to import; a consumer that needs behaviour must depend on the owning package.
- **Rows repeat package facts** — plugin names, peer dependencies, and preset rows are maintained here and in each `package.json`; a single target manifest is still deferred.
- **Bundle root rows stay Agent-scoped** — a root row that injects `tools` never applies, so tool rows belong in the preset layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
