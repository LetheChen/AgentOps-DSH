# Agent Note: AgentOps log patrol and workflow management migration to DSH

Status: proposed

English | [中文](2026-10-27-agentops-log-patrol-dsh-migration.zh.md)

## Problem

AgentOps implements smart-audit log patrol as fixed scheduled workflows. A business record couples a manual remote active-log path, a local extraction directory, puller and analyst behavior, retries, run history, and notification delivery.

Migrating only the puller would leave DSH with a temporary caller and a second set of idempotency, completion, authorization, recovery, and notification semantics. Deferring workflow management would force the same business identities and history to be reinterpreted again after production use begins.

The production MaxKB source is `/opt/AI_Agent_Platform/logs/app/oa_audit.log`. Rotation means capture cannot promise zero loss across replacement. The first release reads only the current `oa_audit.log`, records an explicit gap when continuity cannot be proved, and requires the business owner to approve the resulting recovery point and missed-detection window.

Source of truth: `<legacy-repo>\docs\00-platform\dsh-migration\DESIGN-agentops-log-patrol-with-workflow-v4.zh.md`, SHA-256 `47E2325C6058B8EFA9769888E1A4B97499AC6CBDBEF9BF373C9F850AB9A46409`. v4 supersedes v3 (`FD55A37A…BE62B6`), which stays in AgentOps as revision history and review input; neither version is a production schema, RPC, or cutover baseline.

This Note is a decision summary and an acceptance boundary. It does not replace the v4 protocol, schema, WBS, test matrix, or runbook, and it cannot close an unresolved code-level defect or missing external evidence recorded in the review ledger.

## Proposal

Migrate log patrol and AgentOps workflow management as one program with one cross-service contract and staged delivery:

```text
Phase 0: external evidence, business decisions, and signed acceptance criteria
Phase A: Host secure-execution loop
Phase B: Workflow management loop
Phase C: workflow asset migration
Phase J: joint fault injection, shadow, recovery, and rollback rehearsal
```

No phase may accept production traffic alone. Promotion is per `source_id` after the release set passes its A/B/C/J gates. The first canary claims only the MaxKB source; every unclaimed workflow asset remains disabled.

### Service and transaction protocol

Host and Workflow Manager remain separate service boundaries even when they share one SQLite file. Shared storage does not make two service calls one atomic transaction. Every execution follows:

```text
W1 -> H1 -> Capture -> W2 -> Hfinal -> Projector
```

- W1: Workflow atomically claims the `schedule_occurrence`, inserts its logical trigger, `workflow_run`, `workflow_attempt`, `dispatch_intent`, and `workflow_event`; it persists `request_id`, `request_fingerprint_sha256`, `payload_sha256`, and `attempt_fence`. Dispatch may start only after this local commit.
- H1: Host takes the source lease and fence, creates `host_run`, preallocates a non-empty immutable `capture_generation_id`, and creates `source_observation_intent`; it does not create an observation.
- Capture: Host uses the immutable `capture_generation_id` reserved by H1, opens a stable no-follow object, reads and hashes the active file, publishes that generation exactly once, then inserts one immutable `source_observation`.
- W2: Workflow hard-checks the committed and immutable `source_observation`, its observation hash, the published capture generation, the complete Host run identity, and the dispatch intent. A bare `source_observation_intent` returns `SOURCE_OBSERVATION_NOT_READY`; W2 may then write only the verified `host_run_identity` and dispatch `acknowledged`.
- Hfinal: Host writes the terminal state, immutable completion receipt, and `projection_pending` together.
- Projector: the only writer of `host_run_ref` after Hfinal; it claims with CAS on `projection_fence + projector_runtime_epoch`, validates the receipt, and projects attempt/run, incident/episode, workflow events, and notification outbox in one Workflow-local transaction.

W2, Host, dispatcher, notifier, and stale Projectors must fail attempts to create or mutate `host_run_ref`. Identity matching without an Hfinal receipt never authorizes a ref. Duplicate or conflicting receipts fail closed and remain available for reconciliation.

`runtime_epoch` identifies the control-store state-root / sole-writer generation, while `projector_runtime_epoch` identifies the projector claim generation; they are not interchangeable. A late `lost -> success` receipt must enter `INTEGRITY_CONFLICT` and `needs_attention`, never silently overwrite a terminal result.

### Source identity and local directories

Operations enters, approves, and versions each remote active-file path. Models cannot generate, infer, or override a host, port, path, credential reference, or approval hash. A source revision binds the business identity, connection, endpoint, path approval, capture policy, and host-key pin revision; every request must carry the currently approved `source_revision` or fail closed.

Deployment configures only `DSH_HOME` and the default snapshot root. The run directory is derived as:

