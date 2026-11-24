/**
 * Model-facing deployment tools.
 * @module @agentops/dsh-deployment/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

import type { ArtifactBuildService } from './build.ts'
import type { DeploymentService } from './service.ts'
import { DeploymentError } from './types.ts'

/** Tools registered by this package. */
export const TOOL_NAMES = [
  'artifact_build',
  'deployment_plan',
  'deployment_release',
  'deployment_status',
  'deployment_rollback',
] as const

/** Immutable authorization context bound by the plugin mount. */
export interface DeploymentToolContext {
  readonly agentPreset: string
}

/** Canonical output accepted by every deployment tool. */
interface ToolOutput {
  readonly ok: boolean
  readonly instance_id?: string
  readonly release_uid?: string
  readonly release_id?: string
  readonly state?: string
  readonly manifest?: JsonValue
  readonly manifest_digest?: string
  readonly backup_tag?: string
  readonly backup_image_id?: string
  readonly image_id?: string
  readonly steps?: string[]
  readonly current?: JsonValue
  readonly previous_healthy?: JsonValue
  readonly journal?: JsonValue[]
  readonly live_image_id?: string
  readonly error?: JsonValue
}

/** Shared output contract. */
const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    instance_id: { type: 'string' },
    release_uid: { type: 'string' },
    release_id: { type: 'string' },
    state: { type: 'string' },
    manifest: { type: 'json' },
    manifest_digest: { type: 'string' },
    backup_tag: { type: 'string' },
    backup_image_id: { type: 'string' },
    image_id: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    current: { type: 'json' },
    previous_healthy: { type: 'json' },
    journal: { type: 'array', items: { type: 'json' } },
    live_image_id: { type: 'string' },
    error: { type: 'json' },
  },
} as const

/**
 * Build the artifact build tool definition.
 * @param service - artifact build service.
 * @param auth - preset-scoped tool authorization.
 * @returns the artifact build tool.
 */
