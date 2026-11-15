/**
 * Editable Agent form model and validation shared by the catalogue drawer.
 *
 * Numeric values stay as strings while the user edits them so intermediate
 * input is not silently normalized or lost. Conversion to the API record runs
 * only after validation succeeds.
 *
 * @module @agentops/dsh-client/agent-form
 */

import { isRelativeArtifactPath, isSafeAgentId } from '@agentops/dsh-contracts'

import type {
  AgentExecution,
  AgentHarness,
  AgentRecord,
  AgentTier,
  ExecutionBackend,
} from './agent-catalogue-api.js'

/** Tool access state exposed by the editor. */
export type AgentToolPolicy = 'allowed' | 'denied' | 'default'

/** Editable artifact output row. */
export interface AgentOutputFileDraft {
  /** Stable React list key; never persisted. */
  readonly key: string
  readonly port: string
  readonly path: string
}

/** Every editable field in the Agent editor. */
export interface AgentDraft {
  readonly agentId: string
  readonly displayName: string
  readonly domain: string
  readonly description: string
  readonly harness: AgentHarness
  readonly executionBackend: ExecutionBackend
  readonly tier: AgentTier
  readonly modelMode: 'auto' | 'explicit'
  readonly modelProvider: string
  readonly modelId: string
  readonly systemPrompt: string
  /**
   * Declared execution mode and owned workflow.
   *
   * They are carried through the draft so an edit that does not touch them
   * cannot silently demote a workflow Agent to `skill` and drop its workflow;
   * the YAML remains the place where they are authored.
   */
  readonly execution: AgentExecution
  readonly workflow: string
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
  readonly knowledgeBases: readonly string[]
  readonly timeoutSeconds: string
  readonly maxConcurrentRuns: string
  readonly costUnlimited: boolean
  readonly costLimitPerRun: string
  readonly outputFiles: readonly AgentOutputFileDraft[]
}

/** Field addressed by a local or host validation issue. */
export type AgentDraftField =
  | 'agentId'
  | 'displayName'
  | 'domain'
  | 'description'
  | 'systemPrompt'
  | 'harness'
  | 'tier'
  | 'modelProvider'
  | 'modelId'
  | 'timeoutSeconds'
  | 'maxConcurrentRuns'
  | 'costLimitPerRun'
  | 'knowledgeBases'
  | 'outputFiles'
  | 'tools'
  | 'form'

/** Stable issue codes translated by the render surface. */
export type AgentDraftIssueCode =
  | 'required'
  | 'invalidAgentId'
  | 'modelProviderRequired'
  | 'modelIdRequired'
  | 'positiveInteger'
  | 'nonNegativeNumber'
  | 'outputPortRequired'
  | 'outputPathRequired'
  | 'duplicateOutputPort'
  | 'invalidOutputPath'
  | 'overlappingTools'
  | 'hostRejected'

/** One validation problem attached to an editor field. */
export interface AgentDraftIssue {
  readonly field: AgentDraftField
  readonly code: AgentDraftIssueCode
  readonly detail?: string
}

/** Non-fatal issue returned by the host with a successful write. */
export interface AgentDraftNotice {
  readonly path: string
  readonly message: string
}

const HARNESSES: readonly AgentHarness[] = [
  'local_llm',
  'claude_sdk',
  'codex',
  'opencode',
  'deterministic',
]

const TIERS: readonly AgentTier[] = ['T0', 'T1', 'T2', 'T3']

function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

function normalizedTools(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(value => value.trim()).filter(value => value !== ''))]
}

function isPositiveInteger(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0
}

function isNonNegativeNumber(value: string): boolean {
  if (value.trim() === '') return false
  const number = Number(value)
  return Number.isFinite(number) && number >= 0
}

function isHarness(value: string): value is AgentHarness {
  return HARNESSES.some(item => item === value)
}

function isTier(value: string): value is AgentTier {
  return TIERS.some(item => item === value)
}

/**
 * Create the explicit defaults for a new Agent.
 * @returns an empty T2 Agent draft.
 */
