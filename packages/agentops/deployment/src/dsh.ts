/**
 * Root deployment plugin.
 * @module @agentops/dsh-deployment/dsh
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Service, type Context } from '@deepseek-ai/cordis'
import { CapabilityStore } from '@agentops/dsh-capability'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { DeploymentStore } from './store.ts'
import { Ssh2DeploymentTransport, type DeploymentTransport } from './transport.ts'

export const name = 'agentops-deployment'

export const inject: string[] = []

/** Root plugin configuration. */
export interface DeploymentPluginConfig {
  readonly dbPath?: string
  readonly capabilityDbPath?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    deployment: DeploymentRuntime
  }
}

/** Root-owned deployment journal and capability store. */
export class DeploymentRuntime extends Service {
  /** Durable release journal. */
  readonly journal: DeploymentStore
  /** Capability center store used to resolve deployment and SSH instances. */
  readonly capabilityStore: CapabilityStore
  /** SSH transport used for all remote release operations. */
  readonly transport: DeploymentTransport

  /**
   * @param ctx - root context.
   * @param journal - durable release journal.
   * @param capabilityStore - capability center store.
   * @param transport - SSH release transport.
   */
  constructor(ctx: Context, journal: DeploymentStore, capabilityStore: CapabilityStore, transport: DeploymentTransport) {
    super(ctx, 'deployment')
    this.journal = journal
    this.capabilityStore = capabilityStore
    this.transport = transport
  }
}

/**
 * Resolve the deployment journal path from config, environment, or the default home directory.
 * @param config - plugin config.
 * @returns deployment journal path.
 */
export function resolveDeploymentDbPath(config: DeploymentPluginConfig = {}): string {
  return config.dbPath?.trim() || process.env.AGENTOPS_DEPLOYMENT_DB?.trim() || dshHomePath('agentops', 'deployment.db')
}

/**
 * Mount the deployment journal and capability store.
 * @param ctx - root context.
 * @param config - database path overrides.
 */
export function apply(ctx: Context, config: DeploymentPluginConfig = {}): void {
  const dbPath = resolveDeploymentDbPath(config)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  const journal = new DeploymentStore(db)
  const capabilityStore = new CapabilityStore(
    config.capabilityDbPath?.trim() || dshHomePath('agentops', 'capabilities.db'),
  )
  new DeploymentRuntime(ctx, journal, capabilityStore, new Ssh2DeploymentTransport())
  ctx.effect(() => () => {
    db.close()
    capabilityStore.close()
  })
}
