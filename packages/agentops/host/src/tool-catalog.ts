/**
 * Tool catalogue for the Agent permission matrix.
 *
 * Reads the migrated `agentops/mappings/tool-map.yaml`: the legacy tool
 * catalogue (display name, description, allowed domains, approval) plus the
 * DSH equivalent of every tool. The runtime tool registry is Agent-scoped, so
 * the catalogue cannot be enumerated through `ctx.tools` at root scope; this
 * file is the deployment's declared tool surface.
 *
 * @module @agentops/dsh-host/tool-catalog
 */

import { readFileSync } from 'node:fs'

import { load } from 'js-yaml'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** One tool offered by the Agent permission matrix. */
export interface ToolCatalogEntry {
  /** Legacy tool id stored in `allowed_tools` / `denied_tools`. */
  readonly id: string
  /** Human-readable label. */
  readonly displayName: string
  /** What the tool does. */
  readonly description: string
  /** Legacy business domains the tool was restricted to. */
  readonly allowedDomains: readonly string[]
  /** Whether the legacy tool required human approval before running. */
  readonly requiresHumanApproval: boolean
  /** Whether a DSH equivalent exists. */
  readonly migrated: boolean
  /** Plugin package registering the DSH equivalent, when migrated. */
  readonly mappedPlugin?: string
  /** Tool name inside the plugin, when migrated. */
  readonly mappedTool?: string
  /** Why the tool has no DSH equivalent, when it has none. */
  readonly note?: string
}

/** The tool catalogue read from one mapping file. */
export interface ToolCatalog {
  /** File the catalogue was read from. */
  readonly file: string
  /** Whether the file was missing. */
  readonly missing: boolean
  /** Tools sorted by id. */
  readonly tools: readonly ToolCatalogEntry[]
}

/**
 * Read the tool catalogue.
 *
 * A missing file yields an empty catalogue plus `missing: true`; the page says
 * the catalogue is not deployed instead of showing an empty permission list.
 * Unreadable or malformed YAML yields an empty catalogue without
 * `missing`, so the page reports an empty catalogue instead of claiming the
 * deployment is missing.
 * @param file - path to `tool-map.yaml`.
 * @returns the catalogue entries, and whether the file was missing.
 */
export function readToolCatalog(file: string): ToolCatalog {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, missing: true, tools: [] }
  }

  let parsed: unknown
  try {
    parsed = load(text)
  } catch {
    return { file, missing: false, tools: [] }
  }
  const tools = isRecord(parsed) ? parsed.tools : undefined
  if (!isRecord(tools)) {
    return { file, missing: false, tools: [] }
  }

  const entries: ToolCatalogEntry[] = []
  for (const [id, raw] of Object.entries(tools)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const mapped = readMapped(record.mapped)
    const note = readString(record.note)
    entries.push({
      id,
      displayName: readString(record.display_name) ?? id,
      description: readString(record.description) ?? '',
      allowedDomains: readStringList(record.allowed_domains),
      requiresHumanApproval: record.requires_human_approval === true,
      migrated: mapped !== undefined,
      ...(mapped === undefined ? {} : { mappedPlugin: mapped.plugin, mappedTool: mapped.tool }),
      ...(note === undefined ? {} : { note }),
    })
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return { file, missing: false, tools: entries }
}

/**
 * Register `GET /api/agentops/tools`.
 * @param ctx - context carrying Connection.
 * @param file - tool mapping file path.
 */
export function registerToolCatalogRoute(ctx: Context, file: string): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/tools',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify(readToolCatalog(file)), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  }), 'agentops-system: /api/agentops/tools')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readMapped(value: unknown): { plugin: string; tool: string } | undefined {
  if (!isRecord(value)) return undefined
  const record = value
  const plugin = readString(record.plugin)
  const tool = readString(record.tool)
  if (plugin === undefined || tool === undefined) return undefined
  return { plugin, tool }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
