/**
 * One-way migration from the shapes the task database can have on disk into the
 * versioned target schema.
 *
 * The migrator never mutates the source: it plans against a read-only handle,
 * builds a staging file, verifies it, and only then replaces the target as a
 * file group (main database plus `-wal`/`-shm`). A backup of the original group
 * is taken first, so a failed verification leaves a readable source.
 *
 * Shapes:
 * - `simplified` — the current DSH store (`tasks.id`, `tasks.parent_id`).
 * - `target`     — already `SCHEMA_VERSION`; nothing to do.
 * - `unknown`    — refused; never opened as if it were valid.
 *
 * @module @agentops/dsh-task/migrate
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TASK_TABLES } from './contracts.ts'
import { P0_STATUSES } from './lifecycle/p0.ts'
import { SCHEMA_VERSION, createTaskSchema, readUserVersion } from './schema.ts'
import { TASK_STATUSES } from './status.ts'

/** Detected on-disk shape of the task database. */
export type SourceShape = 'simplified' | 'legacy-p0' | 'legacy-v1' | 'target' | 'unknown'

/** Rows copied per table, used to verify a migration. */
export interface CopiedTable {
  readonly table: string
  readonly rows: number
  /** Target may hold more rows than the source (appended migration events). */
  readonly atLeast?: boolean
}

/** One machine-readable migration plan. */
export interface MigrationPlan {
  readonly sourcePath: string
  readonly shape: SourceShape
  readonly sourceVersion: number
  readonly targetVersion: number
  readonly counts: { readonly tasks: number; readonly stages: number; readonly events: number }
  readonly copied: readonly CopiedTable[]
  readonly issues: readonly string[]
  readonly actions: readonly string[]
}

/** Values that no longer have a target column, kept for audit instead of being dropped silently. */
export interface MigrationManifest {
  readonly droppedTerminalReportPointers: readonly {
    report_id: string
    task_id: string
    terminal_session_id: string
  }[]
}

/** Outcome of `applyMigration`. */
export interface MigrationResult {
  readonly plan: MigrationPlan
  readonly applied: boolean
  readonly verified: boolean
  readonly backupDir?: string
  readonly targetPath: string
  readonly manifest: MigrationManifest
}

const EMPTY_MANIFEST: MigrationManifest = { droppedTerminalReportPointers: [] }

interface SourceTask {
  id: string
  project_id: string | null
  parent_id: string | null
  title: string
  description: string
  status: string
  risk_level: string
  stage: string
  assignee: string | null
  version: number
  created_at: string
  updated_at: string
  closed_at: string | null
}

interface SourceStage {
  task_id: string
  seq: number
  name: string
  status: string
  note: string | null
  entered_at: string
  left_at: string | null
}

interface SourceEvent {
  seq: number
  task_id: string
  kind: string
  from_status: string | null
  to_status: string | null
  actor: string
  reason: string | null
  at: string
}

const STAGE_STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'pending',
  running: 'running',
  committed: 'committed',
  failed: 'failed',
  done: 'committed',
}

/**
 * Open a database read-only for inspection.
 * @param path - database file.
 * @returns a read-only handle.
 */
function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

/**
 * List user tables in a database.
 * @param db - open handle.
 * @returns table names without internal tables.
 */
function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  return rows.map(row => row.name)
}

/**
 * Detect the on-disk shape without writing.
 * @param path - database file.
 * @returns the detected shape.
 */
export function detectShape(path: string): SourceShape {
  if (!existsSync(path)) throw new Error(`task database not found: ${path}`)
  const db = openReadOnly(path)
  try {
    const tables = tableNames(db)
    if (!tables.includes('tasks')) return 'unknown'
    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(row => row.name)
    if (columns.includes('lifecycle_mode')) {
      const version = readUserVersion(db)
      if (!columns.includes('task_id')) return 'unknown'
      if (version === SCHEMA_VERSION) return 'target'
      if (version === 1) return 'legacy-v1'
      return 'unknown'
    }
    if (columns.includes('task_id')) {
      return columns.includes('approved') || columns.includes('archived_at') ? 'legacy-v1' : 'legacy-p0'
    }
    return columns.includes('id') ? 'simplified' : 'unknown'
  } finally {
    db.close()
  }
}