```text
$DSH_HOME/agentops/log-snapshots/<business_id>/<workflow_run_id>/<host_run_id>/
```

The default root is `$DSH_HOME/agentops/log-snapshots`; operators do not enter a local absolute directory per business. Missing, relative, or unsafe `DSH_HOME` configuration fails startup instead of falling back to the current working directory. Run and generation IDs are service-generated, not model supplied.

### Log capture, file identity, and storage

Capture reads only the current active file, fixes an end offset, publishes a complete-line prefix, and records every omitted or uncertain byte as an explicit gap. It does not read rotated archives and does not claim zero loss. An `end_offset`, `size + mtime`, or path approval alone is not a stable file identity.

A strict observation records the source revision, canonical path, inode or file ID, device, size, mtime and its precision, file type, link count, and a bounded `prefix_anchor_length` plus `prefix_anchor_sha256`. This fixed-prefix anchor detects a same-inode `copytruncate` or rewrite; it never becomes a cross-run closed offset. Missing identity fields, insufficient mtime precision, short reads, replacement, truncation, or content change make strict capture non-`completed`.

Local publication uses no-follow opens, identity checks before and after reading, same-filesystem staging, no-clobber rename, file and directory fsync, and an immutable manifest. Before writing, reserve an atomic quota covering the maximum capture, indexes, manifest, findings, report, temporary files, and recovery headroom. Control DB/WAL/SHM and artifacts on the same volume use the worst-case combined increment; `ENOSPC`, inode exhaustion, failed reservation, or an unsafe parent fails closed as `DISK_FULL` without a visible half-generation.

Windows is a development platform only and must reject UNC paths, drive-relative paths, alternate data streams, junctions or other reparse points, hard-link anomalies, case-folding collisions, and parent replacement. Linux production-equivalent evidence must cover SFTP, no-follow reads, file identity, directory durability, permissions, crash recovery, disk exhaustion, and rotation replacement; Windows results never substitute for that evidence.

### Host-key and credential order

The MaxKB owner confirms every SSH endpoint, including every SSH jump host, out of band. Pins live in a controlled, read-only, versioned trust store keyed by `connection_id + endpoint_ref + hop_index`; only the trust-admin control plane can write it. Every SSH hop is checked against its own approved active-pin set, and source revisions, request identity, Host run, receipt, and control-socket reuse bind the approved set ID/revision, matched `pin_id`/revision, algorithm, canonical hop identity, proxy-chain digest, and transport kind. First-use learning, `AutoAddPolicy`, `StrictHostKeyChecking=no`, warning-only continuation, and mismatch downgrade are forbidden.

Pin lifecycle is `staged -> approved active-pin set membership -> approved overlap window -> retired / revoked`. Rotation binds `rotation_from_pin_id` and `rotation_not_before/after`; activation, overlap, retirement, and revocation are audited. Revocation takes effect immediately, invalidates every matching SSH master/control socket, and makes verification or token consumption fail closed.

Credential access is gated by one full-chain verification:

```text
verify all SSH hop and proxy-endpoint identities independently
  -> require every hop to match its approved active-pin set
  -> atomically insert one immutable host_run_hop_trust_verification snapshot
  -> mint one single full-chain verification token from that snapshot
  -> Host-only SecretAccessor atomically consumes the entire token in one CAS
  -> read the Vault password
  -> invoke the SSH password callback
```
The single full-chain verification token binds the complete ordered hop array, `hop_count`, `hop_trust_canonicalization_version`, `approved_hop_trust_expectation_sha256`, `host_run_hop_trust_verification_id`, `hop_trust_identity_sha256`, each hop's approved set ID/revision, matched pin ID/revision, and revocation generation, plus `request_id`, `host_run_id`, issuer, audience, issue time, expiry, and a one-use nonce. Its issuer is the Host verifier, its audience is the Host-only SecretAccessor, and its TTL is shorter than one connection attempt. The SecretAccessor consumes the entire token in one CAS and rechecks every hop's current set revision and revocation generation in that same validation. Missing pins return `HOST_KEY_PIN_MISSING`, mismatches return `HOST_KEY_MISMATCH`, and unavailable or unverifiable trust returns `HOST_KEY_UNVERIFIABLE`. Any such failure, expired token, replay, stale set revision, changed revocation generation, or missing, duplicate, out-of-order, or partially consumed hop makes the whole token invalid: Vault read = 0 and password callback = 0. H1 stores only the approved expectation, never a matched pin, and Capture cannot open the file or read the secret before the immutable full-chain snapshot exists.

`MaxKB password entered` means `stored` only. It does not mean `authorized`, `host_key_verified`, `connection_tested`, or `production_eligible`. Secret views are non-copyable and non-serializable, and sessions, model requests, logs, SSE, manifests, reports, errors, fixtures, notifications, and recovery packages share one redaction sink.

