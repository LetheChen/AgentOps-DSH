/**
 * Public deployment package surface.
 * @module @agentops/dsh-deployment
 */

export { ARTIFACT_BUILD_CAPABILITY_ID, DEPLOYMENT_CAPABILITY_ID, DeploymentError } from './types.ts'
export type {
  ArtifactBuildConfig,
  ArtifactFileLocation,
  DeploymentAccessConfig,
  DeploymentArtifactConfig,
  DeploymentEnvironmentConfig,
  DeploymentHealthConfig,
  DeploymentInstanceConfig,
  DeploymentLease,
  DeploymentMigrationConfig,
  DeploymentRelease,
  DeploymentRemoteConfig,
  DeploymentSshConfig,
  DeploymentSshCredential,
  DeploymentStatus,
  DeploymentStep,
  ReleaseArtifactFile,
  ReleaseManifest,
  RemoteCommandResult,
  VerifiedArtifact,
} from './types.ts'
export { parseArtifactBuildConfig, parseDeploymentConfig, resolveCommand, resolveContained } from './config.ts'
export { ArtifactBuildService } from './build.ts'
export type { ArtifactBuildRequest, ArtifactBuildResult } from './build.ts'
export { SubprocessLocalCommandRunner } from './local-runner.ts'
export type { LocalCommandRunner } from './local-runner.ts'
export { DeploymentService } from './service.ts'
export type { DeploymentActionResult, DeploymentMode, DeploymentPlanResult, DeploymentRequest } from './service.ts'
export { DeploymentStore } from './store.ts'
export type { ClaimedRelease, ReleaseUpdate } from './store.ts'
export { Ssh2DeploymentTransport, hostKeyFingerprint, matchesHostKey, quoteArg, quoteArgv } from './transport.ts'
export type { DeploymentTransport } from './transport.ts'
export { DEPLOYMENT_SCHEMA_VERSION, createDeploymentSchema, readDeploymentSchemaVersion } from './schema.ts'
export { DeploymentRuntime, apply, resolveDeploymentDbPath } from './dsh.ts'
export type { DeploymentPluginConfig } from './dsh.ts'
export { TOOL_NAMES } from './tools.ts'
export type { DeploymentToolContext } from './tools.ts'
