/**
 * Browser-side access to the business-domain registry and the Actor registry.
 *
 * Both registries cross the host wire boundary, so every value consumed by the
 * UI is parsed here instead of being trusted. A registry that the host cannot
 * read surfaces as a rejected promise, and the pages show their own failure
 * state rather than rendering an empty list that looks like a real answer.
 *
 * @module @agentops/dsh-client/registry-api
 */

/** One business domain registered in the deployment's domain directory. */
export interface DomainRegistryEntry {
  /** Stable Domain identifier, also the Agent `domain` value. */
  readonly domain: string
  /** Human-readable Domain name. */
  readonly displayName: string
  /** What the Domain is for. */
  readonly description: string
  /** Tools new Agents in this Domain may use by default. */
  readonly defaultAllowedTools: readonly string[]
  /** Tools new Agents in this Domain may not use by default. */
  readonly defaultDeniedTools: readonly string[]
  /** Knowledge bases new Agents in this Domain read by default. */
  readonly defaultKnowledgeBases: readonly string[]
  /** Per-run cost limit inherited from the Domain. */
  readonly costLimitPerRun: number
  /** Whether the source file parsed without fatal errors. */
  readonly valid: boolean
  /** Non-fatal issues found while parsing the source file. */
  readonly issues: readonly string[]
}

/** One surface view an Actor may publish. */
export interface ActorViewRegistryEntry {
  /** Stable view identifier. */
  readonly viewId: string
  /** Output contract the view fulfils. */
  readonly outputContract: string
  /** What the view shows. */
  readonly description: string
  /** Workflow phases that must run before the view is available. */
  readonly requiredPhases: readonly string[]
  /** Number of fields the view declares. */
  readonly fieldCount: number
}

/** One Actor registered in the deployment's Actor directory. */
export interface ActorRegistryEntry {
  /** Stable Actor identifier. */
  readonly actorId: string
  /** What the Actor does. */
  readonly description: string
  /** Views the Actor is allowed to publish. */
  readonly views: readonly ActorViewRegistryEntry[]
  /** Whether the source file parsed without fatal errors. */
  readonly valid: boolean
  /** Non-fatal issues found while parsing the source file. */
  readonly issues: readonly string[]
}

/** A registry response did not match the wire format. */
export class RegistryResponseError extends Error {
  /** HTTP status of the rejected response. */
  readonly status: number

  /**
   * @param status - HTTP response status.
   * @param message - response validation failure.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'RegistryResponseError'
    this.status = status
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid registry response: object')
  }
  return value as Record<string, unknown>
}

function readText(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new Error(`invalid registry response: ${key}`)
  return value
}

function readTextList(source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`invalid registry response: ${key}`)
  }
  return value as readonly string[]
}

function readFlag(source: Record<string, unknown>, key: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') throw new Error(`invalid registry response: ${key}`)
  return value
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid registry response: ${key}`)
  }
  return value
}

function readIssues(source: Record<string, unknown>): readonly string[] {
  return readTextList(source, 'issues')
}

function parseDomainEntry(value: unknown): DomainRegistryEntry {
  const source = readRecord(value)
  return {
    domain: readText(source, 'domain'),
    displayName: readText(source, 'displayName'),
    description: readText(source, 'description'),
    defaultAllowedTools: readTextList(source, 'defaultAllowedTools'),
    defaultDeniedTools: readTextList(source, 'defaultDeniedTools'),
    defaultKnowledgeBases: readTextList(source, 'defaultKnowledgeBases'),
    costLimitPerRun: readNumber(source, 'costLimitPerRun'),
    valid: readFlag(source, 'valid'),
    issues: readIssues(source),
  }
}

function parseActorViewEntry(value: unknown): ActorViewRegistryEntry {
  const source = readRecord(value)
  return {
    viewId: readText(source, 'viewId'),
    outputContract: readText(source, 'outputContract'),
    description: readText(source, 'description'),
    requiredPhases: readTextList(source, 'requiredPhases'),
    fieldCount: readNumber(source, 'fieldCount'),
  }
}

function parseActorEntry(value: unknown): ActorRegistryEntry {
  const source = readRecord(value)
  const views = source['views']
  if (!Array.isArray(views)) throw new Error('invalid registry response: views')
  return {
    actorId: readText(source, 'actorId'),
    description: readText(source, 'description'),
    views: views.map(parseActorViewEntry),
    valid: readFlag(source, 'valid'),
    issues: readIssues(source),
  }
}

async function readJson(fetchImpl: typeof fetch, path: string): Promise<unknown> {
  const response = await fetchImpl(path, { credentials: 'include' })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new RegistryResponseError(response.status, 'invalid registry response: body')
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['message']
      : undefined
    throw new RegistryResponseError(
      response.status,
      typeof message === 'string' && message !== '' ? message : 'registry request failed',
    )
  }
  return payload
}

/**
 * Load the business-domain registry.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns every registered Domain, including entries with issues.
 */
export async function loadDomainRegistry(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly DomainRegistryEntry[]> {
  const payload = await readJson(fetchImpl, '/api/agentops/domain-registry')
  const source = readRecord(payload)
  const domains = source['domains']
  if (!Array.isArray(domains)) throw new RegistryResponseError(200, 'invalid registry response: domains')
  try {
    return domains.map(parseDomainEntry)
  } catch {
    throw new RegistryResponseError(200, 'invalid registry response: domains')
  }
}

/**
 * Load the Actor registry.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns every registered Actor, including entries with issues.
 */
export async function loadActorRegistry(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ActorRegistryEntry[]> {
  const payload = await readJson(fetchImpl, '/api/agentops/actors')
  const source = readRecord(payload)
  const actors = source['actors']
  if (!Array.isArray(actors)) throw new RegistryResponseError(200, 'invalid registry response: actors')
  try {
    return actors.map(parseActorEntry)
  } catch {
    throw new RegistryResponseError(200, 'invalid registry response: actors')
  }
}
