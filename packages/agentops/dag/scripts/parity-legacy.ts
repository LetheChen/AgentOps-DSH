/**
 * Parity check: load and validate the legacy AgentOps workflows.
 *
 * Run with: node --import tsx scripts/parity-legacy.ts [workflowDir]
 * Exits non-zero when any file fails to load or validate, so it can gate a
 * migration batch.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseWorkflowYaml } from '../src/load.ts'
import { validateWorkflow } from '../src/validate.ts'

const dir = process.argv[2] ?? process.env.AGENTOPS_ROOT
if (dir === undefined) throw new Error('Pass a workflow directory or set AGENTOPS_ROOT')
const files = readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()

let ok = 0
const failures: { file: string; errors: string[] }[] = []
for (const file of files) {
  try {
    const wf = parseWorkflowYaml(readFileSync(join(dir, file), 'utf8'))
    const result = validateWorkflow(wf)
    if (result.ok) ok += 1
    else failures.push({ file, errors: result.errors.slice(0, 8) })
  } catch (error) {
    failures.push({ file, errors: [error instanceof Error ? error.message : String(error)] })
  }
}

console.log(JSON.stringify({ dir, total: files.length, ok, failed: failures.length, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
