/**
 * Durable run state for the DAG engine.
 *
 * One row per run plus one row per node, so a crashed host can show what was
 * running and resume can reuse completed node outputs. Uses `node:sqlite`
 * (no native dependency), matching the knowledge repository.
 */

import { DatabaseSync } from 'node:sqlite'

import type { NodeState, NodeStatus, RunState } from './types.js'

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  inputs      TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  error       TEXT,
  agent_id    TEXT,
  session_id  TEXT
);

CREATE TABLE IF NOT EXISTS run_nodes (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT,
  chosen_port TEXT,
  outputs     TEXT,
  actor       TEXT,
  PRIMARY KEY (run_id, node_id)
);
`

/**
 * Which Agent and session a run belongs to.
 *
 * Attribution is what lets the supervision panel group runs by Agent instead of
 * by workflow id, so a bubble names the Agent that owns the workflow rather
 * than an anonymous run.
 */
export interface RunAttribution {
  /** Agent preset id that owns the workflow. */
  readonly agentId?: string
  /** Session the run executes in. */
  readonly sessionId?: string
  /** Node id to the business role it ran as, for supervision grouping. */
  readonly actors?: Readonly<Record<string, string>>
}

/** Identity and status of one persisted run. */
export interface RunSummary {
  runId: string
  workflowId: string
  status: RunState['status']
  startedAt: string
  finishedAt?: string
  error?: string
  /** Agent preset that owns the workflow, when the run recorded one. */
  agentId?: string
}

/** Optional predicates for paged run listing. */
export interface RunListFilter {
  offset?: number
  status?: RunState['status']
  workflowId?: string
  agentId?: string
}

/** One run with its workflow identity and full node state. */
export interface RunRecord {
  workflowId: string
  state: RunState
}

interface RunRow {
  run_id: string
  workflow_id: string
  status: string
  started_at: string
  finished_at: string | null
  error: string | null
  inputs: string | null
  agent_id: string | null
}

interface NodeRow {
  node_id: string
  status: string
  attempts: number
  started_at: string | null
  finished_at: string | null
  error: string | null
  chosen_port: string | null
  outputs: string | null
  actor: string | null
}

interface CountRow {
  count: number
}

/** SQLite-backed storage for run states and their node states. */
export class SqliteRunStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(SCHEMA)
    // Older databases predate attribution and inputs; add what is missing so a
    // host upgrade never drops an existing run history.
    this.#addColumnIfMissing('runs', 'inputs', 'TEXT')
    this.#addColumnIfMissing('runs', 'agent_id', 'TEXT')
    this.#addColumnIfMissing('runs', 'session_id', 'TEXT')
    this.#addColumnIfMissing('run_nodes', 'actor', 'TEXT')
  }

  #addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all()
    const present = columns.some((entry) => {
      if (typeof entry !== 'object' || entry === null || !('name' in entry)) return false
      return entry.name === column
    })
    if (!present) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  /** Close the database handle. */
  close(): void {
    this.#db.close()
  }

  /**
   * Upsert a run and all of its node states inside one transaction.
   * @param state - settled or in-progress run state.
   * @param workflowId - the definition identity (may differ from runId).
   * @param attribution - Agent and session the run belongs to.
   */
  save(state: RunState, workflowId: string = state.runId, attribution: RunAttribution = {}): void {
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO runs(run_id, workflow_id, status, inputs, started_at, finished_at, error, agent_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status, inputs = excluded.inputs,
          finished_at = excluded.finished_at, error = excluded.error,
          agent_id = COALESCE(excluded.agent_id, runs.agent_id),
          session_id = COALESCE(excluded.session_id, runs.session_id)
      `).run(
        state.runId, workflowId, state.status, JSON.stringify(state.inputs ?? {}), state.startedAt,
        state.finishedAt ?? null, state.error ?? null,
        attribution.agentId ?? null, attribution.sessionId ?? null,
      )

      const upsert = this.#db.prepare(`
        INSERT INTO run_nodes(run_id, node_id, status, attempts, started_at, finished_at, error, chosen_port, outputs, actor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_id) DO UPDATE SET
          status = excluded.status, attempts = excluded.attempts,
          started_at = excluded.started_at, finished_at = excluded.finished_at,
          error = excluded.error, chosen_port = excluded.chosen_port, outputs = excluded.outputs,
          actor = COALESCE(excluded.actor, run_nodes.actor)
      `)
      for (const [nodeId, node] of Object.entries(state.nodes)) {
        upsert.run(
          state.runId, nodeId, node.status, node.attempts,
          node.startedAt ?? null, node.finishedAt ?? null,
          node.error ?? null, node.chosenPort ?? null,
          node.outputs === undefined ? null : JSON.stringify(node.outputs),
          attribution.actors?.[nodeId] ?? null,
        )
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Record a run that has started but has no settled node yet.
   *
   * Live progress needs a run row before the first node settles, otherwise the
   * supervision view has nothing to attach node events to while the workflow is
   * still running.
   * @param runId - run identity.
   * @param workflowId - owning workflow id.
   * @param startedAt - ISO start timestamp.
   * @param inputs - resolved run inputs.
   * @param attribution - Agent and session the run belongs to.
   */
  beginRun(
    runId: string,
    workflowId: string,
    startedAt: string,
    inputs: Readonly<Record<string, unknown>>,
    attribution: RunAttribution = {},
  ): void {
    this.#db.prepare(`
      INSERT INTO runs(run_id, workflow_id, status, inputs, started_at, agent_id, session_id)
      VALUES (?, ?, 'running', ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = 'running', inputs = excluded.inputs,
        agent_id = COALESCE(excluded.agent_id, runs.agent_id),
        session_id = COALESCE(excluded.session_id, runs.session_id)
    `).run(
      runId, workflowId, JSON.stringify(inputs), startedAt,
      attribution.agentId ?? null, attribution.sessionId ?? null,
    )
  }

  /**
   * Upsert one node's state while the run is still executing.
   * @param runId - run identity.
   * @param nodeId - node identity.
   * @param node - settled node state.
   * @param actor - business role the node executed as.
   */
  saveNode(runId: string, nodeId: string, node: NodeState, actor?: string): void {
    this.#db.prepare(`
      INSERT INTO run_nodes(run_id, node_id, status, attempts, started_at, finished_at, error, chosen_port, outputs, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        status = excluded.status, attempts = excluded.attempts,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        error = excluded.error, chosen_port = excluded.chosen_port, outputs = excluded.outputs,
        actor = COALESCE(excluded.actor, run_nodes.actor)
    `).run(
      runId, nodeId, node.status, node.attempts,
      node.startedAt ?? null, node.finishedAt ?? null,
      node.error ?? null, node.chosenPort ?? null,
      node.outputs === undefined ? null : JSON.stringify(node.outputs),
      actor ?? null,
    )
  }

  /**
   * Load one run with its node states.
   * @param runId - run identity.
   * @returns the state, or null when unknown.
   */
  load(runId: string): RunState | null {
    const raw = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (raw === undefined) return null
    return this.#stateFromRow(readRunRow(raw))
  }

  /**
   * Load one run together with the workflow identity needed by the detail API.
   * @param runId - run identity.
   * @returns the record, or null when unknown.
   */
  loadRecord(runId: string): RunRecord | null {
    const raw = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (raw === undefined) return null
    const row = readRunRow(raw)
    return { workflowId: row.workflow_id, state: this.#stateFromRow(row) }
  }

  /**
   * List one page of runs, newest first.
   * @param limit - maximum rows to return.
   * @param filter - optional status and workflow predicates plus row offset.
   * @returns matching run summaries.
   */
  listPage(limit = 20, filter: RunListFilter = {}): RunSummary[] {
    const { where, parameters } = buildFilter(filter)
    const rows = this.#db.prepare(`
      SELECT * FROM runs
      ${where}
      ORDER BY started_at DESC, run_id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, filter.offset ?? 0)
    return rows.map(row => toSummary(readRunRow(row)))
  }

  /**
   * Count runs matching the same predicates as {@link listPage}.
   * @param filter - optional status and workflow predicates.
   * @returns matching run count.
   */
  count(filter: Omit<RunListFilter, 'offset'> = {}): number {
    const { where, parameters } = buildFilter(filter)
    const raw = this.#db.prepare(`SELECT COUNT(*) AS count FROM runs ${where}`).get(...parameters)
    if (raw === undefined) throw new Error('run count query returned no row')
    return readCountRow(raw).count
  }

  /**
   * List the newest run summaries.
   * @param limit - maximum rows to return.
   * @returns run summaries, newest first.
   */
  list(limit = 20): RunSummary[] {
    return this.listPage(limit)
  }

  #stateFromRow(row: RunRow): RunState {
    const nodes: Record<string, NodeState> = {}
    for (const raw of this.#db.prepare('SELECT * FROM run_nodes WHERE run_id = ? ORDER BY node_id').all(row.run_id)) {
      const node = readNodeRow(raw)
      nodes[node.node_id] = {
        status: normalizeStatus(node.status),
        attempts: node.attempts,
        ...(node.started_at === null ? {} : { startedAt: node.started_at }),
        ...(node.finished_at === null ? {} : { finishedAt: node.finished_at }),
        ...(node.error === null ? {} : { error: node.error }),
        ...(node.chosen_port === null ? {} : { chosenPort: node.chosen_port }),
        ...(node.outputs === null ? {} : { outputs: parseOutputs(node.outputs) }),
      }
    }
    return {
      runId: row.run_id,
      status: normalizeRunStatus(row.status),
      inputs: row.inputs === null ? {} : parseOutputs(row.inputs),
      nodes,
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.error === null ? {} : { error: row.error }),
    }
  }
}