/**
 * Build a plan without touching the source or the target.
 * @param path - source database file.
 * @returns the plan, including any rejected rows.
 */
export function planMigration(path: string): MigrationPlan {
  const shape = detectShape(path)
  if (shape === 'unknown') {
    throw new Error(
      `unrecognized task database shape at ${path}; refusing to open it as the target schema`,
    )
  }
  const db = openReadOnly(path)
  try {
    if (shape === 'target') {
      return {
        sourcePath: path,
        shape,
        sourceVersion: readUserVersion(db),
        targetVersion: SCHEMA_VERSION,
        counts: { tasks: count(db, 'tasks'), stages: count(db, 'task_stages'), events: count(db, 'task_events') },
        copied: [],
        issues: [],
        actions: ['already at target schema; nothing to do'],
      }
    }
    if (shape === 'simplified') return planSimplified(db, path)
    return planLegacy(db, path, shape)
  } finally {
    db.close()
  }
}

/**
 * Plan a simplified-store migration.
 * @param db - read-only source handle.
 * @param path - source path recorded in the plan.
 * @returns the plan.
 */
function planSimplified(db: DatabaseSync, path: string): MigrationPlan {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all() as unknown as SourceTask[]
  const stages = db.prepare('SELECT * FROM task_stages ORDER BY task_id, seq').all() as unknown as SourceStage[]
  const events = db.prepare('SELECT * FROM task_events ORDER BY seq').all() as unknown as SourceEvent[]
  const issues: string[] = []

  for (const task of tasks) {
    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      issues.push(`task ${task.id}: unknown status ${JSON.stringify(task.status)}`)
    }
    if (!Number.isInteger(task.version) || task.version < 0) {
      issues.push(`task ${task.id}: version ${String(task.version)} must be a non-negative integer`)
    }
  }
  for (const stage of stages) {
    if (STAGE_STATUS_MAP[stage.status] === undefined) {
      issues.push(`stage ${stage.task_id}#${stage.seq}: unknown status ${JSON.stringify(stage.status)}`)
    }
  }

  return {
    sourcePath: path,
    shape: 'simplified',
    sourceVersion: readUserVersion(db),
    targetVersion: SCHEMA_VERSION,
    counts: { tasks: tasks.length, stages: stages.length, events: events.length },
    copied: [
      { table: 'tasks', rows: tasks.length },
      { table: 'task_stages', rows: stages.length },
      { table: 'task_events', rows: events.length, atLeast: true },
    ],
    issues,
    actions: [
      `create ${TASK_TABLES.length} target tables with ${SCHEMA_VERSION} as user_version`,
      'create one project row per distinct project_id (metadata marks it as a legacy placeholder)',
      'map tasks.version >= 1 to version - 1; keep 0; reject negative',
      'map task_stages.status done -> committed; wrap note into stage_output JSON',
      'append one legacy_import event per task that still carries stage text',
    ],
  }
}

/**
 * Plan a legacy AgentOps migration (P0 or V1).
 * @param db - read-only source handle.
 * @param path - source path recorded in the plan.
 * @param shape - detected legacy mode.
 * @returns the plan.
 */
