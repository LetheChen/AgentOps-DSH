/**
 * DSH plugin surface for AgentOps business routes and deployment diagnostics.
 *
 * Root routes serve generative-UI surfaces plus DSH session and AgentOps agent,
 * schedule, and archive data. The deployment snapshot collector stays pure in
 * `collect.ts`; `createSystemTool` adapts it into a model-facing tool. DSH itself
 * owns runtime, model-provider, and model-credential settings.
 *
 * @module @agentops/dsh-host/dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'


import { registerAgentsRoute } from './agents.ts'
import { registerCatalogRoutes } from './catalog.ts'
import { registerAgentModelsRoute } from './models.ts'
import { registerSessionRoutes } from './sessions.ts'
import type { SessionQueryLike } from './sessions.ts'
import { registerArchiveRoute } from './archive.ts'
import { registerSchedulesRoute, ScheduleRuntime } from './schedules.ts'
import { registerSkillsRoutes } from './skills.ts'
import { registerSurfaceRoutes, SurfaceStore } from './surfaces.ts'
import { registerToolCatalogRoute } from './tool-catalog.ts'
import type { AgentOpsSystemService, DeploymentSnapshot } from './index.ts'

/**
 * Resolve the generative-UI database path: explicit env, else the DSH home.
 * Exported so the tool half opens the same file as the root routes.
 * @param env - environment mapping used to resolve overrides.
 * @returns the SQLite database path shared by routes and Agent tools.
 */
export function resolveSurfaceDbPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.AGENTOPS_SURFACE_DB?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return join(resolveDshHome(undefined, env), 'agentops', 'surfaces.db')
}

export const name = 'agentops-system'

/**
 * Root scope: no model registry here. `tools` is provided per Agent scope, so a
 * root `inject: ['tools']` stays pending forever; the tool half lives in
 * `./tools.ts` and is mounted from a preset.
 */
export const inject: string[] = []

/**
 * Build the model-facing tool over a snapshot service.
 *
 * Exported separately from {@link apply} so contract tests can invoke
 * `execute`/`render` without booting a Cordis tree.
 * @param service - read-only snapshot source.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
export function createSystemTool(service: AgentOpsSystemService): ToolDefinition {
  return defineTool({
    name: 'agentops_system_status',
    description:
      'Read this AgentOps host deployment snapshot: DSH and Node versions, instance topology, '
      + 'Sidecar health, database latency, data-boundary switches, rollback snapshot and warnings. '
      + 'Read-only; use it before claiming the environment is safe or after an upgrade.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dshVersion: { type: 'string', required: true },
          nodeVersion: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          upgradeChannel: { type: 'string', required: true, enum: ['stable', 'preview'] },
          instances: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['single', 'multi'] },
              hostCount: { type: 'integer', required: true },
              sessionSticky: { type: 'boolean', required: true },
            },
          },
          database: {
            type: 'object',
            additionalProperties: false,
            properties: {
              engine: { type: 'string', required: true },
              latencyMs: { type: 'json', required: true },
            },
          },
          dataBoundary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionLogUpload: { type: 'boolean', required: true },
              approvalRequired: { type: 'boolean', required: true },
              networkAllowlist: { type: 'boolean', required: true },
            },
          },
          rollback: {
            type: 'object',
            additionalProperties: false,
            properties: {
              snapshotAt: { type: 'json', required: true },
            },
          },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summarize(value as DeploymentSnapshot) }],
      presentationMeta: (_args, value) => ({
        dshVersion: value.dshVersion,
        warningCount: value.warnings.length,
      }),
    },
    execute() {
      return Promise.resolve(service.snapshot())
    },
    presentCall: () => ({ card: 'generic', title: 'Read deployment snapshot', kind: 'other' }),
  })
}

/**
 * One-line human summary used as the tool result text.
 * @param snapshot - deployment facts.
 * @returns a compact sentence, warnings included.
 */
export function summarize(snapshot: DeploymentSnapshot): string {
  const base =
    `DSH ${snapshot.dshVersion} on Node ${snapshot.nodeVersion} (profile ${snapshot.profile}); `
    + `${snapshot.instances.mode} × ${snapshot.instances.hostCount}, `
    + `sessionSticky=${snapshot.instances.sessionSticky}; `
    + `data ${snapshot.database.engine}; `
    + `db ${snapshot.database.engine} ${snapshot.database.latencyMs ?? '?'}ms`
  return snapshot.warnings.length === 0
    ? `${base}; no warnings`
    : `${base}; ${snapshot.warnings.length} warning(s): ${snapshot.warnings.join(' | ')}`
}

