/**
 * Install the AgentOps skills into DSH's user-level skill root.
 *
 * Why a user root: `skill-filesystem` ships two rows in the web profile, and a
 * patch by id lands on the disabled base row, so `customSkillDirs` there is
 * ignored. The enabled row scans `$DSH_AGENTS_HOME/skills` (default
 * `~/.agents/skills`), which is the documented place for skills that must be
 * visible to every session regardless of its cwd.
 *
 * The package directory stays the source of truth; this script links each skill
 * into that root (junction on Windows, symlink elsewhere).
 *
 * Usage: node --import tsx packages/agentops/scripts/install-skills.ts [--copy]
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sourceRoot = join(import.meta.dirname, '..', 'skills')
const agentsHome = process.env.DSH_AGENTS_HOME?.trim() ?? join(homedir(), '.agents')
const targetRoot = join(agentsHome, 'skills')
const copy = process.argv.includes('--copy')

if (!existsSync(sourceRoot)) throw new Error(`找不到 skill 源目录：${sourceRoot}`)
mkdirSync(targetRoot, { recursive: true })

const results: { name: string; action: string; target: string }[] = []
for (const name of readdirSync(sourceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
  const source = join(sourceRoot, name)
  const target = join(targetRoot, name)
  if (existsSync(target)) {
    const stat = lstatSync(target)
    // Reinstall only what this script owns: a link or an identical copy.
    if (!stat.isSymbolicLink()) rmSync(target, { recursive: true, force: true })
    else rmSync(target, { force: true })
  }
  if (copy) {
    cpSync(source, target, { recursive: true })
    results.push({ name, action: 'copied', target })
  } else {
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    results.push({ name, action: 'linked', target })
  }
}

console.log(JSON.stringify({ agentsHome, targetRoot, mode: copy ? 'copy' : 'link', skills: results }, null, 2))