### Analyst findings and projection

The analyst receives bounded untrusted log data and cannot write terminal state, alter coverage, call arbitrary filesystem or notification tools, or read another run. Deterministic scanning and the model produce findings under a closed schema with `findings_schema_version`, enumerated severity, bounded text, evidence references, and a coverage ledger.

The model may produce only `finding_state=hypothesis`; only the Host rule and schema validator can verify a finding, assign its final severity, or decide a business incident. An unknown `findings_schema_version` is rejected, not parsed best-effort. Empty findings, partial coverage, scanner failure, or analyst failure map to `unknown` or `needs_attention`, never a healthy result.

The completion receipt records the full Host run identity, source observation and generation, terminal state, finding schema version, coverage, and receipt hash. The Projector must reject an identity, hash, generation, receipt, or terminal-epoch mismatch before creating `host_run_ref` or projecting a business outcome.

### Workflow management and consumers

Workflow Manager owns immutable workflow revisions, schedules, occurrences, workflow runs, attempts, dispatch intents, receipt projection, cancellation, retry, and the only business notification outbox. New schedules use an explicit IANA time zone rather than inheriting the old parser's implicit UTC behavior.

The old `/api/agent/workflows` API is not forwarded as a compatibility layer. Its consumers migrate explicitly:

- `WorkflowsPage` uses list/get/validate/create/save-draft/archive and distinguishes draft state from immutable revisions.
- `DagEditorModal` removes the hardcoded `yaml_round_trip=true` claim and uses validator capabilities; unsupported round trips become read-only or rejected.
- `SchedulesPage` lists published-only workflow revisions and requires publisher permission for changes.
- `AuditReplayPage` loads the run's stored `workflow_revision_id`, not the current revision.
- `workflow-author` uses validate/publish APIs and stops requiring a backend restart after topology changes.
- Manager Agent receives narrow list/get/trigger/status/cancel/retry/report tools and no host, path, credential, SQL, schedule-mutation, or publish authority.
- Unknown or dynamically constructed old clients are inventoried, tested, or retired before the old endpoint is removed.

Outbox states are exactly `held`, `ready`, `claimed_not_sent`, `send_started`, `sent`, and `failed`. Permanent or integrity failures remain `failed + failure_class`, move the run to `needs_attention`, and require operator handling; `dead_letter`, `suppressed`, and `cancel_requested` are labels or events, not states. The outbox uniqueness key is `(destination_ref, effect_kind, notification_kind, effect_key, cutover_epoch)`, and delivery is at least once.

`runtime_epoch` identifies a control-store state-root / sole-writer generation, `cutover_epoch` identifies one source's production-notification ownership generation, and `notifier_epoch` identifies one source notifier claim generation. A notifier may send only while its claim, cutoff, and epochs remain current.

### Package, PR-0, and documentation ownership

PR-0 is a blocking prerequisite. It establishes a versioned `target manifest` as the single source of truth for bundle and deploy root plugins, preset rows, required peer dependencies, bootstrap links, path mappings, README generation or checks, profile launch arguments, and smoke assertions. It is still deferred: the bundle patch carries nine AgentOps root rows plus the skill-directory row, the deploy patch carries seven root rows and one preset row with six tool rows, and those rows, the bootstrap links, the package peer and dev dependencies, and the generated presets are maintained separately. Until the manifest exists, removing a required row or dependency fails silently instead of failing a gate.

Extend `packages/agentops/host` for secure capture, analyst coordination, finding validation, reports, and receipts. Add versioned contracts, a sole writable control store, and a Workflow Manager package. Extend the AgentOps client for sources, workflow revisions, schedules, run detail, evidence, and audit. Keep the existing read-only database package limited to approved read queries.

AgentOps remains the owner of old-system facts, historical analysis, v1/v2 designs, original review evidence, and archive material. DSH becomes the owner of the current implementation contract, schemas, tests, deployment, runbooks, current migration status, and upgrade rules. Do not bulk-copy the AgentOps migration directory into DSH.

## Alternatives considered

**Migrate only the log puller first.** Rejected because a temporary caller would fix idempotency, completion, notification, and authorization semantics that Workflow management must later replace.

**Implement every workflow and cut over globally in one release.** Rejected because asset fidelity and business acceptance differ by workflow. One contract does not require one deployment switch.

**Let Manager or the puller model own scheduled completion.** Rejected because a model turn is not a durable state transition or a safe recovery authority.

**Treat shared SQLite as one cross-service transaction.** Rejected because local commits remain independently recoverable facts. Reconciliation must use immutable identities and conditional writes.

**Forward the old workflow API unchanged.** Rejected because it exposes undefined mutation, revision, permission, and round-trip semantics and would silently preserve the old file and restart authority.

