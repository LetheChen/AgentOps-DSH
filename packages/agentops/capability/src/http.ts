/**
 * Transport-neutral HTTP router for the capability control plane.
 *
 * Routes retain the original AgentOps semantics under a stable
 * `/api/agentops/capabilities` prefix. The RPC bridge supplies the method,
 * query and body; tests call this router without a live host.
 *
 * @module @agentops/dsh-capability/http
 */

import { CapabilityError } from './errors.ts'
import { listDatabaseTables, probeCapabilityInstance, probeSshHostKey } from './probe.ts'
import { CapabilityStore, CapabilityStoreError } from './store.ts'
import { CapabilityConfigValidationError } from './validation.ts'
import type { InstanceInput } from './types.ts'

/** One parsed capability request. */
export interface CapabilityHttpRequest {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
  readonly actor?: string
}

/** One capability response. */
export interface CapabilityHttpResponse {
  readonly status: number
  readonly body: unknown
}

const PREFIX = '/api/agentops/capabilities'

function json(status: number, body: unknown): CapabilityHttpResponse {
  return { status, body }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', `${key} is required`)
  }
  return value.trim()
}

function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', `${key} must be an object`)
  }
  return value as Record<string, unknown>
}

function instanceInput(body: Record<string, unknown>, instanceId?: string): InstanceInput {
  const resolvedInstanceId = instanceId ?? (typeof body.instanceId === 'string' ? body.instanceId.trim() : undefined)
  const status = body.status
  if (status !== undefined && status !== 'enabled' && status !== 'disabled' && status !== 'error') {
    throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'status must be enabled, disabled or error')
  }
  const secret = body.secret
  if (secret !== undefined && typeof secret !== 'string') {
    throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'secret must be a string')
  }
  return {
    ...(resolvedInstanceId === undefined || resolvedInstanceId === '' ? {} : { instanceId: resolvedInstanceId }),
    capabilityId: stringField(body, typeof body.capability_id === 'string' ? 'capability_id' : 'capabilityId'),
    name: stringField(body, 'name'),
    config: recordField(body, 'config'),
    accessPolicy: recordField(body, 'access_policy'),
    ...(status === undefined ? {} : { status }),
    ...(secret === undefined ? {} : { secret }),
  }
}

/** Stable transport-neutral capability router. */
export class CapabilityHttpApi {
  readonly #store: CapabilityStore

  /**
   * @param store - domain store shared with the runtime resolver.
   */
  constructor(store: CapabilityStore) {
    this.#store = store
  }

