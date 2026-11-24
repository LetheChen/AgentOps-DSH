/**
 * Deployment capability contracts.
 * @module @agentops/dsh-deployment/types
 */

/** Capability id for SSH-backed release instances. */
export const DEPLOYMENT_CAPABILITY_ID = 'deployment' as const

/** Capability id for local artifact build instances. */
export const ARTIFACT_BUILD_CAPABILITY_ID = 'artifact-build' as const

/** Closed deployment operations that may be granted to a preset. */
export type DeploymentOperation = 'plan' | 'release' | 'status' | 'rollback'

/** Migration behavior selected by the deployment instance, never by the model. */
export type DeploymentMigrationMode = 'always' | 'on-change' | 'explicit-only'

/** Terminal and in-flight release states persisted in `deployment.db`. */
export type DeploymentReleaseState =
  | 'planned'
  | 'uploading'
  | 'releasing'
  | 'health_checking'
  | 'healthy'
  | 'failed'
  | 'unknown_hold'
  | 'rolled_back'

/** Stable deployment error identities. */
export type DeploymentErrorCode =
  | 'DEPLOYMENT_CONFIG_INVALID'
  | 'DEPLOYMENT_ACCESS_DENIED'
  | 'DEPLOYMENT_ARTIFACT_INVALID'
  | 'DEPLOYMENT_MANIFEST_INVALID'
  | 'DEPLOYMENT_LEASE_HELD'
  | 'DEPLOYMENT_RELEASE_NOT_FOUND'
  | 'DEPLOYMENT_RELEASE_NOT_ROLLBACKABLE'
  | 'DEPLOYMENT_APPROVAL_REQUIRED'
  | 'DEPLOYMENT_APPROVAL_DENIED'
  | 'DEPLOYMENT_SSH_HOST_KEY_REJECTED'
  | 'DEPLOYMENT_SSH_AUTH_FAILED'
  | 'DEPLOYMENT_REMOTE_COMMAND_FAILED'
  | 'DEPLOYMENT_REMOTE_AMBIGUOUS'
  | 'DEPLOYMENT_SCRIPT_MISMATCH'
  | 'DEPLOYMENT_TIMEOUT'
  | 'DEPLOYMENT_BUILD_FAILED'
  | 'DEPLOYMENT_LOCAL_ROOT_INVALID'
  | 'DEPLOYMENT_UNSUPPORTED'

/** Typed failure with a stable machine identity and optional cause. */
export class DeploymentError extends Error {
  /** Stable machine-readable failure identity. */
  readonly code: DeploymentErrorCode
  /** Safe next action for the caller. */
  readonly action: string | undefined

  /**
   * @param code - stable machine identity.
   * @param message - actionable detail.
   * @param options - cause and safe next action.
   */
  constructor(code: DeploymentErrorCode, message: string, options: ErrorOptions & { readonly action?: string } = {}) {
    super(message, options)
    this.name = 'DeploymentError'
    this.code = code
    this.action = options.action
  }
}

/** One artifact file recorded in a release manifest. */
export interface ReleaseArtifactFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** Immutable build output identity consumed by deployment tools. */
export interface ReleaseManifest {
  readonly schemaVersion: 1
  readonly releaseId: string
  readonly gitSha: string | null
  readonly dirty: boolean | null
  readonly builtAt: string
  readonly builder: string
  readonly imageName: string | null
  readonly artifactFiles: readonly ReleaseArtifactFile[]
}

/** Access policy embedded in a deployment instance. */
export interface DeploymentAccessConfig {
  readonly presets: readonly string[]
  readonly operations: readonly DeploymentOperation[]
}

/** Local artifact locations and required files. */
export interface DeploymentArtifactConfig {
  /** Absolute local root containing the bundle. */
  readonly localRoot: string
  /** Relative bundle root beneath the local root. */
  readonly bundleRoot: string
  readonly updateFiles: readonly string[]
  readonly firstInstallFiles: readonly string[]
  /** Relative manifest path beneath the local root. */
  readonly manifest: string
  /** Relative sidecar digest path beneath the local root. */
  readonly manifestDigest: string
}

/** Environment file references. Secret contents are never stored in config. */
export interface DeploymentEnvironmentConfig {
  readonly installedEnvFile: string
  readonly firstInstallSecretRef?: string
  readonly firstInstallEnvFile?: string
  readonly remotePermissions: '0600'
  readonly cleanup: 'always'
}

