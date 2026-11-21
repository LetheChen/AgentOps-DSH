#!/usr/bin/env node
/**
 * Container bootstrap: make the AgentOps packages resolvable inside the DSH
 * profile, then hand over to `dsh web`.
 *
 * The preset layer references tools by package name (`@agentops/dsh-task/tools`)
 * because file paths never start inside a preset. That means the profile needs
 * real `node_modules/@agentops/*` entries, which is exactly what this does —
 * one symlink per package, created once per container start.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { seedAgentOps } from './seed-agentops.mjs'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'web')
const packagesDir = resolve('/app/packages/agentops')
const linkRoot = join(profileDir, 'node_modules', '@agentops')

const PACKAGES = ['browser', 'host', 'knowledge', 'dag', 'task', 'vault', 'capability',
  'log-collection',
  'deployment',
  'ui-capability',
  'security',
  'db',
  'workflow-catalog',
  'client',
  'bundle',
]

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
    child.on('error', reject)
  })
}

async function main() {
  // 1) Let DSH create a complete profile first; an empty directory would be invalid.
  await run('pnpm', ['dsh', '--profile', 'web', '--dump-config'], { stdio: 'ignore' }).catch(() => {
    // dump-config can fail without printing anything harmful; the real boot below is authoritative.
  })

  // 2) Link local packages so preset rows resolve by name.
  mkdirSync(linkRoot, { recursive: true })
  for (const name of PACKAGES) {
    const target = join(packagesDir, name)
    const link = join(linkRoot, `dsh-${name}`)
    if (!existsSync(target) || existsSync(link)) continue
    symlinkSync(target, link, 'dir')
  }

  // 3) Seed the migrated Agent and workflow catalogues without overwriting local edits.
  const seeded = seedAgentOps({ dshHome })
  console.log(`assets: copied ${seeded.copied.length}, skipped ${seeded.skipped.length}`)

  // 4) Start the host with both deployment rows and generated Agent presets.
  await run('pnpm', [
    'dsh', 'web', '--port', '3080', '--no-open',
    '--patch', '/etc/agentops/agentops.patch.yml',
    '--patch', '/app/packages/agentops/browser/cordis.patch.yml',
    '--patch', '/app/packages/agentops/bundle/presets/agents.generated.patch.yml',
  ])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