function planLegacy(db: DatabaseSync, path: string, shape: 'legacy-p0' | 'legacy-v1'): MigrationPlan {
  const allowed = shape === 'legacy-p0' ? new Set<string>(P0_STATUSES) : new Set<string>(TASK_STATUSES)
  const sourceTables = tableNames(db)
  const copied: CopiedTable[] = []
  for (const table of TASK_TABLES) {
    if (sourceTables.includes(table)) copied.push({ table, rows: count(db, table) })
  }

  const issues: string[] = []
  const tasks = db.prepare('SELECT task_id, status, version, project_id FROM tasks').all() as unknown as {
    task_id: string
    status: string
    version: number
    project_id: string | null
  }[]
  for (const task of tasks) {
    if (!allowed.has(task.status)) {
      issues.push(`task ${task.task_id}: status ${JSON.stringify(task.status)} is not valid in ${shape}`)
    }
    if (!Number.isInteger(task.version) || task.version < 0) {
      issues.push(`task ${task.task_id}: version ${String(task.version)} must be a non-negative integer`)
    }
  }
  if (sourceTables.includes('task_stages')) {
    const stages = db.prepare('SELECT task_id, stage_id, status FROM task_stages').all() as unknown as {
      task_id: string
      stage_id: string
      status: string
    }[]
    for (const stage of stages) {
      if (STAGE_STATUS_MAP[stage.status] === undefined) {
        issues.push(`stage ${stage.stage_id}: unknown status ${JSON.stringify(stage.status)}`)
      }
    }
  }

  const projects = sourceTables.includes('projects')
    ? new Set((db.prepare('SELECT project_id FROM projects').all() as { project_id: string }[]).map(row => row.project_id))
    : new Set<string>()
  const placeholders = [...new Set(tasks.map(task => task.project_id).filter((id): id is string => id !== null && !projects.has(id)))]

  return {
    sourcePath: path,
    shape,
    sourceVersion: readUserVersion(db),
    targetVersion: SCHEMA_VERSION,
    counts: {
      tasks: tasks.length,
      stages: sourceTables.includes('task_stages') ? count(db, 'task_stages') : 0,
      events: sourceTables.includes('task_events') ? count(db, 'task_events') : 0,
    },
    copied,
    issues,
    actions: [
      `copy ${copied.length} legacy tables into the ${SCHEMA_VERSION} schema`,
      `set lifecycle_mode = '${shape === 'legacy-p0' ? 'p0' : 'v1'}' for every task`,
      'keep 0-based task versions unchanged',
      placeholders.length === 0
        ? 'no project placeholders needed'
        : `create ${placeholders.length} auditable placeholder project(s): ${placeholders.join(', ')}`,
      'carry legacy run pointers in task_runs and record dropped report pointers in the migration manifest',
    ],
  }
}

/**
 * Count rows in a table.
 * @param db - open handle.
 * @param table - table name.
 * @returns the row count.
 */
function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

/**
 * Migrate a database into the target schema.
 * @param path - database file to migrate in place.
 * @param options - `dryRun` plans only; `backupDir` overrides the backup location.
 * @returns the plan and the outcome; throws when the plan has issues or verification fails.
 */
export function applyMigration(
  path: string,
  options: { dryRun?: boolean; backupDir?: string } = {},
): MigrationResult {
  const plan = planMigration(path)
  if (plan.shape === 'target') {
    return { plan, applied: false, verified: true, targetPath: path, manifest: EMPTY_MANIFEST }
  }
  if (plan.issues.length > 0) {
    throw new Error(`migration refused: ${plan.issues.join('; ')}`)
  }
  if (options.dryRun === true) return { plan, applied: false, verified: false, targetPath: path, manifest: EMPTY_MANIFEST }

  const stagingPath = `${path}.staging-${Date.now()}`
  const backupDir = options.backupDir ?? mkdtempSync(join(tmpdir(), 'task-db-backup-'))
  const source = openReadOnly(path)
  const staging = new DatabaseSync(stagingPath)
  const manifest: MigrationManifest = { droppedTerminalReportPointers: [] }
  try {
    createTaskSchema(staging)
    if (plan.shape === 'simplified') copySimplified(source, staging)
    else if (plan.shape === 'legacy-p0' || plan.shape === 'legacy-v1') copyLegacy(source, staging, plan.shape, manifest)
    else throw new Error(`unsupported migration shape ${plan.shape}`)
  } catch (error) {
    staging.close()
    source.close()
    rmSync(stagingPath, { force: true })
    throw error
  }
  staging.close()
  source.close()

  verify(stagingPath, plan)
  backupFileGroup(path, backupDir)
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  renameSync(stagingPath, path)
  const verified = verify(path, plan, { readOnly: true })
  return { plan, applied: true, verified, backupDir, targetPath: path, manifest }
}

