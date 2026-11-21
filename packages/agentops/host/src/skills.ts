/**
 * Agent skill catalog and installation routes.
 *
 * The catalog comes from the live `ctx.skills` provider registry, while
 * installation is constrained to one managed directory. Built-in skills can be
 * disabled but never deleted; installed directories can be removed.
 *
 * @module @agentops/dsh-host/skills
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import { load } from 'js-yaml'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isSkillName, type SkillRegistry } from '@deepseek-ai/dsh-skill'

/** Skill-center deployment configuration. */
export interface SkillCenterConfig {
  /** Directory receiving installed skill bundles. */
  readonly managedDir: string
  /** JSON file containing disabled skill names. */
  readonly disabledFile: string
  /** Maximum downloaded archive size. */
  readonly maxArchiveBytes?: number
}

/** Browser-facing skill row. */
export interface ManagedSkill {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
  readonly path: string | null
  readonly installed: boolean
  readonly disabled: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

interface SkillFrontmatter {
  readonly name: string
  readonly description: string
}

/**
 * Read the disabled-name file. Missing means none.
 * @param file - JSON file path.
 * @returns disabled names.
 */
export function readDisabledSkills(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed) && (parsed === null || typeof parsed !== 'object')) {
      throw new Error('disabled skills must be an array or {"skills": [...]}')
    }
    const values = Array.isArray(parsed) ? parsed : (parsed as { skills?: unknown }).skills
    if (!Array.isArray(values)) throw new Error('disabled skills must contain a skills array')
    const names = values.filter((value): value is string => typeof value === 'string' && isSkillName(value))
    if (names.length !== values.length) throw new Error('disabled skills contains an invalid name')
    return new Set(names)
  } catch (error) {
    if (isMissing(error)) return new Set()
    throw error
  }
}

/**
 * Write disabled names atomically.
 * @param file - JSON file path.
 * @param names - the skill names to disable.
 */
export function writeDisabledSkills(file: string, names: Iterable<string>): void {
  const values = [...new Set(names)].filter(isSkillName).sort()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ skills: values }, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

/**
 * Project live skills plus disabled state into rows safe for the browser.
 * @param skills - the live skill registry to project.
 * @param config - the managed directory and the disabled-name file.
 * @returns the browser-facing rows and the paths they were read from.
 */
