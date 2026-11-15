/**
 * Operator CLI for AgentOps SQLite backups.
 *
 *   node --import tsx scripts/backup.ts backup   [--data <dir>] [--out <dir>]
 *   node --import tsx scripts/backup.ts list     [--out <dir>]
 *   node --import tsx scripts/backup.ts restore <backupDir> [--data <dir>]
 *
 * Defaults: data `$DSH_HOME/agentops`, backups `$DSH_HOME/agentops/backups`.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { backupDatabases, backupFolderName, listBackups, restoreBackup } from '../src/backup.ts'
import { doctor } from '../src/doctor.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const dataDir = resolve(arg('data') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agentops'))
const outRoot = resolve(arg('out') ?? join(dataDir, 'backups'))
const command = process.argv[2] ?? 'help'

if (command === 'backup') {
  const target = join(outRoot, backupFolderName())
  const manifest = backupDatabases(dataDir, target)
  console.log(JSON.stringify({ target, ...manifest }, null, 2))
} else if (command === 'list') {
  console.log(JSON.stringify(listBackups(outRoot), null, 2))
} else if (command === 'restore') {
  const backupDir = process.argv[3]
  if (backupDir === undefined) {
    console.error('restore 需要备份目录参数')
    process.exit(2)
  }
  const result = restoreBackup(resolve(backupDir), dataDir, {
    skipSafetyBackup: process.argv.includes('--no-safety'),
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.rejected.length > 0) process.exitCode = 1
} else if (command === 'doctor') {
  const report = doctor(dataDir, Number(arg('max-age-days') ?? '7'))
  console.log(JSON.stringify(report, null, 2))
  if (report.problems.length > 0) process.exitCode = 1
} else {
  console.log('用法：backup [--data <dir>] [--out <dir>] | list [--out <dir>] | restore <backupDir> [--data <dir>] [--no-safety] | doctor [--max-age-days <n>]')
  process.exitCode = 2
}
