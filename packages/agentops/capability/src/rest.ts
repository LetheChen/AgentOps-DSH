/**
 * Generic REST transport for capability instances.
 *
 * The transport resolves the instance's authentication profile, asks the token
 * broker for the token bound to the request subject, and presents that token
 * according to the profile. It knows nothing about any vendor's routes: a tool
 * names a path and the transport handles authentication, retry, and timeouts.
 *
 * A rejected token is re-minted once for the same subject and the call is
 * retried once. It is never retried in a loop, so a misconfigured instance
 * fails instead of hammering the vendor.
 *
 * @module @agentops/dsh-capability/rest
 */

import { Service, type Context } from '@deepseek-ai/cordis'

import { CapabilityError } from './errors.ts'
import { parseAuthSpec, type AuthSubject, type AuthSpec } from './auth.ts'
import { TokenBroker, type AccessToken, type TokenRequestOptions } from './token-broker.ts'
import type { CapabilityRuntime } from './types.ts'

/** One REST call a capability tool wants to make. */
export interface RestRequest {
  /** HTTP method. */
  readonly method: 'GET' | 'POST'
  /** Path relative to the instance `base_url`. */
  readonly path: string
  /** Query parameters. Undefined values are omitted. */
  readonly query?: Readonly<Record<string, string | number | undefined>>
  /** JSON body for a write call. */
  readonly body?: unknown
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Identity fields the instance auth profile may bind into the token request. */
  readonly subject?: AuthSubject
}

/** The outcome of one REST call. */
export interface RestResponse {
  /** HTTP status code. */
  readonly status: number
  /** True when the status is in the 2xx range. */
  readonly ok: boolean
  /** Parsed response body, or undefined when it was not JSON. */
  readonly json: unknown
  /** Raw response text, truncated for diagnostics. */
  readonly text: string
  /** Complete response text for vendor-specific parsing; never returned to a model. */
  readonly rawText: string
  /** Declared response media type, when the server sent one. */
  readonly contentType: string | null
  /** The token the call presented, or null for a no-auth profile. Never returned to a model. */
  readonly token: AccessToken | null
}

/** Maximum number of characters kept from a response body for diagnostics. */
const DIAGNOSTIC_TEXT_LIMIT = 500

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

/**
 * Perform authenticated REST calls against capability instances.
 */
export class RestTransport {
  readonly #broker: TokenBroker

  /**
   * @param broker - the token broker shared by the host.
   */
  constructor(broker: TokenBroker) {
    this.#broker = broker
  }

  /**
   * Call one instance's REST API with its token applied.
   * @param runtime - the resolved instance.
   * @param request - the call to make.
   * @returns the response.
   */
  async request(runtime: CapabilityRuntime, request: RestRequest): Promise<RestResponse> {
    const baseUrl = runtime.config['base_url']
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new CapabilityError('CAPABILITY_CONFIG_INVALID', `instance ${runtime.instanceId} needs a base_url`)
    }
    const spec = parseAuthSpec(runtime.config['auth'])
    const tokenOptions: TokenRequestOptions = {
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.subject === undefined ? {} : { subject: request.subject }),
    }
    if (spec.type === 'none') {
      return this.#send(runtime, request, baseUrl, spec, null)
    }
    let token = await this.#broker.token(runtime, tokenOptions)
    let response = await this.#send(runtime, request, baseUrl, spec, token)
    if (response.status === 401 || response.status === 403) {
      this.#broker.invalidate(runtime, request.subject ?? {})
      token = await this.#broker.token(runtime, tokenOptions)
      response = await this.#send(runtime, request, baseUrl, spec, token)
    }
    if (response.status === 401 || response.status === 403) {
      throw new CapabilityError(
        'TOKEN_INVALID',
        `instance ${runtime.instanceId} rejected its token after one renewal`,
        { status: response.status },
      )
    }
    return response
  }

  async #send(
    runtime: CapabilityRuntime,
    request: RestRequest,
    baseUrl: string,
    spec: AuthSpec,
    token: AccessToken | null,
  ): Promise<RestResponse> {
    const url = new URL(joinUrl(baseUrl, request.path))
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (token !== null) {
      if (spec.transport === 'header') {
        headers[spec.tokenName] = token.token
      } else if (spec.transport === 'bearer') {
        headers[spec.tokenName] = `Bearer ${token.token}`
      } else {
        url.searchParams.set(spec.tokenName, token.token)
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() =>{ controller.abort() }, request.timeoutMs ?? 15_000)
    let response: Response
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new CapabilityError(
        'CAPABILITY_HTTP_FAILED',
        `instance ${runtime.instanceId} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      json: parseJson(text),
      text: text.slice(0, DIAGNOSTIC_TEXT_LIMIT),
      rawText: text,
      contentType: response.headers.get('content-type'),
      token,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityRest: CapabilityRestService
  }
}

/** Root-owned REST transport shared by every preset scope in this host. */
export class CapabilityRestService extends Service {
  /** The transport every preset scope reads through. */
  readonly transport: RestTransport

  /**
   * @param ctx - root context owning the service.
   * @param transport - the transport instance.
   */
  constructor(ctx: Context, transport: RestTransport) {
    super(ctx, 'capabilityRest')
    this.transport = transport
  }
}
