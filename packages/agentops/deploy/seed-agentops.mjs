#!/usr/bin/env node
/**
 * Copy the migrated AgentOps assets into the runtime `$DSH_HOME/agentops`
 * directory. The Web UI reads that directory, not the repository checkout.
 *
 * Existing files are preserved by default so a deployment does not overwrite
 * local edits. `--force` is the explicit replacement path.
 *
 * Usage: node packages/agentops/deploy/seed-agentops.mjs [--dsh-home <dir>] [--force] [--dry-run]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assetRoot = resolve(here, '..', '..', '..', 'agentops')
const skillsRoot = resolve(here, '..', 'skills')
const ASSET_DIRS = ['agents', 'workflows', 'mappings', 'domains']
const ASSET_TREES = ['actors']

/**
 * Copy every YAML asset under the repository's `agentops/agents`,
 * `agentops/workflows`, and `agentops/mappings` directories into the runtime
 * catalogue. The mappings directory carries the tool and knowledge maps the
 * Agent permission matrix reads.
 *
 * @param {{ dshHome?: string, force?: boolean, dryRun?: boolean }} [options]
 * @returns {{ copied: string[], skipped: string[] }}
 */
export function seedAgentOps(options = {}) {
  const dshHome = options.dshHome?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const force = options.force ?? false
  const dryRun = options.dryRun ?? false
  const targetRoot = join(dshHome, 'agentops')
  const copied = []
  const skipped = []

  for (const relativeDir of ASSET_DIRS) {
    const sourceDir = join(assetRoot, relativeDir)
    if (!existsSync(sourceDir)) throw new Error(`缺少迁移资产目录：${sourceDir}`)
    const files = readdirSync(sourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
      .map(entry => entry.name)
      .sort()
    if (files.length === 0) throw new Error(`迁移资产目录为空：${sourceDir}`)

    const targetDir = join(targetRoot, relativeDir)
    if (!dryRun) mkdirSync(targetDir, { recursive: true })
    for (const file of files) {
      const relative = `${relativeDir}/${file}`
      const target = join(targetDir, file)
      if (existsSync(target) && !force) {
        skipped.push(relative)
        continue
      }
      if (!dryRun) copyFileSync(join(sourceDir, file), target)
      copied.push(relative)
    }
  }

  for (const relativeDir of ASSET_TREES) {
    const sourceDir = join(assetRoot, relativeDir)
    if (!existsSync(sourceDir)) throw new Error(`缺少迁移资产目录：${sourceDir}`)
    const entries = readdirSync(sourceDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    if (entries.length === 0) throw new Error(`迁移资产目录为空：${sourceDir}`)

    for (const entry of entries) {
      const sourceTree = join(sourceDir, entry)
      const files = readdirSync(sourceTree, { withFileTypes: true })
        .filter(item => item.isFile())
        .map(item => item.name)
        .sort()
      if (files.length === 0) throw new Error(`迁移资产目录为空：${sourceTree}`)

      const targetTree = join(targetRoot, relativeDir, entry)
      if (!dryRun) mkdirSync(targetTree, { recursive: true })
      for (const file of files) {
        const relative = `${relativeDir}/${entry}/${file}`
        const target = join(targetTree, file)
        if (existsSync(target) && !force) {
          skipped.push(relative)
          continue
        }
        if (!dryRun) copyFileSync(join(sourceTree, file), target)
        copied.push(relative)
      }
    }
  }

  const skillFiles = listFilesRecursive(skillsRoot)
  if (skillFiles.length === 0) throw new Error(`AgentOps skill 目录为空：${skillsRoot}`)
  const skillTargetRoot = join(targetRoot, 'skills')
  if (!dryRun) mkdirSync(skillTargetRoot, { recursive: true })
  for (const relative of skillFiles) {
    const target = join(skillTargetRoot, relative)
    const display = `skills/${relative.replaceAll('\\', '/')}`
    if (existsSync(target) && !force) {
      skipped.push(display)
      continue
    }
    if (!dryRun) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(skillsRoot, relative), target)
    }
    copied.push(display)
  }

  return { copied, skipped }
}

/** List regular files below a directory as sorted relative paths. */
function listFilesRecursive(root) {
  if (!existsSync(root)) throw new Error(`缺少 AgentOps skill 目录：${root}`)
  const files = []
  const visit = (relativeDir) => {
    const entries = readdirSync(join(root, relativeDir), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = join(relativeDir, entry.name)
      if (entry.isDirectory()) visit(relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  visit('')
  return files
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = seedAgentOps({
      dshHome: arg('--dsh-home'),
      force: process.argv.includes('--force'),
      dryRun: process.argv.includes('--dry-run'),
    })
    for (const file of result.copied) process.stdout.write(`${process.argv.includes('--dry-run') ? 'would seed' : 'seeded'}: ${file}\n`)
    for (const file of result.skipped) process.stdout.write(`skipped existing: ${file}\n`)
    process.stdout.write(`copied=${result.copied.length} skipped=${result.skipped.length}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
