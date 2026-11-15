/**
 * Capability-center adapter for SSH log collection.
 * @module @agentops/dsh-log-collection/capability-resolver
 */

import {
  LogCollectionError,
  type SshCapabilityResolver,
  type SshCredential,
  type SshInstanceConfig,
} from './types.ts'

/** Browser-safe SSH instance fields needed by the resolver. */
export interface CapabilitySshInstance {
  readonly instanceId: string
  readonly capabilityId: string
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly config: Readonly<Record<string, unknown>>
  readonly accessPolicy: Readonly<Record<string, unknown>>
  readonly credentialConfigured: boolean
  readonly credentialGeneration: string
}

/** Capability runtime view with the decrypted secret. */
export interface CapabilitySshRuntime {
  readonly instanceId: string
  readonly secret: string | null
}

/** Structural interface implemented by `CapabilityStore`. */
export interface CapabilitySshSource {
  getInstance(instanceId: string): CapabilitySshInstance | null
  resolveRuntime(agentPreset: string, capabilityId: string, instanceId: string): CapabilitySshRuntime
  /** Owner path: read one instance without a preset binding. */
  resolveInstanceRuntime?(instanceId: string): CapabilitySshRuntime | null
}

/** Resolve SSH config without a secret, then read the secret after host verification. */
export class CapabilitySshResolver implements SshCapabilityResolver {
  readonly #source: CapabilitySshSource
  /** Preset that must hold the pull grant; null selects the owner path. */
  readonly #agentPreset: string | null

  /**
   * @param source - capability store or a test double.
   * @param agentPreset - preset authorized by capability bindings, or null for the owner path.
   */
  constructor(source: CapabilitySshSource, agentPreset: string | null) {
    this.#source = source
    this.#agentPreset = agentPreset
  }

  /**
   * Resolve non-secret SSH configuration.
   * @param instanceId - capability instance id.
   * @returns strict SSH configuration with host-key pin.
   */
  resolveConfig(instanceId: string): SshInstanceConfig {
    const instance = this.#source.getInstance(instanceId)
    if (instance === null || instance.capabilityId !== 'ssh' || instance.status !== 'enabled') {
      throw new LogCollectionError('CAPABILITY_INSTANCE_UNAVAILABLE', `SSH instance ${instanceId} is unavailable`)
    }
    if (!instance.credentialConfigured) {
      throw new LogCollectionError('CREDENTIAL_UNAVAILABLE', `SSH instance ${instanceId} has no credential`)
    }
    const host = text(instance.config.host)
    const username = text(instance.config.username)
    const port = number(instance.config.port)
    const authType = instance.config.auth_type === 'private_key' ? 'key' : 'password'
    const hostKeySha256 = text(instance.config.host_key_sha256)
    if (host === '' || username === '' || port === null || hostKeySha256 === '') {
      throw new LogCollectionError('CAPABILITY_INSTANCE_MISMATCH', `SSH instance ${instanceId} is incompletely configured`)
    }
    return {
      instanceId,
      host,
      port,
      username,
      authType,
      hostKeySha256,
      instanceRevision: instance.credentialGeneration,
    }
  }

  /**
   * Read credential material after host-key verification.
   * @param instanceId - capability instance id.
   * @param expectedRevision - frozen credential generation.
   * @returns password or private key material.
   */
  async readCredential(instanceId: string, expectedRevision: string): Promise<SshCredential> {
    const instance = this.#source.getInstance(instanceId)
    if (instance === null || instance.capabilityId !== 'ssh' || instance.status !== 'enabled') {
      throw new LogCollectionError('CAPABILITY_INSTANCE_UNAVAILABLE', `SSH instance ${instanceId} is unavailable`)
    }
    if (instance.credentialGeneration !== expectedRevision) {
      throw new LogCollectionError('CREDENTIAL_UNAVAILABLE', `credential generation changed for ${instanceId}`)
    }
    let runtime: CapabilitySshRuntime
    try {
      // The owner already has control-plane authority, so it reads the instance
      // directly instead of demanding a preset grant it never asked for.
      runtime = this.#agentPreset === null
        ? this.#source.resolveInstanceRuntime?.(instanceId) ?? (() => { throw new Error(`instance ${instanceId} unavailable`) })()
        : this.#source.resolveRuntime(this.#agentPreset, 'ssh', instanceId)
    } catch (error) {
      throw this.#agentPreset === null
        ? new LogCollectionError('CAPABILITY_INSTANCE_UNAVAILABLE', error instanceof Error ? error.message : String(error))
        : new LogCollectionError('CAPABILITY_BINDING_MISSING', error instanceof Error ? error.message : String(error))
    }
    if (runtime.secret === null) {
      throw new LogCollectionError('CREDENTIAL_UNAVAILABLE', `credential missing for ${instanceId}`)
    }
    return instance.config.auth_type === 'private_key'
      ? { privateKey: runtime.secret }
      : { password: runtime.secret }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65_535) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535) return parsed
  }
  return null
}
