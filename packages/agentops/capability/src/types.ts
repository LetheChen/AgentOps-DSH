/**
 * Capability-center domain types.
 *
 * @module @agentops/dsh-capability/types
 */

/** Lifecycle of one connector instance. */
export type InstanceStatus = 'enabled' | 'disabled' | 'error'

/** Runtime protocols a capability can expose. */
export type CapabilityTransport = 'rest' | 'mcp' | 'cli' | 'webhook' | 'oauth' | 'skill'

/** One form field declared by a capability definition. */
export interface CapabilityConfigField {
  readonly key: string
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'select'
  readonly label: string
  readonly required: boolean
  readonly placeholder?: string
  readonly description?: string
  readonly options?: readonly string[]
  readonly default?: unknown
}

/** A platform capability available to connector instances. */
export interface CapabilityDefinition {
  readonly capabilityId: string
  readonly name: string
  readonly category: string
  readonly provider: string
  readonly description: string
  readonly transports: readonly CapabilityTransport[]
  readonly configSchema: readonly CapabilityConfigField[]
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly authorizationCapabilityId: string
  readonly supportsInstances: boolean
  readonly credentialRequired: boolean
}

/** One tool or declared interface exposed by the capability center. */
export interface CapabilityToolView {
  readonly toolId: string
  readonly displayName: string
  readonly description: string
  readonly capabilityId: string
  readonly capabilityTransport: CapabilityTransport
  readonly authorizationCapabilityId: string
  readonly requiresCapabilityInstance: boolean
  readonly handlerModule: string
  readonly handlerFunction: string
  readonly allowedDomains: readonly string[]
  readonly allowedAgents: readonly string[]
  readonly deniedAgents: readonly string[]
  readonly runtimeAvailable: boolean
  readonly runtimeNote: string
  readonly declarationKind: 'runtime_tool' | 'interface'
}

/** The browser-safe representation of one instance. */
export interface IntegrationInstanceView {
  readonly instanceId: string
  readonly capabilityId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly accessPolicy: Readonly<Record<string, unknown>>
  readonly credentialConfigured: boolean
  readonly credentialGeneration: string
  readonly status: InstanceStatus
  readonly lastTestStatus: 'succeeded' | 'failed' | null
  readonly lastTestAt: string | null
  readonly lastTestError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One authorized instance for an Agent preset. */
export interface CapabilityBinding {
  readonly agentPreset: string
  readonly capabilityId: string
  readonly instanceId: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** Input for creating or replacing an instance. */
export interface InstanceInput {
  readonly instanceId?: string
  readonly capabilityId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly accessPolicy?: Readonly<Record<string, unknown>>
  readonly status?: InstanceStatus
  readonly secret?: string
}

/** The runtime data a resolved tool call may receive. */
export interface CapabilityRuntime {
  readonly agentPreset: string
  readonly capabilityId: string
  readonly instanceId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly accessPolicy: Readonly<Record<string, unknown>>
  readonly secret: string | null
  /**
   * The revision stamp of the stored credential. A token minted from an older
   * generation is not reused after the credential rotates.
   */
  readonly credentialGeneration: string
}

/** Stable capability error codes. */
export type CapabilityErrorCode =
  | 'CAPABILITY_BINDING_MISSING'
  | 'CAPABILITY_BINDING_AMBIGUOUS'
  | 'CAPABILITY_INSTANCE_UNAVAILABLE'
  | 'CAPABILITY_INSTANCE_MISMATCH'
  | 'CAPABILITY_CONFIG_INVALID'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_DECRYPT_FAILED'
  | 'CAPABILITY_AUTH_INVALID'
  | 'TOKEN_ACQUISITION_FAILED'
  | 'TOKEN_INVALID'
  | 'CAPABILITY_HTTP_FAILED'
  | 'CAPABILITY_RESPONSE_INVALID'
  | 'CAPABILITY_IDENTITY_UNBOUND'
