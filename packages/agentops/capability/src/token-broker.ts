/**
 * Generic access-token broker for capability instances.
 *
 * The broker owns the lifetime of a token: it mints one from the instance's
 * declared authentication, caches it against the credential generation and
 * request subject it was minted for, and drops it when the generation moves,
 * the subject changes, or the vendor rejects it. A credential rotation
 * therefore invalidates every token derived from the old credential, and two
 * users cannot accidentally share a token minted for one of them.
 *
 * Tokens never leave this module's callers. No tool returns one to a model.
 *
 * @module @agentops/dsh-capability/token-broker
 */

import { createHash } from 'node:crypto'

import { Service, type Context } from '@deepseek-ai/cordis'

import { CapabilityError } from './errors.ts'
import {
  parseAuthSpec,
  readJsonNumber,
  readJsonString,
  resolveParamSource,
  type AuthSpec,
  type AuthSubject,
  type TokenParamLocation,
} from './auth.ts'
import type { CapabilityRuntime } from './types.ts'

/** One live access token. */
export interface AccessToken {
  /** The opaque token value. Never exposed to a model. */
  readonly token: string
  /** Milliseconds since the epoch when the token was minted. */
  readonly obtainedAt: number
  /** Milliseconds since the epoch after which the token must not be reused. */
  readonly expiresAt: number
  /** The identity the token is bound to, when the vendor reports one. */
  readonly identity: string | null
  /** Where the token came from. */
  readonly source: 'static' | 'token-endpoint'
}

/** Seconds of margin subtracted from a vendor-reported lifetime. */
const EXPIRY_MARGIN_SECONDS = 60

/** Seconds of margin subtracted from the configured fallback lifetime. */
const DEFAULT_TTL_MARGIN_SECONDS = 30

interface CacheEntry {
  readonly generation: string
  readonly token: AccessToken
}

/** Options for one token request. */
export interface TokenRequestOptions {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Identity fields used by `subject.<name>` token parameter sources. */
  readonly subject?: AuthSubject
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function orderedSubject(subject: AuthSubject): AuthSubject {
  return Object.fromEntries(Object.entries(subject).sort(([left], [right]) => left.localeCompare(right)))
}

function tokenScopeKey(runtime: CapabilityRuntime, spec: AuthSpec, subject: AuthSubject): string {
  const material = JSON.stringify({
    instanceId: runtime.instanceId,
    credentialGeneration: runtime.credentialGeneration,
    auth: spec,
    subject: orderedSubject(subject),
  })
  return createHash('sha256').update(material).digest('hex')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function bodyLocation(locations: readonly TokenParamLocation[]): 'json' | 'form' | null {
  const bodies = new Set(locations.filter(location => location !== 'query'))
  if (bodies.size === 0) return null
  if (bodies.size > 1) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'token request cannot mix json and form parameters')
  }
  return bodies.values().next().value as 'json' | 'form'
}

/**
 * Own the access tokens of capability instances.
 *
 * The broker is shared by every preset scope in a host so that two agents
 * bound to the same instance and subject share one token rather than each
 * minting their own.
 */
export class TokenBroker {
  readonly #cache = new Map<string, CacheEntry>()
  readonly #pending = new Map<string, Promise<AccessToken>>()

  /**
   * Read the access token of one instance and subject, minting it when needed.
   * @param runtime - the resolved instance.
   * @param options - request options.
   * @returns the live token.
   */
  async token(runtime: CapabilityRuntime, options: TokenRequestOptions = {}): Promise<AccessToken> {
    const spec = parseAuthSpec(runtime.config['auth'])
    if (spec.type === 'none') {
      throw new CapabilityError(
        'CAPABILITY_AUTH_INVALID',
        `instance ${runtime.instanceId} has no token endpoint; declare auth for this capability instance`,
      )
    }
    const subject = options.subject ?? {}
    const key = tokenScopeKey(runtime, spec, subject)
    const cached = this.#cache.get(key)
    if (cached !== undefined && cached.generation === runtime.credentialGeneration && cached.token.expiresAt > Date.now()) {
      return cached.token
    }
    const pending = this.#pending.get(key)
    if (pending !== undefined) return pending
    const minted = this.#mint(runtime, spec, subject, options)
      .then((token) => {
        this.#cache.set(key, { generation: runtime.credentialGeneration, token })
        return token
      })
      .finally(() => {
        this.#pending.delete(key)
      })
    this.#pending.set(key, minted)
    return minted
  }