export async function listManagedSkills(
  skills: Pick<SkillRegistry, 'snapshot'>,
  config: SkillCenterConfig,
): Promise<{ skills: ManagedSkill[]; managedDir: string; disabledFile: string }> {
  const snapshot = await skills.snapshot({ cwd: process.cwd() })
  const disabled = readDisabledSkills(config.disabledFile)
  const root = resolve(config.managedDir)
  const merged = new Map<string, ManagedSkill>()
  for (const skill of snapshot.skills) {
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      provider: skill.provider,
      path: skill.path ?? null,
      installed: skill.path !== undefined && isInside(root, skill.path),
      disabled: disabled.has(skill.name),
      modelInvocable: skill.invocation.modelInvocable && !disabled.has(skill.name),
      userInvocable: skill.invocation.userInvocable && !disabled.has(skill.name),
    })
  }
  for (const skill of scanLocalSkills(config)) {
    const isDisabled = disabled.has(skill.name)
    merged.set(skill.name, { ...skill, disabled: isDisabled, modelInvocable: !isDisabled, userInvocable: !isDisabled })
  }
  return {
    managedDir: root,
    disabledFile: config.disabledFile,
    skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function scanLocalSkills(config: SkillCenterConfig): ManagedSkill[] {
  const project = process.cwd()
  const roots: { path: string; source: string }[] = [
    { path: join(project, '.dsh', 'skills'), source: 'project-dsh' },
    { path: join(project, '.agents', 'skills'), source: 'project-agents' },
    { path: join(project, 'packages', 'agentops', 'skills'), source: 'bundled' },
    { path: resolve(config.managedDir), source: 'custom' },
    { path: join(resolveDshHome(), 'skills'), source: 'user-dsh' },
    { path: join(resolveAgentsHome(), 'skills'), source: 'user-agents' },
  ]
  const managed = resolve(config.managedDir)
  const result: ManagedSkill[] = []
  for (const root of roots) {
    if (!existsSync(root.path)) continue
    for (const entry of readdirSync(root.path, { withFileTypes: true })) {
      const path = entry.isDirectory()
        ? join(root.path, entry.name, 'SKILL.md')
        : entry.isFile() && entry.name.endsWith('.md')
          ? join(root.path, entry.name)
          : undefined
      if (path === undefined || !existsSync(path)) continue
      try {
        const frontmatter = readSkillFrontmatter(path)
        result.push({
          name: frontmatter.name,
          description: frontmatter.description,
          source: root.source,
          provider: 'filesystem',
          path,
          installed: isInside(managed, path),
          disabled: false,
          modelInvocable: true,
          userInvocable: true,
        })
      } catch {
        // Invalid skills are omitted from the management table; the provider reports discovery failures.
      }
    }
  }
  return result
}

/**
 * Install one skill from a GitHub repository/archive or HTTPS zip URL.
 *
 * The archive is extracted in a temporary directory, exactly one SKILL.md is
 * selected (or the requested name/subdirectory resolves it), and only that
 * directory is copied into the managed root.
 * @param source - HTTPS GitHub repository or zip URL.
 * @param config - managed directory and limits.
 * @param options - optional ref, skill name, subdirectory, and replacement flag.
 * @returns installed frontmatter and destination.
 */
export async function installSkill(
  source: string,
  config: SkillCenterConfig,
  options: { readonly ref?: string; readonly skillName?: string; readonly subdir?: string; readonly replace?: boolean } = {},
): Promise<{ name: string; description: string; directory: string; sourceUrl: string }> {
  validateSource(source)
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentops-skill-'))
  try {
    const { url, ref } = normalizeSource(source, options.ref)
    const archive = await downloadArchive(url, config.maxArchiveBytes ?? 20 * 1024 * 1024)
    const archivePath = join(tempRoot, 'skill.zip')
    writeFileSync(archivePath, archive)
    const extracted = join(tempRoot, 'extracted')
    mkdirSync(extracted)
    await extractZip(archivePath, { dir: extracted })

    const found = findSkillDirectories(extracted, options.subdir)
    const selected = selectSkillDirectory(found, options.skillName)
    const frontmatter = readSkillFrontmatter(join(selected, 'SKILL.md'))
    if (options.skillName !== undefined && options.skillName !== frontmatter.name) {
      throw new Error(`requested skill ${options.skillName} does not match frontmatter ${frontmatter.name}`)
    }
    const destination = join(resolve(config.managedDir), frontmatter.name)
    if (existsSync(destination) && options.replace !== true) {
      throw new Error(`skill ${frontmatter.name} already exists; delete it first or request replacement`)
    }
    mkdirSync(resolve(config.managedDir), { recursive: true })
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
    cpSync(selected, destination, { recursive: true, errorOnExist: true, force: false })
    return { ...frontmatter, directory: destination, sourceUrl: url + (ref === undefined ? '' : `#${ref}`) }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Delete one installed skill directory. Built-in skills are not removable.
 * @param skills - the listed skills to find the target in.
 * @param config - the managed directory and the disabled-name file.
 * @param name - the skill name to delete.
 */
export function deleteInstalledSkill(
  skills: readonly { readonly name: string; readonly path?: string | null }[],
  config: SkillCenterConfig,
  name: string,
): void {
  if (!isSkillName(name)) throw new Error('invalid skill name')
  const skill = skills.find(item => item.name === name)
  if (skill?.path == null) throw new Error(`skill ${name} is not installed on disk`)
  const root = resolve(config.managedDir)
  const directory = dirname(resolve(skill.path))
  if (!isInside(root, directory)) throw new Error(`skill ${name} is built in and cannot be deleted`)
  rmSync(directory, { recursive: true, force: true })
  writeDisabledSkills(config.disabledFile, [...readDisabledSkills(config.disabledFile)].filter(item => item !== name))
}

function validateSource(source: string): void {
  let url: URL
  try { url = new URL(source) } catch { throw new Error('source must be an HTTPS URL') }
  if (url.protocol !== 'https:') throw new Error('source must use HTTPS')
}

function normalizeSource(source: string, requestedRef?: string): { url: string; ref?: string } {
  const url = new URL(source)
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) throw new Error('GitHub source must name owner/repository')
    const owner = parts[0] ?? ''
    const repo = (parts[1] ?? '').replace(/\.git$/, '')
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid GitHub repository')
    const ref = requestedRef ?? (parts[2] === 'tree' && parts[3] !== undefined ? parts[3] : 'main')
    return { url: `https://github.com/${owner}/${repo}/archive/${encodeURIComponent(ref)}.zip`, ref }
  }
  if (!url.pathname.toLowerCase().endsWith('.zip')) throw new Error('non-GitHub source must be a .zip URL')
  return { url: url.toString() }
}

async function downloadArchive(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`archive exceeds ${maxBytes} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error(`archive exceeds ${maxBytes} bytes`)
  return bytes
}

function findSkillDirectories(current: string, subdir?: string, depth = 0): string[] {
  if (depth > 5) return []
  const target = subdir === undefined ? current : join(current, subdir)
  if (!existsSync(target)) throw new Error(`subdirectory not found: ${subdir}`)
  const found: string[] = []
  if (existsSync(join(target, 'SKILL.md'))) found.push(target)
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX' || entry.name === '.git' || entry.name === 'node_modules') continue
    found.push(...findSkillDirectories(join(target, entry.name), undefined, depth + 1))
  }
  return [...new Set(found)]
}

function selectSkillDirectory(found: readonly string[], requestedName?: string): string {
  if (requestedName !== undefined) {
    const match = found.find(directory => readSkillFrontmatter(join(directory, 'SKILL.md')).name === requestedName)
    if (match === undefined) throw new Error(`skill ${requestedName} not found in archive`)
    return match
  }
  if (found.length === 0) throw new Error('archive contains no SKILL.md')
  if (found.length > 1) throw new Error(`archive contains multiple skills: ${found.map(item => basename(item)).join(', ')}; provide skillName`)
  const skill = found[0]
  if (skill === undefined) throw new Error('archive contains no SKILL.md')
  return skill
}

function readSkillFrontmatter(file: string): SkillFrontmatter {
  const text = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) throw new Error('SKILL.md has no YAML frontmatter')
  const data = load(match[1] ?? '') as { name?: unknown; description?: unknown } | undefined
  if (typeof data?.name !== 'string' || !isSkillName(data.name)) throw new Error('SKILL.md name must be kebab-case')
  if (typeof data.description !== 'string' || data.description.trim() === '') throw new Error('SKILL.md description is required')
  return { name: data.name, description: data.description.trim() }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Register the skill management routes.
 * @param ctx - the plugin context owning the connection.
 * @param skills - the live skill registry.
 * @param config - the managed directory and the disabled-name file.
 */
export function registerSkillsRoutes(ctx: Context, skills: SkillRegistry, config: SkillCenterConfig): void {
  const routes = [
    { path: '/api/agentops/skills', handler: skillListHandler(skills, config) },
    { path: '/api/agentops/skills/install', handler: skillInstallHandler(config) },
    { path: '/api/agentops/skills/toggle', handler: skillToggleHandler(config) },
    { path: '/api/agentops/skills/delete', handler: skillDeleteHandler(skills, config) },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route.handler,
    }), `agentops-skills: ${route.path}`)
  }
}

function skillListHandler(skills: Pick<SkillRegistry, 'snapshot'>, config: SkillCenterConfig) {
  return async (): Promise<Response> => json(200, await listManagedSkills(skills, config))
}

function skillInstallHandler(config: SkillCenterConfig) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request)
      const ref = optionalString(body, 'ref')
      const skillName = optionalString(body, 'skill_name')
      const subdir = optionalString(body, 'subdir')
      const result = await installSkill(stringField(body, 'source'), config, {
        ...(ref === undefined ? {} : { ref }),
        ...(skillName === undefined ? {} : { skillName }),
        ...(subdir === undefined ? {} : { subdir }),
        replace: body.replace === true,
      })
      return json(200, { installed: result })
    } catch (error) {
      return json(400, { error: { code: 'skill_install_failed', message: messageOf(error) } })
    }
  }
}

function skillToggleHandler(config: SkillCenterConfig) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request)
      const name = stringField(body, 'name')
      if (!isSkillName(name)) throw new Error('invalid skill name')
      const disabled = readDisabledSkills(config.disabledFile)
      if (body.disabled === true) {
        disabled.add(name)
      } else {
        disabled.delete(name)
      }
      writeDisabledSkills(config.disabledFile, disabled)
      return json(200, { ok: true, name, disabled: disabled.has(name) })
    } catch (error) {
      return json(400, { error: { code: 'skill_toggle_failed', message: messageOf(error) } })
    }
  }
}

function skillDeleteHandler(skills: SkillRegistry, config: SkillCenterConfig) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request)
      const name = stringField(body, 'name')
      const listed = (await listManagedSkills(skills, config)).skills
      deleteInstalledSkill(listed, config, name)
      return json(200, { ok: true, name })
    } catch (error) {
      return json(400, { error: { code: 'skill_delete_failed', message: messageOf(error) } })
    }
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = await request.json() } catch { throw new Error('request body must be JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key)
  if (value === undefined || value === '') throw new Error(`${key} is required`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value.trim()
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
