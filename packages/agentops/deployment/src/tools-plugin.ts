/**
 * Agent-scoped deployment tool registration.
 * @module @agentops/dsh-deployment/tools
 */

import type { Context } from '@deepseek-ai/cordis'

import { ArtifactBuildService } from './build.ts'
import { DeploymentService } from './service.ts'
import { SubprocessLocalCommandRunner } from './local-runner.ts'
import {
  createArtifactBuildTool,
  createDeploymentPlanTool,
  createDeploymentReleaseTool,
  createDeploymentRollbackTool,
  createDeploymentStatusTool,
  TOOL_NAMES,
} from './tools.ts'

export const name = 'agentops-deployment-tools'

export const inject = ['tools', 'deployment', 'approval', 'subprocess']

export { TOOL_NAMES } from './tools.ts'

/** Agent-scoped tool configuration. */
export interface DeploymentToolsConfig {
  /** Preset owning these tools; omission fails the registration. */
  readonly agentPreset?: string
  readonly only?: readonly string[]
}

/** Register the deployment tools for one Agent preset. */
export function apply(ctx: Context, config: DeploymentToolsConfig): void {
  const agentPreset = config.agentPreset?.trim() ?? ''
  if (agentPreset === '') throw new Error('@agentops/dsh-deployment/tools requires config.agentPreset')
  const only = config.only === undefined ? undefined : new Set(config.only)
  for (const name of config.only ?? []) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(`only contains unknown deployment tool "${name}"; known: ${TOOL_NAMES.join(', ')}`)
    }
  }
  const include = (name: string): boolean => only === undefined || only.has(name)
  const auth = { agentPreset }
  const deployment = new DeploymentService(ctx.deployment.journal, ctx.deployment.capabilityStore, ctx.deployment.transport)
  if (include('artifact_build')) {
    const build = new ArtifactBuildService(ctx.deployment.capabilityStore, new SubprocessLocalCommandRunner(ctx.subprocess))
    ctx.tools.register(createArtifactBuildTool(build, auth))
  }
  if (include('deployment_plan')) ctx.tools.register(createDeploymentPlanTool(deployment, auth))
  if (include('deployment_release')) ctx.tools.register(createDeploymentReleaseTool(deployment, auth, ctx))
  if (include('deployment_status')) ctx.tools.register(createDeploymentStatusTool(deployment, auth))
  if (include('deployment_rollback')) ctx.tools.register(createDeploymentRollbackTool(deployment, auth, ctx))
}
