/**
 * Backup and restore for the AgentOps SQLite stores.
 *
 * A plain file copy of a live SQLite database can capture a torn write. These
 * helpers use `VACUUM INTO`, which writes a consistent snapshot of the database
 * as of that moment, then hash the result so a restore can prove it is reading
 * the same bytes a backup produced.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface BackupFile {
  name: string
  bytes: number
  sha256: string
}

export interface BackupManifest {
  createdAt: string
  nodeVersion: string
  files: BackupFile[]
  /** Databases requested but absent at backup time. */
  skipped: string[]
}

/** Directory names the AgentOps stack owns under `$DSH_HOME/agentops`. */
export const KNOWN_DATABASES = ['knowledge.db', 'tasks.db', 'runs.db'] as const

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Snapshot each database into `outDir`.
 * @param dataDir - directory holding the live databases.
 * @param outDir - destination directory (created when missing).
 * @param names - database file names to snapshot.
 * @returns manifest describing exactly what was written.
 */
export function backupDatabases(
  dataDir: string,
  outDir: string,
  names: readonly string[] = KNOWN_DATABASES,
): BackupManifest {
  mkdirSync(outDir, { recursive: true })
  const files: BackupFile[] = []
  const skipped: string[] = []

  for (const name of names) {
    const source = join(dataDir, name)
    if (!existsSync(source)) {
      skipped.push(name)
      continue
    }
    const target = join(outDir, name)
    const db = new DatabaseSync(source)
    try {
      // Consistent snapshot without copying the WAL by hand.
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    files.push({ name, bytes: statSync(target).size, sha256: sha256Of(target) })
  }

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    files,
    skipped,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

export interface RestoreResult {
  restored: string[]
  /** Files whose hash did not match the manifest, left untouched. */
  rejected: string[]
  /** Snapshot of the pre-restore state, when one was taken. */
  safetyBackup?: string
}

/**
 * Restore a backup into `targetDir`.
 *
 * A file is copied only when its hash matches the manifest; a mismatch is
 * reported instead of silently overwriting a good database. Unless disabled, the
 * current databases are snapshotted first so a wrong restore can be undone.
 * @param backupDir - directory produced by {@link backupDatabases}.
 * @param targetDir - live data directory to restore into.
 * @param options - `safetyBackupDir` overrides where the pre-restore snapshot goes.
 */
export function restoreBackup(
  backupDir: string,
  targetDir: string,
  options: { safetyBackupDir?: string; skipSafetyBackup?: boolean } = {},
): RestoreResult {
  const manifestPath = join(backupDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`备份缺少 manifest.json：${backupDir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest

  mkdirSync(targetDir, { recursive: true })

  let safetyBackup: string | undefined
  if (options.skipSafetyBackup !== true) {
    const root = options.safetyBackupDir ?? join(targetDir, 'backups')
    const hasLiveData = manifest.files.some(file => existsSync(join(targetDir, file.name)))
    if (hasLiveData) {
      safetyBackup = join(root, `pre-restore-${backupFolderName()}`)
      backupDatabases(targetDir, safetyBackup, manifest.files.map(file => file.name))
    }
  }
  const restored: string[] = []
  const rejected: string[] = []
  for (const file of manifest.files) {
    const source = join(backupDir, file.name)
    if (!existsSync(source)) { rejected.push(file.name); continue }
    if (sha256Of(source) !== file.sha256) { rejected.push(file.name); continue }
    copyFileSync(source, join(targetDir, file.name))
    restored.push(file.name)
  }
  return { restored, rejected, ...(safetyBackup === undefined ? {} : { safetyBackup }) }
}

/**
 * List existing backups under a root directory, newest first.
 * @param root - directory holding timestamped backup folders.
 */
export function listBackups(root: string): { name: string; path: string; createdAt: string }[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap((entry) => {
      const manifestPath = join(root, entry.name, 'manifest.json')
      if (!existsSync(manifestPath)) return []
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
      return [{ name: entry.name, path: join(root, entry.name), createdAt: manifest.createdAt }]
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** Default backup folder name for a timestamp. */
export function backupFolderName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export { basename }
