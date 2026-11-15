/**
 * Migrate one task database in place.
 *
 * Usage:
 *   node --import tsx scripts/migrate-task-db.ts --db <path> [--dry-run] [--backup <dir>]
 *
 * Prints the plan as JSON. `--dry-run` never writes; a real run backs up the
 * main database plus `-wal`/`-shm`, verifies the staging file, then replaces the
 * file group. Errors exit non-zero after printing the refusal reason.
 *
 * @module @agentops/dsh-task/scripts/migrate-task-db
 */

import { applyMigration } from '../src/migrate.ts'

/**
 * Read `--name value` or `--flag` from argv.
 * @param argv - process arguments after the script path.
 * @returns parsed options.
 */
export function parseArgs(argv: readonly string[]): { db?: string; dryRun: boolean; backup?: string } {
  const result: { db?: string; dryRun: boolean; backup?: string } = { dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--db') result.db = argv[index += 1]
    else if (arg === '--backup') result.backup = argv[index += 1]
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
if (options.db === undefined) {
  console.error('usage: migrate-task-db.ts --db <path> [--dry-run] [--backup <dir>]')
  process.exitCode = 2
} else {
  try {
    const result = applyMigration(options.db, {
      dryRun: options.dryRun,
      ...(options.backup === undefined ? {} : { backupDir: options.backup }),
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
