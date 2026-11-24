#!/usr/bin/env node
/**
 * Create the `agentops` profile: a supported, reproducible launch path.
 *
 * Before this script the only working compositions lived in someone's
 * `$DSH_HOME` (an M1-era smoke profile with three packages and no client), so
 * a fresh checkout had no way to boot AgentOps at all.
 *
 * The profile declares the DSH base layer, the Web app layer, an optional DSH
 * native browser bundle, and `@agentops/dsh-bundle`. Keeping the browser layer
 * separate lets the AgentOps plugins ship without one concrete provider.
 * Package resolution still needs links: bundle rows name `@agentops/dsh-*`,
 * and an unlinked name fails at session creation with `never started`.
 *
 * Usage: node packages/agentops/deploy/bootstrap-profile.mjs [--profile agentops] [--dry-run]
 */

import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { seedAgentOps } from './seed-agentops.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = resolve(here, '..')
const repoRoot = resolve(packagesRoot, '..', '..')

/** Every workspace package whose name the bundle patch references, plus its library dependencies. */
const LINKED = [
  'bundle',
  'browser',
  'client',
  'contracts',
  'dag',
  'db',
  'host',
  'knowledge',
  'log-collection',
  'deployment',
  'security',
  'ui-capability',
  'task',
  'vault',
  'workflow-catalog',
  'workflow-compiler',
  'workspace-layout',
]

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const profileName = arg('--profile', 'agentops')
const dryRun = process.argv.includes('--dry-run')
const dshHome = process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)

/** Read one package's manifest name. */
function packageName(dir) {
  const manifest = join(packagesRoot, dir, 'package.json')
  if (!existsSync(manifest)) throw new Error(`缺少包的 package.json：${manifest}`)
  return JSON.parse(readFileSync(manifest, 'utf8')).name
}

if (existsSync(profileDir) && !process.argv.includes('--force')) {
  console.error(`profile 已存在：${profileDir}\n用 --force 覆盖，或换一个 --profile 名字。`)
  process.exit(1)
}

const profilePackage = {
  name: `dsh-profile-${profileName}`,
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@agentops/dsh-browser',
        '@agentops/dsh-bundle',
      ],
    },
  },
}

if (dryRun) {
  console.log(JSON.stringify({ profileDir, profilePackage, linked: LINKED }, null, 2))
  process.exit(0)
}

mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.yml'), '# dsh profile root — an empty entry list; the tree is composed as patches.\n[]\n', 'utf8')
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')

// Windows needs `mklink /J`; POSIX uses a plain symlink. Both are re-runnable.
const isWindows = process.platform === 'win32'
for (const dir of LINKED) {
  const target = join(packagesRoot, dir)
  const link = join(profileDir, 'node_modules', packageName(dir))
  mkdirSync(dirname(link), { recursive: true })
  if (existsSync(link)) continue
  if (isWindows) {
    const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    if (result.status !== 0) throw new Error(`建立 junction 失败：${link} -> ${target}`)
  } else {
    spawnSync('ln', ['-s', target, link], { stdio: 'ignore' })
  }
}

const linkedCount = LINKED.filter(dir => existsSync(join(profileDir, 'node_modules', packageName(dir)))).length
const seeded = seedAgentOps({ dshHome })
console.log(`profile: ${profileDir}`)
console.log(`bundles: ${profilePackage.dsh.profile.bundles.join(', ')}`)
console.log(`linked:  ${linkedCount} 个 @agentops 包`)
console.log(`assets:  copied ${seeded.copied.length}, skipped ${seeded.skipped.length}`)
console.log(`\n下一步：dsh --profile ${profileName}`)
console.log('工作流目录与 Agent 目录默认落在 $DSH_HOME/agentops/ 下，由 bundle 的 dshHomePath 解析。')