export function emptyAgentDraft(): AgentDraft {
  return {
    agentId: '',
    displayName: '',
    domain: '',
    description: '',
    harness: 'local_llm',
    executionBackend: 'auto',
    tier: 'T2',
    modelMode: 'auto',
    modelProvider: '',
    modelId: '',
    systemPrompt: '',
    execution: 'skill',
    workflow: '',
    allowedTools: [],
    deniedTools: [],
    knowledgeBases: [],
    timeoutSeconds: '',
    maxConcurrentRuns: '',
    costUnlimited: false,
    costLimitPerRun: '',
    outputFiles: [],
  }
}

/**
 * Convert a complete API record into an editable draft without dropping fields.
 * @param record - the loaded Agent definition.
 * @returns a draft preserving every persisted value.
 */
export function agentRecordToDraft(record: AgentRecord): AgentDraft {
  return {
    agentId: record.agentId,
    displayName: record.displayName,
    domain: record.domain,
    description: record.description ?? '',
    harness: record.harness,
    executionBackend: record.executionBackend,
    tier: record.tier,
    modelMode: record.model === 'auto' ? 'auto' : 'explicit',
    modelProvider: record.model === 'auto' ? '' : record.model.provider,
    modelId: record.model === 'auto' ? '' : record.model.id,
    systemPrompt: record.systemPrompt ?? '',
    execution: record.execution,
    workflow: record.workflow ?? '',
    allowedTools: [...record.permissions.allowedTools],
    deniedTools: [...record.permissions.deniedTools],
    knowledgeBases: [...(record.knowledgeBases ?? [])],
    timeoutSeconds: record.timeoutSeconds === undefined ? '' : String(record.timeoutSeconds),
    maxConcurrentRuns: record.maxConcurrentRuns === undefined ? '' : String(record.maxConcurrentRuns),
    costUnlimited: record.costLimitPerRun === null,
    costLimitPerRun: record.costLimitPerRun == null ? '' : String(record.costLimitPerRun),
    outputFiles: Object.entries(record.outputFiles).map(([port, path]) => ({ key: `output:${port}`, port, path })),
  }
}

/**
 * Resolve a tool's current access state.
 * @param draft - current editor draft.
 * @param toolId - tool identifier to inspect.
 * @returns `allowed`, `denied`, or `default`.
 */
export function toolPolicyFor(draft: AgentDraft, toolId: string): AgentToolPolicy {
  const id = toolId.trim()
  if (draft.allowedTools.includes(id)) return 'allowed'
  if (draft.deniedTools.includes(id)) return 'denied'
  return 'default'
}

/**
 * Apply one tool policy, removing the identifier from the opposite list.
 * @param draft - current editor draft.
 * @param toolId - tool identifier to update.
 * @param policy - requested three-state policy.
 * @returns a draft with one mutually exclusive tool state.
 */
export function setToolPolicy(
  draft: AgentDraft,
  toolId: string,
  policy: AgentToolPolicy,
): AgentDraft {
  const id = toolId.trim()
  if (id === '') return draft
  const allowed = draft.allowedTools.filter(item => item !== id)
  const denied = draft.deniedTools.filter(item => item !== id)
  return {
    ...draft,
    allowedTools: policy === 'allowed' ? [...allowed, id] : allowed,
    deniedTools: policy === 'denied' ? [...denied, id] : denied,
  }
}

/**
 * Add a knowledge-base identifier once.
 * @param draft - current editor draft.
 * @param value - identifier to append.
 * @returns a draft with a trimmed unique identifier.
 */
export function addKnowledgeBase(draft: AgentDraft, value: string): AgentDraft {
  const id = value.trim()
  if (id === '' || draft.knowledgeBases.includes(id)) return draft
  return { ...draft, knowledgeBases: [...draft.knowledgeBases, id] }
}

/**
 * Remove a knowledge-base identifier.
 * @param draft - current editor draft.
 * @param value - identifier to remove.
 * @returns a draft without the identifier.
 */
export function removeKnowledgeBase(draft: AgentDraft, value: string): AgentDraft {
  return { ...draft, knowledgeBases: draft.knowledgeBases.filter(item => item !== value) }
}

/**
 * Validate a draft before conversion to the host record format.
 * @param draft - complete editable Agent state.
 * @returns every local validation issue in form order.
 */
