/**
 * Real connection probes for capability instances.
 *
 * Database instances reuse their decrypted capability credential and run one
 * trivial read. SSH instances authenticate in-process, so a credential never
 * passes through a shell, and the same handshake can verify a pinned host-key
 * fingerprint. Feishu docs probes mint an app token and read one cloud-drive
 * page. Capability kinds without a bridged probe return an explicit unsupported
 * result.
 *
 * @module @agentops/dsh-capability/probe
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { Client } from './ssh2.ts'

import { authSubject, buildAffairRequest, readAffairRows, resolveOaSubject } from './oa-affairs.ts'
import { RestTransport } from './rest.ts'
import { TokenBroker } from './token-broker.ts'
import { resolveFeishuDocsBaseUrl, resolveWebhookUrl } from './validation.ts'
import type { CapabilityRuntime } from './types.ts'

/** One capability instance probe result. */
export interface CapabilityProbeResult {
  readonly ok: boolean
  readonly detail: string
  readonly elapsedMs: number
}

interface MysqlConnectionOptions {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database?: string
  readonly connectTimeout: number
}

interface MysqlConnection {
  query(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, readonly unknown[] | undefined]>
  end(): Promise<void>
}

type MysqlCreateConnection = (options: MysqlConnectionOptions) => Promise<MysqlConnection>

let mysqlDriver: { readonly createConnection: MysqlCreateConnection } | undefined

let pgDriver: typeof import('pg') | undefined

/** Load PostgreSQL only when a PostgreSQL capability instance is actually probed. */
async function pg(): Promise<typeof import('pg')> {
  pgDriver ??= await import('pg')
  return pgDriver
}

/** Load MySQL only when a MySQL capability instance is actually probed. */
async function mysql(): Promise<{ readonly createConnection: MysqlCreateConnection }> {
  const specifier = 'mysql2/promise'
  mysqlDriver ??= (await import(specifier)) as unknown as { readonly createConnection: MysqlCreateConnection }
  return mysqlDriver
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

interface FeishuApiResponse {
  readonly status: number
  readonly ok: boolean
  readonly body: Readonly<Record<string, unknown>>
}

async function feishuRequest(url: string, init: RequestInit, timeoutMs: number): Promise<FeishuApiResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  let response: Response | undefined
  let body: unknown
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    body = await response.json()
  } catch (reason) {
    if (controller.signal.aborted) throw new Error(`飞书 API 请求超时（${timeoutMs}ms）`)
    if (response === undefined) {
      throw new Error(`飞书 API 不可达：${reason instanceof Error ? reason.message : String(reason)}`)
    }
    throw new Error(`飞书 API 返回了非 JSON 响应（HTTP ${response.status}）`)
  } finally {
    clearTimeout(timer)
  }
  return { status: response.status, ok: response.ok, body: objectValue(body) }
}

function feishuErrorDetail(body: Readonly<Record<string, unknown>>, status: number): string {
  const code = typeof body.code === 'number' ? body.code : undefined
  const message = text(body.msg) || text(body.message) || `HTTP ${status}`
  return code === undefined ? message : `code=${code}: ${message}`
}

