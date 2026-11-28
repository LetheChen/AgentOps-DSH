---
description: "The AgentOps host routes: agent, schedule, archive, surface, session-replay, and tool-catalogue endpoints behind one plugin."
kind: "package-reference"
---

# @agentops/dsh-host

English | [中文](README.zh.md)

## Summary

This package is the read side of the Agent management screens. It scans the legacy `config/agents/*.yaml` directory, exposes schedules and archive metadata, publishes the surface inventory and verified image assets the client renders, and serves the legacy tool catalogue with its DSH migration targets. Directory-backed routes register only when the deployment supplies the matching directory or file, so an unconfigured profile serves no data rather than failing at request time.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it when serving Agent management reads; writes go through the migration contracts package. Agents publish image cards with `present_content` and `content_type: "image"`; that path stores screenshot, workspace, or remote image bytes under a SHA-256 digest and serves only verified raster formats. `present_content` accepts `data`, `surface`, and `content` as objects; JSON-encoded object strings are decoded at the tool boundary for compatibility with model calls.

The package serves these routes:

| Route | Returns |
|---|---|
| `GET /api/agentops/agents` | The Agent catalogue read from the configured YAML directory |
| `GET /api/agentops/schedules` | Scheduled runs and their recorded archive metadata |
| `GET /api/agentops/archive` | Files the Agents produced |
| `GET /api/agentops/surfaces` | The generative-UI surface inventory |
| `GET /api/agentops/surfaces/asset?digest=<sha256>` | One content-addressed PNG, JPEG, WebP, or GIF published with a surface |
| `GET /api/agentops/tools` | The legacy tool catalogue and each tool's DSH migration target |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/agents.ts` | Agent catalogue route over the legacy YAML directory |
| `src/schedules.ts` | Schedule and archive reads |
| `src/tool-catalog.ts` | Tool catalogue and DSH migration targets for the permission matrix |
| `src/surfaces.ts` | Surface storage, image assets, publication routes, and the `present_content` tool |
| `src/dsh.ts` | Plugin entry and route registration |

The tool catalogue comes from `agentops/mappings/tool-map.yaml`, which lists each legacy tool's display name, description, allowed business domains, and approval requirement, plus the DSH plugin and tool that replaced it. A tool with no DSH equivalent carries a `note` saying why.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../client/`](../client/README.md) — the panels that consume these routes

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exposes routes, storage, and fixed tool definitions without constructing model input.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Directory-backed routes need configuration** — `/agents`, `/schedules`, and `/archive` register only when `agentDir`, `schedulesFile`, and `archiveDir` are non-empty.
- **Tool catalogue route needs configuration** — `/tools` registers only when `toolMapFile` (or `AGENTOPS_TOOL_MAP_FILE`) is non-empty.
- **Malformed tool map serves an empty catalogue** — unreadable YAML reports an empty catalogue instead of a missing deployment, so the page shows no tools rather than claiming the deployment is absent.
- **Read-only** — the package never writes agent YAML; saving needs the migration contracts path. Surface images are removed when no remaining card references their digest.
- **Host-served images are raster only** — stored image assets serve PNG, JPEG, WebP, and GIF; SVG and HTML are excluded so the Host never publishes active content.
- **Surface order is user-owned** — new cards append, republishing a view id keeps its slot, and `/api/agentops/surfaces/reorder` writes the full drag order; a partial, duplicated, or unknown sequence is rejected.
- **Surface store is never closed** — the surface registry keeps its store for the process lifetime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