export function validateAgentDraft(draft: AgentDraft): readonly AgentDraftIssue[] {
  const issues: AgentDraftIssue[] = []
  if (draft.agentId.trim() === '') {
    issues.push({ field: 'agentId', code: 'required' })
  } else if (!isSafeAgentId(draft.agentId.trim())) {
    issues.push({ field: 'agentId', code: 'invalidAgentId' })
  }
  if (draft.displayName.trim() === '') issues.push({ field: 'displayName', code: 'required' })
  if (draft.domain.trim() === '') issues.push({ field: 'domain', code: 'required' })
  if (!isHarness(draft.harness)) issues.push({ field: 'form', code: 'hostRejected' })
  if (!isTier(draft.tier)) issues.push({ field: 'form', code: 'hostRejected' })
  if (draft.modelMode === 'explicit') {
    if (draft.modelProvider.trim() === '') {
      issues.push({ field: 'modelProvider', code: 'modelProviderRequired' })
    }
    if (draft.modelId.trim() === '') issues.push({ field: 'modelId', code: 'modelIdRequired' })
  }
  if (draft.timeoutSeconds.trim() !== '' && !isPositiveInteger(draft.timeoutSeconds)) {
    issues.push({ field: 'timeoutSeconds', code: 'positiveInteger' })
  }
  if (draft.maxConcurrentRuns.trim() !== '' && !isPositiveInteger(draft.maxConcurrentRuns)) {
    issues.push({ field: 'maxConcurrentRuns', code: 'positiveInteger' })
  }
  if (!draft.costUnlimited
    && draft.costLimitPerRun.trim() !== ''
    && !isNonNegativeNumber(draft.costLimitPerRun)) {
    issues.push({ field: 'costLimitPerRun', code: 'nonNegativeNumber' })
  }
  const ports = new Set<string>()
  for (const output of draft.outputFiles) {
    const port = output.port.trim()
    const path = output.path.trim()
    if (port === '' && path === '') continue
    if (port === '') {
      issues.push({ field: 'outputFiles', code: 'outputPortRequired' })
      continue
    }
    if (ports.has(port)) issues.push({ field: 'outputFiles', code: 'duplicateOutputPort', detail: port })
    ports.add(port)
    if (path === '') {
      issues.push({ field: 'outputFiles', code: 'outputPathRequired' })
    } else if (!isRelativeArtifactPath(path)) {
      issues.push({ field: 'outputFiles', code: 'invalidOutputPath', detail: path })
    }
  }

  const overlap = normalizedTools(draft.allowedTools)
    .find(tool => normalizedTools(draft.deniedTools).includes(tool))
  if (overlap !== undefined) {
    issues.push({ field: 'tools', code: 'overlappingTools', detail: overlap })
  }
  return issues
}

/**
 * Convert a validated draft into the exact record sent to the host.
 * @param draft - validated editable Agent state.
 * @returns a complete API record, preserving explicit tier and model selection.
 */
export function draftToAgentRecord(draft: AgentDraft): AgentRecord {
  const description = optionalText(draft.description)
  const systemPrompt = optionalText(draft.systemPrompt)
  const knowledgeBases = normalizedTools(draft.knowledgeBases)
  const timeoutSeconds = optionalNumber(draft.timeoutSeconds)
  const maxConcurrentRuns = optionalNumber(draft.maxConcurrentRuns)
  const cost = draft.costUnlimited
    ? null
    : optionalNumber(draft.costLimitPerRun)
  const outputFiles = Object.fromEntries(
    draft.outputFiles
      .filter(output => output.port.trim() !== '' && output.path.trim() !== '')
      .map(output => [output.port.trim(), output.path.trim()]),
  )
  return {
    agentId: draft.agentId.trim(),
    displayName: draft.displayName.trim(),
    domain: draft.domain.trim(),
    ...(description === undefined ? {} : { description }),
    harness: draft.harness,
    executionBackend: draft.executionBackend,
    model: draft.modelMode === 'auto'
      ? 'auto'
      : { provider: draft.modelProvider.trim(), id: draft.modelId.trim() },
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    tier: draft.tier,
    execution: draft.execution,
    ...(draft.execution !== 'workflow' || draft.workflow.trim() === ''
      ? {}
      : { workflow: draft.workflow.trim() }),
    permissions: {
      allowedTools: normalizedTools(draft.allowedTools),
      deniedTools: normalizedTools(draft.deniedTools),
    },
    ...(knowledgeBases.length === 0 ? {} : { knowledgeBases }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(cost === undefined ? {} : { costLimitPerRun: cost }),
    outputFiles,
  }
}
