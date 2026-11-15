/**
 * Read-only routes for the business-domain registry and the Actor whitelist.
 *
 * The Agent catalogue lives in `agents.ts`; these two registries are separate
 * assets with separate directories. A missing directory is an empty registry,
 * and an invalid file stays visible as an entry with its issues, so a broken
 * file never disappears from the page.
 *
 * @module @agentops/dsh-host/catalog
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadActorVisualProfile,
  loadDomainDefinition,
  type ActorVisualProfile,
  type DomainDefinition,
} from '@agentops/dsh-contracts'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** One business domain as the Agent editor sees it. */
export interface DomainSummary {
  readonly domain: string
  readonly displayName: string
  readonly description: string
  readonly defaultAllowedTools: readonly string[]
  readonly defaultDeniedTools: readonly string[]
  readonly defaultKnowledgeBases: readonly string[]
  readonly costLimitPerRun: number
  readonly valid: boolean
  readonly issues: readonly string[]
}

/** One Actor surface view as the collaboration page sees it. */
export interface ActorViewSummary {
  readonly viewId: string
  readonly outputContract: string
  readonly description: string
  readonly requiredPhases: readonly string[]
  readonly fieldCount: number
}

/** One Actor as the collaboration page sees it. */
export interface ActorSummary {
  readonly actorId: string
  readonly description: string
  readonly views: readonly ActorViewSummary[]
  readonly valid: boolean
  readonly issues: readonly string[]
}

/** A directory scan result. A missing directory is an empty, valid registry. */
export interface RegistryScan<T> {
  readonly dir: string
  readonly entries: readonly T[]
  readonly missing: boolean
}

/**
 * Scan one directory of business-domain YAML files.
 * @param dir - directory holding `*.yaml` domain definitions.
 * @returns domain rows and whether the directory exists.
 */
export function scanDomains(dir: string): RegistryScan<DomainSummary> {
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()
  } catch {
    return { dir, entries: [], missing: true }
  }

  const entries = files.map((fileName) => {
    let source: string
    try {
      source = readFileSync(join(dir, fileName), 'utf8')
    } catch {
      return invalidDomain(fileName, ['无法读取业务域文件'])
    }
    const parsed = loadDomainDefinition(source)
    if (!parsed.ok) return invalidDomain(fileName, parsed.issues.map(issue => issue.message))
    return domainSummary(parsed.value, parsed.issues.map(issue => issue.message))
  })
  return { dir, entries, missing: false }
}

/**
 * Scan one directory of Actor visual profiles.
 *
 * Each Actor owns a subdirectory that holds `actor_visual_profile.json`.
 * @param dir - directory holding one subdirectory per Actor.
 * @returns Actor rows and whether the directory exists.
 */
export function scanActors(dir: string): RegistryScan<ActorSummary> {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return { dir, entries: [], missing: true }
  }

  const entries: ActorSummary[] = []
  for (const name of names) {
    const path = join(dir, name, 'actor_visual_profile.json')
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      entries.push(invalidActor(name, ['无法读取 Actor Profile']))
      continue
    }
    const parsed = loadActorVisualProfile(source)
    if (!parsed.ok) {
      entries.push(invalidActor(name, parsed.issues.map(issue => issue.message)))
      continue
    }
    entries.push(actorSummary(parsed.value, parsed.issues.map(issue => issue.message)))
  }
  return { dir, entries, missing: false }
}

/**
 * Register the read-only registry routes.
 * @param ctx - context carrying Connection.
 * @param domainDir - directory holding business-domain YAML files.
 * @param actorDir - directory holding Actor visual profiles.
 */
export function registerCatalogRoutes(ctx: Context, domainDir: string, actorDir: string): void {
  if (domainDir.length > 0) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/agentops/domain-registry',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response(JSON.stringify({ domains: scanDomains(domainDir).entries }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    }), 'agentops-system: GET /api/agentops/domain-registry')
  }

  if (actorDir.length > 0) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/agentops/actors',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json({ actors: scanActors(actorDir).entries }),
    }), 'agentops-system: GET /api/agentops/actors')
  }
}

function domainSummary(definition: DomainDefinition, issues: readonly string[]): DomainSummary {
  return {
    domain: definition.domain,
    displayName: definition.displayName,
    description: definition.description,
    defaultAllowedTools: definition.defaultPermissions.allowedTools,
    defaultDeniedTools: definition.defaultPermissions.deniedTools,
    defaultKnowledgeBases: definition.defaultKnowledgeBases,
    costLimitPerRun: definition.costLimitPerRun,
    valid: true,
    issues,
  }
}

function invalidDomain(fileName: string, issues: readonly string[]): DomainSummary {
  const domain = fileName.replace(/\.yaml$/, '')
  return {
    domain,
    displayName: domain,
    description: '',
    defaultAllowedTools: [],
    defaultDeniedTools: [],
    defaultKnowledgeBases: [],
    costLimitPerRun: 0,
    valid: false,
    issues,
  }
}

function actorSummary(profile: ActorVisualProfile, issues: readonly string[]): ActorSummary {
  return {
    actorId: profile.actorId,
    description: profile.description,
    views: profile.allowedSurfaceViews.map(view => ({
      viewId: view.viewId,
      outputContract: view.outputContract,
      description: view.description,
      requiredPhases: view.requiredPhases,
      fieldCount: Object.keys(view.fields).length,
    })),
    valid: true,
    issues,
  }
}

function invalidActor(name: string, issues: readonly string[]): ActorSummary {
  return {
    actorId: name,
    description: '',
    views: [],
    valid: false,
    issues,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
