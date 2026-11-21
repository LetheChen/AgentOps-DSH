---
description: "The AgentOps release capability: local artifact manifests, SSH-backed production updates, timestamped image backup, durable release journal, health checks, and rollback."
kind: "package-reference"
---

# @agentops/dsh-deployment

English | [中文](README.zh.md)

## Summary

This package separates artifact production from production deployment. `artifact_build` writes a release manifest from an authorized local build instance. The deployment tools verify the referenced SSH instance, record the current image id, create a timestamped backup tag, upload verified artifacts, invoke the configured release command, and persist the result in `deployment.db`.

## Table of Contents

- [Use This Package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use This Package

Mount the root plugin once and the `/tools` plugin inside the `deploy_operator` and `build_operator` presets. The deployment tools require a deployment binding and an SSH binding for the same preset. Build tools resolve only artifact-build instances and do not receive production SSH credentials.

The release journal is stored at `$DSH_HOME/agentops/deployment.db` by default. `ctx.jobs` may display live progress when composed, but it is not the durable release record.

Reference entrypoints live in `scripts/`: `build-image.ps1` syncs a project build context, builds the image, and exports the archive on Windows; `deploy-image.sh` performs the locked remote image backup, migration, application-only recreation, health check, and rollback. An artifact-build instance and its deployment instance must use compatible artifact roots so manifest paths match exactly.

## Configuration

A deployment instance carries `tenantKey`, `ownerDomain`, `sshInstanceId`, access presets and operations, local artifact files, env-file references, remote paths, argv commands, migration policy, and health checks.

Commands are authored in the capability instance, never supplied by the model. The instance requires the generic deployment script path, version, and SHA-256. `deployment_plan`, `deployment_release`, and `deployment_rollback` read the script digest through non-interactive sudo and fail closed before lease acquisition or artifact upload when it differs. A release first resolves the current container image id, tags it as `app:backup-YYYYMMDD-HHMMSS-<shortImageId>`, then uploads and verifies the new artifact before invoking the release command. The runtime tag remains `app:latest`; rollback identity is the recorded full image id plus the backup tag.

## Model Experience

### Model-visible tools and results

#### What the model sees

When the preset mounts this plugin, the model sees the five tool names, their descriptions, parameter schemas, and call results. `deployment_release` and `deployment_rollback` additionally require a one-shot approval before their body runs. Failure results expose a stable error code, a readable summary, and a safe next action; secrets and command bodies are never returned.

#### Token effect

The schemas add a fixed request-prefix cost while the tools are visible. Tool calls and results remain in the conversation history and may be large enough to trigger compaction; `deployment_status` is the bounded read path after an unknown result.

#### KV Cache effect

The tool schemas are stable while the plugin is mounted. Activation or disposal may change the request prefix; tool-call history is append-only.

## Known Limitations and Deferred Work

- `migration.mode` currently supports the `always` release path; other modes fail closed until an explicit command contract is added.
- First install requires every file declared by the deployment instance and a complete manifest. `firstInstallSecretRef` is validated configuration metadata; staged env-file delivery is not part of this slice, so the operator must provide the target env source.
- Release execution depends on the configured target scripts; this package never builds an undocumented remote command sequence. The pinned digest detects content drift but does not establish the script's source revision or builder identity, or protect against a root actor changing both the script and the instance digest.
- Database restore is intentionally outside `deployment_rollback`.
- A persistent release journal is process-independent, but target host lock behavior still requires deployment preflight evidence.
- The Windows build entrypoint requires a running Docker daemon and PowerShell 7; a build instance still fails closed when either dependency is unavailable.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The first slice supports update releases and manifest/artifact verification. First-install env staging, recovery from `unknown_hold`, and fixed DAG orchestration remain deferred until target-host evidence exists.

</details>
