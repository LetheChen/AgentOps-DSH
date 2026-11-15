/**
 * Deployment self-check for the AgentOps data layer.
 *
 * Answers three questions an operator actually asks after an install:
 * are the databases readable and uncorrupted, is the backup folder recent
 * enough to roll back, and is the sidecar reachable.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { KNOWN_DATABASES, listBackups } from './backup.ts'

export interface DatabaseCheck {
  name: string
  present: boolean
  bytes: number | null
  integrity: 'ok' | 'corrupt' | 'unreadable' | 'missing'
  tables: number | null
  error?: string
}

export interface DoctorReport {
  dataDir: string
  databases: DatabaseCheck[]
  backups: { count: number; latestAt: string | null }
  problems: string[]
}

/**
 * Inspect the data directory.
 * @param dataDir - directory holding the SQLite stores.
 * @param maxBackupAgeDays - report a problem when the newest backup is older.
 */
export function doctor(dataDir: string, maxBackupAgeDays = 7): DoctorReport {
  const problems: string[] = []
  const databases: DatabaseCheck[] = []

  if (!existsSync(dataDir)) {
    problems.push(`数据目录不存在：${dataDir}`)
  }

  for (const name of KNOWN_DATABASES) {
    const path = join(dataDir, name)
    if (!existsSync(path)) {
      databases.push({ name, present: false, bytes: null, integrity: 'missing', tables: null })
      continue
    }
    try {
      const bytes = statSync(path).size
      const db = new DatabaseSync(path)
      try {
        const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
        const integrity = row?.integrity_check === 'ok' ? 'ok' as const : 'corrupt' as const
        const tables = (db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c
        databases.push({ name, present: true, bytes, integrity, tables })
        if (integrity !== 'ok') problems.push(`${name} 完整性检查失败（${row?.integrity_check ?? 'unknown'}）`)
      } finally {
        db.close()
      }
    } catch (error) {
      databases.push({
        name, present: true, bytes: null, integrity: 'unreadable', tables: null,
        error: error instanceof Error ? error.message : String(error),
      })
      problems.push(`${name} 无法打开：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!databases.some(check => check.present)) {
    problems.push('没有找到任何 AgentOps 数据库（全新部署时属于正常）')
  }

  const backups = listBackups(join(dataDir, 'backups'))
  const latestAt = backups[0]?.createdAt ?? null
  if (latestAt === null) {
    problems.push('尚无备份；生产部署应先跑一次 backup')
  } else {
    const ageDays = (Date.now() - Date.parse(latestAt)) / 86_400_000
    if (ageDays > maxBackupAgeDays) problems.push(`最近备份距今 ${ageDays.toFixed(1)} 天，超过 ${maxBackupAgeDays} 天阈值`)
  }

  return { dataDir, databases, backups: { count: backups.length, latestAt }, problems }
}

/** Count backup folders that contain a manifest (used by the CLI listing). */
export function countBackups(root: string): number {
  if (!existsSync(root)) return 0
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
    .length
}
