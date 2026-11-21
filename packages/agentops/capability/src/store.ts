/**
 * Transactional capability repository.
 *
 * The store owns one SQLite handle. Instance state, sealed credentials, audit
 * rows and outbox rows commit together; a failure at any point rolls all four
 * back. Browser reads are projected without credential references or ciphertext.
 *
 * @module @agentops/dsh-capability/store
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { BUILTIN_CAPABILITIES, listCapabilityTools } from './catalog.ts'
import { openCapabilitySecret, sealCapabilitySecret, loadCapabilityMasterKey } from './crypto.ts'
import { CapabilityError } from './errors.ts'
import { createCapabilitySchema, assertCapabilitySchema, readSchemaVersion, SCHEMA_VERSION } from './schema.ts'
import { assertConfigShape, validateInstanceConfig } from './validation.ts'
import type { MasterKey } from '@agentops/dsh-vault/src/crypto.ts'
import type {
  CapabilityBinding,
  CapabilityDefinition,
  CapabilityRuntime,
  CapabilityToolView,
  InstanceInput,
  IntegrationInstanceView,
} from './types.ts'

interface DefinitionRow {
  capability_id: string
  name: string
  category: string
  provider: string
  description: string
  transports: string
  config_schema: string
  risk_level: string
  authorization_capability_id: string
  supports_instances: number
  credential_required: number
  created_at: string
  updated_at: string
}

interface InstanceRow {
  instance_id: string
  capability_id: string
  name: string
  config_json: string
  access_policy_json: string
  credential_cipher: string | null
  credential_updated_at: string | null
  status: string
  last_test_status: string | null
  last_test_at: string | null
  last_test_error: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

interface BindingRow {
  agent_preset: string
  capability_id: string
  instance_id: string
  enabled: number
  created_at: string
  updated_at: string
}

/** One mutation is rejected before any row changes. */
export class CapabilityStoreError extends Error {
  /**
   * @param code - stable error code.
   * @param message - human-readable detail.
   */
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityStoreError'
  }
}

