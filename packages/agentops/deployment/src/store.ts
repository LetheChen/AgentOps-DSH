/**
 * Durable deployment journal and release lease store.
 * @module @agentops/dsh-deployment/store
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { DeploymentError, type DeploymentLease, type DeploymentRelease, type DeploymentReleaseState, type DeploymentStatus, type DeploymentStep, type ReleaseManifest } from './types.ts'
import { DEPLOYMENT_SCHEMA_VERSION, createDeploymentSchema, readDeploymentSchemaVersion } from './schema.ts'

interface ReleaseRow extends Record<string, SQLOutputValue> {
  release_uid: string
  instance_id: string
  tenant_key: string
  release_id: string
  state: DeploymentReleaseState
  manifest_json: string | null
  manifest_digest: string | null
  backup_tag: string | null
  backup_image_id: string | null
  image_id: string | null
  last_confirmed_step: string | null
  steps_json: string
  error_code: string | null
  error_message: string | null
  started_at: string
  updated_at: string
  finished_at: string | null
}

interface LeaseRow extends Record<string, SQLOutputValue> {
  instance_id: string
  release_uid: string
  owner_preset: string
  fencing_token: string
  state: 'active' | 'unknown_hold'
  acquired_at: string
  heartbeat_at: string
}

/** One claimed release lease. */
export interface ClaimedRelease {
  readonly releaseUid: string
  readonly fencingToken: string
}

/** Fields a caller may update while one release is active. */
export interface ReleaseUpdate {
  readonly state?: DeploymentReleaseState
  readonly manifest?: ReleaseManifest | null
  readonly manifestDigest?: string | null
  readonly backupTag?: string | null
  readonly backupImageId?: string | null
  readonly imageId?: string | null
  readonly lastConfirmedStep?: string | null
}

/** SQLite-backed deployment journal. */
export class DeploymentStore {
  readonly #db: DatabaseSync

  /**
   * @param db - open SQLite database.
   */
  constructor(db: DatabaseSync) {
    this.#db = db
    db.exec('PRAGMA foreign_keys = ON')
    const version = readDeploymentSchemaVersion(db)
    if (version === 0) createDeploymentSchema(db)
    if (readDeploymentSchemaVersion(db) !== DEPLOYMENT_SCHEMA_VERSION) {
      throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', `unsupported deployment schema ${version}`)
    }
  }

