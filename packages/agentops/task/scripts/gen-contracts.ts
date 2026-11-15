/**
 * Write or verify the task contract snapshot.
 *
 * Usage:
 *   node --import tsx scripts/gen-contracts.ts --write
 *   node --import tsx scripts/gen-contracts.ts --check
 *
 * `--check` exits 1 when the checked-in JSON differs from the snapshot derived
 * from source, which is how drift in tables, indexes, triggers, routes or
 * lifecycle edges is caught before a migration runs.
 *
 * @module @agentops/dsh-task/scripts/gen-contracts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTaskContractSnapshot } from '../src/contracts.ts'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(PACKAGE_ROOT, 'contracts', 'task-contracts.v1.json')

/**
 * Render the snapshot as stable, reviewable JSON.
 * @param value - the snapshot to render.
 * @returns JSON text with two-space indentation and one trailing newline.
 */
export function renderSnapshot(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--write') ? 'write' : ''
if (mode === '') {
  console.error('usage: gen-contracts.ts --write | --check')
  process.exitCode = 2
} else {
  const rendered = renderSnapshot(buildTaskContractSnapshot())
  if (mode === 'write') {
    mkdirSync(dirname(OUTPUT), { recursive: true })
    writeFileSync(OUTPUT, rendered, 'utf8')
    console.log(`wrote ${OUTPUT}`)
  } else {
    let current = ''
    try {
      current = readFileSync(OUTPUT, 'utf8')
    } catch {
      console.error(`missing ${OUTPUT}; run --write`)
      process.exitCode = 1
    }
    if (current !== '' && current !== rendered) {
      const expected = rendered.split('\n')
      const actual = current.split('\n')
      const at = expected.findIndex((line, index) => line !== actual[index])
      console.error(`contract drift at line ${at + 1}:\n  expected: ${expected[at] ?? '<eof>'}\n  actual:   ${actual[at] ?? '<eof>'}`)
      process.exitCode = 1
    } else if (current !== '') {
      console.log('contract snapshot is current')
    }
  }
}
