/**
 * Non-secret instance configuration validation, mirroring the original AgentOps
 * `application/capability_validation.py` rules.
 *
 * Storage used to accept any JSON object, so a mistyped webhook host or a
 * malformed endpoint only failed at send time. Validation runs before the
 * transaction and reports the offending field by name.
 *
 * @module @agentops/dsh-capability/validation
 */

import type { CapabilityDefinition } from './types.ts'

/** One rejected configuration, shaped like the store's configuration errors. */
export class CapabilityConfigValidationError extends Error {
  /** Stable error code shared with the HTTP layer. */
  readonly code = 'CAPABILITY_CONFIG_INVALID'

  /**
   * @param message - operator-facing reason naming the offending field.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityConfigValidationError'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}


/**
 * Split one host into the hostname the operator meant, rejecting anything that
 * is really a URL or a path.
 * @param raw - the configured `webhook_host` value.
 * @param field - schema field used in the failure message.
 * @returns the normalized hostname.
 */
function webhookHost(raw: unknown, field: string): string {
  const host = text(raw)
  if (host === '') throw new CapabilityConfigValidationError(`${field} 必填：请填写 Webhook 主机名，例如 qyapi.weixin.qq.com`)
  if (host.includes('://')) {
    throw new CapabilityConfigValidationError(`${field} 只填主机名，不要带协议；完整 Webhook URL 请写入加密凭证`)
  }
  if (/[/?#]/.test(host)) {
    throw new CapabilityConfigValidationError(`${field} 只填主机名，不要带路径；完整 Webhook URL 请写入加密凭证`)
  }
  if (host.includes(' ')) throw new CapabilityConfigValidationError(`${field} 不能包含空格`)
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new CapabilityConfigValidationError(`${field} 不是合法主机名：${host}`)
  }
  return host.toLowerCase()
}

/**
 * Validate the timeout field shared by the message connectors.
 * @param value - configured seconds.
 * @returns the clamped timeout, or undefined when unset.
 */
function timeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) {
    throw new CapabilityConfigValidationError('超时时间必须是 1–30 秒之间的整数')
  }
  return Math.trunc(parsed)
}

/**
 * Normalize one array-valued field into a trimmed string list.
 * @param value - configured value, either a list or a comma-separated string.
 * @returns the normalized values.
 */
function stringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const result: string[] = []
  for (const item of raw) {
    const entry = text(item)
    if (entry !== '' && !result.includes(entry)) result.push(entry)
  }
  return result
}

/** Engines this build can actually connect to. */
const DATABASE_ENGINES = new Set(['mysql', 'pg', 'postgres', 'postgresql', 'sqlite'])

function requiredText(config: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const value = text(config[key])
  if (value === '') throw new CapabilityConfigValidationError(`${label} 必填`)
  return value
}

function databasePort(config: Readonly<Record<string, unknown>>, engine: string): number {
  const raw = config.port
  if (raw === undefined || raw === null || raw === '') return engine === 'sqlite' ? 0 : engine === 'mysql' ? 3306 : 5432
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new CapabilityConfigValidationError('端口必须是 1–65535 之间的整数')
  }
  return parsed
}
/**
 * Validate one capability's non-secret configuration.
 *
 * Capabilities without a declared rule are returned unchanged: the centre must
 * not reject a connector it does not yet model.
 * @param capability - the capability definition being instantiated.
 * @param config - the submitted non-secret configuration.
 * @returns the normalized configuration to persist.
 */
