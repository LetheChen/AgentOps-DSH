import { buildDeploymentSnapshot } from './collect.js'
import type { DeploymentInput, DeploymentSnapshot } from './types.js'

/** Service surface other AgentOps packages may inject. */
export interface AgentOpsSystemService {
  snapshot(): DeploymentSnapshot
}

/**
 * Read deployment facts from the process environment.
 *
 * Only reads: no filesystem writes, no clock, no network. Missing values stay
 * missing so `buildDeploymentSnapshot` can warn instead of inventing facts.
 * @param env - the process environment to read.
 * @returns the deployment facts found in the environment.
 */
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): DeploymentInput {
  const hostCount = toNumber(env.AGENTOPS_HOST_COUNT)
  const latencyMs = toNumber(env.AGENTOPS_DB_LATENCY_MS)
  const snapshotAt = nonEmpty(env.AGENTOPS_ROLLBACK_SNAPSHOT_AT)
  const dbEngine = nonEmpty(env.AGENTOPS_DB_ENGINE)
  const dshVersion = nonEmpty(env.DSH_VERSION)
  const profile = nonEmpty(env.AGENTOPS_PROFILE)
  const upgradeChannel = nonEmpty(env.AGENTOPS_UPGRADE_CHANNEL)

  return {
    ...(dshVersion === undefined ? {} : { dshVersion }),
    ...(profile === undefined ? {} : { profile }),
    ...(upgradeChannel === undefined ? {} : { upgradeChannel }),
    nodeVersion: process.version.replace(/^v/, ''),
    instances: {
      mode: env.AGENTOPS_INSTANCE_MODE === 'multi' ? 'multi' : 'single',
      sessionSticky: env.AGENTOPS_SESSION_STICKY !== 'false',
      ...(hostCount === undefined ? {} : { hostCount }),
    },
    database: {
      ...(dbEngine === undefined ? {} : { engine: dbEngine }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
    },
    dataBoundary: {
      sessionLogUpload: env.AGENTOPS_SESSION_LOG_UPLOAD === 'true',
      approvalRequired: env.AGENTOPS_APPROVAL_REQUIRED !== 'false',
      networkAllowlist: env.AGENTOPS_NETWORK_ALLOWLIST !== 'false',
    },
    rollback: {
      ...(snapshotAt === undefined ? {} : { snapshotAt }),
    },
  }
}

/**
 * Create the read-only system service.
 * @param input - the raw deployment facts.
 * @returns the read-only system service.
 */
export function createSystemService(input: DeploymentInput = readEnvironment()): AgentOpsSystemService {
  const snapshot = buildDeploymentSnapshot(input)
  return { snapshot: () => structuredClone(snapshot) }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
