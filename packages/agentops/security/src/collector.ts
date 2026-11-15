/**
 * Usage tap: records one row per model call from the `llm/stream` waterfall.
 *
 * The waterfall hands us the request options and the inner stream. We pass the
 * inner stream through untouched and only read `usage` chunks — no rewriting, no
 * buffering, so a crash here cannot corrupt a response.
 *
 * Identity: DSH puts only `sessionId` on the request. Per-user attribution is
 * therefore recorded as `unattributed` unless a future caller supplies a user;
 * the monitor page shows that honestly instead of guessing.
 *
 * @module @agentops/dsh-security/collector
 */

import { randomUUID } from 'node:crypto'

import type { SecurityStore } from './store.ts'

/** Minimal shapes we rely on, kept structural so this package needs no LLM dependency. */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface ChunkLike {
  type: string
  usage?: UsageLike
}

interface OptionsLike {
  model?: string
  provider?: string
  sessionId?: string
  purpose?: string
}

/** Attribution fallback and injectable clock and id for the usage tap. */
export interface UsageTapOptions {
  /** Label recorded when the request carries no user identity. */
  unattributedUser?: string
  now?: () => Date
  id?: () => string
}

/**
 * Sum provider usage buckets without double counting cache tokens.
 * @param usage - provider-reported usage.
 * @returns the prompt and completion token counts, with cache tokens counted once.
 */
export function totalTokensOf(usage: UsageLike): { prompt: number; completion: number } {
  return {
    prompt: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    completion: usage.outputTokens ?? 0,
  }
}

/**
 * Build the waterfall listener.
 * @param store - security store receiving the rows.
 * @param options - attribution fallback and injectable clock/id.
 * @returns a waterfall listener that records provider usage.
 */
export function createUsageTap(
  store: SecurityStore,
  options: UsageTapOptions = {},
): (request: OptionsLike, next: () => AsyncIterable<ChunkLike>) => AsyncIterable<ChunkLike> {
  const unattributed = options.unattributedUser ?? 'unattributed'
  const now = options.now ?? (() => new Date())
  const id = options.id ?? (() => `use_${randomUUID().slice(0, 8)}`)

  return async function* tap(request, next) {
    let recorded = false
    for await (const chunk of next()) {
      if (!recorded && chunk.type === 'usage' && chunk.usage !== undefined) {
        const { prompt, completion } = totalTokensOf(chunk.usage)
        if (prompt + completion > 0) {
          recorded = true
          try {
            store.recordUsage({
              id: id(),
              userId: unattributed,
              ...(typeof request.sessionId === 'string' ? { sessionId: request.sessionId } : {}),
              agent: request.purpose ?? 'chat',
              provider: request.provider ?? 'unknown',
              model: request.model ?? 'unknown',
              promptTokens: prompt,
              completionTokens: completion,
              at: now().toISOString(),
            })
          } catch {
            // Telemetry must never break a model call.
          }
        }
      }
      yield chunk
    }
  }
}
