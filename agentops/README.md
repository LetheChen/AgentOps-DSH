# agentops/ — the AgentOps directory inside the DSH repository

English | [中文](README.zh.md)

This directory is the single entry point for the AgentOps project inside the DSH repository: the governance manifests, the baseline record, the upgrade procedure, and the check scripts. The code itself lives in `packages/agentops/**`, which the `packages/*/*` glob in `pnpm-workspace.yaml` picks up automatically.

## Files

| File | Purpose |
|---|---|
| [`OWNED-PATHS.txt`](./OWNED-PATHS.txt) | Whitelist of owned paths (`packages/agentops/`, `agentops/`) |
| [`CORE-PATHS.txt`](./CORE-PATHS.txt) | Registered changes to DSH core sources |
| [`INTEGRATION-PATHS.txt`](./INTEGRATION-PATHS.txt) | DSH files required to join the workspace (tsconfig ×2 + pnpm-lock) |
| [`ENV-ARTIFACTS.txt`](./ENV-ARTIFACTS.txt) | Checkout artifacts (symlink and permission differences with identical blobs) |
| [`DSH-BASELINE.md`](./DSH-BASELINE.md) | Baseline coordinates, how the baseline was obtained, how to deepen history |
| [`DSH-CORE-CHANGES.md`](./DSH-CORE-CHANGES.md) | Ledger of CORE changes and INTEGRATION wiring |
| [`UPGRADE.md`](./UPGRADE.md) | DSH upgrade procedure (no wholesale copying) |
| [`scripts/check-owned-paths.mjs`](./scripts/check-owned-paths.mjs) | Five-category change check; exits 1 when UNEXPECTED is not 0 |

## Migrated assets

| Directory | Contents | Consumed by |
|---|---|---|
| `agents/` | 20 Agent YAML definitions | Agent catalogue, preset generator |
| `workflows/` | 16 workflow YAML definitions | Workflow list, YAML editor, DAG runs |
| `domains/` | 9 business-domain YAML files with Agent defaults | `GET /api/agentops/domains`, Agent identity tab |
| `actors/` | 7 Actor visual profiles under `<id>/actor_visual_profile.json` | `GET /api/agentops/actors`, collaboration Actor summary |
| `mappings/` | Tool and knowledge-base migration maps | Tool catalogue, preset generator |

The bundle points `domainDir` at `$DSH_HOME/agentops/domains` and `actorDir` at
`$DSH_HOME/agentops/actors`. The deployment seed copies both trees into the data volume; a missing
directory reads as an empty registry and an invalid file stays visible with its validation issues.

## One command for the five change categories

```powershell
node agentops/scripts/check-owned-paths.mjs
```

The script compares HEAD against the baseline tag `agentops-baseline` and prints one line per category:

```text
OWNED
CORE
INTEGRATION
ENV-ARTIFACT
UNEXPECTED
```

`UNEXPECTED` must stay 0: every change belongs to one of the four registered categories. Pass `--base <ref>` to compare against a different upstream point.

## Rules

1. **AgentOps-owned code** goes only under the prefixes registered in `OWNED-PATHS.txt`; that file is the boundary for a future `subtree split`.
2. **Anything a profile, bundle, or preset can solve must not change a DSH file.**
3. When a DSH source change is unavoidable, register the path in both `CORE-PATHS.txt` and `DSH-CORE-CHANGES.md`, with the reason, the test, and the rollback.
4. Build-wiring files belong in `INTEGRATION-PATHS.txt` and must not masquerade as CORE; environment differences belong in `ENV-ARTIFACTS.txt`.
5. Upgrades follow `UPGRADE.md`; never overwrite an upstream directory wholesale, because that deletes `packages/agentops`.
6. `agentops/` holds governance and assets only; **do not** put plugin packages here that the Loader has to parse — those belong in `packages/agentops/*`, and preset lines accept package names only.