function now(): string {
  return new Date().toISOString()
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function definition(row: DefinitionRow): CapabilityDefinition {
  return {
    capabilityId: row.capability_id,
    name: row.name,
    category: row.category,
    provider: row.provider,
    description: row.description,
    transports: parseJsonArray(row.transports) as CapabilityDefinition['transports'],
    configSchema: parseJsonArray(row.config_schema) as CapabilityDefinition['configSchema'],
    riskLevel: row.risk_level === 'high' ? 'high' : row.risk_level === 'medium' ? 'medium' : 'low',
    authorizationCapabilityId: row.authorization_capability_id,
    supportsInstances: row.supports_instances === 1,
    credentialRequired: row.credential_required === 1,
  }
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function view(row: InstanceRow): IntegrationInstanceView {
  return {
    instanceId: row.instance_id,
    capabilityId: row.capability_id,
    name: row.name,
    config: parseJsonObject(row.config_json),
    accessPolicy: parseJsonObject(row.access_policy_json),
    credentialConfigured: row.credential_cipher !== null,
    credentialGeneration: row.credential_updated_at ?? row.updated_at,
    status: row.status === 'enabled' || row.status === 'disabled' ? row.status : 'error',
    lastTestStatus: row.last_test_status === 'succeeded' || row.last_test_status === 'failed'
      ? row.last_test_status
      : null,
    lastTestAt: row.last_test_at,
    lastTestError: row.last_test_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function binding(row: BindingRow): CapabilityBinding {
  return {
    agentPreset: row.agent_preset,
    capabilityId: row.capability_id,
    instanceId: row.instance_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** SQLite-backed capability repository. */
export class CapabilityStore {
  readonly #db: DatabaseSync
  readonly #key: MasterKey

  /**
   * Open and migrate an empty capability database.
   * @param path - SQLite path, or `:memory:`.
   * @param key - optional test key; production loads the AgentOps master key.
   */
  constructor(path: string, key: MasterKey = loadCapabilityMasterKey()) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#key = key
    const version = readSchemaVersion(this.#db)
    if (version === 0) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        createCapabilitySchema(this.#db)
        this.#seed(this.#db)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        this.#db.close()
        throw error
      }
    } else {
      try {
        assertCapabilitySchema(this.#db)
        this.#syncDefinitions()
      } catch (error) {
        this.#db.close()
        throw error
      }
    }
  }

  /** Close the database handle. */
  close(): void {
    this.#db.close()
  }

  /**
   * List all built-in definitions.
   * @returns definitions in category and id order.
   */
  listCapabilities(): CapabilityDefinition[] {
    const rows = this.#db.prepare(
      'SELECT * FROM capability_definitions ORDER BY category, capability_id',
    ).all() as unknown as DefinitionRow[]
    return rows.map(definition)
  }

  /**
   * Read one migration marker written by the legacy credential import.
   * @param key - marker key.
   * @returns the marker value, or null when the marker is absent.
   */
  readMeta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM capability_meta WHERE key = ?')
      .get(key) as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value : null
  }

  /**
   * Write one migration marker. Markers are idempotency facts, not credentials.
   * @param key - marker key.
   * @param value - marker value.
   */
  writeMeta(key: string, value: string): void {
    this.#db.prepare(
      'INSERT INTO capability_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  /**
   * Copy legacy vault connections into capability instances exactly once.
   * Existing capability rows win; missing rows are created with the source id.
   * The caller supplies plaintext passwords only for this in-process import.
   * @param connections - browser-safe connection metadata plus optional plaintext secret.
   * @param actor - authenticated owner id used in audit.
   * @returns number of newly created instances.
   */
  importLegacyConnections(
    connections: readonly {
      readonly id: string
      readonly kind: 'database' | 'server'
      readonly name: string
      readonly driver: string
      readonly host: string
      readonly port: number | null
      readonly username: string
      readonly defaultDatabase: string | null
      readonly enabled: boolean
      readonly secret: string | null
    }[],
    actor: string = 'migration',
  ): number {
    let imported = 0
    for (const connection of connections) {
      if (this.getInstance(connection.id) !== null) continue
      const capabilityId = connection.kind === 'database' ? 'database' : 'ssh'
      const config: Record<string, unknown> = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        ...(connection.kind === 'database'
          ? { engine: connection.driver, database: connection.defaultDatabase ?? '' }
          : { driver: connection.driver }),
      }
      this.saveInstance({
        instanceId: connection.id,
        capabilityId,
        name: connection.name,
        config,
        accessPolicy: {},
        status: connection.enabled ? 'enabled' : 'disabled',
        ...(connection.secret === null ? {} : { secret: connection.secret }),
      }, actor)
      imported += 1
    }
    return imported
  }

  /**
   * List static tool and interface declarations, optionally for one capability.
   * @param capabilityId - optional capability filter.
   * @returns tool rows sorted by capability and tool id.
   */
  listTools(capabilityId?: string): CapabilityToolView[] {
    return listCapabilityTools(capabilityId)
  }

  /**
   * Read one capability definition.
   * @param capabilityId - stable capability id.
   * @returns the definition, or null.
   */
  getCapability(capabilityId: string): CapabilityDefinition | null {
    const row = this.#db.prepare(
      'SELECT * FROM capability_definitions WHERE capability_id = ?',
    ).get(capabilityId) as DefinitionRow | undefined
    return row === undefined ? null : definition(row)
  }

  /**
   * List instances, optionally restricted by capability.
   * @param capabilityId - optional capability filter.
   * @returns browser-safe instance views.
   */
  listInstances(capabilityId?: string): IntegrationInstanceView[] {
    const rows = (capabilityId === undefined
      ? this.#db.prepare('SELECT * FROM capability_instances ORDER BY created_at DESC, instance_id').all()
      : this.#db.prepare(
        'SELECT * FROM capability_instances WHERE capability_id = ? ORDER BY created_at DESC, instance_id',
      ).all(capabilityId)) as unknown as InstanceRow[]
    return rows.map(view)
  }

  /**
   * Read one instance without exposing its credential cipher.
   * @param instanceId - stable instance id.
   * @returns the projected instance, or null.
   */
  getInstance(instanceId: string): IntegrationInstanceView | null {
    const row = this.#db.prepare(
      'SELECT * FROM capability_instances WHERE instance_id = ?',
    ).get(instanceId) as InstanceRow | undefined
    return row === undefined ? null : view(row)
  }

  /**
   * Create or update one instance and its credential in one transaction.
   * @param input - instance fields and optional plaintext secret.
   * @param actor - authenticated owner id used in audit.
   * @returns the browser-safe saved instance.
   */
  saveInstance(input: InstanceInput, actor: string = 'owner'): IntegrationInstanceView {
    const capability = this.getCapability(input.capabilityId)
    if (capability === null) {
      throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', `unknown capability ${input.capabilityId}`)
    }
    if (!capability.supportsInstances) {
      throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', `capability ${input.capabilityId} does not support instances`)
    }
    if (input.name.trim() === '') {
      throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'instance name is required')
    }
    // Reject a malformed connector before the transaction opens, so an
    // operator sees which field is wrong instead of a later send-time failure.
    assertConfigShape(capability, input.config)
    const config = validateInstanceConfig(capability, input.config)
    const instanceId = input.instanceId?.trim() || `int_${randomUUID().replaceAll('-', '')}`
    const existing = this.getInstance(instanceId)
    const at = now()
    this.#transaction(() => {
      if (existing === null) {
        this.#db.prepare(
          'INSERT INTO capability_instances ' +
          '(instance_id, capability_id, name, config_json, access_policy_json, credential_cipher, credential_updated_at, status, created_by, updated_by, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          instanceId,
          input.capabilityId,
          input.name.trim(),
          JSON.stringify(config),
          JSON.stringify(input.accessPolicy ?? {}),
          input.secret === undefined || input.secret.length === 0 ? null : sealCapabilitySecret(this.#key, instanceId, input.secret),
          input.secret === undefined || input.secret.length === 0 ? null : at,
          input.status ?? 'enabled',
          actor,
          actor,
          at,
          at,
        )
      } else {
        const secretClause = input.secret !== undefined && input.secret.length > 0
          ? { cipher: sealCapabilitySecret(this.#key, instanceId, input.secret), at }
          : { cipher: null, at: null }
        this.#db.prepare(
          'UPDATE capability_instances SET capability_id = ?, name = ?, config_json = ?, access_policy_json = ?, ' +
          'credential_cipher = COALESCE(?, credential_cipher), credential_updated_at = COALESCE(?, credential_updated_at), ' +
          'status = ?, updated_by = ?, updated_at = ? WHERE instance_id = ?',
        ).run(
          input.capabilityId,
          input.name.trim(),
          JSON.stringify(config),
          JSON.stringify(input.accessPolicy ?? existing.accessPolicy),
          secretClause.cipher,
          secretClause.at,
          input.status ?? existing.status,
          actor,
          at,
          instanceId,
        )
      }
      this.#appendAudit(actor, existing === null ? 'integration.create' : 'integration.update', instanceId, 'ok', {
        capability_id: input.capabilityId,
        credential_rotated: input.secret !== undefined && input.secret.length > 0,
      })
      this.#appendOutbox(existing === null ? 'capability.created' : 'capability.updated', {
        instance_id: instanceId,
        capability_id: input.capabilityId,
      })
    })
    const saved = this.getInstance(instanceId)
    if (saved === null) throw new Error('saved instance disappeared')
    return saved
  }

  /**
   * Delete one instance and append its audit/outbox event.
   * @param instanceId - instance to delete.
   * @param actor - authenticated owner id.
   * @returns whether a row was deleted.
   */
  deleteInstance(instanceId: string, actor: string = 'owner'): boolean {
    return this.#transaction(() => {
      const result = this.#db.prepare('DELETE FROM capability_instances WHERE instance_id = ?').run(instanceId)
      if (result.changes === 0) return false
      this.#appendAudit(actor, 'integration.delete', instanceId, 'ok', {})
      this.#appendOutbox('capability.deleted', { instance_id: instanceId })
      return true
    })
  }

  /**
   * Read one resolvable runtime instance for an explicit probe without checking a preset binding.
   * Control-plane tests validate the saved connector itself; preset authorization is enforced
   * separately whenever a tool consumes it.
   * @param instanceId - instance to resolve.
   * @returns the instance with its opened credential, or null when it does not exist.
   */
  resolveInstanceRuntime(instanceId: string): CapabilityRuntime | null {
    const row = this.#db.prepare(
      'SELECT * FROM capability_instances WHERE instance_id = ?',
    ).get(instanceId) as InstanceRow | undefined
    if (row === undefined) return null
    const credentialRequired = this.getCapability(row.capability_id)?.credentialRequired ?? true
    let secret: string | null = null
    if (row.credential_cipher !== null) {
      try {
        secret = openCapabilitySecret(this.#key, row.instance_id, row.credential_cipher)
      } catch {
        throw new CapabilityError('CREDENTIAL_DECRYPT_FAILED', `credential for ${row.instance_id} cannot be decrypted`)
      }
    } else if (credentialRequired) {
      throw new CapabilityError('CREDENTIAL_UNAVAILABLE', `credential missing for ${row.instance_id}`)
    }
    return {
      agentPreset: '',
      capabilityId: row.capability_id,
      instanceId: row.instance_id,
      name: row.name,
      config: parseJsonObject(row.config_json),
      accessPolicy: parseJsonObject(row.access_policy_json),
      secret,
      credentialGeneration: row.credential_updated_at ?? row.updated_at,
    }
  }

  /**
   * Persist a probe result without accepting secret material.
   * @param instanceId - probed instance.
   * @param ok - probe outcome.
   * @param error - failure detail, if any.
   * @param actor - authenticated owner id used in audit.
   * @returns the updated browser-safe instance, or null.
   */
  recordTest(instanceId: string, ok: boolean, error: string | null, actor: string = 'owner'): IntegrationInstanceView | null {
    const at = now()
    return this.#transaction(() => {
      const result = this.#db.prepare(
        'UPDATE capability_instances SET last_test_status = ?, last_test_at = ?, last_test_error = ?, updated_at = ? WHERE instance_id = ?',
      ).run(ok ? 'succeeded' : 'failed', at, error, at, instanceId)
      if (result.changes === 0) return null
      this.#appendAudit(actor, 'integration.test', instanceId, ok ? 'ok' : 'fail', { error })
      return this.getInstance(instanceId)
    })
  }

  /**
   * Read bindings for one Agent preset.
   * @param agentPreset - preset id.
   * @returns enabled and disabled bindings.
   */
  listBindings(agentPreset: string): CapabilityBinding[] {
    const rows = this.#db.prepare(
      'SELECT * FROM capability_bindings WHERE agent_preset = ? ORDER BY capability_id, instance_id',
    ).all(agentPreset) as unknown as BindingRow[]
    return rows.map(binding)
  }

  /**
   * Replace all bindings for one Agent preset in one transaction.
   * @param agentPreset - preset id.
   * @param bindings - complete new binding set.
   * @param actor - authenticated owner id.
   * @returns the saved bindings.
   */
  replaceBindings(agentPreset: string, bindings: readonly { capabilityId: string; instanceId: string; enabled: boolean }[], actor: string = 'owner'): CapabilityBinding[] {
    const at = now()
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM capability_bindings WHERE agent_preset = ?').run(agentPreset)
      for (const item of bindings) {
        const instance = this.getInstance(item.instanceId)
        if (instance === null || instance.capabilityId !== item.capabilityId) {
          throw new CapabilityStoreError('CAPABILITY_INSTANCE_MISMATCH', `instance ${item.instanceId} does not belong to ${item.capabilityId}`)
        }
        if (item.enabled && instance.status !== 'enabled') {
          throw new CapabilityStoreError('CAPABILITY_INSTANCE_UNAVAILABLE', `instance ${item.instanceId} is not enabled`)
        }
        if (item.enabled && instance.capabilityId === 'database') {
          const allowed = instance.accessPolicy.allowed_tables
          const hasTable = Array.isArray(allowed)
            ? allowed.length > 0
            : typeof allowed === 'object' && allowed !== null
              && Object.values(allowed as Record<string, unknown>).some(value => Array.isArray(value) && value.length > 0)
          if (!hasTable) {
            throw new CapabilityStoreError(
              'CAPABILITY_CONFIG_INVALID',
              `database instance ${item.instanceId} must authorize at least one table before binding`,
            )
          }
        }
        this.#db.prepare(
          'INSERT INTO capability_bindings(agent_preset, capability_id, instance_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(agentPreset, item.capabilityId, item.instanceId, item.enabled ? 1 : 0, at, at)
      }
      this.#appendAudit(actor, 'capability.bindings.update', agentPreset, 'ok', { count: bindings.length })
      this.#appendOutbox('capability.bindings.updated', { agent_preset: agentPreset, count: bindings.length })
    })
    return this.listBindings(agentPreset)
  }

  /**
   * Whether this preset has ever been configured by the capability center.
   * replaceBindings persists an audit row even for an empty set, so this is
   * the explicit fail-closed signal rather than presence of a binding row.
   * @param agentPreset - preset whose configuration state is read.
   * @returns whether the preset has ever been configured in the capability center.
   */
  hasBindings(agentPreset: string): boolean {
    const row = this.#db.prepare(
      "SELECT 1 AS present FROM capability_audit WHERE action = 'capability.bindings.update' AND target = ? LIMIT 1",
    ).get(agentPreset) as { present?: number } | undefined
    return row?.present === 1
  }

  /**
   * Find one instance by its id, display name or configured default database.
   *
   * This is the key collision check the database tools use before falling back
   * to the legacy datasource file: a capability-managed instance must never be
   * reachable through a second, unaudited resolver.
   * @param capabilityId - capability family to search.
   * @param key - model-supplied identifier.
   * @returns the matching instance view, or null when no instance claims the key.
   */
  findInstanceByKey(capabilityId: string, key: string): IntegrationInstanceView | null {
    const wanted = key.trim()
    if (wanted === '') return null
    return this.listInstances(capabilityId).find(item =>
      item.instanceId === wanted
      || item.name === wanted
      || item.config.database === wanted,
    ) ?? null
  }

  /**
   * List every enabled, authorized runtime instance for one capability.
   * @param agentPreset - preset whose enabled bindings are authorized.
   * @param capabilityId - capability family, normally `database`.
   * @returns runtime rows with sealed credentials already opened for this call.
   */
  listRuntimes(agentPreset: string, capabilityId: string): CapabilityRuntime[] {
    const bindings = this.listBindings(agentPreset)
      .filter(item => item.enabled && item.capabilityId === capabilityId)
    const rows: CapabilityRuntime[] = []
    for (const item of bindings) {
      try {
        rows.push(this.resolveRuntime(agentPreset, capabilityId, item.instanceId))
      } catch (error) {
        if (error instanceof CapabilityError && error.code === 'CAPABILITY_INSTANCE_UNAVAILABLE') continue
        throw error
      }
    }
    return rows
  }

  /**
   * Resolve exactly one enabled instance for a capability and open its secret.
   * @param agentPreset - authenticated preset id.
   * @param capabilityId - capability to resolve.
   * @param requestedInstanceId - optional explicit instance id or alias.
   * @returns runtime data for a handler.
   */
  resolveRuntime(agentPreset: string, capabilityId: string, requestedInstanceId?: string): CapabilityRuntime {
    const candidates = this.listBindings(agentPreset).filter(item => item.enabled && item.capabilityId === capabilityId)
    const selected = requestedInstanceId === undefined || requestedInstanceId.trim() === ''
      ? candidates
      : candidates.filter((item) => {
        const instance = this.getInstance(item.instanceId)
        return item.instanceId === requestedInstanceId
          || instance?.name === requestedInstanceId
          || instance?.config.database === requestedInstanceId
      })
    if (selected.length === 0) {
      throw new CapabilityError('CAPABILITY_BINDING_MISSING', `Agent ${agentPreset} has no authorized ${capabilityId} instance`)
    }
    if (selected.length > 1) {
      throw new CapabilityError('CAPABILITY_BINDING_AMBIGUOUS', `Agent ${agentPreset} has multiple ${capabilityId} instances`)
    }
    const selectedBinding = selected[0]
    if (selectedBinding === undefined) {
      throw new CapabilityError('CAPABILITY_BINDING_MISSING', `Agent ${agentPreset} has no authorized ${capabilityId} instance`)
    }
    const row = this.#db.prepare(
      'SELECT * FROM capability_instances WHERE instance_id = ?',
    ).get(selectedBinding.instanceId) as InstanceRow | undefined
    if (row === undefined) {
      throw new CapabilityError('CAPABILITY_INSTANCE_UNAVAILABLE', `instance ${selectedBinding.instanceId} is missing`)
    }
    if (row.status !== 'enabled') {
      throw new CapabilityError('CAPABILITY_INSTANCE_UNAVAILABLE', `instance ${row.instance_id} is disabled`)
    }
    const credentialRequired = this.getCapability(row.capability_id)?.credentialRequired ?? true
    let secret: string | null = null
    if (row.credential_cipher !== null) {
      try {
        secret = openCapabilitySecret(this.#key, row.instance_id, row.credential_cipher)
      } catch {
        throw new CapabilityError('CREDENTIAL_DECRYPT_FAILED', `credential for ${row.instance_id} cannot be decrypted`)
      }
    } else if (credentialRequired) {
      throw new CapabilityError('CREDENTIAL_UNAVAILABLE', `credential missing for ${row.instance_id}`)
    }
    return {
      agentPreset,
      capabilityId: row.capability_id,
      instanceId: row.instance_id,
      name: row.name,
      config: parseJsonObject(row.config_json),
      accessPolicy: parseJsonObject(row.access_policy_json),
      secret,
      credentialGeneration: row.credential_updated_at ?? row.updated_at,
    }
  }

  /**
   * Read the newest control-plane audit rows.
   * @param limit - maximum rows.
   * @returns newest rows first, without secret material.
   */
  listAudit(limit: number = 50): readonly Record<string, unknown>[] {
    const rows = this.#db.prepare(
      'SELECT seq, actor, action, target, result, detail_json, at FROM capability_audit ORDER BY seq DESC LIMIT ?',
    ).all(limit) as unknown as Record<string, unknown>[]
    return rows.map(row => ({
      seq: row.seq,
      actor: row.actor,
      action: row.action,
      target: row.target,
      result: row.result,
      detail: parseJsonObject(String(row.detail_json)),
      at: row.at,
    }))
  }

  /** Refresh built-in definitions without touching deployment data. */
  #syncDefinitions(): void {
    const existing = new Set(
      (this.#db.prepare('SELECT capability_id FROM capability_definitions').all() as { capability_id: string }[])
        .map(row => row.capability_id),
    )
    const at = now()
    const update = this.#db.prepare(
      'UPDATE capability_definitions SET name = ?, category = ?, provider = ?, description = ?, transports = ?, ' +
      'config_schema = ?, risk_level = ?, authorization_capability_id = ?, supports_instances = ?, ' +
      'credential_required = ?, updated_at = ? WHERE capability_id = ?',
    )
    const insert = this.#db.prepare(
      'INSERT INTO capability_definitions ' +
      '(capability_id, name, category, provider, description, transports, config_schema, risk_level, ' +
      'authorization_capability_id, supports_instances, credential_required, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.#transaction(() => {
      const builtIn = new Set(BUILTIN_CAPABILITIES.map(item => item.capabilityId))
      const remove = this.#db.prepare('DELETE FROM capability_definitions WHERE capability_id = ?')
      for (const capabilityId of existing) {
        if (!builtIn.has(capabilityId)) remove.run(capabilityId)
      }
      for (const item of BUILTIN_CAPABILITIES) {
        const transports = JSON.stringify(item.transports)
        const schema = JSON.stringify(item.configSchema)
        if (existing.has(item.capabilityId)) {
          update.run(
            item.name, item.category, item.provider, item.description, transports, schema,
            item.riskLevel, item.authorizationCapabilityId, item.supportsInstances ? 1 : 0,
            item.credentialRequired ? 1 : 0, at, item.capabilityId,
          )
        } else {
          insert.run(
            item.capabilityId, item.name, item.category, item.provider, item.description,
            transports, schema, item.riskLevel, item.authorizationCapabilityId,
            item.supportsInstances ? 1 : 0, item.credentialRequired ? 1 : 0, at, at,
          )
        }
      }
    })
  }

  #seed(db: DatabaseSync): void {
    const at = now()
    const statement = db.prepare(
      'INSERT INTO capability_definitions ' +
      '(capability_id, name, category, provider, description, transports, config_schema, risk_level, authorization_capability_id, supports_instances, credential_required, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const item of BUILTIN_CAPABILITIES) {
      statement.run(
        item.capabilityId,
        item.name,
        item.category,
        item.provider,
        item.description,
        JSON.stringify(item.transports),
        JSON.stringify(item.configSchema),
        item.riskLevel,
        item.authorizationCapabilityId,
        item.supportsInstances ? 1 : 0,
        item.credentialRequired ? 1 : 0,
        at,
        at,
      )
    }
    db.prepare('INSERT INTO capability_meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }

  #appendAudit(actor: string, action: string, target: string, result: 'ok' | 'fail', detail: Record<string, unknown>): void {
    this.#db.prepare(
      'INSERT INTO capability_audit(actor, action, target, result, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(actor, action, target, result, JSON.stringify(detail), now())
  }

  #appendOutbox(eventType: string, payload: Record<string, unknown>): void {
    this.#db.prepare(
      'INSERT INTO capability_outbox(event_type, payload_json, created_at) VALUES (?, ?, ?)',
    ).run(eventType, JSON.stringify(payload), now())
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}
