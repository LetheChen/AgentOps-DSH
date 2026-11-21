/**
 * DSH plugin surface for the AgentOps knowledge base.
 *
 * Read/import-planning tools plus the LLM Wiki category, draft, check and
 * publish workflow. The same routes serve the browser workbench and the model.
 *
 * @module @agentops/dsh-knowledge/dsh
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { planImport, summarizePlan } from './import-plan.ts'
import type { ImportCandidate } from './import-plan.ts'
import { registerKnowledgeRoute, registerLintRoute, registerVaultRoutes, registerWikiRoutes } from './http.ts'
import { KnowledgeService } from './service.ts'
import { SqliteKnowledgeRepository } from './sqlite.ts'
import { WikiService } from './wiki-service.ts'
import type { CreateWikiDraftInput, WikiPageType, WikiSourceKind } from './wiki.ts'

export const name = 'agentops-knowledge'

/**
 * Root scope: the model surface is registered by `./tools.ts` inside a preset,
 * because `tools` is an Agent-scoped service.
 */
export const inject: string[] = []

/** Deployment configuration for the knowledge plugin. */
export interface KnowledgeConfig {
  /**
   * SQLite file holding spaces, documents and chunks. Omit it in a bundle and
   * let `resolveKnowledgeDbPath` pick the deployment default.
   */
  dbPath?: string
  /** Spaces this deployment may read; empty disables search. */
  readableSpaces: readonly string[]
  /** Roots an import plan may mention; empty rejects every candidate. */
  allowedImportRoots: readonly string[]
  /** Path prefix → space id, used to resolve an import target. */
  spaceMap?: Readonly<Record<string, string>>
  /** Default result cap for `knowledge_search`. Max 50. */
  defaultLimit?: number
}

/** Configuration used when the deployment names none: no readable space, no import root. */
export const DEFAULT_CONFIG: KnowledgeConfig = {
  readableSpaces: [],
  allowedImportRoots: [],
}

/**
 * Resolve the SQLite path for this host.
 *
 * Order: explicit config, then `AGENTOPS_KNOWLEDGE_DB`, then
 * `$DSH_HOME/agentops/knowledge.db` (falling back to `~/.dsh`).
 * @param config - deployment configuration.
 * @param env - process environment (injectable for tests).
 * @param home - `os.homedir()` replacement for tests.
 * @returns absolute or `:memory:` path.
 */
export function resolveKnowledgeDbPath(
  config: KnowledgeConfig = DEFAULT_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = config.dbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.AGENTOPS_KNOWLEDGE_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const dshHome = env.DSH_HOME?.trim() ?? join(home, '.dsh')
  return join(dshHome, 'agentops', 'knowledge.db')
}

/**
 * Build the model-facing search tool.
 * @param service - hydrated knowledge service.
 * @param config - readable spaces and default limit.
 * @returns the search tool definition handed to `ctx.tools.register`.
 */
export function createSearchTool(service: KnowledgeService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_search',
    description:
      'Search the AgentOps knowledge base and return passages with document, version and locator. '
      + 'Read-only. Cite results by chunkId/version; never invent a citation when a search returns nothing.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for; Chinese or English.' },
      limit: { type: 'integer', description: 'Max passages, 1-50. Defaults to the deployment cap.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chunkId: { type: 'string', required: true },
                documentId: { type: 'string', required: true },
                version: { type: 'integer', required: true },
                spaceId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                score: { type: 'number', required: true },
                locator: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start: { type: 'integer', required: true },
                    end: { type: 'integer', required: true },
                    page: { type: 'integer' },
                    section: { type: 'string' },
                  },
                },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? 'No passages found. Do not fabricate a citation; tell the user the knowledge base has no match.'
          : value.hits
            .map(hit => `[${hit.chunkId}] ${hit.spaceId}/${hit.documentId}@v${hit.version} (score ${hit.score})\n${hit.text}`)
            .join('\n\n'),
      }],
    },
    execute(args) {
      const limit = clampLimit(args.limit, config.defaultLimit ?? 10)
      const hits = service.search(args.query, service.readableSpaces(config.readableSpaces), limit)
      return Promise.resolve({
        hits: hits.map(hit => ({
          chunkId: hit.chunk.id,
          documentId: hit.chunk.documentId,
          version: hit.chunk.version,
          spaceId: hit.chunk.spaceId,
          text: hit.chunk.text,
          score: hit.score,
          locator: hit.chunk.locator,
        })),
        truncated: hits.length === limit,
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Search knowledge', kind: 'other', rawInput: args.query }),
  })
}

/**
 * Build the model-facing draft tool for LLM Wiki ingestion.
 * @param wiki - wiki workflow service.
 * @param config - readable spaces used by relation checks.
 * @returns the draft tool definition.
 */
