/**
 * Connection probes for the credential page's 测试 button.
 *
 * Database probes really connect (mysql2 handshake / SQLite open) and run one
 * trivial statement; server probes only open a TCP connection — an SSH login is
 * deliberately not attempted here, and the result says so.
 */

import { DatabaseSync } from 'node:sqlite'
import { createConnection } from 'node:net'

import { createConnection as createMysqlConnection } from 'mysql2/promise'

import type { ConnectionView } from './store.ts'

/** Outcome of one connection probe. */
export interface ProbeResult {
  readonly ok: boolean
  readonly detail: string
  readonly elapsedMs: number
}

/**
 * Probe one connection with its decrypted secret.
 * @param connection - stored metadata.
 * @param secret - decrypted password, or null when none is stored.
 * @param timeoutMs - hard cap for the attempt.
 * @returns the probe outcome, including the failure reason when it failed.
 */
export async function probeConnection(
  connection: ConnectionView,
  secret: string | null,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const started = Date.now()
  try {
    if (connection.kind === 'server') {
      await tcpProbe(connection.host, connection.port ?? 22, timeoutMs)
      return { ok: true, detail: `TCP ${connection.host}:${connection.port ?? 22} 可达（未验证 SSH 登录）`, elapsedMs: Date.now() - started }
    }
    if (connection.driver === 'mysql') {
      const handle = await createMysqlConnection({
        host: connection.host,
        port: connection.port ?? 3306,
        user: connection.username,
        password: secret ?? '',
        ...(connection.defaultDatabase === null ? {} : { database: connection.defaultDatabase }),
        connectTimeout: timeoutMs,
      })
      try {
        const [rows] = await handle.query('SELECT 1 AS ok')
        const first = (rows as { ok?: number }[])[0]
        return { ok: first?.ok === 1, detail: `MySQL 握手成功（${connection.defaultDatabase ?? '无默认库'}）`, elapsedMs: Date.now() - started }
      } finally {
        await handle.end().catch(() => undefined)
      }
    }
    // SQLite: the "host" column holds the file path.
    const db = new DatabaseSync(connection.host, { readOnly: true })
    try {
      db.prepare('SELECT 1').get()
      return { ok: true, detail: `SQLite 文件可读：${connection.host}`, elapsedMs: Date.now() - started }
    } finally {
      db.close()
    }
  } catch (reason) {
    return {
      ok: false,
      detail: reason instanceof Error ? reason.message : String(reason),
      elapsedMs: Date.now() - started,
    }
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接超时（${timeoutMs}ms）`))
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
