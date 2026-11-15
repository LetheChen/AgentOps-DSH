/**
 * Public capability-center surface.
 *
 * @module @agentops/dsh-capability
 */

export { BUILTIN_CAPABILITIES, BUILTIN_CAPABILITY_TOOLS, capabilitiesByTransport, listCapabilityTools } from './catalog.ts'
export { CapabilityError } from './errors.ts'
export { listDatabaseTables, probeCapabilityInstance, probeSshHostKey, probeWebhook } from './probe.ts'
export type { CapabilityProbeResult, DatabaseTableInfo, DatabaseTablesResult, SshHostKeyProbeResult } from './probe.ts'
export {
  assertConfigShape,
  CapabilityConfigValidationError,
  resolveWebhookUrl,
  validateInstanceConfig,
  WEBHOOK_ALLOWED_HOSTS,
  WEBHOOK_URL_CAPABILITIES,
} from './validation.ts'
export { CapabilityStore, CapabilityStoreError } from './store.ts'
export { CapabilityRuntimeService, openCapabilityRuntimeStore, resolveCapabilitiesForTool, resolveCapabilitySetForTool, resolveCapabilityForTool } from './runtime.ts'
export type { CapabilityToolResolution } from './runtime.ts'
export { CapabilityHttpApi } from './http.ts'
export type { CapabilityHttpRequest, CapabilityHttpResponse } from './http.ts'
export { apply, name, inject, resolveCapabilityDbPath } from './dsh.ts'
export type { CapabilityPluginConfig } from './dsh.ts'
export { SCHEMA_VERSION, CAPABILITY_TABLES, createCapabilitySchema, readSchemaVersion, assertCapabilitySchema } from './schema.ts'
export type {
  CapabilityBinding,
  CapabilityConfigField,
  CapabilityDefinition,
  CapabilityErrorCode,
  CapabilityRuntime,
  CapabilityToolView,
  CapabilityTransport,
  InstanceInput,
  InstanceStatus,
  IntegrationInstanceView,
} from './types.ts'
