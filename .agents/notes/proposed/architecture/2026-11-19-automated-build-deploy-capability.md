# Agent Note: Automated build and deployment capability

Status: proposed

English | [中文](2026-11-19-automated-build-deploy-capability.zh.md)

Review status: R1 adversarial review completed on 2026-11-19. This revision addresses the accepted blockers.

## Problem

The target deployment environment has a configured SSH capability instance for production. Enterprise Service Hub Platform also has a Docker bundle in its own repository, but the repository does not yet provide a safe AgentOps release capability around it. Static repository evidence cannot prove the production binding or the target host state; those remain deployment inputs that the capability must resolve and verify at run time.

A skill-only release is insufficient. Skills are optional instructions; they carry no deployment instance, durable release record, concurrency lock, remote command contract, migration policy, rollback pointer, or health evidence. A fixed DAG alone is also insufficient: the current AgentOps DAG runs agent nodes, while deployment authority, SSH binding, artifact integrity, release state, and rollback evidence must remain deterministic outside model reasoning.

The current external bundle also lacks the contract this design requires:

- `docker/build/build.sh` exports `eshp.tar` but does not write a release manifest.
- `docker/image/manifest.json` records exported file hashes but is not consumed by deployment scripts.
- `deploy.sh` requires `eshp.tar`, `mysql.tar`, `redis.tar`, Compose, `deploy.sh`, and an env file; the sample instance names only `eshp.tar`.
- `update.sh` migrates without a backup step and records no dated backup tag or current image id before replacing `eshp:latest`.
- `rollback.sh` does not exist.
- Neither deployment script takes a remote lock.
- The generic SSH provider introduces no SSH-specific model tool, and `ssh_exec` is not mapped for model use.

## Proposal

Implement an AgentOps release capability in two trust domains, then add an operator skill and constrained presets. A fixed DAG remains a later orchestration option and is not required for the first release slice.

### Separate artifact production from production deployment

Artifact production and production release have different trust and permission needs.

- `artifact_build` runs in a configured local project root, executes a configured build entrypoint, collects exact output files, and writes a release manifest. It receives no production SSH credential.
- `deployment_*` tools consume only a verified release manifest and artifact set. They never build source and never accept an arbitrary command from the model.
- `build_operator` owns the build toolset in a local workspace.
- `deploy_operator` owns only deployment tools and has no generic shell, no write/edit tools, no capability-center administration, and no generic SSH execution.

If an operator wants one end-to-end automation, a parent Agent or later workflow invokes both roles. It does not merge their production authority.

### Capability instances and access

A `deployment` capability instance stores non-secret release data and an opaque SSH instance id. It also records tenant, owner domain, allowed presets, and allowed operations.

The `deploy_operator` preset must be bound to both:

1. the deployment instance; and
2. the referenced SSH instance.

Runtime resolution requires both bindings and verifies the SSH host-key pin and credential generation before any remote mutation. A future cross-capability reference grant must be a separate audited feature; the first version does not add an owner bypass.

Release and rollback require `ctx.approval.request()`. Only `allowed-once` proceeds. `rejected`, `cancelled`, and `unavailable` fail closed. The journal records the approval outcome without secrets.

### Persistence

The capability store remains the source for definitions, instances, bindings, and credentials. Release execution uses a separate `deployment.db` under the Harness home because capability writes are short control-plane transactions, while release state must survive process death and SSH ambiguity.

`deployment.db` has a monotonically increasing `SCHEMA_VERSION` and stores:

- deployment releases;
- artifact manifests;
- leases and fencing tokens;
- health checks;
- rollback points;
- approval receipts;
- terminal run evidence.

`ctx.jobs`, when composed, is only a live progress view. It is never the authoritative release record.

### Tool surface

The first slice exposes five model-facing tools:

| Tool | Effect |
|---|---|
| `artifact_build` | Build from the configured local root, verify outputs, and write a release manifest. No SSH. |
| `deployment_plan` | Read-only plan: validate both bindings, artifact manifest hashes, SSH host key, remote lock, target directories, env source, backup capacity, current release, and migration policy. |
| `deployment_release` | Require approval, claim the release lease, upload verified artifacts, invoke the configured release entrypoint, and persist every step. |
| `deployment_status` | Read the current and previous healthy releases, journal state, image id, migration revision, and latest health evidence. |
| `deployment_rollback` | Require approval and invoke the configured rollback entrypoint for a recorded healthy release. Database restore is not part of this tool. |