export function validateInstanceConfig(
  capability: CapabilityDefinition,
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...config }

  // Every schema field marked required must be present; this catches a request
  // that bypasses the form without inventing per-capability rules.
  if (capability.capabilityId === 'feishu-bot' || capability.capabilityId === 'wecom') {
    normalized.webhook_host = webhookHost(config.webhook_host, 'Webhook 主机')
    const timeout = timeoutSeconds(config.timeout_seconds)
    if (timeout === undefined) delete normalized.timeout_seconds
    else normalized.timeout_seconds = timeout
    if (capability.capabilityId === 'wecom') {
      const mentions = stringList(config.mentions)
      if (mentions.length === 0) delete normalized.mentions
      else normalized.mentions = mentions
    } else {
      delete normalized.mentions
    }
  }


  if (capability.capabilityId === 'database') {
    const engine = text(config.engine).toLowerCase() || 'mysql'
    if (!DATABASE_ENGINES.has(engine)) {
      throw new CapabilityConfigValidationError(`数据库引擎必须是 mysql / pg / sqlite 之一，收到 ${engine}`)
    }
    const normalizedEngine = engine === 'postgres' || engine === 'postgresql' ? 'pg' : engine
    normalized.engine = normalizedEngine === 'pg' ? 'postgres' : normalizedEngine
    normalized.host = requiredText(config, 'host', '主机')
    if (normalizedEngine === 'sqlite') {
      normalized.port = 0
      delete normalized.username
      delete normalized.database
    } else {
      normalized.username = requiredText(config, 'username', '用户名')
      normalized.database = requiredText(config, 'database', '数据库')
      normalized.port = databasePort(config, normalizedEngine)
      normalized.auth_type = text(config.auth_type) || 'password'
    }
    if (normalizedEngine === 'pg') {
      normalized.schema = text(config.schema) || 'public'
    }
  }

  // Remaining schema-wide required fields. Capability rules above already
  // produced precise messages for the fields they own.
  const capabilityOwned = capability.capabilityId === 'database'
    ? new Set(['host', 'port', 'username', 'database', 'schema', 'auth_type'])
    : capability.capabilityId === 'feishu-bot' || capability.capabilityId === 'wecom'
      ? new Set(['webhook_host'])
      : new Set<string>()
  for (const field of capability.configSchema) {
    if (field.key === 'secret' || capabilityOwned.has(field.key)) continue
    if (!field.required) continue
    const value = config[field.key]
    const present = field.type === 'boolean'
      ? typeof value === 'boolean'
      : field.type === 'number'
        ? typeof value === 'number' || text(value) !== ''
        : field.type === 'array'
          ? (Array.isArray(value) && value.length > 0) || text(value) !== ''
          : text(value) !== ''
    if (!present) throw new CapabilityConfigValidationError(`${field.label} 必填`)
  }

  return normalized
}

/**
 * Reject a configuration that does not match the declared schema types.
 * @param capability - capability definition.
 * @param config - submitted configuration.
 */
export function assertConfigShape(
  capability: CapabilityDefinition,
  config: Readonly<Record<string, unknown>>,
): void {
  for (const field of capability.configSchema) {
    if (field.key === 'secret') continue
    const value = config[field.key]
    if (value === undefined) continue
    if (field.type === 'number' && typeof value !== 'number' && text(value) === '') {
      throw new CapabilityConfigValidationError(`${field.label} 必须是数字`)
    }
    if (field.type === 'array' && !Array.isArray(value) && typeof value !== 'string') {
      throw new CapabilityConfigValidationError(`${field.label} 必须是数组`)
    }
    if (field.type === 'select' && field.options !== undefined && typeof value === 'string' && !field.options.includes(value)) {
      throw new CapabilityConfigValidationError(`${field.label} 必须是 ${field.options.join(' / ')} 之一`)
    }
  }
}

/** Capabilities whose credential is a complete webhook URL. */
export const WEBHOOK_URL_CAPABILITIES: readonly string[] = ['feishu-bot', 'wecom']

/** Allowed hosts per webhook capability, used by the connection test. */
export const WEBHOOK_ALLOWED_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'feishu-bot': ['open.feishu.cn', 'open.larksuite.com'],
  wecom: ['qyapi.weixin.qq.com'],
}

/**
 * Check one webhook credential against its configured host.
 * @param capabilityId - `feishu-bot` or `wecom`.
 * @param config - instance configuration containing `webhook_host`.
 * @param secret - the sealed webhook URL, already opened.
 * @returns the URL to post to, or the reason it is rejected.
 */
export function resolveWebhookUrl(
  capabilityId: string,
  config: Readonly<Record<string, unknown>>,
  secret: string | null,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string } {
  const raw = secret?.trim() ?? ''
  if (raw === '') {
    return { ok: false, reason: 'Webhook 未配置：请在加密凭证里粘贴完整 Webhook URL' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'Webhook 凭证不是合法 URL：请粘贴完整 https:// 地址' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Webhook 必须是 https:// 地址' }
  }
  const configured = text(config.webhook_host).toLowerCase()
  const allowed = configured === ''
    ? (WEBHOOK_ALLOWED_HOSTS[capabilityId] ?? [])
    : [configured]
  const hostname = parsed.hostname.toLowerCase()
  if (!allowed.includes(hostname)) {
    return { ok: false, reason: `Webhook 主机不在允许范围：凭证指向 ${hostname}，实例配置为 ${configured || allowed.join(' / ')}` }
  }
  return { ok: true, url: parsed.toString() }
}
