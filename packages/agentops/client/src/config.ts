/** Polling configuration shared by the Host injection and browser parser. */
import z from '@deepseek-ai/schemastery'

/** Deployment settings for the collaboration panel. */
export interface Config {
  /** Delay between settled run-activity polls, in milliseconds. */
  collaborationPollIntervalMs: number
}

/** Validated collaboration panel settings. */
export const Config: z<Partial<Config>, Config> = z.object({
  collaborationPollIntervalMs: z.natural().min(1).max(2_147_483_646).default(3_000),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the browser copy of the injected collaboration configuration.
 *
 * The page global is a serialization boundary. Missing configuration uses the
 * documented defaults; every supplied field must have its declared type and
 * pass {@link Config} validation.
 * @param value - the global configuration value, or `undefined` when absent.
 * @returns validated collaboration settings.
 */
export function resolveClientConfig(value: unknown): Config {
  if (value === undefined) return Config({})
  if (!isRecord(value)) throw new TypeError('invalid AgentOps client configuration')
  if (
    Object.hasOwn(value, 'collaborationPollIntervalMs')
    && typeof value.collaborationPollIntervalMs !== 'number'
  ) {
    throw new TypeError('invalid AgentOps client configuration')
  }
  return Config(value)
}
