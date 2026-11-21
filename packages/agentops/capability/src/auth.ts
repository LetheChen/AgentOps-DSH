/**
 * Generic token-endpoint authentication for capability instances.
 *
 * An instance declares how to mint an access token, which request identity to
 * bind, and how to present the token on business calls. This module interprets
 * that declaration and holds no vendor knowledge. A vendor-specific token
 * profile therefore remains configuration, while credential rotation, cache
 * ownership, and request presentation stay in the shared runtime.
 *
 * A token is a credential. Nothing in this module hands one to a model; the
 * token broker and REST transport keep it inside the process.
 *
 * @module @agentops/dsh-capability/auth
 */

import { CapabilityError } from './errors.ts'

/** Where one token request parameter travels. */
export type TokenParamLocation = 'query' | 'json' | 'form'

/** How a business call presents the token. */
export type TokenTransport = 'header' | 'query' | 'bearer'

/** A token parameter value source. */
export type TokenParamSource = string

/** One token request parameter and its location. */
export interface TokenParamSpec {
  /** A source such as `secret`, `config.username`, `subject.memberCode`, or `literal:rest`. */
  readonly source: TokenParamSource
  /** Where this parameter travels in the token request. */
  readonly in: TokenParamLocation
}

/** Identity fields a token request may bind through `subject.<name>` sources. */
export type AuthSubject = Readonly<Record<string, string>>

/** The declared authentication of one capability instance. */
export interface AuthSpec {
  /** `none` sends no token; `token-endpoint` mints one before each business call. */
  readonly type: 'none' | 'token-endpoint'
  /** Token endpoint path, resolved against the instance `base_url`. */
  readonly tokenUrl: string
  /** HTTP method used for the token request. */
  readonly tokenMethod: 'GET' | 'POST'
  /** Default location for parameters without an explicit `in`. */
  readonly tokenParamsIn: TokenParamLocation
  /** Parameter name to source and request location. */
  readonly tokenParams: Readonly<Record<string, TokenParamSpec>>
  /** Dotted path of the token inside the token response body. */
  readonly tokenPath: string
  /** Dotted path of the lifetime in seconds inside the token response body. */
  readonly expiresInPath: string | null
  /** Dotted path of the identity the token is bound to inside the token response body. */
  readonly identityPath: string | null
  /** Lifetime used when the response carries none. */
  readonly defaultTtlSeconds: number
  /** How business calls present the token. */
  readonly transport: TokenTransport
  /** Header or query parameter name carrying the token. */
  readonly tokenName: string
  /** Token response values that mean authentication failed. */
  readonly invalidTokenValues: readonly string[]
  /** Additional token-request headers. */
  readonly requestHeaders: Readonly<Record<string, string>>
}

/** The authentication of an instance that sends no token. */
export const NO_AUTH: AuthSpec = {
  type: 'none',
  tokenUrl: '',
  tokenMethod: 'GET',
  tokenParamsIn: 'query',
  tokenParams: {},
  tokenPath: '',
  expiresInPath: null,
  identityPath: null,
  defaultTtlSeconds: 0,
  transport: 'header',
  tokenName: '',
  invalidTokenValues: [],
  requestHeaders: { accept: 'application/json' },
}

/**
 * Narrow an unknown value to a plain object.
 * @param value - candidate value.
 * @returns the value as a record, or null when it is not a plain object.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read a dotted path inside a parsed JSON payload.
 * @param payload - parsed response body.
 * @param path - dotted path such as `id` or `data.access_token`.
 * @returns the addressed value, or undefined when the path does not resolve.
 */
export function readJsonPath(payload: unknown, path: string): unknown {
  if (path === '') return undefined
  let current: unknown = payload
  for (const segment of path.split('.')) {
    const record = asRecord(current)
    if (record === null) return undefined
    current = record[segment]
  }
  return current
}

/**
 * Read a dotted path and narrow it to a non-empty string.
 * @param payload - parsed response body.
 * @param path - dotted path.
 * @returns the addressed string, or null when it is absent or not a string.
 */
export function readJsonString(payload: unknown, path: string): string | null {
  const value = readJsonPath(payload, path)
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Read a dotted path and narrow it to a finite number.
 * @param payload - parsed response body.
 * @param path - dotted path.
 * @returns the addressed number, or null when it is absent or not numeric.
 */
export function readJsonNumber(payload: unknown, path: string): number | null {
  const value = readJsonPath(payload, path)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseAuthJson(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown)
  } catch {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth is not valid JSON')
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key)
  if (value === null) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.${key} is required`)
  }
  return value
}

function parseParamLocation(value: unknown, field: string): TokenParamLocation {
  const location = typeof value === 'string' ? value.trim() : ''
  if (location !== 'query' && location !== 'json' && location !== 'form') {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `${field} must be query, json, or form`)
  }
  return location
}

function parseParamSpec(name: string, value: unknown, defaultLocation: TokenParamLocation): TokenParamSpec {
  if (typeof value === 'string' && value.trim() !== '') {
    return { source: value.trim(), in: defaultLocation }
  }
  const record = asRecord(value)
  if (record === null) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.token_params.${name} must be a source string or object`)
  }
  const source = optionalString(record, 'source')
  if (source === null) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.token_params.${name}.source is required`)
  }
  const location = record['in'] === undefined
    ? defaultLocation
    : parseParamLocation(record['in'], `auth.token_params.${name}.in`)
  return { source, in: location }
}

function parseRequestHeaders(raw: unknown): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const record = asRecord(raw)
  if (record === null) return headers
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.token_request_headers.${name} must be a non-empty string`)
    }
    headers[name.toLowerCase()] = value.trim()
  }
  return headers
}