export function createWikiDraftTool(wiki: WikiService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_wiki_draft',
    description:
      'Create a checked LLM Wiki draft from a task report, extracted document, or manual source. '
      + 'Reuse an existing category or provide a stable one-/two-segment category path; never create a new top-level knowledge space. '
      + 'The draft enters the review inbox with page type, category and conflict findings; publication is a separate step.',
    parameters: {
      title: { type: 'string', required: true, description: 'Page title.' },
      content: { type: 'string', required: true, description: 'Markdown source content.' },
      sourceKind: { type: 'string', required: true, description: 'task_report, manual, or archive.' },
      sourceRef: { type: 'string', description: 'Stable source reference such as task/report id.' },
      sourceTaskId: { type: 'string' },
      sourceReportId: { type: 'string' },
      pageType: { type: 'string', description: 'source, entity, concept, comparison, or overview.' },
      targetSpaceId: { type: 'string', description: 'Optional existing knowledge space id. Omit it to auto-classify into a built-in domain.' },
      categoryPath: { type: 'string', description: 'Optional category path. Omit it for automatic routing; flat domains always use the space root.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          pageType: { type: 'string', required: true },
          categoryPath: { type: 'string', required: true },
          conflicts: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Wiki draft ${value.draftId}: ${value.status} (${value.pageType}); ${value.conflicts.length} finding(s).`,
      }],
    },
    execute(args) {
      const input: CreateWikiDraftInput = {
        title: args.title,
        content: args.content,
        sourceKind: sourceKind(args.sourceKind),
        ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
        ...(args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId }),
        ...(args.sourceReportId === undefined ? {} : { sourceReportId: args.sourceReportId }),
        ...(args.pageType === undefined ? {} : { pageType: pageType(args.pageType) }),
        ...(args.targetSpaceId === undefined ? {} : { targetSpaceId: args.targetSpaceId }),
        ...(args.categoryPath === undefined ? {} : { categoryPath: args.categoryPath }),
      }
      const draft = wiki.createDraft(input, config.readableSpaces)
      return Promise.resolve({
        draftId: draft.id,
        status: draft.status,
        pageType: draft.pageType,
        categoryPath: draft.categoryPath,
        conflicts: draft.conflicts.map(conflict => ({ ...conflict })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Create LLM Wiki draft', kind: 'other' }),
  })
}

/**
 * Build the model-facing conflict-check tool.
 * @param wiki - wiki workflow service.
 * @param config - readable spaces used by relation checks.
 * @returns the check tool definition.
 */
export function createWikiCheckTool(wiki: WikiService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_wiki_check',
    description: 'Re-run structural, duplicate, sensitive-content and related-page checks for one LLM Wiki draft.',
    parameters: { draftId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          categoryPath: { type: 'string', required: true },
          conflicts: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Wiki draft ${value.draftId}: ${value.status}; ${value.conflicts.length} finding(s).` }],
    },
    execute(args) {
      const draft = wiki.checkDraft(args.draftId, config.readableSpaces)
      return Promise.resolve({
        draftId: draft.id,
        status: draft.status,
        categoryPath: draft.categoryPath,
        conflicts: draft.conflicts.map(conflict => ({ ...conflict })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Check LLM Wiki draft', kind: 'other' }),
  })
}

/**
 * Build the category listing tool used before drafting or publishing.
 * @param wiki - wiki workflow service.
 * @param config - readable spaces used to filter the returned directories.
 * @returns the category listing tool definition.
 */
export function createWikiCategoriesTool(wiki: WikiService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_wiki_categories',
    description:
      'List Agent-maintained category directories before filing a document. Reuse an existing path; create a new path only when none matches. '
      + 'Never create a new top-level knowledge space from an Agent.',
    parameters: {
      spaceId: { type: 'string', description: 'Optional knowledge space id to filter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          categories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                spaceId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                reviewStatus: { type: 'string', required: true },
                documentCount: { type: 'integer', required: true },
                draftCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.categories.length === 0
          ? 'No maintained categories found. Create one only inside an existing knowledge space.'
          : value.categories.map(item => `${item.spaceId}/${item.path} (${item.reviewStatus}, ${item.documentCount} doc, ${item.draftCount} draft)`).join('\n'),
      }],
    },
    execute(args) {
      const readable = new Set(wiki.readableSpaces(config.readableSpaces))
      const categories = wiki.snapshot().categories
        .filter(category => readable.has(category.spaceId) && (args.spaceId === undefined || category.spaceId === args.spaceId))
        .map(category => ({
          spaceId: category.spaceId,
          path: category.path,
          reviewStatus: category.reviewStatus,
          documentCount: category.documentCount,
          draftCount: category.draftCount,
        }))
      return Promise.resolve({ categories })
    },
    presentCall: () => ({ card: 'generic', title: 'List Wiki categories', kind: 'other' }),
  })
}

/**
 * Build the model-facing publication tool.
 * @param wiki - wiki workflow service.
 * @param config - readable spaces used by the final check.
 * @returns the publication tool definition.
 */
