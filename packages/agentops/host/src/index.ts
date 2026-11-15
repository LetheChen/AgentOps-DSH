/**
 * Package root: the DSH plugin entry plus the pure deployment API.
 *
 * The bundle mounts this package by name, so `name`/`inject`/`apply` must stay
 * reachable from the root export. Snapshot helpers are re-exported for other
 * AgentOps packages and for contract tests.
 *
 * @module @agentops/dsh-host
 */

export { name, inject, apply, createSystemTool, summarize } from './dsh.ts'
export type {
  DataBoundary,
  DatabaseStatus,
  DeploymentInput,
  DeploymentSnapshot,
  InstanceTopology,
  RollbackStatus,
  SidecarStatus,
} from './types.ts'
export { buildDeploymentSnapshot } from './collect.ts'
export { createSystemService, readEnvironment } from './plugin.ts'
export type { AgentOpsSystemService } from './plugin.ts'
