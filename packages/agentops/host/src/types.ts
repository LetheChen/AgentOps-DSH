/**
 * Deployment-facing facts for one AgentOps host.
 *
 * Everything here is derived (never read from the model context) so the same
 * snapshot can be rendered by the settings page, asserted in contract tests,
 * and compared across hosts during an upgrade.
 */
export interface DeploymentSnapshot {
  /** Locked DSH runtime version, e.g. `0.2.1-rc.3`. */
  dshVersion: string
  /** Runtime Node major/minor, e.g. `24.9`. */
  nodeVersion: string
  /** Profile name the host booted with. */
  profile: string
  /** Upgrade lane this deployment follows. */
  upgradeChannel: 'stable' | 'preview'
  instances: InstanceTopology
  database: DatabaseStatus
  dataBoundary: DataBoundary
  rollback: RollbackStatus
  /** Non-fatal findings the settings page must surface. */
  warnings: string[]
}

/** How many host instances serve this deployment. */
export interface InstanceTopology {
  mode: 'single' | 'multi'
  hostCount: number
  /** Session logs have a single writer; multi-instance hosts need sticky routing. */
  sessionSticky: boolean
}

/** Health of the sidecar replicas beside this host. */
export interface SidecarStatus {
  replicas: number
  healthy: boolean
}

/** Database engine and its observed latency. */
export interface DatabaseStatus {
  engine: string
  latencyMs: number | null
}

/** Which data may leave this deployment. */
export interface DataBoundary {
  /** Whether the official model route receives the session-log field. */
  sessionLogUpload: boolean
  /** High-risk tools require an explicit human approval. */
  approvalRequired: boolean
  /** Outbound network is restricted to registered endpoints. */
  networkAllowlist: boolean
}

/** Whether a profile snapshot is available for rollback. */
export interface RollbackStatus {
  /** ISO timestamp of the newest profile snapshot, when one exists. */
  snapshotAt: string | null
}

/** Raw inputs, as collected from the host environment. */
export interface DeploymentInput {
  dshVersion?: string
  nodeVersion?: string
  profile?: string
  upgradeChannel?: string
  instances?: Partial<InstanceTopology>
  database?: Partial<DatabaseStatus>
  dataBoundary?: Partial<DataBoundary>
  rollback?: Partial<RollbackStatus>
}
