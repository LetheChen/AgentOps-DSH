/**
 * Log collection task types.
 * @module @agentops/dsh-log-collection/types
 */

/** A stable log collection task. */
export interface LogCollectionTask {
  readonly taskUid: string
  readonly tenantKey: string
  readonly taskId: string
  readonly name: string
  readonly ownerDomain: string
  readonly sshInstanceId: string
  readonly remotePaths: readonly string[]
  readonly storageKey: string
  /** Business-local subdirectory under the configured root; empty means `<tenant>/<task>`. */
  readonly localSubdir: string
  readonly localMaxDays: number
  readonly enabled: boolean
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Input for creating one task. Tenant and owner domain come from auth context. */
export interface CreateLogCollectionTaskInput {
  readonly tenantKey: string
  readonly taskId?: string
  readonly name: string
  readonly ownerDomain: string
  readonly sshInstanceId: string
  readonly remotePaths: readonly string[]
  /** Business-local subdirectory under the configured root. */
  readonly localSubdir?: string
  readonly localMaxDays: number
  readonly enabled?: boolean
  readonly actor: string
}

/** Input for updating one task. */
export interface UpdateLogCollectionTaskInput {
  readonly tenantKey: string
  readonly taskId: string
  readonly expectedRevision: number
  readonly actor: string
  readonly name?: string
  readonly sshInstanceId?: string
  readonly remotePaths?: readonly string[]
  readonly localSubdir?: string
  readonly localMaxDays?: number
  readonly enabled?: boolean
}

/** One preset grant for a task. */
export interface LogCollectionTaskAcl {
  readonly agentPreset: string
  readonly canPull: boolean
  readonly canQuery: boolean
  readonly revoked: boolean
}

/** Stable public error codes. */
export type LogCollectionErrorCode =
  | 'LOG_TASK_NOT_FOUND'
  | 'LOG_TASK_INVALID'
  | 'LOG_TASK_CONFLICT'
  | 'LOG_TASK_DISABLED'
  | 'LOG_TASK_ACCESS_DENIED'
  | 'LOG_LOCAL_ROOT_INVALID'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'SSH_HOST_KEY_REJECTED'
  | 'SSH_AUTH_FAILED'
  | 'SFTP_PULL_FAILED'
  | 'CAPABILITY_INSTANCE_UNAVAILABLE'
  | 'CAPABILITY_INSTANCE_MISMATCH'
  | 'CAPABILITY_BINDING_MISSING'

/** Typed log collection failure. */
export class LogCollectionError extends Error {
  readonly code: LogCollectionErrorCode

  /**
   * @param code - stable error code.
   * @param message - actionable detail.
   */
  constructor(code: LogCollectionErrorCode, message: string) {
    super(message)
    this.name = 'LogCollectionError'
    this.code = code
  }
}
/** One SSH capability instance configuration without credential material. */
export interface SshInstanceConfig {
  readonly instanceId: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authType: 'password' | 'key'
  readonly hostKeySha256: string
  readonly instanceRevision: string
}

/** Credential material resolved only after host-key verification. */
export interface SshCredential {
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
}

/** Resolve SSH configuration and credentials through separate calls. */
export interface SshCapabilityResolver {
  resolveConfig(instanceId: string): SshInstanceConfig
  readCredential(instanceId: string, instanceRevision: string): Promise<SshCredential>
}

/** Result of one pull_logs invocation. */
export interface PullLogsResult {
  readonly ok: true
  readonly logTaskId: string
  readonly sshInstanceId: string
  readonly files: readonly {
    readonly remotePath: string
    readonly localPath: string
    /** Total local file size after this pull. */
    readonly bytes: number
    /** Offset where content added by this pull begins. */
    readonly deltaStart: number
    /** Offset where content added by this pull ends. */
    readonly deltaEnd: number
    /** Whether the remote file was unchanged since the previous pull. */
    readonly skipped: boolean
  }[]
  /** Local files removed by the retention window. */
  readonly filesCleaned: number
}