/**
 * Copy the simplified store into an empty target database.
 * @param source - read-only source handle.
 * @param target - target handle with the schema already created.
 */
function copySimplified(source: DatabaseSync, target: DatabaseSync): void {
  const tasks = source.prepare('SELECT * FROM tasks ORDER BY id').all() as unknown as SourceTask[]
  const stages = source.prepare('SELECT * FROM task_stages ORDER BY task_id, seq').all() as unknown as SourceStage[]
  const events = source.prepare('SELECT * FROM task_events ORDER BY seq').all() as unknown as SourceEvent[]

  target.exec('BEGIN')
  try {
    const projects = new Set<string>()
    for (const task of tasks) projects.add(task.project_id ?? 'legacy_default')
    const insertProject = target.prepare(
      `INSERT INTO projects(project_id, name, type, metadata, created_at, updated_at)
       VALUES (?, ?, 'code', ?, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
    )
    for (const project of projects) {
      insertProject.run(project, project, JSON.stringify({ legacy_project: { source: 'simplified' } }))
    }

    const insertTask = target.prepare(
      `INSERT INTO tasks(
         task_id, project_id, source_candidate_id, lifecycle_mode, parent_task_id, title, description, status,
         task_type, risk_level, assignee_name, version, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 'v1', ?, ?, ?, ?, 'code', ?, ?, ?, ?, ?, ?)`,
    )
    for (const task of tasks) {
      const candidateId = stageLegacyTaskCandidate(target, {
        taskId: task.id,
        projectId: task.project_id ?? 'legacy_default',
        title: task.title,
        description: task.description,
        riskLevel: task.risk_level,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      })
      insertTask.run(
        task.id,
        task.project_id ?? 'legacy_default',
        candidateId,
        task.parent_id,
        task.title,
        task.description,
        task.status,
        ['low', 'medium', 'high'].includes(task.risk_level) ? task.risk_level : 'medium',
        task.assignee,
        Math.max(0, task.version - 1),
        task.created_at,
        task.updated_at,
        task.closed_at,
      )
      finalizeLegacyTaskCandidate(target, candidateId, task.id, task.updated_at)
    }

    const insertStage = target.prepare(
      `INSERT INTO task_stages(stage_id, task_id, stage_type, status, stage_output, started_at, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const stage of stages) {
      const mapped = STAGE_STATUS_MAP[stage.status]
      if (mapped === undefined) throw new Error(`unknown stage status ${JSON.stringify(stage.status)}`)
      insertStage.run(
        `${stage.task_id}:${stage.seq}`,
        stage.task_id,
        stage.name,
        mapped,
        stage.note === null ? null : JSON.stringify({ note: stage.note }),
        stage.entered_at,
        stage.left_at,
      )
    }

    const insertEvent = target.prepare(
      `INSERT INTO task_events(event_id, task_id, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const event of events) {
      const payload = event.from_status === null && event.to_status === null && event.reason === null
        ? null
        : JSON.stringify({ from: event.from_status, to: event.to_status, reason: event.reason })
      insertEvent.run(`${event.task_id}:${event.seq}`, event.task_id, event.kind, event.actor, payload, event.at)
    }

    for (const task of tasks) {
      if (task.stage === '') continue
      insertEvent.run(
        `${task.id}:legacy_stage`,
        task.id,
        'legacy_import',
        'migration',
        JSON.stringify({ stage: task.stage }),
        task.updated_at,
      )
    }
    target.exec('COMMIT')
  } catch (error) {
    target.exec('ROLLBACK')
    throw error
  }
}

/**
 * Copy a legacy AgentOps database into an empty target database.
 *
 * Columns are copied by intersection with the target definition, so a legacy
 * table that gained extra columns does not break the copy; the two exceptions
 * are handled explicitly: `projects` extra columns move into
 * `metadata.legacy_project`, and report terminal pointers are recorded in the
 * manifest because the target has no such column.
 * @param source - read-only source handle.
 * @param target - target handle with the schema already created.
 * @param shape - detected legacy mode.
 * @param manifest - mutable manifest collecting values without a target column.
 */
function copyLegacy(
  source: DatabaseSync,
  target: DatabaseSync,
  shape: 'legacy-p0' | 'legacy-v1',
  manifest: MigrationManifest,
): void {
  const mode = shape === 'legacy-p0' ? 'p0' : 'v1'
  const sourceTables = new Set(tableNames(source))
  const dropped = manifest.droppedTerminalReportPointers as {
    report_id: string
    task_id: string
    terminal_session_id: string
  }[]
  target.exec('BEGIN')
  try {
    if (sourceTables.has('global_revision')) {
      const row = source.prepare('SELECT revision FROM global_revision WHERE singleton = 1').get() as
        | { revision: number }
        | undefined
      if (row !== undefined) target.prepare('UPDATE global_revision SET revision = ? WHERE singleton = 1').run(row.revision)
    }

    const projects = sourceTables.has('projects')
      ? (source.prepare('SELECT * FROM projects').all() as unknown as Record<string, unknown>[])
      : []
    const projectIds = new Set(projects.map(project => String(project.project_id)))
    for (const project of projects) insertMapped(target, 'projects', project, { extraToMetadata: true })

    const tasks = source.prepare('SELECT * FROM tasks').all() as unknown as Record<string, unknown>[]
    for (const task of tasks) {
      const projectId = typeof task.project_id === 'string' && task.project_id !== '' ? task.project_id : 'legacy_default'
      if (!projectIds.has(projectId)) {
        target.prepare(
          `INSERT INTO projects(project_id, name, type, metadata, created_at, updated_at)
           VALUES (?, ?, 'code', ?, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
        ).run(projectId, projectId, JSON.stringify({ legacy_project: { source: 'legacy', reason: 'missing project reference' } }))
        projectIds.add(projectId)
      }
      const taskId = String(task.task_id)
      const candidateId = stageLegacyTaskCandidate(target, {
        taskId,
        projectId,
        title: typeof task.title === 'string' ? task.title : taskId,
        description: typeof task.description === 'string' ? task.description : '',
        riskLevel: typeof task.risk_level === 'string' ? task.risk_level : 'medium',
        createdAt: typeof task.created_at === 'string' ? task.created_at : new Date(0).toISOString(),
        updatedAt: typeof task.updated_at === 'string' ? task.updated_at : new Date(0).toISOString(),
      })
      insertMapped(target, 'tasks', task, {
        overrides: { lifecycle_mode: mode, project_id: projectId, source_candidate_id: candidateId },
        drop: ['terminal_session_id'],
      })
      finalizeLegacyTaskCandidate(target, candidateId, taskId, typeof task.updated_at === 'string' ? task.updated_at : new Date(0).toISOString())
    }

    if (sourceTables.has('task_stages')) {
      for (const stage of source.prepare('SELECT * FROM task_stages').all() as unknown as Record<string, unknown>[]) {
        const mapped = STAGE_STATUS_MAP[String(stage.status)]
        if (mapped === undefined) throw new Error(`unknown stage status ${JSON.stringify(stage.status)}`)
        insertMapped(target, 'task_stages', stage, { overrides: { status: mapped } })
      }
    }

    if (sourceTables.has('task_runs')) {
      for (const run of source.prepare('SELECT * FROM task_runs').all() as unknown as Record<string, unknown>[]) {
        insertMapped(target, 'task_runs', run, {
          overrides: { status: run.status === undefined || run.status === null ? 'unknown' : run.status },
        })
      }
    }

    if (sourceTables.has('task_reports')) {
      for (const report of source.prepare('SELECT * FROM task_reports').all() as unknown as Record<string, unknown>[]) {
        if (typeof report.terminal_session_id === 'string' && report.terminal_session_id !== '') {
          dropped.push({
            report_id: String(report.report_id),
            task_id: String(report.task_id),
            terminal_session_id: report.terminal_session_id,
          })
        }
        insertMapped(target, 'task_reports', report)
      }
    }

    if (sourceTables.has('ideas')) copyLegacyIdeas(source, target)

    const copied = new Set(['global_revision', 'projects', 'tasks', 'task_stages', 'task_runs', 'task_reports', 'ideas'])
    for (const table of TASK_TABLES) {
      if (copied.has(table) || !sourceTables.has(table)) continue
      for (const row of source.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[]) {
        insertMapped(target, table, row)
      }
    }
    target.exec('COMMIT')
  } catch (error) {
    target.exec('ROLLBACK')
    throw error
  }
}