Listing instances is part of `deployment_plan` with no selected instance; a separate list tool is not needed for the first slice.

### Versioned instance contract

Commands are configured argv arrays with an explicit remote exec policy. They are not model arguments.

```json
{
  "schemaVersion": 1,
  "instanceId": "eshp-production",
  "tenantKey": "gsafety",
  "ownerDomain": "smart_ops",
  "sshInstanceId": "int_fb7f38478f7a44e0af7d84acbacb7ba8",
  "access": {
    "presets": ["deploy_operator"],
    "operations": ["plan", "release", "status", "rollback"]
  },
  "artifact": {
    "updateFiles": ["image/eshp.tar"],
    "firstInstallFiles": [
      "image/eshp.tar",
      "image/mysql.tar",
      "image/redis.tar",
      "docker-compose.yml",
      "deploy.sh",
      "deploy.env.template"
    ],
    "manifest": "image/release-manifest.json",
    "manifestDigestFile": "image/release-manifest.sha256",
    "bundleRoot": "docker"
  },
  "environment": {
    "installedEnvFile": "/opt/eshp/.env",
    "firstInstallSecretRef": "capability-secret:eshp-prod-env",
    "firstInstallEnvFile": "/tmp/eshp-release/{releaseId}/prod.env",
    "remotePermissions": "0600",
    "cleanup": "always"
  },
  "remote": {
    "workRoot": "/tmp/eshp-release",
    "targetPath": "/opt/eshp",
    "lockPath": "/run/lock/eshp-release.lock",
    "commandTimeoutMs": 1800000,
    "sudoMode": "non-interactive",
    "firstInstallCommand": [
      "sudo", "{workDir}/docker/deploy.sh",
      "--bundle", "{workDir}/docker",
      "--env-file", "{firstInstallEnvFile}",
      "--base-dir", "{targetPath}"
    ],
    "updateCommand": [
      "sudo", "{workDir}/docker/update.sh",
      "--image", "{workDir}/docker/image/eshp.tar",
      "--release-id", "{releaseId}",
      "--backup-dir", "{targetPath}/backups/mysql",
      "--base-dir", "{targetPath}",
      "--env-file", "{targetPath}/.env"
    ],
    "rollbackCommand": [
      "sudo", "{workDir}/docker/rollback.sh",
      "--release-id", "{rollbackReleaseId}",
      "--base-dir", "{targetPath}",
      "--env-file", "{targetPath}/.env"
    ]
  },
  "migration": {
    "mode": "always",
    "backupBeforeMigrate": true,
    "backupRetentionDays": 7
  },
  "health": {
    "timeoutMs": 180000,
    "checks": [
      ["curl", "-fsS", "http://127.0.0.1:8000/version"],
      ["curl", "-fsS", "http://127.0.0.1:8000/health/live"],
      ["curl", "-fsS", "http://127.0.0.1:8000/health/ready"]
    ]
  }
}
```

The deployment instance stores no secret value. `firstInstallSecretRef` resolves through the credential provider only for the release operation; the staged env file is mode `0600`, never echoed, and removed on every completion path.

### Remote execution

The remote executor uses an argv array and a closed placeholder set. Placeholders resolve only from trusted instance state and generated release state:

- `workDir`
- `targetPath`
- `releaseId`
- `rollbackReleaseId`
- `firstInstallEnvFile`

The executor rejects unknown placeholders, control characters, empty arguments, non-absolute remote paths, and arguments outside the configured command family. If the underlying SSH transport exposes only `exec(command: string)`, the adapter applies POSIX argument quoting for every argv element and tests hostile path and release-id inputs. A deployment helper with `execFile`-style semantics is preferred when available.

The deployment instance must pin the remote script's absolute path, version, and non-empty SHA-256. `deployment_plan`, `deployment_release`, and `deployment_rollback` verify the digest through `sudo -n sha256sum` before any lease, upload, or remote mutation. A mismatch fails closed; the operator must update the script version and instance digest together. The remote script runs with non-interactive sudo. Preflight also checks `sudo -n true`, Docker, Compose v2, curl, lock-directory writability, disk capacity, and the target env file.

### Release script ownership

The remote release script owns the ordered remote steps; the capability does not duplicate them. The script must:

