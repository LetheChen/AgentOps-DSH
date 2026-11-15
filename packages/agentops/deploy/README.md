---
description: "The AgentOps container deployment assets: Docker build context, compose service, bootstrap links, and the deployment patch a container mounts."
kind: "package-reference"
---

# @agentops/deploy

English | [中文](README.zh.md)

## Summary

This directory holds the container deployment of AgentOps on DSH: the Dockerfile, the compose file, the bootstrap that links packages into the profile, and the patch mounted at `/etc/agentops/agentops.patch.yml`. It carries no JavaScript entry point; a deployment consumes these files rather than importing them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Build from the repository root, then start the compose service:

```bash
docker build -f packages/agentops/deploy/Dockerfile -t agentops-dsh .
docker compose -f packages/agentops/deploy/docker-compose.yml up -d
```

The Web entry is `http://<host>:3080`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Container layout and patch shape — click to expand</summary>

| Path | Purpose |
|---|---|
| `/app` | Built DSH workspace |
| `/data/dsh` | `DSH_HOME`: profile, stores, and the seeded runtime catalogues |
| `/data/dsh/agentops/agents` | Runtime Agent YAML, seeded from the image on first start |
| `/data/dsh/agentops/workflows` | Runtime workflow YAML, seeded from the image on first start |
| `/data/dsh/agentops/mappings` | Tool and knowledge-base migration maps, seeded from the image |
| `/data/dsh/agentops/domains` | Business-domain defaults read by the Agent identity tab |
| `/data/dsh/agentops/actors` | Actor visual profiles read by the collaboration Actor summary |
| `/data/agentops-outputs` | Agent artifacts, mounted read-only for the archive screen |
| `/app/agentops/agents`, `/app/agentops/workflows`, `/app/agentops/mappings`, `/app/agentops/domains`, `/app/agentops/actors` | Default migrated assets carried by the image |
| `/etc/agentops/agentops.patch.yml` | Mounted deployment patch: absolute root rows plus preset package names |
| `/app/packages/agentops/bundle/presets/agents.generated.patch.yml` | Generated Agent presets applied as a second patch |

Root rows address `/app/packages/agentops/*/lib/index.js` because `--patch` runs inside the image. Preset rows live in the Agent scope and must resolve by package name, so `bootstrap.mjs` links the packages into `$DSH_HOME/profiles/<profile>/node_modules/@agentops/*`. On every start it seeds the image assets into `$DSH_HOME/agentops` without overwriting existing files, then passes both patch layers to `dsh web`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../bundle/`](../bundle/README.md) — the distribution bundle this deployment mounts.
- [`../README.md`](../README.md) — the package family.

-----

<a id="model-experience"></a>
## Model Experience

None, as this directory ships deployment files and constructs no model input.

#### KV Cache effect

None; no model request is constructed or sent here.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The compose file runs one service** — `docker-compose.yml` defines the `dsh` service only, while earlier text described a second sidecar container; the compose file is the authority.
- **Seeded assets preserve local edits** — the default start does not overwrite an existing Agent or workflow file; replace one deliberately or run the seed script with `--force`.
- **No image build in CI** — the deployment patch and Dockerfile are reviewed by reading, not by building in a gate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