interface LegacyTaskCandidateInput {
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  readonly description: string
  readonly riskLevel: string
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Create the auditable Candidate / snapshot / gate records required before a
 * migrated Task can be inserted. Legacy rows are imported by a service actor,
 * but the synthetic approval keeps the normal Candidate closure invariants.
 * @param target - target handle with the schema already created.
 * @param input - task fields needed for the admission records.
 * @returns the Candidate id that must be linked to the Task.
 */
function stageLegacyTaskCandidate(target: DatabaseSync, input: LegacyTaskCandidateInput): string {
  const digest = createHash('sha256').update(input.taskId, 'utf8').digest('hex').slice(0, 32)
  const candidateId = `cand_legacy_${digest}`
  const snapshotId = `snap_legacy_${digest}`
  const gateEventId = `gate_legacy_${digest}`
  const title = input.title.trim() === '' ? input.taskId : input.title
  const riskLevel = ['low', 'medium', 'high'].includes(input.riskLevel) ? input.riskLevel : 'medium'
  const snapshotVersion = 1
  const canonical = JSON.stringify({
    candidateId,
    candidateVersion: 0,
    projectId: input.projectId,
    searchQuery: { source: 'legacy_task', taskId: input.taskId },
    searchCoverage: { status: 'legacy_import' },
    activeWork: [],
    proposedDecisions: [],
    authoritativeDecisions: [],
    historicalDecisions: [],
    selectedDecisionIds: [],
    decisionLinkCount: 0,
    conflicts: [],
    requiredActions: [],
    residualRisk: 'Legacy task imported without retrospective decision reconstruction.',
    snapshotVersion,
  })
  const snapshotHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`

  target
    .prepare(
      `INSERT INTO task_candidates(
         candidate_id, source_type, source_system, source_ref, project_id, title, description,
         status, risk_level, complexity, owner_user_id, created_at, updated_at)
       VALUES (?, 'legacy_task', 'legacy', ?, ?, ?, ?, 'awaiting_gate', ?, 'medium', '', ?, ?)`,
    )
    .run(candidateId, input.taskId, input.projectId, title, input.description, riskLevel, input.createdAt, input.updatedAt)

  target
    .prepare(
      `INSERT INTO admission_snapshots(
         snapshot_id, candidate_id, candidate_version, project_id, search_query_json,
         search_coverage_json, active_work_json, proposed_decisions_json,
         authoritative_decisions_json, historical_decisions_json, selected_decision_ids_json,
         decision_link_count, conflicts_json, required_actions_json, residual_risk,
         snapshot_version, canonical_json, snapshot_hash, created_by, created_at)
       VALUES (?, ?, 0, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0, '[]', '[]', ?, ?,
               ?, ?, 'migration', ?)`,
    )
    .run(
      snapshotId,
      candidateId,
      input.projectId,
      JSON.stringify({ source: 'legacy_task', taskId: input.taskId }),
      JSON.stringify({ status: 'legacy_import' }),
      'Legacy task imported without retrospective decision reconstruction.',
      snapshotVersion,
      canonical,
      snapshotHash,
      input.createdAt,
    )

  target
    .prepare(
      `INSERT INTO candidate_gate_events(
         event_id, candidate_id, candidate_version, snapshot_id, snapshot_hash, action,
         actor_type, actor_id, reason, decided_at, request_id, idempotency_key, payload_hash)
       VALUES (?, ?, 0, ?, ?, 'approve', 'service', 'migration', 'legacy task import', ?,
               ?, ?, ?)`,
    )
    .run(
      gateEventId,
      candidateId,
      snapshotId,
      snapshotHash,
      input.updatedAt,
      `req_legacy_${digest}`,
      `legacy-import:${input.taskId}`,
      snapshotHash,
    )

  target
    .prepare(
      `UPDATE task_candidates
       SET admission_snapshot_id = ?, admission_snapshot_hash = ?, latest_gate_event_id = ?
       WHERE candidate_id = ?`,
    )
    .run(snapshotId, snapshotHash, gateEventId, candidateId)
  return candidateId
}

/**
 * Close the synthetic Candidate after its Task row exists.
 * @param target - target handle.
 * @param candidateId - staged Candidate id.
 * @param taskId - migrated Task id.
 * @param updatedAt - source timestamp for the converted state.
 */
function finalizeLegacyTaskCandidate(target: DatabaseSync, candidateId: string, taskId: string, updatedAt: string): void {
  target
    .prepare(
      `UPDATE task_candidates
       SET status = 'converted', converted_task_id = ?, version = 1, updated_at = ?
       WHERE candidate_id = ?`,
    )
    .run(taskId, updatedAt, candidateId)
}

/**
 * Copy legacy ideas into the inbox model, mapping the old single `source`
 * string onto the channel/source-system axes and the old status onto the
 * capture pipeline.
 * @param source - read-only source handle.
 * @param target - target handle with the schema already created.
 */
function copyLegacyIdeas(source: DatabaseSync, target: DatabaseSync): void {
  const statusMap: Readonly<Record<string, string>> = {
    draft: 'captured',
    open: 'triaged',
    converted: 'converted',
    archived: 'archived',
  }
  const sourceMap: Readonly<Record<string, { channel: string; system: string | null }>> = {
    manual: { channel: 'manual', system: null },
    conversation: { channel: 'agent', system: 'internal' },
    github_issue: { channel: 'connector', system: 'github' },
    feishu_doc: { channel: 'connector', system: 'feishu' },
  }
  const projects = new Set(
    (target.prepare('SELECT project_id FROM projects').all() as { project_id: string }[]).map(row => row.project_id),
  )
  const insert = target.prepare(
    `INSERT INTO ideas(idea_id, project_id, channel, source_system, source_ref, kind, title, content, tags,
       status, confidence, priority, revision, captured_at, converted_task_id, version, created_at)
     VALUES (?, ?, ?, ?, ?, 'idea', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  )
  const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  for (const row of source.prepare('SELECT * FROM ideas').all() as unknown as Record<string, unknown>[]) {
    const ideaId = asText(row.idea_id)
    if (ideaId === null) continue
    const mapped = sourceMap[asText(row.source) ?? 'manual'] ?? { channel: 'manual', system: null }
    const content = asText(row.content) ?? ''
    const createdAt = asText(row.created_at) ?? new Date().toISOString()
    const projectId = typeof row.project_id === 'string' && projects.has(row.project_id) ? row.project_id : null
    insert.run(
      ideaId,
      projectId,
      mapped.channel,
      mapped.system,
      asText(row.source_ref),
      content.split('\n')[0]?.slice(0, 80) ?? null,
      content,
      asText(row.tags),
      statusMap[asText(row.status) ?? ''] ?? 'captured',
      typeof row.confidence === 'string' ? row.confidence : 'medium',
      typeof row.priority === 'string' ? row.priority : 'P2',
      createdAt,
      asText(row.converted_task_id),
      Number(row.version ?? 0),
      createdAt,
    )
  }
}

/**
 * Insert one source row into a target table by column intersection.
 * @param target - target handle.
 * @param table - target table name.
 * @param row - source row keyed by column name.
 * @param options - `overrides` replace columns, `drop` omits columns,
 * `extraToMetadata` folds unknown columns into `metadata.legacy_project`.
 */
function insertMapped(
  target: DatabaseSync,
  table: string,
  row: Record<string, unknown>,
  options: { overrides?: Record<string, unknown>; drop?: readonly string[]; extraToMetadata?: boolean } = {},
): void {
  const columns = targetColumns(target, table)
  const overrides = options.overrides ?? {}
  const values: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (options.drop?.includes(key) === true) continue
    if (columns.has(key)) values[key] = value === undefined ? null : value
    else if (!key.endsWith('_terminal') && key !== 'terminal_session_id') extra[key] = value
  }
  Object.assign(values, overrides)
  if (options.extraToMetadata === true && columns.has('metadata')) {
    const base = typeof values.metadata === 'string' ? safeParse(values.metadata) : {}
    values.metadata = JSON.stringify({ ...base, legacy_project: { ...extra } })
  }
  const keys = Object.keys(values).filter(key => columns.has(key))
  if (keys.length === 0) return
  const placeholders = keys.map(() => '?').join(', ')
  target
    .prepare(`INSERT INTO ${table}(${keys.join(', ')}) VALUES (${placeholders})`)
    .run(...keys.map(key => values[key] as string | number | null))
}

