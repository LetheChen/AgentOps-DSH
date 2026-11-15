/**
 * Live model catalog for the Agent editor.
 *
 * Provider discovery crosses the DSH LLM service rather than AgentOps YAML.
 * One provider failure is reported beside the successful provider groups so a
 * single unavailable endpoint cannot hide every usable model.
 *
 * @module @agentops/dsh-host/models
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

/** One model option exposed to the Agent editor. */
export interface AgentModelOption {
  /** Model id accepted by the provider route. */
  readonly id: string
  /** Human-readable label. */
  readonly name: string
  /** Optional distinction from otherwise similar models. */
  readonly description?: string
}

/** Models currently advertised by one provider route. */
export interface AgentModelProvider {
  /** Provider route id stored on an Agent definition. */
  readonly id: string
  /** Human-readable provider label. */
  readonly name: string
  /** Models advertised by this provider, in registry order. */
  readonly models: readonly AgentModelOption[]
}

/** Provider catalog read failure retained for diagnostics and retry UI. */
export interface AgentModelFailure {
  /** Provider route id whose model lookup failed. */
  readonly id: string
  /** Human-readable provider label. */
  readonly name: string
  /** Actionable provider failure message. */
  readonly message: string
}

/** Complete response returned by `/api/agentops/models`. */
export interface AgentModelCatalog {
  /** Successfully queried providers, including providers with no models. */
  readonly providers: readonly AgentModelProvider[]
  /** Providers whose model lookup failed. */
  readonly failures: readonly AgentModelFailure[]
}

/** Minimal live LLM registry surface consumed by catalog assembly. */
export interface AgentModelLlm {
  /** @returns registered provider routes. */
  listProviders(): readonly LlmProviderInfo[]
  /** @param provider - provider route id. @returns models advertised by that route. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/**
 * Build the Agent editor model catalog from the live LLM registry.
 * @param llm - live LLM provider and model registry.
 * @returns successful provider groups and isolated provider failures.
 */
export async function buildAgentModelCatalog(llm: AgentModelLlm): Promise<AgentModelCatalog> {
  const entries = await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      return {
        kind: 'provider' as const,
        provider: {
          id: provider.id,
          name: provider.name,
          models: models.map(model => ({
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
          })),
        },
      }
    } catch (reason) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: reason instanceof Error ? reason.message : String(reason),
        },
      }
    }
  }))
  return {
    providers: entries.flatMap(entry => entry.kind === 'provider' ? [entry.provider] : []),
    failures: entries.flatMap(entry => entry.kind === 'failure' ? [entry.failure] : []),
  }
}

/**
 * Register the read-only model catalog route.
 * @param ctx - context carrying the DSH connection route registry.
 * @param llm - live LLM registry.
 */
export function registerAgentModelsRoute(ctx: Context, llm: AgentModelLlm): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/models',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify(await buildAgentModelCatalog(llm)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  }), 'agentops-system: GET /api/agentops/models')
}
