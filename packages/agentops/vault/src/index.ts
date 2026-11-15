/**
 * Root half of the credential vault: HTTP routes for connections.
 *
 * There are no tools here on purpose — the model never reads or writes secrets.
 * The page shows metadata and a "has secret" flag; passwords travel only from
 * the form into the store, sealed before they touch disk.
 *
 * @module @agentops/dsh-vault
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { appendAudit, listCredentialAudit } from './audit.ts'
import { probeConnection } from './probe.ts'
import { ConnectionStore, type ConnectionInput } from './store.ts'

export const name = 'agentops-vault'

/** Root mounts no tools. */
export const inject: string[] = []

/** Configuration accepted by the credential vault plugin. */
export interface VaultPluginConfig {
  /** SQLite path for connection metadata + sealed secrets. */
  dbPath?: string
}

/**
 * Resolve the vault database path: config > env > `$DSH_HOME/agentops/credentials.db`.
 * @param config - plugin configuration whose `dbPath` takes precedence.
 * @returns the path of the vault database.
 */
export function resolveVaultPath(config: VaultPluginConfig = {}): string {
  const explicit = config.dbPath?.trim() ?? process.env.AGENTOPS_CRED_DB?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return dshHomePath('agentops', 'credentials.db')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Register the connection routes on the Connection service.
 * @param ctx - context carrying Connection.
 * @param store - connection store.
 */
export function registerVaultRoutes(ctx: Context, store: ConnectionStore): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/connections',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const kind = new URL(request.url).searchParams.get('kind')
      const filter = kind === 'database' || kind === 'server' ? kind : undefined
      return json({ connections: store.list(filter) })
    },
  }), 'agentops-vault: list connections')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/connections/save',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, reason: '请求体不是合法 JSON' }, 400)
      }
      const input = parseInput(body)
      if (typeof input === 'string') return json({ ok: false, reason: input }, 400)
      const existed = store.get(input.id) !== null
      try {
        const connection = store.upsert(input)
        // Two facts, two rows: a create/update is one action, a password write is
        // another (it can happen on its own during rotation).
        appendAudit({
          action: existed ? 'connection.update' : 'connection.create',
          target: input.id,
          result: 'ok',
          detail: { kind: input.kind, driver: input.driver, host: input.host, port: input.port, enabled: input.enabled },
        })
        if (input.password !== undefined) {
          appendAudit({ action: 'connection.secret.set', target: input.id, result: 'ok' })
        }
        return json({ ok: true, connection })
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        appendAudit({ action: existed ? 'connection.update' : 'connection.create', target: input.id, result: 'fail', detail: { error: message.slice(0, 200) } })
        return json({ ok: false, reason: message }, 409)
      }
    },
  }), 'agentops-vault: upsert connection')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/connections/remove',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, reason: '请求体不是合法 JSON' }, 400)
      }
      const id = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : ''
      if (id === '') return json({ ok: false, reason: '缺少 id' }, 400)
      const removed = store.remove(id)
      appendAudit({ action: 'connection.delete', target: id, result: removed ? 'ok' : 'fail' })
      return json({ ok: removed })
    },
  }), 'agentops-vault: delete connection')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/connections/audit',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') ?? '20') || 20, 1), 100)
      return json({ events: listCredentialAudit(limit) })
    },
  }), 'agentops-vault: credential audit')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/connections/test',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, reason: '请求体不是合法 JSON' }, 400)
      }
      const id = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : ''
      const connection = id === '' ? null : store.get(id)
      if (connection === null) return json({ ok: false, reason: `未知连接：${id}` }, 404)
      let secret: string | null = null
      try {
        secret = store.readSecret(id)
      } catch (reason) {
        return json({ ok: false, reason: `无法解密凭据：${reason instanceof Error ? reason.message : String(reason)}` }, 500)
      }
      const result = await probeConnection(connection, secret)
      store.recordTest(id, result.ok, result.ok ? null : result.detail)
      appendAudit({
        action: 'connection.test',
        target: id,
        result: result.ok ? 'ok' : 'fail',
        detail: {
          kind: connection.kind,
          driver: connection.driver,
          elapsedMs: result.elapsedMs,
          error: result.ok ? undefined : result.detail.slice(0, 160),
        },
      })
      return json({ ok: result.ok, detail: result.detail, elapsedMs: result.elapsedMs })
    },
  }), 'agentops-vault: test connection')
}

function parseInput(body: unknown): ConnectionInput | string {
  if (body === null || typeof body !== 'object') return '请求体必须是对象'
  const row = body as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!/^[a-z0-9_-]{2,64}$/i.test(id)) return '连接 ID 必须是 2-64 位字母、数字、下划线或短横线'
  const kind = row.kind === 'server' ? 'server' : row.kind === 'database' ? 'database' : null
  if (kind === null) return 'kind 必须是 database 或 server'
  const host = typeof row.host === 'string' ? row.host.trim() : ''
  if (host === '') return '地址不能为空'
  const port = row.port === null || row.port === undefined || row.port === ''
    ? null
    : Number(row.port)
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return '端口必须是 1-65535'
  return {
    id,
    kind,
    name: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim() : id,
    driver: typeof row.driver === 'string' && row.driver.trim().length > 0
      ? row.driver.trim()
      : (kind === 'server' ? 'ssh' : 'mysql'),
    host,
    port,
    username: typeof row.username === 'string' ? row.username.trim() : '',
    defaultDatabase: typeof row.defaultDatabase === 'string' && row.defaultDatabase.trim().length > 0
      ? row.defaultDatabase.trim()
      : null,
    enabled: row.enabled === undefined ? true : row.enabled === true,
    ...(typeof row.password === 'string' && row.password.length > 0 ? { password: row.password } : {}),
  }
}

/**
 * Mount the vault root: open the store, then register routes once Connection is ready.
 * @param ctx - Cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: VaultPluginConfig = {}): void {
  const path = resolveVaultPath(config)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const store = new ConnectionStore(path)
  ctx.effect(() => () =>{  store.close() }, 'agentops-vault: close store')
  ctx.inject(['connection'], (connectionCtx) => {
    registerVaultRoutes(connectionCtx, store)
  })
}

export * from './probe.ts'
export * from './store.ts'