1. acquire the configured remote lock with a timeout;
2. verify the release manifest and every artifact hash again;
3. create and verify a MySQL backup before migration when policy requires it;
4. run the migration or explicitly skip it under policy control;
5. record the current running image id, tag that image id with a timestamped backup tag, then import the new `latest` image;
6. recreate only ESHP;
7. emit structured JSON-line progress and return a terminal exit code.

The deployment service invokes that script, parses the progress records into the journal, and records stdout/stderr by retention policy. It does not re-run migration or recreate independently.

### Release identity and integrity

`artifact_build` writes a release manifest after all outputs exist. The manifest contains:

- `releaseId`;
- `gitSha`;
- `dirty`;
- `builtAt`;
- `builder`;
- `imageName`;
- `imageId`;
- `artifactFiles[]` with `path`, `bytes`, and `sha256`.

The manifest digest is stored in a separate `release-manifest.sha256` file. There is no self-hash field. Local and remote verification compute the same bytes over the same manifest file, then verify every artifact file before import.

### Latest runtime tag and image-id rollback

Compose may continue to run `eshp:latest`. Before `docker load` replaces that tag, the release script resolves the running container image id and creates a backup tag such as `eshp:backup-20261119-153045-ab12cd34`. The tag uses a timestamp and a short image id, not a date alone, so two releases on one day cannot collide.

The release journal records the backup tag, full image id, current release id when known, and whether the pre-release health checks passed. A backup tag is a convenience pointer; the image id is the rollback identity. `rollback.sh` resolves a recorded healthy backup to its image id, acquires the same remote lock, retags that image id as `eshp:latest`, and recreates ESHP. It never restores MySQL. Database restore is a separate explicit operation with its own approval and backup selection.

### Migration, backup, and unknown outcomes

ESHP starts with `migration.mode = always` and `backupBeforeMigrate = true`. A release that changes schema cannot report success unless the backup completed and produced a non-empty artifact with a verifiable checksum.

If SSH disconnects after a mutating step, the journal enters `unknown_hold`. The service does not release the lease, retry the command, or report success. `deployment_status` must be used before recovery. The remote lock remains the safety net while the script is alive.

### Health evidence

A release is healthy only when:

- the configured health checks exit successfully;
- `/version` reports the expected `releaseId`;
- `docker inspect` reports the expected image id for `eshp`;
- the migration revision matches the release journal.

Container `.State.Health.Status` alone is insufficient.

### Skill and presets

`production-deployment` documents when to call release tools, approval requirements, backup expectations, status-first recovery after `unknown_hold`, and the release report. It contains no production paths, credentials, or command bodies.

The generated `deploy_operator` preset is tested negatively: it must expose no `bash`, `pwsh`, write/edit, generic SSH, capability administration, or arbitrary instance switching.

### Workflow entry conditions

A fixed DAG is deferred until the capability has a persistent release journal, remote lock, backup/restore, rollback, real composition tests, and at least one non-interactive approval path. When introduced, its release node calls `deployment_release`; it does not embed SSH commands or deployment paths.

## Alternatives considered

**Use only a deployment skill.** Rejected because a skill cannot enforce instance authorization, artifact hashes, migration backup, concurrency locks, approval, or rollback evidence.

**Hard-code the release as a DAG first.** Rejected because current DAG command nodes are not implemented, and model-authored nodes cannot hold deployment authority, SSH paths, migration policy, and rollback state.

**Use one Agent preset with both build and production release authority.** Rejected because build scripts delete and rewrite build directories and need local workspace writes, while production release needs the SSH credential. Combining both violates least privilege.

**Store free-form shell commands in the instance.** Rejected because placeholder injection and shell parsing create command-injection and drift paths. The instance stores argv arrays and a closed placeholder set.

**Let the model supply host, target path, or credential.** Rejected because deployment authority belongs to the capability instance and preset bindings, not to model input.

**Put scripts only in `docker/README.md`.** Rejected because prose is not executable authority. The README explains recovery and design; the instance and scripts define the executable contract.

**Use the generic SSH capability as the deployment tool.** Rejected because arbitrary SSH execution bypasses release identity, artifact verification, migration policy, and rollback state. The current repository also does not expose `ssh_exec` to models.

**Rely on `ctx.jobs` as the release record.** Rejected because the in-process job registry can lose settlement on process death. Jobs may show live progress, but `deployment.db` owns durable state.