function parseInvalidTokenValues(raw: unknown): readonly string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth.token_invalid_values must be an array of strings')
  }
  const values: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || value === '') {
      throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth.token_invalid_values must contain non-empty strings')
    }
    values.push(value)
  }
  return values
}

/**
 * Parse the `auth` block of an instance configuration.
 * @param raw - the raw `auth` value from the instance configuration.
 * @returns the declared authentication, or {@link NO_AUTH} when none is declared.
 */
export function parseAuthSpec(raw: unknown): AuthSpec {
  if (raw === undefined || raw === null) return NO_AUTH
  const record = typeof raw === 'string' ? parseAuthJson(raw) : asRecord(raw)
  if (record === null) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth must be an object or a JSON object string')
  }
  const type = optionalString(record, 'type') ?? 'token-endpoint'
  if (type === 'none') return NO_AUTH
  if (type !== 'token-endpoint') {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.type ${type} is not supported`)
  }
  const paramsIn = parseParamLocation(optionalString(record, 'token_params_in') ?? 'json', 'auth.token_params_in')
  const transport = optionalString(record, 'transport') ?? 'header'
  if (transport !== 'header' && transport !== 'query' && transport !== 'bearer') {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.transport ${transport} is not supported`)
  }
  const method = (optionalString(record, 'token_method') ?? 'POST').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', `auth.token_method ${method} is not supported`)
  }
  const params = asRecord(record['token_params']) ?? {}
  const tokenParams: Record<string, TokenParamSpec> = {}
  for (const [name, source] of Object.entries(params)) {
    tokenParams[name] = parseParamSpec(name, source, paramsIn)
  }
  const bodyLocations = new Set(
    Object.values(tokenParams)
      .map(param => param.in)
      .filter(location => location !== 'query'),
  )
  if (bodyLocations.size > 1) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth.token_params cannot mix json and form body parameters')
  }
  const defaultTtl = record['default_ttl_seconds']
  if (defaultTtl !== undefined && (typeof defaultTtl !== 'number' || !Number.isFinite(defaultTtl) || defaultTtl <= 0)) {
    throw new CapabilityError('CAPABILITY_AUTH_INVALID', 'auth.default_ttl_seconds must be a positive number')
  }
  return {
    type: 'token-endpoint',
    tokenUrl: requireString(record, 'token_url'),
    tokenMethod: method,
    tokenParamsIn: paramsIn,
    tokenParams,
    tokenPath: requireString(record, 'token_path'),
    expiresInPath: optionalString(record, 'expires_in_path'),
    identityPath: optionalString(record, 'identity_path'),
    defaultTtlSeconds: defaultTtl === undefined ? 900 : defaultTtl,
    transport,
    tokenName: requireString(record, 'token_name'),
    invalidTokenValues: parseInvalidTokenValues(record['token_invalid_values']),
    requestHeaders: parseRequestHeaders(record['token_request_headers']),
  }
}

/**
 * Resolve one token parameter from its declared source.
 * @param source - `secret`, `config.<key>`, `subject.<key>`, or `literal:<text>`.
 * @param secret - the sealed instance credential.
 * @param config - the instance configuration.
 * @param subject - the identity fields bound for this token request.
 * @returns the resolved value.
 */
export function resolveParamSource(
  source: TokenParamSource,
  secret: string | null,
  config: Readonly<Record<string, unknown>>,
  subject: AuthSubject = {},
): string {
  if (source === 'secret') {
    if (secret === null || secret === '') {
      throw new CapabilityError('CREDENTIAL_UNAVAILABLE', 'the token request needs the instance credential')
    }
    return secret
  }
  if (source.startsWith('config.')) {
    const key = source.slice('config.'.length)
    const value = config[key]
    if (typeof value !== 'string' || value === '') {
      throw new CapabilityError('CAPABILITY_CONFIG_INVALID', `instance config ${key} is required to mint a token`)
    }
    return value
  }
  if (source.startsWith('subject.')) {
    const key = source.slice('subject.'.length)
    const value = subject[key]
    if (value === undefined || value === '') {
      throw new CapabilityError('CAPABILITY_IDENTITY_UNBOUND', `token subject ${key} is required to mint a token`)
    }
    return value
  }
  if (source.startsWith('literal:')) {
    return source.slice('literal:'.length)
  }
  throw new CapabilityError('CAPABILITY_AUTH_INVALID', `token parameter source ${source} is not supported`)
}
