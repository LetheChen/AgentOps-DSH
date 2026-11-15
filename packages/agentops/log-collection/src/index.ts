/**
 * Public log collection surface.
 * @module @agentops/dsh-log-collection
 */

export {
  LOG_COLLECTION_SCHEMA_VERSION,
  createLogCollectionSchema,
  readLogCollectionSchemaVersion,
} from './schema.ts'
export { LogCollectionStore } from './store.ts'
export { PullLogsService } from './pull.ts'
export { Ssh2LogTransport, hostKeyFingerprint, matchesHostKey } from './transport.ts'
export { CapabilitySshResolver } from './capability-resolver.ts'
export { createPullLogsTool, mountPullLogsTool } from './tools.ts'
export { LogCollectionRuntime, apply, resolveLogCollectionDbPath, resolveLogCollectionRoot } from './dsh.ts'
export { LogCollectionHttpApi, DEFAULT_TENANT } from './http.ts'
export type { LogCollectionHttpRequest, LogCollectionHttpResponse } from './http.ts'
export {
  decodeLogCollectionEndpoint,
  handleLogCollectionRpc,
  LOG_COLLECTION_BRIDGE_PATH,
  LOG_COLLECTION_ENDPOINT_PREFIX,
  registerLogCollectionRpc,
} from './mount-rpc.ts'
export { LogCollectionRuns, LOG_COLLECTION_RUN_SCHEMA_VERSION, createLogCollectionRunSchema } from './schema-runs.ts'
export type { LogCollectionRun } from './schema-runs.ts'
export type { LogCollectionPluginConfig } from './dsh.ts'
export type { LogCollectionStoreOptions } from './store.ts'
export type { PullLogsRequest } from './pull.ts'
export type { LogSftpTransport } from './transport.ts'
export type { CapabilitySshInstance, CapabilitySshRuntime, CapabilitySshSource } from './capability-resolver.ts'
export type { PullLogsToolContext } from './tools.ts'
export { LogCollectionError } from './types.ts'
export type {
  CreateLogCollectionTaskInput,
  LogCollectionErrorCode,
  LogCollectionTask,
  LogCollectionTaskAcl,
  PullLogsResult,
  SshCapabilityResolver,
  SshCredential,
  SshInstanceConfig,
  UpdateLogCollectionTaskInput,
} from './types.ts'