function buildFilter(filter: Omit<RunListFilter, 'offset'>): { where: string; parameters: string[] } {
  const clauses: string[] = []
  const parameters: string[] = []
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    parameters.push(filter.status)
  }
  if (filter.workflowId !== undefined) {
    clauses.push('workflow_id = ?')
    parameters.push(filter.workflowId)
  }
  if (filter.agentId !== undefined) {
    clauses.push('agent_id = ?')
    parameters.push(filter.agentId)
  }
  return {
    where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`,
    parameters,
  }
}

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    status: normalizeRunStatus(row.status),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
  }
}

function normalizeStatus(value: string): NodeStatus {
  return value === 'ready' || value === 'running' || value === 'completed' || value === 'failed' || value === 'skipped'
    ? value
    : 'pending'
}

function normalizeRunStatus(value: string): RunState['status'] {
  return value === 'completed' || value === 'failed' || value === 'cancelled' ? value : 'running'
}

function parseOutputs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readRunRow(row: Readonly<Record<string, unknown>>): RunRow {
  return {
    run_id: readString(row, 'run_id'),
    workflow_id: readString(row, 'workflow_id'),
    status: readString(row, 'status'),
    started_at: readString(row, 'started_at'),
    finished_at: readNullableString(row, 'finished_at'),
    error: readNullableString(row, 'error'),
    inputs: readNullableString(row, 'inputs'),
    agent_id: readNullableString(row, 'agent_id'),
  }
}

function readNodeRow(row: Readonly<Record<string, unknown>>): NodeRow {
  return {
    node_id: readString(row, 'node_id'),
    status: readString(row, 'status'),
    attempts: readNumber(row, 'attempts'),
    started_at: readNullableString(row, 'started_at'),
    finished_at: readNullableString(row, 'finished_at'),
    error: readNullableString(row, 'error'),
    chosen_port: readNullableString(row, 'chosen_port'),
    outputs: readNullableString(row, 'outputs'),
    actor: readNullableString(row, 'actor'),
  }
}

function readCountRow(row: Readonly<Record<string, unknown>>): CountRow {
  return { count: readNumber(row, 'count') }
}

function readString(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`invalid run store text column: ${column}`)
  return value
}

function readNullableString(row: Readonly<Record<string, unknown>>, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`invalid run store text column: ${column}`)
  return value
}

function readNumber(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`invalid run store integer column: ${column}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