export function createArtifactBuildTool(service: ArtifactBuildService, auth: DeploymentToolContext): ToolDefinition {
  return defineTool({
    name: 'artifact_build',
    description: 'Build from the configured local artifact-build instance, verify declared outputs, and write the release manifest. This tool has no production SSH credential.',
    parameters: {
      build_instance_id: { type: 'string', required: true, description: 'Authorized artifact-build instance id.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<ToolOutput> {
      try {
        const result = await service.build({ agentPreset: auth.agentPreset, instanceId: args.build_instance_id, signal: exec.signal })
        return {
          ok: true,
          instance_id: result.instanceId,
          release_id: result.releaseId,
          manifest: jsonValue(result.manifest),
          manifest_digest: result.manifestDigest,
          steps: ['build-complete', 'artifact-verified', 'manifest-written'],
        }
      } catch (error) {
        return failure('artifact_build', args.build_instance_id, error)
      }
    },
  })
}

/**
 * Build the deployment plan tool definition.
 * @param service - deployment service.
 * @param auth - preset-scoped tool authorization.
 * @returns the deployment plan tool.
 */
export function createDeploymentPlanTool(service: DeploymentService, auth: DeploymentToolContext): ToolDefinition {
  return defineTool({
    name: 'deployment_plan',
    description: 'Read-only deployment preflight over an authorized deployment instance. Verifies local artifacts, SSH host key, remote prerequisites, and the configured release mode.',
    parameters: {
      deployment_instance_id: { type: 'string', required: true, description: 'Authorized deployment instance id.' },
      mode: { type: 'string', description: 'update or first_install; defaults to update.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<ToolOutput> {
      try {
        const result = await service.plan({
          agentPreset: auth.agentPreset,
          instanceId: args.deployment_instance_id,
          mode: parseMode(args.mode),
          signal: exec.signal,
        })
        return {
          ok: true,
          instance_id: result.instanceId,
          release_id: result.manifest.releaseId,
          manifest: jsonValue(result.manifest),
          manifest_digest: result.manifestDigest,
          steps: [...result.steps],
        }
      } catch (error) {
        return failure('deployment_plan', args.deployment_instance_id, error)
      }
    },
  })
}

/**
 * Build the approved release tool definition.
 * @param service - deployment service.
 * @param auth - preset-scoped tool authorization.
 * @param ctx - context that owns approval requests.
 * @returns the deployment release tool.
 */
export function createDeploymentReleaseTool(service: DeploymentService, auth: DeploymentToolContext, ctx: Context): ToolDefinition {
  return defineTool({
    name: 'deployment_release',
    description: 'Require one-shot approval, back up the current production image under a timestamped image-id tag, upload and verify artifacts, execute the configured update entrypoint, and verify health.',
    parameters: {
      deployment_instance_id: { type: 'string', required: true, description: 'Authorized deployment instance id.' },
      mode: { type: 'string', description: 'update or first_install; defaults to update.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<ToolOutput> {
      try {
        await approve(ctx, exec, 'deployment_release', `Release ${args.deployment_instance_id} to production`)
        const result = await service.release({
          agentPreset: auth.agentPreset,
          instanceId: args.deployment_instance_id,
          mode: parseMode(args.mode),
          signal: exec.signal,
        })
        return actionResult(result)
      } catch (error) {
        return failure('deployment_release', args.deployment_instance_id, error)
      }
    },
  })
}

/**
 * Build the deployment status tool definition.
 * @param service - deployment service.
 * @param auth - preset-scoped tool authorization.
 * @returns the deployment status tool.
 */
export function createDeploymentStatusTool(service: DeploymentService, auth: DeploymentToolContext): ToolDefinition {
  return defineTool({
    name: 'deployment_status',
    description: 'Read the current release, previous healthy backup, live image id, journal state, and last confirmed step for one authorized deployment instance.',
    parameters: {
      deployment_instance_id: { type: 'string', required: true, description: 'Authorized deployment instance id.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<ToolOutput> {
      try {
        const result = await service.status({ agentPreset: auth.agentPreset, instanceId: args.deployment_instance_id, signal: exec.signal })
        return {
          ok: true,
          instance_id: args.deployment_instance_id,
          current: result.current === null ? null : jsonValue(result.current),
          previous_healthy: result.previousHealthy === null ? null : jsonValue(result.previousHealthy),
          journal: result.journal.map(item => jsonValue(item)),
          ...(result.liveImageId === null ? {} : { live_image_id: result.liveImageId }),
        }
      } catch (error) {
        return failure('deployment_status', args.deployment_instance_id, error)
      }
    },
  })
}

/**
 * Build the approved rollback tool definition.
 * @param service - deployment service.
 * @param auth - preset-scoped tool authorization.
 * @param ctx - context that owns approval requests.
 * @returns the deployment rollback tool.
 */
export function createDeploymentRollbackTool(service: DeploymentService, auth: DeploymentToolContext, ctx: Context): ToolDefinition {
  return defineTool({
    name: 'deployment_rollback',
    description: 'Require one-shot approval and roll back one recorded healthy release. Database restore is not performed.',
    parameters: {
      deployment_instance_id: { type: 'string', required: true, description: 'Authorized deployment instance id.' },
      release_id: { type: 'string', required: true, description: 'Recorded healthy release id.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<ToolOutput> {
      try {
        await approve(ctx, exec, 'deployment_rollback', `Roll back ${args.deployment_instance_id} to ${args.release_id}`)
        const result = await service.rollback({
          agentPreset: auth.agentPreset,
          instanceId: args.deployment_instance_id,
          releaseId: args.release_id,
          signal: exec.signal,
        })
        return actionResult(result)
      } catch (error) {
        return failure('deployment_rollback', args.deployment_instance_id, error)
      }
    },
  })
}

async function approve(ctx: Context, exec: ToolRunContext, toolName: string, reason: string): Promise<void> {
  if (exec.agent === undefined) {
    throw new DeploymentError('DEPLOYMENT_APPROVAL_REQUIRED', 'deployment tool call has no owning Agent')
  }
  const outcome = await ctx.approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new DeploymentError('DEPLOYMENT_APPROVAL_DENIED', `approval ${outcome}`, {
      action: 'Ask the user to approve the exact release or rollback action.',
    })
  }
}

function actionResult(result: Awaited<ReturnType<DeploymentService['release']>>): ToolOutput {
  return {
    ok: true,
    instance_id: result.instanceId,
    release_uid: result.releaseUid,
    release_id: result.releaseId,
    state: result.state,
    manifest: jsonValue(result.manifest),
    ...(result.backupTag === null ? {} : { backup_tag: result.backupTag }),
    ...(result.backupImageId === null ? {} : { backup_image_id: result.backupImageId }),
    ...(result.imageId === null ? {} : { image_id: result.imageId }),
    steps: [...result.steps],
  }
}

function failure(tool: string, instanceId: string, error: unknown): ToolOutput {
  const deployment = error instanceof DeploymentError
    ? {
      code: error.code,
      message: error.message,
      ...(error.action === undefined ? {} : { action: error.action }),
    }
    : { code: 'DEPLOYMENT_UNSUPPORTED', message: error instanceof Error ? error.message : String(error) }
  return { ok: false, instance_id: instanceId, error: { tool, ...deployment } }
}

function jsonValue(value: object): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (!isJsonValue(snapshot)) throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', 'deployment result is not lossless JSON')
  return snapshot as JsonValue
}

function parseMode(value: string | undefined): 'update' | 'first_install' {
  if (value === undefined || value === '' || value === 'update') return 'update'
  if (value === 'first_install') return 'first_install'
  throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', `unsupported deployment mode ${value}`)
}
