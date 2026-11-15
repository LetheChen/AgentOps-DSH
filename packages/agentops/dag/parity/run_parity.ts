/**
 * Execution parity: legacy Python engine vs the new DAG engine.
 *
 * Compares **node states and run outcome only** — never text. That keeps the
 * comparison harness-independent and avoids pretending model output is stable.
 *
 * Run with: node --import tsx parity/run_parity.ts
 * Requires `AGENTOPS_ROOT` for the legacy tree.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DagEngine } from '../src/engine.ts'
import { parseWorkflowYaml } from '../src/load.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const python = process.env.AGENTOPS_PYTHON ?? 'python'
const legacyRoot = process.env.AGENTOPS_ROOT
if (legacyRoot === undefined) throw new Error('Set AGENTOPS_ROOT to the legacy AgentOps project root')

interface LegacyResult {
  file: string
  status: string
  nodes: Record<string, string>
}

/**
 * What status-level parity cannot see.
 *
 * The gateway's port choice does not change which nodes run (the graph decides
 * that), and the legacy engine exposes no `chosenPort`, so status comparison is
 * blind to the old stub. Port selection is covered by unit tests instead.
 */
const OBSERVABILITY_NOTES: Record<string, string> = {
  'parity-gateway.yaml': '端口选择在状态层不可观测：两侧都跑完两条分支；chosenPort 由单测覆盖',
  'parity-skip.yaml': 'skip_if 是否命中不体现在状态层：两侧均为 completed',
}

const files = ['parity-linear.yaml', 'parity-parallel.yaml', 'parity-gateway.yaml', 'parity-skip.yaml']
const paths = files.map(file => join(fixtures, file))

const legacy = JSON.parse(execFileSync(
  python,
  [join(here, 'run_legacy.py'), ...paths],
  {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', AGENTOPS_ROOT: legacyRoot },
    timeout: 180_000,
  },
)) as LegacyResult[]

const rows = []
let mismatches = 0

for (const [index, file] of files.entries()) {
  const workflow = parseWorkflowYaml(readFileSync(join(fixtures, file), 'utf8'))
  const state = await new DagEngine().run(workflow, async () => ({}))
  const ours: Record<string, string> = Object.fromEntries(
    Object.entries(state.nodes).map(([id, node]) => [id, node.status]),
  )
  const theirs = legacy[index]?.nodes ?? {}

  const ids = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort()
  const diffs = ids
    .filter(id => ours[id] !== theirs[id])
    .map(id => ({ id, legacy: theirs[id] ?? '(missing)', next: ours[id] ?? '(missing)' }))

  const runStatusOurs = state.status
  const runStatusLegacy = legacy[index]?.status === 'RUN_COMPLETED' ? 'completed' : 'failed'
  if (runStatusOurs !== runStatusLegacy) diffs.push({ id: '(run)', legacy: runStatusLegacy, next: runStatusOurs })

  const note = OBSERVABILITY_NOTES[file]
  mismatches += diffs.length
  rows.push({
    file,
    legacyRun: runStatusLegacy,
    nextRun: runStatusOurs,
    diffs,
    ...(note === undefined ? {} : { note }),
  })
}

console.log(JSON.stringify({ fixtures: rows.length, mismatches, rows }, null, 2))
if (mismatches > 0) process.exitCode = 1
