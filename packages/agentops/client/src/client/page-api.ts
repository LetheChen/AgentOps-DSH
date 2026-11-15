/**
 * Shared HTTP helpers for the credential, session-replay, and generative-UI
 * pages.
 *
 * Responses are wire data: every loader reads them as `unknown` and narrows
 * the fields it displays, so a malformed body fails before it reaches a table.
 *
 * @module @agentops/dsh-client/page-api
 */

/** A non-success HTTP response from an AgentOps page route. */
export class PageRequestError extends Error {
  /**
   * @param status - HTTP status returned by the host.
   * @param reason - server-provided reason, empty when the body carried none.
   */
  public constructor(public readonly status: number, public readonly reason = '') {
    super(reason === '' ? `HTTP ${status}` : reason)
    this.name = 'PageRequestError'
  }
}

/** A successful HTTP response whose body is not the JSON the route documents. */
export class PageResponseError extends Error {
  /**
   * @param cause - parser error that made the body invalid, when available.
   */
  public constructor(cause?: unknown) {
    super('page response has an invalid format', { cause })
    this.name = 'PageResponseError'
  }
}

/**
 * Narrow a value to a plain object.
 * @param value - value read from the wire.
 * @returns whether the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a JSON body from an AgentOps page route.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param url - route to request.
 * @returns the parsed body.
 */
export async function readJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { credentials: 'include' })
  if (!response.ok) throw new PageRequestError(response.status)
  let payload: unknown
  try {
    payload = await response.json()
  } catch (reason) {
    throw new PageResponseError(reason)
  }
  return payload
}

/**
 * Post a JSON body to an AgentOps page route.
 *
 * The body is parsed even for a failed status, because the vault routes report
 * their refusal reason inside it.
 *
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param url - route to request.
 * @param body - request body.
 * @returns the parsed response body.
 */
export async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch (reason) {
    throw new PageResponseError(reason)
  }
  if (!response.ok) {
    const reason = isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : ''
    throw new PageRequestError(response.status, reason)
  }
  return payload
}