async function probeFeishuDocs(
  runtime: CapabilityRuntime,
  timeoutMs: number,
  started: number,
): Promise<CapabilityProbeResult> {
  const appId = text(runtime.config.app_id)
  if (appId === '') throw new Error('飞书文档实例缺少 App ID')
  const appSecret = runtime.secret?.trim() ?? ''
  if (appSecret === '') throw new Error('飞书文档实例缺少加密凭证 App Secret')
  const baseUrl = resolveFeishuDocsBaseUrl(runtime.config.base_url)
  const tokenResponse = await feishuRequest(
    `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    timeoutMs,
  )
  if (!tokenResponse.ok || tokenResponse.body.code !== 0) {
    return {
      ok: false,
      detail: `飞书 tenant_access_token 获取失败：${feishuErrorDetail(tokenResponse.body, tokenResponse.status)}`,
      elapsedMs: Date.now() - started,
    }
  }
  const token = text(tokenResponse.body.tenant_access_token)
  if (token === '') throw new Error('飞书 token 响应缺少 tenant_access_token')

  const driveResponse = await feishuRequest(
    `${baseUrl}/open-apis/drive/v1/files?page_size=1`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    },
    timeoutMs,
  )
  if (!driveResponse.ok || driveResponse.body.code !== 0) {
    return {
      ok: false,
      detail: `飞书凭证有效，但云空间读取失败：${feishuErrorDetail(driveResponse.body, driveResponse.status)}`,
      elapsedMs: Date.now() - started,
    }
  }
  const data = objectValue(driveResponse.body.data)
  if (!Array.isArray(data.files)) throw new Error('飞书云空间响应缺少 files 数组')
  return {
    ok: true,
    detail: `飞书 tenant_access_token 获取成功；云空间可读取（本页 ${data.files.length} 项）`,
    elapsedMs: Date.now() - started,
  }
}

async function probeOa(runtime: CapabilityRuntime, timeoutMs: number, started: number): Promise<CapabilityProbeResult> {
  const subject = resolveOaSubject(runtime)
  const target = buildAffairRequest('pending', subject)
  const transport = new RestTransport(new TokenBroker())
  const response = await transport.request(runtime, {
    method: 'GET',
    path: target.path,
    query: { ...target.query, pageNo: '1', pageSize: '1' },
    subject: authSubject(subject),
    timeoutMs,
  })
  if (!response.ok) {
    return { ok: false, detail: `OA 事项接口返回 ${response.status}`, elapsedMs: Date.now() - started }
  }
  if (response.json === undefined || response.json === null) {
    return { ok: false, detail: 'OA 事项接口返回了非 JSON 响应', elapsedMs: Date.now() - started }
  }
  const rows = readAffairRows(response.json)
  return {
    ok: true,
    detail: `OA token 获取成功；待办接口可访问（本页 ${rows.length} 条）`,
    elapsedMs: Date.now() - started,
  }
}

/**
 * Probe one instance against its real connector target.
 * @param runtime - instance configuration and opened credential.
 * @param timeoutMs - hard cap for network-backed probes.
 * @returns success detail or the actionable failure reason.
 */
export async function probeCapabilityInstance(
  runtime: CapabilityRuntime,
  timeoutMs = 5000,
): Promise<CapabilityProbeResult> {
  const started = Date.now()
  try {
    if (runtime.capabilityId === 'ssh') {
      return await probeSsh(runtime, timeoutMs, started)
    }
    if (runtime.capabilityId === 'feishu-docs') {
      return await probeFeishuDocs(runtime, timeoutMs, started)
    }
    if (runtime.capabilityId === 'feishu-bot' || runtime.capabilityId === 'wecom') {
      return probeWebhook(runtime)
    }
    if (runtime.capabilityId === 'oa') {
      return await probeOa(runtime, timeoutMs, started)
    }
    if (runtime.capabilityId !== 'database') {
      return {
        ok: false,
        detail: `能力 ${runtime.capabilityId} 尚未接入运行探测`,
        elapsedMs: Date.now() - started,
      }
    }
    const engine = text(runtime.config.engine).toLowerCase() || 'mysql'
    const host = text(runtime.config.host)
    if (host === '') throw new Error('数据库实例缺少 host')
    if (engine === 'sqlite') {
      const db = new DatabaseSync(host, { readOnly: true })
      try {
        db.prepare('SELECT 1 AS ok').get()
      } finally {
        db.close()
      }
      return { ok: true, detail: `SQLite 文件可读：${host}`, elapsedMs: Date.now() - started }
    }
    const database = text(runtime.config.database)
    if (engine === 'pg' || engine === 'postgres' || engine === 'postgresql') {
      const { Client: PgClient } = await pg()
      const client = new PgClient({
        host,
        port: typeof runtime.config.port === 'number' ? runtime.config.port : 5432,
        user: text(runtime.config.username),
        password: runtime.secret ?? '',
        ...(database === '' ? {} : { database }),
        connectionTimeoutMillis: timeoutMs,
      })
      await client.connect()
      try {
        await client.query('SELECT 1 AS ok')
      } finally {
        await client.end().catch(() => undefined)
      }
      return {
        ok: true,
        detail: `PostgreSQL 握手成功（${database || '无默认库'}）`,
        elapsedMs: Date.now() - started,
      }
    }
    const handle = await (await mysql()).createConnection({
      host,
      port: typeof runtime.config.port === 'number' ? runtime.config.port : 3306,
      user: text(runtime.config.username),
      password: runtime.secret ?? '',
      ...(database === '' ? {} : { database }),
      connectTimeout: timeoutMs,
    })
    try {
      await handle.query('SELECT 1 AS ok')
    } finally {
      await handle.end().catch(() => undefined)
    }
    return {
      ok: true,
      detail: `MySQL 握手成功（${database || '无默认库'}）`,
      elapsedMs: Date.now() - started,
    }
  } catch (reason) {
    return {
      ok: false,
      detail: reason instanceof Error ? reason.message : String(reason),
      elapsedMs: Date.now() - started,
    }
  }
}

/** Max characters kept from a probe failure message. */
const SSH_DETAIL_LIMIT = 280

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`TCP ${host}:${port} 连接超时（${timeoutMs}ms）`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Map one ssh2 client failure to an actionable probe detail. */
function sshProbeFailure(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  if (/all configured authentication methods failed|permission denied|authentication failure/i.test(normalized)) {
    return 'SSH 登录被拒绝：用户名或凭证不正确'
  }
  if (/ECONNREFUSED/i.test(normalized)) return 'SSH 端口拒绝连接'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(normalized)) return 'SSH 主机名无法解析'
  if (/timed out|timeout/i.test(normalized)) return 'SSH 登录超时'
  if (/host key verification failed/i.test(normalized)) return 'SSH 主机指纹校验失败'
  return normalized === '' ? 'SSH 登录失败' : normalized.slice(0, SSH_DETAIL_LIMIT)
}

/** One SSH probe outcome before it is stamped with timing. */
interface SshProbeOutcome {
  readonly ok: boolean
  readonly detail: string
}

interface SshConnectOptions {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly privateKeyPath: string
  readonly expectedPin: string
  readonly timeoutMs: number
}

/**
 * Authenticate one SSH target inside this process.
 *
 * The credential reaches the library as a string, so a password containing shell
 * metacharacters is transmitted byte-for-byte. Driving a shell or a generated
 * askpass script instead lets the login shell reinterpret the value, which
 * silently corrupts passwords containing `&`, `%`, `^`, `(`, `)` or `|`.
 * When the instance carries a host-key fingerprint, the same handshake verifies
 * the presented key and a mismatch aborts before authentication runs.
 * @param options - resolved host, credential and expected host-key fingerprint.
 * @returns whether the login succeeded, with a human-readable detail.
 */
function connectSsh(options: SshConnectOptions): Promise<SshProbeOutcome> {
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    let observedPin = ''
    let pinMismatch = false
    const finish = (outcome: SshProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, detail: `SSH 登录超时（${options.timeoutMs}ms）` })
    }, options.timeoutMs)
    client.once('ready', () => {
      const note = observedPin === ''
        ? ''
        : options.expectedPin === ''
          ? `（未配置主机指纹，本次观察到 ${observedPin}）`
          : `（主机指纹已校验：${observedPin}）`
      finish({ ok: true, detail: `SSH 登录成功：${options.username}@${options.host}:${options.port}${note}` })
    })
    client.once('error', (error: Error) => {
      finish({
        ok: false,
        detail: pinMismatch
          ? `SSH 主机指纹不匹配：实例配置 ${options.expectedPin}，服务器实际出示 ${observedPin}`
          : sshProbeFailure(error.message),
      })
    })
    client.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      readyTimeout: options.timeoutMs,
      ...(options.privateKeyPath === ''
        ? { password: options.password }
        : { privateKey: readFileSync(options.privateKeyPath), ...(options.password === '' ? {} : { passphrase: options.password }) }),
      hostVerifier: (key: Buffer) => {
        observedPin = hostKeyFingerprint(key)
        if (options.expectedPin === '') return true
        if (observedPin === options.expectedPin) return true
        pinMismatch = true
        return false
      },
    })
  })
}

/**
 * Probe one SSH instance with a real login.
 * @param runtime - instance host, port, user, key policy and decrypted credential.
 * @param timeoutMs - TCP and SSH connect timeout.
 * @param started - probe start timestamp.
 * @returns success detail or the actionable failure reason.
 */
async function probeSsh(
  runtime: CapabilityRuntime,
  timeoutMs: number,
  started: number,
): Promise<CapabilityProbeResult> {
  const host = text(runtime.config.host)
  const username = text(runtime.config.username)
  if (host === '') throw new Error('SSH 实例缺少 host')
  if (username === '') throw new Error('SSH 实例缺少 username')
  const port = typeof runtime.config.port === 'number' ? runtime.config.port : 22
  const password = runtime.secret ?? ''
  const privateKeyPath = text(runtime.config.private_key_path)
  if (password === '' && privateKeyPath === '') {
    return { ok: false, detail: 'SSH 实例缺少凭证：需要密码或私钥文件', elapsedMs: Date.now() - started }
  }
  await tcpReachable(host, port, timeoutMs)
  const outcome = await connectSsh({
    host,
    port,
    username,
    password,
    privateKeyPath,
    expectedPin: text(runtime.config.host_key_sha256),
    timeoutMs,
  })
  return { ok: outcome.ok, detail: outcome.detail, elapsedMs: Date.now() - started }
}

/**
 * Validate one webhook instance without sending a message.
 *
 * The original AgentOps center checked URL syntax and the allowed host and
 * explicitly did not deliver a test message, so a "test" never spams the group.
 * @param runtime - webhook instance configuration and decrypted URL.
 * @returns whether the credential and host agree.
 */
export function probeWebhook(runtime: CapabilityRuntime): CapabilityProbeResult {
  const started = Date.now()
  const resolved = resolveWebhookUrl(runtime.capabilityId, runtime.config, runtime.secret)
  if (!resolved.ok) return { ok: false, detail: resolved.reason, elapsedMs: Date.now() - started }
  const host = new URL(resolved.url).hostname
  return {
    ok: true,
    detail: `Webhook 地址与主机校验通过（${host}，未发送消息）`,
    elapsedMs: Date.now() - started,
  }
}

/** One base table offered for table-level authorization. */
export interface DatabaseTableInfo {
  /** Table name exactly as the server reports it. */
  readonly name: string
  /** Table comment, empty when the engine does not expose one. */
  readonly comment: string
}

/** Table listing result for one database instance. */
export interface DatabaseTablesResult {
  readonly ok: boolean
  readonly detail: string
  readonly tables: readonly DatabaseTableInfo[]
}

/**
 * List the base tables of one database instance.
 *
 * The capability center needs this to offer an explicit table whitelist: the
 * operator picks tables from the real server instead of typing names from
 * memory. Only catalog metadata is read; no business rows are touched.
 * @param runtime - instance configuration and decrypted credential.
 * @param timeoutMs - network connect timeout.
 * @returns the table names, or the reason they could not be read.
 */
export async function listDatabaseTables(runtime: CapabilityRuntime, timeoutMs = 8000): Promise<DatabaseTablesResult> {
  try {
    const engine = text(runtime.config.engine).toLowerCase() || 'mysql'
    const host = text(runtime.config.host)
    if (host === '') throw new Error('数据库实例缺少 host')
    if (engine === 'sqlite') {
      const db = new DatabaseSync(host, { readOnly: true })
      try {
        const rows = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as { name: string }[]
        return {
          ok: true,
          detail: `SQLite 表清单：${rows.length} 张`,
          tables: rows.map(row => ({ name: row.name, comment: '' })),
        }
      } finally {
        db.close()
      }
    }
    const database = text(runtime.config.database)
    if (engine === 'pg' || engine === 'postgres' || engine === 'postgresql') {
      const { Client: PgClient } = await pg()
      const schema = text(runtime.config.schema) || 'public'
      const client = new PgClient({
        host,
        port: typeof runtime.config.port === 'number' ? runtime.config.port : 5432,
        user: text(runtime.config.username),
        password: runtime.secret ?? '',
        ...(database === '' ? {} : { database }),
        connectionTimeoutMillis: timeoutMs,
      })
      await client.connect()
      try {
        const result = await client.query(
          "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
          [schema],
        )
        const rows = result.rows as { t: string }[]
        return {
          ok: true,
          detail: `${schema} 表清单：${rows.length} 张`,
          tables: rows.map(row => ({ name: row.t, comment: '' })),
        }
      } finally {
        await client.end().catch(() => undefined)
      }
    }
    if (database === '') throw new Error('数据库实例缺少 database')
    const handle = await (await mysql()).createConnection({
      host,
      port: typeof runtime.config.port === 'number' ? runtime.config.port : 3306,
      user: text(runtime.config.username),
      password: runtime.secret ?? '',
      database,
      connectTimeout: timeoutMs,
    })
    try {
      const [rows] = await handle.query(
        "SELECT TABLE_NAME AS t, TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        [database],
      )
      const list = rows as { t: string; c: string | null }[]
      return {
        ok: true,
        detail: `${database} 表清单：${list.length} 张`,
        tables: list.map(row => ({ name: row.t, comment: row.c ?? '' })),
      }
    } finally {
      await handle.end().catch(() => undefined)
    }
  } catch (reason) {
    return {
      ok: false,
      detail: reason instanceof Error ? reason.message : String(reason),
      tables: [],
    }
  }
}

/** Host-key evidence returned by a credential-free SSH handshake. */
export interface SshHostKeyProbeResult {
  readonly hostKeySha256: string
  readonly elapsedMs: number
}

/** OpenSSH fingerprint display form for one raw host key. */
function hostKeyFingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * Read the SSH server host key without authenticating or reading a credential.
 *
 * The probe performs only the transport handshake and stops before userauth,
 * so it can run before any secret is leased. Callers must still show the
 * returned fingerprint to a human for confirmation: this value is evidence of
 * what the server currently presents, not proof that the server is trusted.
 * @param host - SSH host.
 * @param port - SSH port.
 * @param timeoutMs - handshake timeout.
 * @returns SHA-256 fingerprint in OpenSSH display form.
 */
export async function probeSshHostKey(host: string, port: number, timeoutMs = 15_000): Promise<SshHostKeyProbeResult> {
  if (host.trim() === '') throw new Error('SSH 实例缺少 host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口无效：' + String(port))
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (fingerprint?: string, error?: Error): void => {
      if (settled) return
      settled = true
      client.end()
      if (fingerprint !== undefined) resolve({ hostKeySha256: fingerprint, elapsedMs: Date.now() - started })
      else reject(error ?? new Error('SSH 服务器未提供主机指纹'))
    }
    client.once('error', (error) => { finish(undefined, error) })
    client.once('ready', () => { finish(undefined, new Error('SSH 服务器在未认证阶段就接受了连接')) })
    client.connect({
      host,
      port,
      username: 'host-key-probe',
      readyTimeout: Math.max(1000, timeoutMs),
      hostVerifier: (key: Buffer) => {
        finish(hostKeyFingerprint(key))
        return false
      },
    })
  })
}
