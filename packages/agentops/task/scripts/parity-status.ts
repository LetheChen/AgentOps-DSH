/**
 * Parity check: TS transition table vs the legacy Python definition.
 *
 * Run with: node --import tsx scripts/parity-status.ts
 * Requires a Python interpreter able to import the legacy project; set
 * AGENTOPS_PYTHON to override the interpreter path.
 */

import { execFileSync } from 'node:child_process'

import { PAUSABLE, TERMINAL, TRANSITIONS } from '../src/status.ts'

const python = process.env.AGENTOPS_PYTHON ?? 'python'
const legacyRoot = process.env.AGENTOPS_ROOT
if (legacyRoot === undefined) throw new Error('Set AGENTOPS_ROOT to the legacy AgentOps project root')

const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(legacyRoot)})
from task.status import TRANSITIONS, TERMINAL, PAUSABLE
print(json.dumps({
  "transitions": [[t.from_status.value, t.to_status.value, t.action, bool(t.requires_user)] for t in TRANSITIONS],
  "terminal": sorted(s.value for s in TERMINAL),
  "pausable": sorted(s.value for s in PAUSABLE),
}, ensure_ascii=False))
`

const legacy = JSON.parse(execFileSync(python, ['-c', script], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
})) as {
  transitions: [string, string, string, boolean][]
  terminal: string[]
  pausable: string[]
}

const ours = TRANSITIONS.map(rule => [rule.from, rule.to, rule.action, rule.requiresUser])
const key = (row: [string, string, string, boolean]): string => row.join('|')

const legacySet = new Set(legacy.transitions.map(key))
const ourSet = new Set(ours.map(key))
const missing = [...legacySet].filter(item => !ourSet.has(item))
const extra = [...ourSet].filter(item => !legacySet.has(item))

const report = {
  legacyTransitions: legacy.transitions.length,
  tsTransitions: ours.length,
  missing,
  extra,
  terminalMatches: JSON.stringify([...TERMINAL].sort()) === JSON.stringify(legacy.terminal),
  pausableMatches: JSON.stringify([...PAUSABLE].sort()) === JSON.stringify(legacy.pausable),
}

console.log(JSON.stringify(report, null, 2))
if (missing.length > 0 || extra.length > 0 || !report.terminalMatches || !report.pausableMatches) {
  process.exitCode = 1
}
