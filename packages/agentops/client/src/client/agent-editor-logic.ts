/** Mapping between Agent form fields, editor tabs, and localized API failures. */

import {
  AgentBadRequestError,
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
} from './agent-catalogue-api.js'
import type { AgentDraftField, AgentDraftIssue } from './agent-form.js'

/** Tabs exposed by the Agent editor. */
export type AgentEditorTab = 'identity' | 'responsibility' | 'permissions' | 'knowledge' | 'runtime'

/** Localized error keys available to Agent operations. */
export type AgentErrorKey =
  | 'error.badRequest'
  | 'error.notFound'
  | 'error.conflict'
  | 'error.server'
  | 'error.validation'
  | 'error.generic'

const TAB_ORDER: readonly AgentEditorTab[] = [
  'identity',
  'responsibility',
  'permissions',
  'knowledge',
  'runtime',
]

/**
 * Resolve the tab that owns a form field.
 * @param field - field named by a local or host validation issue.
 * @returns the editor tab that displays the field.
 */
export function tabForAgentField(field: AgentDraftField): AgentEditorTab {
  switch (field) {
    case 'agentId':
    case 'displayName':
    case 'domain':
    case 'harness':
    case 'tier':
    case 'modelProvider':
    case 'modelId':
    case 'form':
      return 'identity'
    case 'description':
    case 'systemPrompt':
      return 'responsibility'
    case 'tools':
      return 'permissions'
    case 'knowledgeBases':
      return 'knowledge'
    case 'timeoutSeconds':
    case 'maxConcurrentRuns':
    case 'costLimitPerRun':
    case 'outputFiles':
      return 'runtime'
  }
}

/**
 * Resolve a host issue path to the closest editable field.
 * @param path - camelCase or snake_case path returned by the host.
 * @returns the editable field, or `form` when no field matches.
 */
export function fieldForHostIssuePath(path: string): AgentDraftField {
  const normalized = path.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.includes('allowedtools') || normalized.includes('deniedtools')) return 'tools'
  if (normalized.includes('knowledgebase')) return 'knowledgeBases'
  if (normalized.includes('timeoutsecond')) return 'timeoutSeconds'
  if (normalized.includes('maxconcurrentrun')) return 'maxConcurrentRuns'
  if (normalized.includes('costlimitperrun')) return 'costLimitPerRun'
  if (normalized.includes('outputfile')) return 'outputFiles'
  if (normalized.includes('systemprompt')) return 'systemPrompt'
  if (normalized.includes('displayname') || normalized.endsWith('name')) return 'displayName'
  if (normalized.includes('modelprovider')) return 'modelProvider'
  if (normalized.includes('modelid')) return 'modelId'
  if (normalized.includes('agentid')) return 'agentId'
  if (normalized.includes('description')) return 'description'
  if (normalized.includes('domain')) return 'domain'
  if (normalized.includes('harness')) return 'harness'
  if (normalized.includes('tier')) return 'tier'
  if (normalized.includes('permission') || normalized.includes('tool')) return 'tools'
  if (normalized.includes('model')) return 'modelId'
  return 'form'
}

/**
 * Convert host issue paths into the editor's localized field issues.
 * Host messages and paths remain internal and are never rendered.
 * @param issues - validation issues returned by the host.
 * @returns one `hostRejected` issue per affected field.
 */
export function hostIssuesForDraft(
  issues: readonly { readonly path: string }[],
): readonly AgentDraftIssue[] {
  return issues.map(issue => ({
    field: fieldForHostIssuePath(issue.path),
    code: 'hostRejected',
  }))
}

/**
 * Find the first tab in display order that contains an issue.
 * @param issues - local and host issues currently attached to the form.
 * @returns the first affected tab, or `identity` when there are no issues.
 */
export function firstIssueTab(issues: readonly AgentDraftIssue[]): AgentEditorTab {
  for (const tab of TAB_ORDER) {
    if (issues.some(issue => tabForAgentField(issue.field) === tab)) return tab
  }
  return 'identity'
}

/**
 * Select a localized copy key without exposing a host error message.
 * @param reason - rejection from an Agent API operation.
 * @returns the localized error key for the rejection class.
 */
export function agentErrorKey(reason: unknown): AgentErrorKey {
  if (reason instanceof AgentBadRequestError) return 'error.badRequest'
  if (reason instanceof AgentNotFoundError) return 'error.notFound'
  if (reason instanceof AgentConflictError) return 'error.conflict'
  if (reason instanceof AgentValidationError) return 'error.validation'
  if (reason instanceof Error && reason.name === 'AgentServerError') return 'error.server'
  return 'error.generic'
}