  /**
   * Drop the cached token of one instance and subject.
   * @param runtime - the instance whose token is rejected or rotated.
   * @param subject - the identity whose token scope is invalidated.
   */
  invalidate(runtime: CapabilityRuntime, subject: AuthSubject = {}): void {
    const spec = parseAuthSpec(runtime.config['auth'])
    if (spec.type === 'none') return
    const key = tokenScopeKey(runtime, spec, subject)
    this.#cache.delete(key)
    this.#pending.delete(key)
  }

  async #mint(
    runtime: CapabilityRuntime,
    spec: AuthSpec,
    subject: AuthSubject,
    options: TokenRequestOptions,
  ): Promise<AccessToken> {
    const baseUrl = runtime.config['base_url']
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new CapabilityError('CAPABILITY_CONFIG_INVALID', `instance ${runtime.instanceId} needs a base_url`)
    }
    const url = new URL(joinUrl(baseUrl, spec.tokenUrl))
    const jsonBody: Record<string, string> = {}
    const formBody: Record<string, string> = {}
    const locations: TokenParamLocation[] = []
    for (const [name, param] of Object.entries(spec.tokenParams)) {
      const value = resolveParamSource(param.source, runtime.secret, runtime.config, subject)
      locations.push(param.in)
      if (param.in === 'query') url.searchParams.set(name, value)
      else if (param.in === 'json') jsonBody[name] = value
      else formBody[name] = value
    }
    const bodyKind = bodyLocation(locations)
    const headers: Record<string, string> = { ...spec.requestHeaders }
    let payload: string | undefined
    if (bodyKind === 'json') {
      payload = JSON.stringify(jsonBody)
      headers['content-type'] = 'application/json; charset=utf-8'
    } else if (bodyKind === 'form') {
      payload = new URLSearchParams(formBody).toString()
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    }
    const controller = new AbortController()
    const timer = setTimeout(() =>{ controller.abort() }, options.timeoutMs ?? 15_000)
    let response: Response
    try {
      response = await fetch(url, {
        method: spec.tokenMethod,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new CapabilityError(
        'TOKEN_ACQUISITION_FAILED',
        `token endpoint of ${runtime.instanceId} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new CapabilityError(
        'TOKEN_ACQUISITION_FAILED',
        `token endpoint of ${runtime.instanceId} returned ${response.status}`,
        { status: response.status },
      )
    }
    const parsed = parseJson(text)
    if (parsed === undefined) {
      throw new CapabilityError(
        'TOKEN_ACQUISITION_FAILED',
        `token endpoint of ${runtime.instanceId} returned a non-JSON body`,
      )
    }
    const token = readJsonString(parsed, spec.tokenPath)
    if (token === null) {
      throw new CapabilityError(
        'TOKEN_ACQUISITION_FAILED',
        `token endpoint of ${runtime.instanceId} did not return ${spec.tokenPath}`,
      )
    }
    if (spec.invalidTokenValues.includes(token)) {
      throw new CapabilityError(
        'TOKEN_ACQUISITION_FAILED',
        `token endpoint of ${runtime.instanceId} returned a declared invalid token`,
      )
    }
    const now = Date.now()
    const reported = spec.expiresInPath === null ? null : readJsonNumber(parsed, spec.expiresInPath)
    const lifetimeSeconds = reported === null
      ? Math.max(spec.defaultTtlSeconds - DEFAULT_TTL_MARGIN_SECONDS, 1)
      : Math.max(reported - EXPIRY_MARGIN_SECONDS, 1)
    const identity = spec.identityPath === null ? null : readJsonString(parsed, spec.identityPath)
    return {
      token,
      obtainedAt: now,
      expiresAt: now + lifetimeSeconds * 1000,
      identity,
      source: 'token-endpoint',
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityTokens: CapabilityTokenService
  }
}

/**
 * Root-owned token broker shared by every preset scope in this host.
 *
 * Sharing one broker lets two agents bound to the same instance reuse a token
 * instead of each minting their own. Cache entries remain separated by subject.
 */
export class CapabilityTokenService extends Service {
  /** The broker every preset scope reads through. */
  readonly broker: TokenBroker

  /**
   * @param ctx - root context owning the service.
   * @param broker - the broker instance.
   */
  constructor(ctx: Context, broker: TokenBroker) {
    super(ctx, 'capabilityTokens')
    this.broker = broker
  }
}