/** Remote command and identity configuration. */
export interface DeploymentRemoteConfig {
  readonly workRoot: string
  readonly targetPath: string
  readonly lockPath: string
  readonly imageName: string
  readonly backupTagPrefix: string
  readonly containerName: string
  readonly composeFile: string
  /** Canonical generic deployment script; every plan, release, and rollback verifies it. */
  readonly scriptPath: string
  /** Operator-visible script version. */
  readonly scriptVersion: string
  /** Expected SHA-256 of the remote script; configuration rejects an empty value. */
  readonly scriptSha256: string
  readonly commandTimeoutMs: number
  readonly sudoMode: 'non-interactive'
  readonly firstInstallCommand: readonly string[]
  readonly updateCommand: readonly string[]
  readonly rollbackCommand: readonly string[]
}

/** Migration and backup policy. */
export interface DeploymentMigrationConfig {
  readonly mode: DeploymentMigrationMode
  readonly backupBeforeMigrate: boolean
  readonly backupRetentionDays: number
}

/** Remote release health checks. */
export interface DeploymentHealthConfig {
  readonly timeoutMs: number
  readonly checks: readonly (readonly string[])[]
}

/** One SSH-backed deployment instance. */
export interface DeploymentInstanceConfig {
  readonly schemaVersion: 1
  readonly instanceId: string
  readonly tenantKey: string
  readonly ownerDomain: string
  readonly sshInstanceId: string
  readonly access: DeploymentAccessConfig
  readonly artifact: DeploymentArtifactConfig
  readonly environment: DeploymentEnvironmentConfig
  readonly remote: DeploymentRemoteConfig
  readonly migration: DeploymentMigrationConfig
  readonly health: DeploymentHealthConfig
}

/** One local artifact build instance. */
export interface ArtifactBuildConfig {
  readonly schemaVersion: 1
  readonly instanceId: string
  readonly tenantKey: string
  readonly ownerDomain: string
  readonly access: Readonly<{ presets: readonly string[] }>
  readonly localRoot: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly outputs: readonly string[]
  readonly manifest: string
  readonly manifestDigest: string
  readonly imageName: string | null
}

/** One remote command result. Independent facts remain separately readable. */
export interface RemoteCommandResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Resolved SSH coordinates for a deployment operation. */
export interface DeploymentSshConfig {
  readonly instanceId: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authType: 'password' | 'key'
  readonly hostKeySha256: string
  readonly instanceRevision: string
}

/** Credential material resolved only after host-key verification. */
export interface DeploymentSshCredential {
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
}

/** One persisted deployment release. */
export interface DeploymentRelease {
  readonly releaseUid: string
  readonly instanceId: string
  readonly tenantKey: string
  readonly releaseId: string
  readonly state: DeploymentReleaseState
  readonly manifest: ReleaseManifest | null
  readonly manifestDigest: string | null
  readonly backupTag: string | null
  readonly backupImageId: string | null
  readonly imageId: string | null
  readonly lastConfirmedStep: string | null
  readonly steps: readonly DeploymentStep[]
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt: string | null
}

/** One journaled step. */
export interface DeploymentStep {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly at: string
  readonly detail?: string
}

/** Active release lease. */
export interface DeploymentLease {
  readonly instanceId: string
  readonly releaseUid: string
  readonly ownerPreset: string
  readonly fencingToken: string
  readonly state: 'active' | 'unknown_hold'
  readonly acquiredAt: string
  readonly heartbeatAt: string
}

/** Store-level status projection. */
export interface DeploymentStatus {
  readonly current: DeploymentRelease | null
  readonly previousHealthy: DeploymentRelease | null
  readonly journal: readonly DeploymentRelease[]
}

/** Artifact verification result shared by plan and release. */
export interface VerifiedArtifact {
  readonly manifest: ReleaseManifest
  readonly manifestDigest: string
  readonly files: readonly ArtifactFileLocation[]
}

/** One local file and its corresponding remote path. */
export interface ArtifactFileLocation {
  readonly relativePath: string
  readonly localPath: string
  readonly remotePath: string
  readonly sha256: string
  readonly bytes: number
}