**Keep a closed offset for the rotating active file.** Rejected for the first release because rotation, truncation, and replacement make cross-run continuity unprovable. The Host captures a bounded generation and records the gap.

**Accept model output as a business finding.** Rejected because a model-generated hypothesis is not verified evidence; only Host validation and deterministic coverage may create a business outcome.

## Acceptance criteria

- Phase 0 records an owner, evidence path, date, and signature for the RPO and missed-detection formula, rotation loss tolerance, remote path approval, connection authority, per-hop host-key evidence source independence and rotation, credential access, notification destination, workflow ownership, rollback, and Linux validation.
- Host tests prove host-key verification precedes SecretAccessor access, Vault reads, and password callbacks; missing pins, mismatches, unverifiable trust, same-source confirmation, expired tokens, replay, stale sets, and revocation changes all produce Vault read = 0 and callback = 0.
- Capture tests prove H1 preallocates a non-empty immutable generation, the generation is published once, and no-follow reads, stable file identity, fixed-prefix copytruncate detection, bounded overlap-digest continuity checks, end-boundary handling, immutable manifests, serialized run directories, crash recovery, atomic quota, explicit rotation gaps, and `continuity_unprovable` hold on Linux.
- Workflow tests prove occurrence claim and logical trigger are one transaction; immutable revisions; IANA scheduling; occurrence uniqueness; attempt fencing; receipt projection; cancellation races; retry classification; and one outbox keyed by `notification_kind`.
- Negative tests prove W2, Host, dispatcher, notifier, and stale Projectors cannot create `host_run_ref`; only one Projector can hold the current `projection_fence + projector_runtime_epoch` CAS; a late `lost -> success` receipt becomes `INTEGRITY_CONFLICT` and `needs_attention`.
- Analyst tests prove the closed `findings_schema_version` schema, unknown-version rejection, `finding_state=hypothesis` for model output, Host-only verification, coverage enforcement, single-line/fragment/tool-return bounds, control-character handling, and non-healthy mapping for empty, partial, or failed analysis.
- Consumer tests cover every row of the workflow migration matrix, including replay revision binding, published-only schedules, real round-trip capabilities, and unknown old clients.
- Asset migration reproduces accepted workflow definitions from frozen source, explains every definition diff, and keeps unclaimed assets disabled.
- PR-0a tests prove the target manifest mechanically validates bundle patch, deploy patch, dependency, bootstrap, preset, README, and profile smoke expectations; removing a required root or dependency fails the gate. PR-0b separately proves the SQLite authorizer rejects unauthorized tables and query forms.
- An operator can back up, restore, reconcile, and roll back a release set on Linux before any primary cutover. Shadow and canary comparisons cover findings, gaps, reports, destinations, and notification counts, and cutover never produces dual production notifications.

## Risks

**Rotation loss.** Replacing the active file can lose bytes between observations. The business must accept the recovery point and missed-detection window, and the run must expose the gap.

**Credential and host-key compromise.** A downgraded host verification could disclose the MaxKB password. Trust anchors stay read-only, rotation is approved, and every mismatch fails closed before credential access.

**Cross-service divergence.** A crash between W1, H1, Capture, W2, Hfinal, and Projector can leave partial state. Unknown outcomes require reconciliation and visible attention, never guessed success.

**Workflow asset fidelity.** The old loader and serializer do not preserve every field. Compatibility requires frozen hashes, fixtures, expected outputs, and an owned disposition for every definition diff.

**Notification duplication or loss.** Delivery is at least once. Destination idempotency, cutover and notifier epochs, failure handling, and operator ownership must be explicit.

**Log content as an attack path.** Log data may contain prompt injection, control characters, secrets, and malformed records. The analyst receives bounded untrusted data, cannot alter completion state, and cannot invoke arbitrary notification or filesystem tools.

**Current status.** This is a proposed design, not an implementation or production approval. v4 closed 16 design and documentation findings from R6 and folded in the 2026-10-28 read-only production measurements; the code-level R6-09–13 and the external-evidence R6-18/20/23 remain open. Three independent red teams then reviewed v4 on 2026-10-29 — static verification, measured execution, and reverse reconstruction — and returned 9 blockers and 12 severe findings, so `R6: NOT PASS / R7: NOT PASS / Phase 0: OPEN / G0 未通过` remains in force. Phase 0 evidence, Linux production-equivalent validation, joint A/B/C/J gates, PR-0a and PR-0b, an explicit canary decision, and closure of the open findings are still required. The review ledger is `<legacy-repo>\docs\00-platform\dsh-migration\REVIEW-agentops-log-patrol-with-workflow-2026-10-28.md` and the v4 review is its `REVIEW-R7-design-v4-2026-10-29.md`. No production schema, RPC, or cutover authority is frozen.
