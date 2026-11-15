/**
 * Typed browser requests for the read-only security administration pages.
 *
 * Fetch responses are untrusted wire data. Each loader validates the fields the
 * UI needs, discards additive server fields, and fails before a malformed row
 * reaches the panel.
 *
 * @module @agentops/dsh-client/security-api
 */

/** A security principal returned by `GET /api/agentops/security/users`. */
export interface SecurityUser {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly status: 'active' | 'disabled'
  readonly createdAt: string
  readonly roleIds: readonly string[]
}

/** A role returned by `GET /api/agentops/security/roles`. */
export interface SecurityRole {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly permissions: readonly string[]
}

/** A login session returned by `GET /api/agentops/security/sessions`. */
export interface SecuritySession {
  readonly id: string
  readonly userId: string
  readonly agent: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly status: 'active' | 'ended'
}

/** An API token descriptor returned by `GET /api/agentops/security/tokens`. */
export interface SecurityToken {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly prefix: string
  readonly createdAt: string
  readonly revokedAt: string | null
}

/** A non-success HTTP response from a security API route. */
export class SecurityRequestError extends Error {
  /**
   * @param status - HTTP status returned by the host.
   */
  public constructor(public readonly status: number) {
    super(`security request failed with HTTP ${status}`)
    this.name = 'SecurityRequestError'
  }
}

/** A successful HTTP response whose JSON does not match the expected security rows. */
export class SecurityResponseError extends Error {
  /**
   * @param cause - parser error that made the response invalid, when available.
   */
  public constructor(cause?: unknown) {
    super('security response has an invalid format', { cause })
    this.name = 'SecurityResponseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseSecurityUser(value: unknown): SecurityUser | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, email, status, createdAt, roleIds } = value
  if (
    typeof id !== 'string'
    || typeof name !== 'string'
    || !isNullableString(email)
    || (status !== 'active' && status !== 'disabled')
    || typeof createdAt !== 'string'
    || !isStringArray(roleIds)
  ) return undefined
  return { id, name, email, status, createdAt, roleIds: [...roleIds] }
}

function parseSecurityRole(value: unknown): SecurityRole | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, description, permissions } = value
  if (
    typeof id !== 'string'
    || typeof name !== 'string'
    || typeof description !== 'string'
    || !isStringArray(permissions)
  ) return undefined
  return { id, name, description, permissions: [...permissions] }
}

function parseSecuritySession(value: unknown): SecuritySession | undefined {
  if (!isRecord(value)) return undefined
  const { id, userId, agent, startedAt, endedAt, status } = value
  if (
    typeof id !== 'string'
    || typeof userId !== 'string'
    || typeof agent !== 'string'
    || typeof startedAt !== 'string'
    || !isNullableString(endedAt)
    || (status !== 'active' && status !== 'ended')
  ) return undefined
  return { id, userId, agent, startedAt, endedAt, status }
}

function parseSecurityToken(value: unknown): SecurityToken | undefined {
  if (!isRecord(value)) return undefined
  const { id, userId, name, prefix, createdAt, revokedAt } = value
  if (
    typeof id !== 'string'
    || typeof userId !== 'string'
    || typeof name !== 'string'
    || typeof prefix !== 'string'
    || typeof createdAt !== 'string'
    || !isNullableString(revokedAt)
  ) return undefined
  return { id, userId, name, prefix, createdAt, revokedAt }
}

async function loadList<T>(
  path: string,
  field: 'users' | 'roles' | 'sessions' | 'tokens',
  parseItem: (value: unknown) => T | undefined,
  fetchImpl: typeof fetch,
): Promise<readonly T[]> {
  const response = await fetchImpl(path, { credentials: 'include' })
  if (!response.ok) throw new SecurityRequestError(response.status)

  let payload: unknown
  try {
    payload = await response.json()
  } catch (reason) {
    throw new SecurityResponseError(reason)
  }

  if (!isRecord(payload) || !Array.isArray(payload[field])) {
    throw new SecurityResponseError()
  }
  const rows: T[] = []
  for (const raw of payload[field]) {
    const row = parseItem(raw)
    if (row === undefined) throw new SecurityResponseError()
    rows.push(row)
  }
  return rows
}

/**
 * Load security users with their assigned role ids.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns validated user rows.
 */
export async function loadSecurityUsers(fetchImpl: typeof fetch = fetch): Promise<readonly SecurityUser[]> {
  return loadList('/api/agentops/security/users', 'users', parseSecurityUser, fetchImpl)
}

/**
 * Load role definitions and their permission ids.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns validated role rows.
 */
export async function loadSecurityRoles(fetchImpl: typeof fetch = fetch): Promise<readonly SecurityRole[]> {
  return loadList('/api/agentops/security/roles', 'roles', parseSecurityRole, fetchImpl)
}

/**
 * Load login-session records.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns validated session rows.
 */
export async function loadSecuritySessions(fetchImpl: typeof fetch = fetch): Promise<readonly SecuritySession[]> {
  return loadList('/api/agentops/security/sessions', 'sessions', parseSecuritySession, fetchImpl)
}

/**
 * Load API-token descriptors. Plaintext tokens and hashes are never returned.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns validated token rows.
 */
export async function loadSecurityTokens(fetchImpl: typeof fetch = fetch): Promise<readonly SecurityToken[]> {
  return loadList('/api/agentops/security/tokens', 'tokens', parseSecurityToken, fetchImpl)
}