/**
 * Read a table's column names from a handle.
 * @param db - open handle.
 * @param table - table name.
 * @returns the column-name set.
 */
function targetColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name))
}

/**
 * Parse JSON defensively.
 * @param text - candidate JSON text.
 * @returns the parsed object, or an empty object when it is not a JSON object.
 */
function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Verify a migrated database against the plan.
 * @param path - database file to check.
 * @param plan - plan that produced it.
 * @param options - `readOnly` opens the file without write intent.
 * @returns true when every check passes; throws otherwise.
 */
function verify(path: string, plan: MigrationPlan, options: { readOnly?: boolean } = {}): boolean {
  const db = options.readOnly === true ? openReadOnly(path) : new DatabaseSync(path)
  try {
    if (readUserVersion(db) !== SCHEMA_VERSION) throw new Error('schema version mismatch after migration')
    if (tableNames(db).length !== TASK_TABLES.length) throw new Error('table set is incomplete after migration')
    if (count(db, 'tasks') !== plan.counts.tasks) throw new Error('task row count changed during migration')
    for (const entry of plan.copied) {
      if (entry.table === 'projects') continue
      const actual = count(db, entry.table)
      const ok = entry.atLeast === true ? actual >= entry.rows : actual === entry.rows
      if (!ok) {
        throw new Error(`row count changed for ${entry.table}: expected ${entry.atLeast === true ? '>=' : ''}${entry.rows}, got ${actual}`)
      }
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length > 0) throw new Error(`foreign key violations after migration: ${JSON.stringify(fk)}`)
    const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, string>
    if (Object.values(integrity)[0] !== 'ok') throw new Error('integrity_check failed after migration')
    return true
  } finally {
    db.close()
  }
}

/**
 * Copy the database file group into a backup directory.
 * @param path - main database file.
 * @param backupDir - destination directory.
 */
function backupFileGroup(path: string, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true })
  const suffix = path.split(/[\\/]/).at(-1) ?? 'tasks.db'
  copyFileSync(path, join(backupDir, suffix))
  for (const sidecar of ['-wal', '-shm']) {
    if (existsSync(`${path}${sidecar}`)) copyFileSync(`${path}${sidecar}`, join(backupDir, `${suffix}${sidecar}`))
  }
}