export function createWikiPublishTool(wiki: WikiService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_wiki_publish',
    description: 'Publish a ready LLM Wiki draft into a knowledge space as searchable Markdown. Blocking conflicts reject publication.',
    parameters: {
      draftId: { type: 'string', required: true },
      targetSpaceId: { type: 'string', required: true, description: 'Existing knowledge space that should receive the page.' },
      categoryPath: { type: 'string', description: 'Optional existing or automatically created category path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string', required: true },
          pageId: { type: 'string', required: true },
          documentId: { type: 'string', required: true },
          spaceId: { type: 'string', required: true },
          categoryPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Published wiki page ${value.pageId} as ${value.documentId} in ${value.spaceId}.` }],
    },
    execute(args) {
      const result = wiki.publishDraft(args.draftId, args.targetSpaceId, config.readableSpaces, args.categoryPath)
      return Promise.resolve({
        draftId: result.draft.id,
        pageId: result.page.id,
        documentId: result.page.documentId,
        spaceId: result.page.spaceId,
        categoryPath: result.page.categoryPath,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Publish LLM Wiki page', kind: 'other' }),
  })
}

/**
 * Build the import-planning tool. Planning only: it never copies a file.
 * @param service - used for existing hashes (duplicate detection).
 * @param config - authorized roots and space mapping.
 * @returns the import-planning tool definition handed to `ctx.tools.register`.
 */
export function createImportPlanTool(service: KnowledgeService, config: KnowledgeConfig): ToolDefinition {
  return defineTool({
    name: 'knowledge_import_plan',
    description:
      'Plan an import of legacy files into knowledge spaces without copying anything. '
      + 'Returns per-file action (import/duplicate/unsupported/too-large/outside-root/needs-mapping), '
      + 'sensitive-value findings and a summary. Use it to show the operator what would happen first.',
    parameters: {
      candidates: {
        type: 'array',
        required: true,
        description: 'Files reported by the scanner.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            size: { type: 'integer', required: true },
            mime: { type: 'string' },
            contentHash: { type: 'string' },
            sample: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          byAction: {
            type: 'object',
            additionalProperties: false,
            properties: {
              import: { type: 'integer', required: true },
              duplicate: { type: 'integer', required: true },
              unsupported: { type: 'integer', required: true },
              'too-large': { type: 'integer', required: true },
              'outside-root': { type: 'integer', required: true },
              'needs-mapping': { type: 'integer', required: true },
            },
          },
          sensitiveFiles: { type: 'integer', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                action: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                spaceId: { type: 'string' },
                contentHash: { type: 'string' },
                sensitive: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Import plan: ${value.total} file(s) — ${JSON.stringify(value.byAction)}; `
          + `${value.sensitiveFiles} file(s) contain sensitive values. Review before importing.`,
      }],
    },
    execute(args) {
      const plan = planImport(args.candidates as ImportCandidate[], {
        allowedRoots: config.allowedImportRoots,
        existingHashes: service.existingHashes(),
        ...(config.spaceMap === undefined ? {} : { spaceMap: config.spaceMap }),
      })
      const summary = summarizePlan(plan)
      return Promise.resolve({
        total: summary.total,
        byAction: summary.byAction,
        sensitiveFiles: summary.sensitiveFiles,
        entries: plan.map(entry => ({
          path: entry.path,
          action: entry.action,
          reason: entry.reason,
          ...(entry.spaceId === undefined ? {} : { spaceId: entry.spaceId }),
          ...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
          sensitive: [...entry.sensitive],
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Plan knowledge import', kind: 'other' }),
  })
}

/**
 * Mount the knowledge capability.
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - repository path and visibility policy.
 */
export function apply(ctx: Context, config: KnowledgeConfig = DEFAULT_CONFIG): void {
  const dbPath = resolveKnowledgeDbPath(config)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const repository = new SqliteKnowledgeRepository(dbPath)
  const service = KnowledgeService.open(repository)
  const wiki = new WikiService(service, repository)
  ctx.inject(['connection'], (connectionCtx) => {
    registerKnowledgeRoute(connectionCtx, service, config.readableSpaces)
    registerVaultRoutes(connectionCtx, service, config.readableSpaces)
    registerLintRoute(connectionCtx, service, config.readableSpaces)
    registerWikiRoutes(connectionCtx, wiki, config.readableSpaces)
  })
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), 50)
}

function sourceKind(value: string): WikiSourceKind {
  if (value === 'task_report' || value === 'manual' || value === 'archive') return value
  throw new Error('sourceKind must be task_report, manual or archive')
}

function pageType(value: string): WikiPageType {
  if (value === 'source' || value === 'entity' || value === 'concept' || value === 'comparison' || value === 'overview') return value
  throw new Error('pageType must be source, entity, concept, comparison or overview')
}