**Use only a date or the mutable `previous` tag as the rollback pointer.** Rejected because a date-only tag can collide and `previous` can be overwritten by a failed retry. Rollback selects a recorded healthy backup tag plus its full image id; `latest` remains the runtime tag.

## Acceptance criteria

- Schema validation rejects incomplete first-install artifact sets, relative or non-absolute remote paths, unknown placeholders, empty argv entries, unknown fields, missing lock path, invalid env permissions, and unsupported sudo mode.
- Tests prove release and rollback require `deploy_operator` to hold both deployment and referenced SSH bindings; missing SSH binding fails before any remote connection.
- Tests prove release and rollback call `ctx.approval.request()` and reject every outcome except `allowed-once`, including `unavailable`.
- Tests prove SSH host-key pin and credential generation are checked before mutation, and rotation or fingerprint change fails closed.
- Build tests prove release manifest creation, separate manifest digest verification, dirty/source revision recording, and output containment under the configured local root.
- Artifact tests prove first install rejects missing `eshp.tar`, `mysql.tar`, or `redis.tar`, and the installed env file comes from the configured secret reference with mode `0600` and cleanup on success, failure, and cancellation.
- Remote release tests prove the configured remote lock rejects a second process and that the deployment journal records `unknown_hold` on SSH loss without retry.
- Migration tests prove backup failure prevents migration, migration failure prevents image import/recreate, and policy controls `--skip-migrate` rather than model input.
- Health tests prove `/version`, image id, migration revision, and every configured check are matched before `healthy`.
- Rollback tests prove the running image id is tagged before `latest` is replaced, date collisions are rejected in favor of timestamp-plus-image-id tags, and database restore remains a separate approval path.
- `deployment_status` reports current release, previous healthy backup tag, full image id, migration revision, journal state, and last confirmed step after process restart.
- The generated `deploy_operator` preset snapshot proves no generic shell, write/edit, capability administration, or generic SSH tools.
- The deployment skill is packaged through `packages/agentops/skills`, copied into the runtime skill directory, and covered by preset generation tests.
- Package README/JSDoc, capability catalogue, bundle patch, preset generator, deployment seed, and capability UI tests are updated in the same change.
- A real profile-boot test exercises the capability store, deployment journal, tools, and preset bindings without production credentials; real production release remains operator-triggered.
- Recorded-session snapshots cover tool schemas, skill guidance, successful release evidence, approval rejection, health failure, and `unknown_hold`.
- A fixed workflow is not added until the release journal, remote lock, backup/restore, rollback, and real composition tests pass.

## Risks

**Build and deployment remain different trust domains.** A compromised build can still produce a malicious artifact. Manifest hashes and source revision improve traceability but do not prove source honesty; source review and build-environment integrity remain separate controls.

**The remote script is now the ordered authority.** A bug in `update.sh` or `rollback.sh` can bypass service expectations. The script and capability must share one manifest contract and integration tests; the service must not silently replicate steps.

**Database restore can destroy newer writes.** Application rollback and database restore remain separate decisions. Automatic database restore is forbidden.

**SSH ambiguity blocks releases.** `unknown_hold` intentionally prioritizes safety over availability. An operator must inspect the remote lock, journal, and current image before recovery.

**The remote lock depends on target host behavior.** `/run/lock` may not be writable, and `flock` may be unavailable. Preflight must fail closed and allow an instance-specific lock path.

**Manifest hashing proves transport integrity; it does not prove that the recorded source revision and builder identity are true.** The first slice records source revision and builder identity; cryptographic signing or attestation remains deferred until the build environment has a stable trust root.

**The capability journal is deployment-local.** A second control plane can still race unless the remote script lock is authoritative. The design accepts that the remote lock is the final fence.

**Health checks can be incomplete.** `/version`, image id, and migration revision bind health to the intended release, but they do not prove business correctness. The skill requires a post-release smoke check where the project defines one.

**Redis persistence is project-specific.** The first ESHP contract requires MySQL backup, not Redis backup. If Redis stores state that cannot be rebuilt, the deployment instance must add a Redis backup and restore policy before release is enabled.

**A single tenant or owner-domain may be too narrow.** The schema carries tenant and owner domain so ACL can be added without migrating release identity; an installation that needs cross-tenant release authority must define that policy explicitly.

**The fixed workflow can become a second authority.** If it embeds commands or paths, the capability and workflow will drift. The workflow must call the same tools with the same instance ids.
