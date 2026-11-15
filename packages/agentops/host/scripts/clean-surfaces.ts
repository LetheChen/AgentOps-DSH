/**
 * Delete stored surfaces that can never render (components without a name).
 *
 * One-shot maintenance: bad rows were published before `present_content`
 * validated with the real schema, and the screen has to skip them at runtime.
 *
 * Usage: node --import tsx packages/agentops/host/scripts/clean-surfaces.ts [--dry]
 */

import { resolveSurfaceDbPath } from '../src/dsh.ts'
import { SurfaceStore } from '../src/surfaces.ts'

const dryRun = process.argv.includes('--dry')
const path = resolveSurfaceDbPath()

const store = new SurfaceStore(path)
const invalid = store.invalidIds()
console.log(JSON.stringify({ path, invalid, dryRun }))

if (!dryRun) {
  for (const id of invalid) store.remove(id)
  console.log(JSON.stringify({ removed: invalid.length, remaining: store.list(500).length }))
}
store.close()