/** Configuration for AgentOps root routes. */
export interface HostPluginConfig {
  /** Directory holding legacy `*.yaml` agent definitions. */
  agentDir?: string
  /** Legacy `schedules.yaml` path. */
  schedulesFile?: string
  /** Directory containing workflow YAML used by scheduled runs. */
  workflowDir?: string
  /** Directory holding files agents produced. */
  archiveDir?: string
  /** Legacy tool catalogue and DSH tool mapping file. */
  toolMapFile?: string
  /** Directory holding business-domain YAML definitions. */
  domainDir?: string
  /** Directory holding Actor visual profiles. */
  actorDir?: string
  /** Directory receiving installed skills. */
  skillManagedDir?: string
  /** JSON file listing disabled skill names. */
  skillsDisabledFile?: string
}

/**
 * Register AgentOps business routes in the connected DSH host.
 * @param ctx - Cordis context.
 * @param config - AgentOps route configuration.
 */
export function apply(ctx: Context, config: HostPluginConfig = {}): void {
  ctx.inject(['connection'], (connectionCtx) => {
    // Generative UI surfaces: agents publish through `present_content`, pages read here.
    const surfacePath = resolveSurfaceDbPath()
    if (surfacePath !== ':memory:') mkdirSync(dirname(surfacePath), { recursive: true })
    registerSurfaceRoutes(connectionCtx, new SurfaceStore(surfacePath))

    // Session replay reads DSH's own sessionQuery service; absent means the
    // deployment has no session persistence, which the page must show as empty.
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query !== undefined) registerSessionRoutes(connectionCtx, query)

    const dir = config.agentDir?.trim() ?? process.env.AGENTOPS_AGENT_DIR?.trim() ?? ''
    if (dir.length > 0) registerAgentsRoute(connectionCtx, dir)

    // Model selection is independent of the legacy Agent directory. Register
    // the live catalog whenever the DSH LLM service is present; absence leaves
    // the endpoint unavailable rather than serving fabricated model options.
    connectionCtx.inject(['llm'], (llmCtx) => {
      registerAgentModelsRoute(connectionCtx, llmCtx.llm)
    })
    const schedules = config.schedulesFile?.trim() ?? process.env.AGENTOPS_SCHEDULES_FILE?.trim() ?? ''
    const workflowDir = config.workflowDir?.trim() ?? join(resolveDshHome(undefined), 'agentops', 'workflows')
    const scheduleRuntime = schedules.length === 0
      ? undefined
      : new ScheduleRuntime(schedules, workflowDir, () => ctx.get('sessionController'))
    if (schedules.length > 0) registerSchedulesRoute(connectionCtx, schedules, scheduleRuntime)
    if (scheduleRuntime !== undefined) {
      ctx.inject(['sessionController'], () => {
        scheduleRuntime.start()
        ctx.effect(() => () => { scheduleRuntime.dispose() }, 'agentops-system: schedule runtime')
      })
    }
    const archive = config.archiveDir?.trim() ?? process.env.AGENTOPS_ARCHIVE_DIR?.trim() ?? ''
    if (archive.length > 0) registerArchiveRoute(connectionCtx, archive)
    // The tool catalogue is a deployment asset: the runtime tool registry is
    // Agent-scoped, so the root scope cannot enumerate the tool surface.
    const toolMap = config.toolMapFile?.trim() ?? process.env.AGENTOPS_TOOL_MAP_FILE?.trim() ?? ''
    if (toolMap.length > 0) registerToolCatalogRoute(connectionCtx, toolMap)
    // Business domains and Actor profiles are separate registries: the editor
    // pre-fills an Agent from its domain, and the collaboration page lists the
    // surface views an Actor may publish.
    const domains = config.domainDir?.trim() || process.env.AGENTOPS_DOMAIN_DIR?.trim()
      || join(resolveDshHome(undefined), 'agentops', 'domains')
    const actors = config.actorDir?.trim() ?? process.env.AGENTOPS_ACTOR_DIR?.trim() ?? ''
    if (domains.length > 0 || actors.length > 0) registerCatalogRoutes(connectionCtx, domains, actors)

    const skillManagedDir = config.skillManagedDir?.trim() ?? join(resolveDshHome(undefined), 'agentops', 'skills')
    const skillsDisabledFile = config.skillsDisabledFile?.trim() ?? join(resolveDshHome(undefined), 'agentops', 'skills-disabled.json')
    connectionCtx.inject(['skills'], (skillsCtx) => {
      registerSkillsRoutes(connectionCtx, skillsCtx.skills, { managedDir: skillManagedDir, disabledFile: skillsDisabledFile })
    })
  })
}