  /**
   * Claim one release lease and create its journal row atomically.
   * @param input - release identity and initial evidence.
   * @returns the generated release uid and fencing token.
   * @throws DeploymentError when another release owns the instance lease.
   */
  claim(input: {
    readonly instanceId: string
    readonly tenantKey: string
    readonly releaseId: string
    readonly ownerPreset: string
  }): ClaimedRelease {
    return this.#transaction(() => {
      const lease = this.#db.prepare('SELECT 1 AS present FROM deployment_leases WHERE instance_id = ?').get(input.instanceId)
      if (lease !== undefined) {
        throw new DeploymentError('DEPLOYMENT_LEASE_HELD', `deployment ${input.instanceId} already has an active release lease`, {
          action: 'Inspect deployment_status and wait for or explicitly recover the existing lease.',
        })
      }
      const now = new Date().toISOString()
      const releaseUid = randomUUID()
      const fencingToken = randomUUID()
      this.#db.prepare(`
        INSERT INTO deployment_releases(
          release_uid, instance_id, tenant_key, release_id, state, manifest_json, manifest_digest,
          backup_tag, backup_image_id, image_id, last_confirmed_step, steps_json, error_code,
          error_message, started_at, updated_at, finished_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        releaseUid, input.instanceId, input.tenantKey, input.releaseId, 'planned', null, null,
        null, null, null, null, '[]', null, null, now, now, null,
      )
      this.#db.prepare(`
        INSERT INTO deployment_leases(instance_id, release_uid, owner_preset, fencing_token, state, acquired_at, heartbeat_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(input.instanceId, releaseUid, input.ownerPreset, fencingToken, 'active', now, now)
      return { releaseUid, fencingToken }
    })
  }

  /**
   * Update one active release and append a step in one transaction.
   * @param releaseUid - release identity.
   * @param step - step name and status.
   * @param patch - optional release fields.
   */
  recordStep(releaseUid: string, step: DeploymentStep, patch: ReleaseUpdate = {}): void {
    this.#transaction(() => {
      const release = this.get(releaseUid)
      const steps = [...release.steps, step]
      this.#update(releaseUid, {
        ...patch,
        lastConfirmedStep: step.status === 'passed' ? step.name : patch.lastConfirmedStep ?? release.lastConfirmedStep,
      }, steps)
      this.#db.prepare('UPDATE deployment_leases SET heartbeat_at = ? WHERE release_uid = ?').run(new Date().toISOString(), releaseUid)
    })
  }

  /**
   * Mark a release terminal and release its lease unless the outcome is unknown.
   * @param releaseUid - release identity.
   * @param state - terminal state.
   * @param error - optional typed failure.
   */
  settle(releaseUid: string, state: Exclude<DeploymentReleaseState, 'planned' | 'uploading' | 'releasing' | 'health_checking' | 'unknown_hold'>, error?: { code: string; message: string }): void {
    this.#transaction(() => {
      const now = new Date().toISOString()
      this.#db.prepare(`
        UPDATE deployment_releases
        SET state = ?, error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
        WHERE release_uid = ?
      `).run(state, error?.code ?? null, error?.message ?? null, now, now, releaseUid)
      this.#db.prepare('DELETE FROM deployment_leases WHERE release_uid = ?').run(releaseUid)
    })
  }

  /**
   * Put a release into `unknown_hold` and retain its lease.
   * @param releaseUid - release identity.
   * @param step - step whose outcome is unknown.
   * @param message - safe diagnostic.
   */
  holdUnknown(releaseUid: string, step: string, message: string): void {
    this.#transaction(() => {
      const now = new Date().toISOString()
      this.#db.prepare(`
        UPDATE deployment_releases
        SET state = 'unknown_hold', error_code = 'DEPLOYMENT_REMOTE_AMBIGUOUS', error_message = ?, last_confirmed_step = ?, updated_at = ?
        WHERE release_uid = ?
      `).run(message, step, now, releaseUid)
      this.#db.prepare(`
        UPDATE deployment_leases SET state = 'unknown_hold', heartbeat_at = ? WHERE release_uid = ?
      `).run(now, releaseUid)
    })
  }

  /**
   * Read one release by uid.
   * @param releaseUid - release identity.
   * @returns release record.
   */
  get(releaseUid: string): DeploymentRelease {
    const row = this.#db.prepare('SELECT * FROM deployment_releases WHERE release_uid = ?').get(releaseUid) as ReleaseRow | undefined
    if (row === undefined) throw new DeploymentError('DEPLOYMENT_RELEASE_NOT_FOUND', `release ${releaseUid} is unknown`)
    return toRelease(row)
  }

  /**
   * Read one release by instance and human release id.
   * @param instanceId - deployment instance.
   * @param releaseId - release identity from the manifest.
   * @returns release record or null.
   */
  findByReleaseId(instanceId: string, releaseId: string): DeploymentRelease | null {
    const row = this.#db.prepare('SELECT * FROM deployment_releases WHERE instance_id = ? AND release_id = ?').get(instanceId, releaseId) as ReleaseRow | undefined
    return row === undefined ? null : toRelease(row)
  }

  /**
   * Read the current, previous healthy, and recent journal records.
   * @param instanceId - deployment instance.
   * @returns status projection.
   */
  status(instanceId: string): DeploymentStatus {
    const currentRow = this.#db.prepare(
      'SELECT * FROM deployment_releases WHERE instance_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(instanceId) as ReleaseRow | undefined
    const previousRow = currentRow?.state === 'healthy'
      ? this.#db.prepare(
        "SELECT * FROM deployment_releases WHERE instance_id = ? AND state = 'healthy' AND started_at < ? ORDER BY finished_at DESC LIMIT 1",
      ).get(instanceId, currentRow.started_at) as ReleaseRow | undefined
      : this.#db.prepare(
        "SELECT * FROM deployment_releases WHERE instance_id = ? AND state = 'healthy' ORDER BY finished_at DESC LIMIT 1",
      ).get(instanceId) as ReleaseRow | undefined
    const journalRows = this.#db.prepare(
      'SELECT * FROM deployment_releases WHERE instance_id = ? ORDER BY started_at DESC LIMIT 20',
    ).all(instanceId) as ReleaseRow[]
    return {
      current: currentRow === undefined ? null : toRelease(currentRow),
      previousHealthy: previousRow === undefined ? null : toRelease(previousRow),
      journal: journalRows.map(toRelease),
    }
  }

  /**
   * Read one instance lease.
   * @param instanceId - deployment instance.
   * @returns lease or null.
   */
  lease(instanceId: string): DeploymentLease | null {
    const row = this.#db.prepare('SELECT * FROM deployment_leases WHERE instance_id = ?').get(instanceId) as LeaseRow | undefined
    return row === undefined ? null : toLease(row)
  }

  /**
   * Record one passed health check.
   * @param releaseUid - release identity.
   * @param name - check name.
   */
  healthPassed(releaseUid: string, name: string): void {
    this.recordStep(releaseUid, { name, status: 'passed', at: new Date().toISOString() })
  }

  #update(releaseUid: string, patch: ReleaseUpdate, steps?: readonly DeploymentStep[]): void {
    const current = this.get(releaseUid)
    const now = new Date().toISOString()
    this.#db.prepare(`
      UPDATE deployment_releases
      SET state = ?, manifest_json = ?, manifest_digest = ?, backup_tag = ?, backup_image_id = ?,
          image_id = ?, last_confirmed_step = ?, steps_json = ?, updated_at = ?
      WHERE release_uid = ?
    `).run(
      patch.state ?? current.state,
      JSON.stringify(patch.manifest === undefined ? current.manifest : patch.manifest),
      patch.manifestDigest === undefined ? current.manifestDigest : patch.manifestDigest,
      patch.backupTag === undefined ? current.backupTag : patch.backupTag,
      patch.backupImageId === undefined ? current.backupImageId : patch.backupImageId,
      patch.imageId === undefined ? current.imageId : patch.imageId,
      patch.lastConfirmedStep === undefined ? current.lastConfirmedStep : patch.lastConfirmedStep,
      JSON.stringify(steps ?? current.steps),
      now,
      releaseUid,
    )
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}

function toRelease(row: ReleaseRow): DeploymentRelease {
  return {
    releaseUid: row.release_uid,
    instanceId: row.instance_id,
    tenantKey: row.tenant_key,
    releaseId: row.release_id,
    state: row.state,
    manifest: row.manifest_json === null ? null : JSON.parse(row.manifest_json) as ReleaseManifest,
    manifestDigest: row.manifest_digest,
    backupTag: row.backup_tag,
    backupImageId: row.backup_image_id,
    imageId: row.image_id,
    lastConfirmedStep: row.last_confirmed_step,
    steps: JSON.parse(row.steps_json) as DeploymentStep[],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}

function toLease(row: LeaseRow): DeploymentLease {
  return {
    instanceId: row.instance_id,
    releaseUid: row.release_uid,
    ownerPreset: row.owner_preset,
    fencingToken: row.fencing_token,
    state: row.state,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
  }
}