  /**
   * Handle one capability request.
   * @param request - method, logical path, query, body and authenticated actor.
   * @returns status and JSON response.
   */
  async handle(request: CapabilityHttpRequest): Promise<CapabilityHttpResponse> {
    try {
      const path = request.path
      if (!path.startsWith(PREFIX)) return json(404, { error: { code: 'not_found', message: `unknown path ${path}` } })
      const suffix = path.slice(PREFIX.length).replace(/^\//, '')
      const parts = suffix === '' ? [] : suffix.split('/')
      const method = request.method.toUpperCase()
      const actor = request.actor ?? 'owner'

      if (parts[0] === 'catalog' && parts.length === 1 && method === 'GET') {
        const capabilityId = request.query?.capability_id
        return json(200, {
          capabilities: this.#store.listCapabilities(),
          integrations: this.#store.listInstances(capabilityId === undefined || capabilityId === '' ? undefined : capabilityId),
        })
      }
      if (parts[0] === 'catalog' && parts.length === 2 && method === 'GET') {
        const capabilityId = parts[1] ?? ''
        const capability = this.#store.getCapability(capabilityId)
        if (capability === null) return json(404, { error: { code: 'not_found', message: 'capability not found' } })
        return json(200, {
          capability,
          integrations: this.#store.listInstances(capability.capabilityId),
        })
      }
      if (parts[0] === 'tools' && parts.length === 1 && method === 'GET') {
        const capabilityId = request.query?.capability_id?.trim() ?? ''
        return json(200, { tools: this.#store.listTools(capabilityId === '' ? undefined : capabilityId) })
      }
      if (parts[0] === 'integrations' && parts.length === 1 && method === 'GET') {
        const capabilityId = request.query?.capability_id
        return json(200, { integrations: this.#store.listInstances(capabilityId === undefined || capabilityId === '' ? undefined : capabilityId) })
      }
      if (parts[0] === 'integrations' && parts.length === 1 && method === 'POST') {
        const saved = this.#store.saveInstance(instanceInput(objectBody(request.body)), actor)
        return json(201, { integration: saved })
      }
      if (parts[0] === 'integrations' && parts.length === 3 && parts[2] === 'test' && method === 'POST') {
        const instanceId = parts[1] ?? ''
        const current = this.#store.getInstance(instanceId)
        if (current === null) return json(404, { error: { code: 'not_found', message: 'integration not found' } })
        const runtime = this.#store.resolveInstanceRuntime(instanceId)
        if (runtime === null) return json(404, { error: { code: 'not_found', message: 'integration not found' } })
        const probe = await probeCapabilityInstance(runtime)
        const updated = this.#store.recordTest(instanceId, probe.ok, probe.ok ? null : probe.detail, actor)
        return json(200, {
          ok: probe.ok,
          message: probe.detail,
          elapsed_ms: probe.elapsedMs,
          integration: updated,
        })
      }
      if (parts[0] === 'integrations' && parts.length === 3 && parts[2] === 'tables' && method === 'POST') {
        const instanceId = parts[1] ?? ''
        const runtime = this.#store.resolveInstanceRuntime(instanceId)
        if (runtime === null) return json(404, { error: { code: 'not_found', message: 'integration not found' } })
        if (runtime.capabilityId !== 'database') {
          return json(400, { error: { code: 'CAPABILITY_CONFIG_INVALID', message: 'instance is not a database' } })
        }
        const result = await listDatabaseTables(runtime)
        return json(result.ok ? 200 : 400, {
          ok: result.ok,
          message: result.detail,
          tables: result.tables,
        })
      }
      if (parts[0] === 'integrations' && parts.length === 2 && method === 'PATCH') {
        const instanceId = parts[1] ?? ''
        const current = this.#store.getInstance(instanceId)
        if (current === null) return json(404, { error: { code: 'not_found', message: 'integration not found' } })
        const body = objectBody(request.body)
        const saved = this.#store.saveInstance(instanceInput({
          capability_id: body.capability_id ?? current.capabilityId,
          name: body.name ?? current.name,
          config: body.config ?? current.config,
          access_policy: body.access_policy ?? current.accessPolicy,
          status: body.status ?? current.status,
          ...(body.secret === undefined ? {} : { secret: body.secret }),
        }, instanceId), actor)
        return json(200, { integration: saved })
      }
      if (parts[0] === 'integrations' && parts.length === 2 && method === 'DELETE') {
        const instanceId = parts[1] ?? ''
        const deleted = this.#store.deleteInstance(instanceId, actor)
        return deleted ? json(200, { deleted: true, instance_id: instanceId }) : json(404, { error: { code: 'not_found', message: 'integration not found' } })
      }
      if (parts[0] === 'ssh' && parts.length === 2 && parts[1] === 'host-key' && method === 'POST') {
        const body = objectBody(request.body)
        const host = stringField(body, 'host')
        const rawPort = body.port
        const port = typeof rawPort === 'number' ? rawPort : Number.parseInt(typeof rawPort === 'string' ? rawPort : '', 10)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'port must be an integer between 1 and 65535')
        }
        try {
          const probe = await probeSshHostKey(host, port)
          return json(200, { host_key_sha256: probe.hostKeySha256, elapsed_ms: probe.elapsedMs })
        } catch (reason) {
          throw new CapabilityStoreError('SSH_HOST_KEY_UNREACHABLE', reason instanceof Error ? reason.message : String(reason))
        }
      }
      if (parts[0] === 'bindings' && parts.length === 1 && method === 'GET') {
        const agentPreset = request.query?.agent_preset?.trim() ?? ''
        if (agentPreset === '') return json(400, { error: { code: 'CAPABILITY_CONFIG_INVALID', message: 'agent_preset is required' } })
        return json(200, { agent_preset: agentPreset, bindings: this.#store.listBindings(agentPreset) })
      }
      if (parts[0] === 'bindings' && parts.length === 1 && method === 'PUT') {
        const body = objectBody(request.body)
        const agentPreset = stringField(body, 'agent_preset')
        const rawBindings = body.bindings
        if (!Array.isArray(rawBindings)) throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'bindings must be an array')
        const bindings = rawBindings.map((item) => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new CapabilityStoreError('CAPABILITY_CONFIG_INVALID', 'binding must be an object')
          }
          const row = item as Record<string, unknown>
          return {
            capabilityId: stringField(row, 'capability_id'),
            instanceId: stringField(row, 'instance_id'),
            enabled: row.enabled !== false,
          }
        })
        return json(200, { agent_preset: agentPreset, bindings: this.#store.replaceBindings(agentPreset, bindings, actor) })
      }
      if (parts[0] === 'audit' && parts.length === 1 && method === 'GET') {
        return json(200, { events: this.#store.listAudit(20) })
      }
      return json(404, { error: { code: 'not_found', message: `unknown route ${method} ${path}` } })
    } catch (error) {
      if (error instanceof CapabilityError) {
        return json(400, { error: { code: error.code, message: error.message, details: error.details } })
      }
      if (error instanceof CapabilityStoreError) {
        return json(400, { error: { code: error.code, message: error.message, details: {} } })
      }
      if (error instanceof CapabilityConfigValidationError) {
        return json(400, { error: { code: error.code, message: error.message, details: {} } })
      }
      throw error
    }
  }
}
