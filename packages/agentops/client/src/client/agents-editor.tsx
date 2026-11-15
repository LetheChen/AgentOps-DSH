/**
 * Create and edit Agent definitions through the five-section Agent form.
 *
 * @module @agentops/dsh-client/agents-editor
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import {
  Button,
  Checkbox,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  AgentValidationError,
  createAgent,
  loadAgent,
  loadAgentModelCatalog,
  loadAgentToolCatalog,
  removeAgent,
  updateAgent,
  type ExecutionBackend,
  type AgentModelCatalog,
  type AgentRecord,
  type AgentTier,
  type AgentToolCatalog,
  type AgentToolCatalogEntry,
} from './agent-catalogue-api.js'
import type { DomainRegistryEntry } from './registry-api.js'
import {
  agentErrorKey,
  firstIssueTab,
  hostIssuesForDraft,
  type AgentEditorTab,
  type AgentErrorKey,
} from './agent-editor-logic.js'
import { loadAgentRunStats, type AgentRunStats } from './agent-run-stats.js'
import {
  addKnowledgeBase,
  agentRecordToDraft,
  draftToAgentRecord,
  emptyAgentDraft,
  removeKnowledgeBase,
  setToolPolicy,
  toolPolicyFor,
  validateAgentDraft,
  type AgentDraft,
  type AgentDraftIssue,
  type AgentToolPolicy,
} from './agent-form.js'
import { AGENTS_NS } from './agent-locales/index.js'
import {
  loadWorkflowCatalog,
  type WorkflowCatalog,
  type WorkflowSummary,
  type WorkflowSummaryNode,
} from './workflow-editor-api.js'

/** Editor identity: an empty create form or one persisted Agent. */
export type AgentEditorTarget =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly agentId: string }

/** Browser-supplied Agent editor services. */
export type AgentsEditorProps = PropsLocale<typeof AGENTS_NS> & {
  /** Definition to create or edit. */
  readonly target: AgentEditorTarget
  /** Close the editor without a mutation. */
  readonly onClose: () => void
  /** Refresh the catalogue after a successful create or update. */
  readonly onSaved: () => void
  /** Refresh the catalogue after a successful delete. */
  readonly onDeleted: () => void
  /** Publish a localized success notice outside the editor lifetime. */
  readonly publishSuccess: (text: string) => void
  /** Publish a localized failure notice outside the editor lifetime. */
  readonly publishFailure: (text: string) => void
  /** Existing catalogue Domains offered as editor input suggestions. */
  readonly domainSuggestions: readonly string[]
  /** Registered business Domains and the defaults they carry. */
  readonly domainRegistry: readonly DomainRegistryEntry[]
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
}

type AgentEditorTranslate = PropsLocale<typeof AGENTS_NS>['t']
type PendingOperation = 'saving' | 'deleting' | null

const TABS: readonly AgentEditorTab[] = [
  'identity',
  'responsibility',
  'permissions',
  'knowledge',
  'runtime',
]

const EXECUTION_BACKENDS: readonly ExecutionBackend[] = ['auto', 'dsh_native', 'codex', 'claude_code']
const TIERS: readonly AgentTier[] = ['T0', 'T1', 'T2', 'T3']

function isExecutionBackend(value: string): value is ExecutionBackend {
  return EXECUTION_BACKENDS.some(item => item === value)
}

function isTier(value: string): value is AgentTier {
  return TIERS.some(item => item === value)
}


function tabCopyKey(tab: AgentEditorTab): `tabs.${AgentEditorTab}` {
  return `tabs.${tab}`
}

function issueCopy(t: AgentEditorTranslate, issue: AgentDraftIssue): string {
  switch (issue.code) {
    case 'required': return t('validation.required')
    case 'invalidAgentId': return t('validation.invalidAgentId')
    case 'modelProviderRequired': return t('validation.modelProviderRequired')
    case 'modelIdRequired': return t('validation.modelIdRequired')
    case 'positiveInteger': return t('validation.positiveInteger')
    case 'nonNegativeNumber': return t('validation.nonNegativeNumber')
    case 'outputPortRequired': return t('validation.outputPortRequired')
    case 'outputPathRequired': return t('validation.outputPathRequired')
    case 'duplicateOutputPort':
      return t('validation.duplicateOutputPort', { detail: issue.detail ?? '' })
    case 'invalidOutputPath':
      return t('validation.invalidOutputPath', { detail: issue.detail ?? '' })
    case 'overlappingTools':
      return t('validation.overlappingTools', { detail: issue.detail ?? '' })
    case 'hostRejected': return t('validation.hostRejected')
  }
}

function issueCopies(
  t: AgentEditorTranslate,
  issues: readonly AgentDraftIssue[],
  field: AgentDraftIssue['field'],
): readonly string[] {
  return [...new Set(issues.filter(issue => issue.field === field).map(issue => issueCopy(t, issue)))]
}

function FieldIssues({ copies }: { readonly copies: readonly string[] }): ReactElement | null {
  if (copies.length === 0) return null
  return (
    <ul className="agx-field-issues">
      {copies.map(copy => <li key={copy}>{copy}</li>)}
    </ul>
  )
}

function policyVariant(policy: AgentToolPolicy, target: AgentToolPolicy): 'primary' | 'outline' {
  return policy === target ? 'primary' : 'outline'
}

function policyCopyKey(policy: AgentToolPolicy): 'tool.allowed' | 'tool.denied' | 'tool.default' {
  switch (policy) {
    case 'allowed': return 'tool.allowed'
    case 'denied': return 'tool.denied'
    case 'default': return 'tool.default'
  }
}

type RunStatsStatus = NonNullable<AgentRunStats['latest']>['status']

function runStatusCopyKey(
  status: RunStatsStatus,
): 'runStats.running' | 'runStats.completed' | 'runStats.failed' | 'runStats.cancelled' {
  switch (status) {
    case 'running': return 'runStats.running'
    case 'completed': return 'runStats.completed'
    case 'failed': return 'runStats.failed'
    case 'cancelled': return 'runStats.cancelled'
  }
}

function emptyRunStats(): AgentRunStats {
  return {
    workflowCount: 0,
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
}

/**
 * Render the Agent create/edit dialog.
 * @param props - localized copy, editor target, lifecycle callbacks, and feedback publishers.
 * @returns the modal editor and its delete confirmation when needed.
 */
export function AgentsEditor({
  t,
  target,
  onClose,
  onSaved,
  onDeleted,
  publishSuccess,
  publishFailure,
  domainSuggestions,
  domainRegistry,
  fetchImpl,
}: AgentsEditorProps): ReactElement {
  const isCreate = target.kind === 'create'
  const [draft, setDraft] = useState<AgentDraft>(emptyAgentDraft)
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('identity')
  const [issues, setIssues] = useState<readonly AgentDraftIssue[]>([])
  const [operationError, setOperationError] = useState<AgentErrorKey | null>(null)
  const [loading, setLoading] = useState(!isCreate)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const [pending, setPending] = useState<PendingOperation>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newTool, setNewTool] = useState('')
  const [newKnowledge, setNewKnowledge] = useState('')
  const [modelCatalogEntry, setModelCatalogEntry] = useState<{
    readonly version: number
    readonly value: AgentModelCatalog
  } | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelLoadFailed, setModelLoadFailed] = useState(false)
  const [modelCatalogVersion, setModelCatalogVersion] = useState(0)
  const [workflowCatalogEntry, setWorkflowCatalogEntry] = useState<{
    readonly version: number
    readonly value: WorkflowCatalog
  } | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowLoadFailed, setWorkflowLoadFailed] = useState(false)
  const [workflowCatalogVersion, setWorkflowCatalogVersion] = useState(0)
  const [toolCatalogEntry, setToolCatalogEntry] = useState<{
    readonly version: number
    readonly value: AgentToolCatalog
  } | null>(null)
  const [toolCatalogLoading, setToolCatalogLoading] = useState(false)
  const [toolCatalogLoadFailed, setToolCatalogLoadFailed] = useState(false)
  const [toolCatalogVersion, setToolCatalogVersion] = useState(0)
  const [toolQuery, setToolQuery] = useState('')
  const [runStatsState, setRunStatsState] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly key: string }
    | { readonly kind: 'failed'; readonly key: string }
    | { readonly kind: 'loaded'; readonly key: string; readonly value: AgentRunStats }
  >({ kind: 'idle' })
  const [runStatsVersion, setRunStatsVersion] = useState(0)
  const nextOutputKey = useRef(0)
  const requestSequence = useRef(0)
  const runStatsRequestSequence = useRef(0)

  const targetKind = target.kind
  const targetAgentId = target.kind === 'edit' ? target.agentId : null
  const selectedDomain = useMemo(
    () => domainRegistry.find(entry => entry.domain === draft.domain.trim()) ?? null,
    [domainRegistry, draft.domain],
  )

  useEffect(() => {
    if (activeTab !== 'runtime') return
    if (workflowCatalogEntry?.version === workflowCatalogVersion) return
    let active = true
    setWorkflowLoading(true)
    setWorkflowLoadFailed(false)
    loadWorkflowCatalog(fetchImpl ?? fetch)
      .then((catalog) => {
        if (!active) return
        setWorkflowCatalogEntry({ version: workflowCatalogVersion, value: catalog })
        setWorkflowLoading(false)
      })
      .catch(() => {
        if (!active) return
        setWorkflowLoadFailed(true)
        setWorkflowLoading(false)
      })
    return () => { active = false }
  }, [activeTab, fetchImpl, workflowCatalogEntry, workflowCatalogVersion])

  useEffect(() => {
    if (activeTab !== 'permissions') return
    if (toolCatalogEntry?.version === toolCatalogVersion) return
    let active = true
    setToolCatalogLoading(true)
    setToolCatalogLoadFailed(false)
    loadAgentToolCatalog(fetchImpl ?? fetch)
      .then((catalog) => {
        if (!active) return
        setToolCatalogEntry({ version: toolCatalogVersion, value: catalog })
        setToolCatalogLoading(false)
      })
      .catch(() => {
        if (!active) return
        setToolCatalogLoadFailed(true)
        setToolCatalogLoading(false)
      })
    return () => { active = false }
  }, [activeTab, fetchImpl, toolCatalogEntry, toolCatalogVersion])

  useEffect(() => {
    const sequence = ++requestSequence.current
    setActiveTab('identity')
    setOperationError(null)
    setNewTool('')
    setNewKnowledge('')
    if (targetKind === 'create') {
      setDraft(emptyAgentDraft())
      setIssues([])
      setLoading(false)
      setLoadFailed(false)
      return
    }
    if (targetAgentId === null) return
    setLoading(true)
    setLoadFailed(false)
    loadAgent(fetchImpl ?? fetch, targetAgentId)
      .then((result) => {
        if (sequence !== requestSequence.current) return
        setDraft(agentRecordToDraft(result.value))
        setIssues([])
        setLoading(false)
      })
      .catch(() => {
        if (sequence !== requestSequence.current) return
        setLoadFailed(true)
        setLoading(false)
      })
  }, [fetchImpl, loadVersion, targetAgentId, targetKind])

  useEffect(() => {
    if (draft.modelMode !== 'explicit') return
    if (modelCatalogEntry?.version === modelCatalogVersion) return
    let active = true
    setModelLoading(true)
    setModelLoadFailed(false)
    loadAgentModelCatalog(fetchImpl ?? fetch)
      .then((catalog) => {
        if (!active) return
        setModelCatalogEntry({ version: modelCatalogVersion, value: catalog })
        setModelLoading(false)
      })
      .catch(() => {
        if (!active) return
        setModelLoadFailed(true)
        setModelLoading(false)
      })
    return () => { active = false }
  }, [draft.modelMode, fetchImpl, modelCatalogEntry, modelCatalogVersion])

  const mutateDraft = (mutate: (current: AgentDraft) => AgentDraft): void => {
    setDraft(current => mutate(current))
    setIssues([])
    setOperationError(null)
  }

  const applyDomainDefaults = (entry: DomainRegistryEntry): void => {
    mutateDraft(current => ({
      ...current,
      allowedTools: [...entry.defaultAllowedTools],
      deniedTools: [...entry.defaultDeniedTools],
      knowledgeBases: [...entry.defaultKnowledgeBases],
      costUnlimited: false,
      costLimitPerRun: String(entry.costLimitPerRun),
    }))
    publishSuccess(t('domain.applied', { name: entry.displayName || entry.domain }))
  }

  const addTool = (): void => {
    const id = newTool.trim()
    if (id === '') return
    mutateDraft(current => setToolPolicy(current, id, 'allowed'))
    setNewTool('')
  }

  const addKnowledge = (): void => {
    const id = newKnowledge.trim()
    if (id === '') return
    mutateDraft(current => addKnowledgeBase(current, id))
    setNewKnowledge('')
  }

  const addOutput = (): void => {
    const key = `output:${String(++nextOutputKey.current)}`
    mutateDraft(current => ({
      ...current,
      outputFiles: [...current.outputFiles, { key, port: '', path: '' }],
    }))
  }

  const close = (): void => {
    if (pending !== null) return
    onClose()
  }

  const reportOperationError = (reason: unknown, operation: 'save' | 'delete'): void => {
    const key = agentErrorKey(reason)
    setOperationError(key)
    publishFailure(t(operation === 'save' ? 'error.save' : 'error.delete'))
  }

  const save = async (): Promise<void> => {
    if (pending !== null || loading || loadFailed) return
    const localIssues = validateAgentDraft(draft)
    if (localIssues.length > 0) {
      setIssues(localIssues)
      setActiveTab(firstIssueTab(localIssues))
      setOperationError(null)
      publishFailure(t('error.validation'))
      return
    }
    setPending('saving')
    setIssues([])
    setOperationError(null)
    try {
      const record: AgentRecord = draftToAgentRecord(draft)
      const result = isCreate
        ? await createAgent(fetchImpl ?? fetch, record)
        : await updateAgent(fetchImpl ?? fetch, record)
      setPending(null)
      onSaved()
      if (result.issues.length > 0) {
        publishSuccess(t('notice.savedWithWarnings'))
      } else {
        publishSuccess(t(isCreate ? 'notice.created' : 'notice.updated'))
      }
    } catch (reason) {
      if (reason instanceof AgentValidationError) {
        const hostIssues = hostIssuesForDraft(reason.issues)
        const nextIssues = hostIssues.length > 0
          ? hostIssues
          : [{ field: 'form', code: 'hostRejected' } as const]
        setIssues(nextIssues)
        setActiveTab(firstIssueTab(nextIssues))
      }
      setPending(null)
      reportOperationError(reason, 'save')
    }
  }

  const deleteAgent = async (): Promise<void> => {
    if (pending !== null || target.kind !== 'edit') return
    setPending('deleting')
    setOperationError(null)
    try {
      await removeAgent(fetchImpl ?? fetch, target.agentId)
      setPending(null)
      setConfirmDelete(false)
      onDeleted()
      publishSuccess(t('notice.deleted'))
    } catch (reason) {
      setPending(null)
      setConfirmDelete(false)
      reportOperationError(reason, 'delete')
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void save()
  }

  const tabIssueCounts = useMemo(() => {
    const counts: Record<AgentEditorTab, number> = {
      identity: 0,
      responsibility: 0,
      permissions: 0,
      knowledge: 0,
      runtime: 0,
    }
    for (const issue of issues) {
      const tab = firstIssueTab([issue])
      counts[tab] += 1
    }
    return counts
  }, [issues])

  const tabOptions = TABS.map(tab => ({
    value: tab,
    label: tabIssueCounts[tab] === 0
      ? t(tabCopyKey(tab))
      : `${t(tabCopyKey(tab))} (${t('validation.tabIssue', { count: String(tabIssueCounts[tab]) })})`,
  }))

  const toolIds = [...new Set([...draft.allowedTools, ...draft.deniedTools])].sort()
  const toolCatalog = toolCatalogEntry?.version === toolCatalogVersion
    ? toolCatalogEntry.value
    : undefined
  const catalogueById = new Map<string, AgentToolCatalogEntry>(
    (toolCatalog?.tools ?? []).map(tool => [tool.id, tool]),
  )
  const filteredCatalogue = useMemo(() => {
    const tools = toolCatalog?.tools ?? []
    const query = toolQuery.trim().toLowerCase()
    if (query === '') return tools
    return tools.filter(tool => (
      tool.id.toLowerCase().includes(query)
      || tool.displayName.toLowerCase().includes(query)
      || tool.description.toLowerCase().includes(query)
    ))
  }, [toolCatalog, toolQuery])
  const identityIssues = {
    agentId: issueCopies(t, issues, 'agentId'),
    displayName: issueCopies(t, issues, 'displayName'),
    domain: issueCopies(t, issues, 'domain'),
    modelProvider: issueCopies(t, issues, 'modelProvider'),
    modelId: issueCopies(t, issues, 'modelId'),
    form: issueCopies(t, issues, 'form'),
  }
  const responsibilityIssues = {
    description: issueCopies(t, issues, 'description'),
    systemPrompt: issueCopies(t, issues, 'systemPrompt'),
  }
  const toolIssues = issueCopies(t, issues, 'tools')
  const knowledgeIssues = issueCopies(t, issues, 'knowledgeBases')
  const runtimeIssues = {
    timeoutSeconds: issueCopies(t, issues, 'timeoutSeconds'),
    maxConcurrentRuns: issueCopies(t, issues, 'maxConcurrentRuns'),
    costLimitPerRun: issueCopies(t, issues, 'costLimitPerRun'),
    outputFiles: issueCopies(t, issues, 'outputFiles'),
  }
  const modelCatalog = modelCatalogEntry?.version === modelCatalogVersion
    ? modelCatalogEntry.value
    : null
  const modelProviders = modelCatalog?.providers ?? []
  const selectedProvider = modelProviders.find(provider => provider.id === draft.modelProvider)
  const providerUnavailable = draft.modelProvider !== '' && selectedProvider === undefined
  const selectedModel = selectedProvider?.models.find(model => model.id === draft.modelId)
  const modelUnavailable = draft.modelId !== '' && (selectedProvider === undefined || selectedModel === undefined)
  const providerCatalogNames = (modelCatalog?.failures ?? []).map(failure => failure.name).join(', ')

  const workflowCatalog = workflowCatalogEntry?.version === workflowCatalogVersion
    ? workflowCatalogEntry.value
    : null
  const workflowBindings = useMemo(() => {
    const agentId = draft.agentId.trim()
    if (agentId === '') return []
    return (workflowCatalog?.entries ?? []).flatMap((workflow: WorkflowSummary) => (
      workflow.status !== 'verified'
        ? []
        : workflow.nodes
          .filter((node: WorkflowSummaryNode) => node.agentRef === agentId)
          .map(node => ({ workflow, node }))
    ))
  }, [draft.agentId, workflowCatalog])
  const workflowBindingIds = useMemo(
    () => [...new Set(workflowBindings.map(binding => binding.workflow.id))],
    [workflowBindings],
  )
  const runStatsKey = JSON.stringify([workflowBindingIds, runStatsVersion])

  useEffect(() => {
    if (activeTab !== 'runtime') return
    if (workflowLoading || workflowLoadFailed || workflowCatalog === null) return
    const sequence = ++runStatsRequestSequence.current
    if (workflowBindingIds.length === 0) {
      setRunStatsState({
        kind: 'loaded',
        key: runStatsKey,
        value: emptyRunStats(),
      })
      return
    }
    setRunStatsState({ kind: 'loading', key: runStatsKey })
    loadAgentRunStats(workflowBindingIds, fetchImpl ?? fetch)
      .then((value) => {
        if (sequence !== runStatsRequestSequence.current) return
        setRunStatsState({ kind: 'loaded', key: runStatsKey, value })
      })
      .catch(() => {
        if (sequence !== runStatsRequestSequence.current) return
        setRunStatsState({ kind: 'failed', key: runStatsKey })
      })
    return () => {
      if (runStatsRequestSequence.current === sequence) {
        runStatsRequestSequence.current += 1
      }
    }
  }, [
    activeTab,
    fetchImpl,
    runStatsKey,
    workflowBindingIds,
    workflowCatalog,
    workflowLoadFailed,
    workflowLoading,
  ])

  const renderTab = (): ReactElement => {
    if (activeTab === 'identity') {
      return (
        <div className="agx-form-grid">
          {identityIssues.form.length > 0 && <FieldIssues copies={identityIssues.form} />}
          <div className="agx-field">
            <label htmlFor="agent-editor-id">{t('field.agentId')} <span aria-hidden="true">*</span></label>
            <Input
              id="agent-editor-id"
              value={draft.agentId}
              readOnly={!isCreate}
              disabled={pending !== null}
              placeholder={t('placeholder.agentId')}
              aria-invalid={identityIssues.agentId.length > 0}
              aria-describedby={identityIssues.agentId.length > 0 ? 'agent-editor-id-issues' : undefined}
              data-modal-autofocus={isCreate ? '' : undefined}
              onChange={(event) => {
                mutateDraft(current => ({ ...current, agentId: event.target.value }))
              }}
            />
            <p className="agx-helper">
              {t(isCreate ? 'editor.idEditableHint' : 'editor.idReadonlyHint')}
            </p>
            <div id="agent-editor-id-issues"><FieldIssues copies={identityIssues.agentId} /></div>
          </div>
          <div className="agx-field">
            <label htmlFor="agent-editor-name">{t('field.displayName')} <span aria-hidden="true">*</span></label>
            <Input
              id="agent-editor-name"
              value={draft.displayName}
              disabled={pending !== null}
              placeholder={t('placeholder.displayName')}
              aria-invalid={identityIssues.displayName.length > 0}
              aria-describedby={identityIssues.displayName.length > 0 ? 'agent-editor-name-issues' : undefined}
              data-modal-autofocus={!isCreate ? '' : undefined}
              onChange={(event) => {
                mutateDraft(current => ({ ...current, displayName: event.target.value }))
              }}
            />
            <div id="agent-editor-name-issues"><FieldIssues copies={identityIssues.displayName} /></div>
          </div>
          <div className="agx-field">
            <label htmlFor="agent-editor-domain">{t('field.domain')} <span aria-hidden="true">*</span></label>
            <Input
              id="agent-editor-domain"
              list="agent-editor-domain-options"
              value={draft.domain}
              disabled={pending !== null}
              placeholder={t('placeholder.domain')}
              aria-invalid={identityIssues.domain.length > 0}
              aria-describedby={identityIssues.domain.length > 0 ? 'agent-editor-domain-issues' : undefined}
              onChange={(event) => {
                mutateDraft(current => ({ ...current, domain: event.target.value }))
              }}
            />
            <datalist id="agent-editor-domain-options">
              {domainSuggestions.map(domain => <option key={domain} value={domain} />)}
            </datalist>
            <div id="agent-editor-domain-issues"><FieldIssues copies={identityIssues.domain} /></div>
          </div>
          {selectedDomain !== null && (
            <div className="agx-field agx-field-wide">
              <div className="agx-section-heading">
                <h3>{t('domain.defaultsTitle')}</h3>
                {isCreate && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => { applyDomainDefaults(selectedDomain) }}
                  >
                    {t('domain.applyDefaults')}
                  </Button>
                )}
              </div>
              <dl className="agx-domain-defaults">
                <div>
                  <dt>{t('domain.costLimit')}</dt>
                  <dd className="agx-mono">{selectedDomain.costLimitPerRun}</dd>
                </div>
              </dl>
              <div className="agx-domain-tools">
                <span className="agx-domain-tool-group">
                  <span className="agx-config-label">{t('domain.allowedTools')}</span>
                  {selectedDomain.defaultAllowedTools.length === 0
                    ? <span className="agx-helper">{t('common.none')}</span>
                    : selectedDomain.defaultAllowedTools.map(tool => (
                      <code key={tool} className="agx-mono">{tool}</code>
                    ))}
                </span>
                <span className="agx-domain-tool-group">
                  <span className="agx-config-label">{t('domain.deniedTools')}</span>
                  {selectedDomain.defaultDeniedTools.length === 0
                    ? <span className="agx-helper">{t('common.none')}</span>
                    : selectedDomain.defaultDeniedTools.map(tool => (
                      <code key={tool} className="agx-mono">{tool}</code>
                    ))}
                </span>
                <span className="agx-domain-tool-group">
                  <span className="agx-config-label">{t('domain.knowledgeBases')}</span>
                  {selectedDomain.defaultKnowledgeBases.length === 0
                    ? <span className="agx-helper">{t('common.none')}</span>
                    : selectedDomain.defaultKnowledgeBases.map(base => (
                      <code key={base} className="agx-mono">{base}</code>
                    ))}
                </span>
              </div>
            </div>
          )}
          <div className="agx-field">
            <label htmlFor="agent-editor-execution-backend">执行后端</label>
            <select
              id="agent-editor-execution-backend"
              className="agx-select"
              value={draft.executionBackend}
              disabled={pending !== null}
              onChange={(event) => {
                const value = event.target.value
                if (!isExecutionBackend(value)) return
                mutateDraft(current => ({ ...current, executionBackend: value }))
              }}
            >
              <option value="auto">自动（优先外部编码后端）</option>
              <option value="dsh_native">DSH 原生</option>
              <option value="codex">Codex</option>
              <option value="claude_code">Claude Code</option>
            </select>
            <p className="agx-helper">仅 coding_agent 接入 Codex/Claude 外挂执行；其他 Agent 按 DSH 原生执行。</p>
          </div>
          <div className="agx-field">
            <label htmlFor="agent-editor-tier">{t('field.tier')}</label>
            <select
              id="agent-editor-tier"
              className="agx-select"
              value={draft.tier}
              disabled={pending !== null}
              aria-describedby="agent-editor-tier-helper"
              onChange={(event) => {
                const value = event.target.value
                if (!isTier(value)) return
                mutateDraft(current => ({ ...current, tier: value }))
              }}
            >
              {TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
            </select>
            <p id="agent-editor-tier-helper" className="agx-helper">{t('helper.tier')}</p>
          </div>
          <div className="agx-field agx-field-wide">
            <label htmlFor="agent-editor-model-mode">{t('field.modelMode')}</label>
            <select
              id="agent-editor-model-mode"
              className="agx-select"
              value={draft.modelMode}
              disabled={pending !== null}
              onChange={(event) => {
                const value = event.target.value
                if (value !== 'auto' && value !== 'explicit') return
                mutateDraft(current => ({ ...current, modelMode: value }))
              }}
            >
              <option value="auto">{t('model.auto')}</option>
              <option value="explicit">{t('model.explicit')}</option>
            </select>
            <p className="agx-helper">
              {t(draft.modelMode === 'auto' ? 'model.autoDescription' : 'model.explicitDescription')}
            </p>
          </div>
          {draft.modelMode === 'explicit' && (
            <>
              {modelLoading && (
                <p className="agx-helper agx-field-wide" role="status">{t('model.loading')}</p>
              )}
              {modelLoadFailed && (
                <div className="agx-form-error agx-field-wide" role="alert">
                  <p>{t('model.loadFailed')}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => { setModelCatalogVersion(value => value + 1) }}
                  >
                    {t('model.retry')}
                  </Button>
                </div>
              )}
              {!modelLoading && !modelLoadFailed && modelCatalog !== null && modelProviders.length === 0 && (
                <p className="agx-helper agx-field-wide">{t('model.empty')}</p>
              )}
              {!modelLoading && modelCatalog !== null && modelCatalog.failures.length > 0 && (
                <p className="agx-helper agx-field-wide" role="status">
                  {t('model.partialFailure', {
                    count: String(modelCatalog.failures.length),
                    names: providerCatalogNames,
                  })}
                </p>
              )}
              <div className="agx-field">
                <label htmlFor="agent-editor-provider">{t('field.modelProvider')} <span aria-hidden="true">*</span></label>
                <select
                  id="agent-editor-provider"
                  className="agx-select"
                  value={draft.modelProvider}
                  disabled={pending !== null || modelLoading}
                  aria-invalid={identityIssues.modelProvider.length > 0}
                  aria-describedby={identityIssues.modelProvider.length > 0 ? 'agent-editor-provider-issues' : undefined}
                  onChange={(event) => {
                    const providerId = event.target.value
                    const provider = modelProviders.find(item => item.id === providerId)
                    mutateDraft(current => ({
                      ...current,
                      modelProvider: providerId,
                      modelId: provider?.models[0]?.id ?? '',
                    }))
                  }}
                >
                  <option value="">{t('model.selectProvider')}</option>
                  {modelProviders.map(provider => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name === provider.id ? provider.name : `${provider.name} (${provider.id})`}
                    </option>
                  ))}
                  {providerUnavailable && (
                    <option value={draft.modelProvider}>
                      {modelCatalog === null
                        ? draft.modelProvider
                        : t('model.unavailableProvider', { value: draft.modelProvider })}
                    </option>
                  )}
                </select>
                <div id="agent-editor-provider-issues"><FieldIssues copies={identityIssues.modelProvider} /></div>
              </div>
              <div className="agx-field">
                <label htmlFor="agent-editor-model">{t('field.modelId')} <span aria-hidden="true">*</span></label>
                <select
                  id="agent-editor-model"
                  className="agx-select"
                  value={draft.modelId}
                  disabled={pending !== null || modelLoading}
                  aria-invalid={identityIssues.modelId.length > 0}
                  aria-describedby={identityIssues.modelId.length > 0 ? 'agent-editor-model-issues' : undefined}
                  onChange={(event) => {
                    const modelId = event.target.value
                    mutateDraft(current => ({ ...current, modelId }))
                  }}
                >
                  <option value="">{t('model.selectModel')}</option>
                  {(selectedProvider?.models ?? []).map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name === model.id ? model.name : `${model.name} (${model.id})`}
                    </option>
                  ))}
                  {modelUnavailable && (
                    <option value={draft.modelId}>
                      {t('model.unavailableModel', { value: draft.modelId })}
                    </option>
                  )}
                </select>
                {selectedProvider !== undefined && selectedProvider.models.length === 0 && (
                  <p className="agx-helper">{t('model.providerEmpty')}</p>
                )}
                {modelCatalog !== null && modelUnavailable && (
                  <p className="agx-helper">{t('model.unavailableHint')}</p>
                )}
                {selectedModel?.description !== undefined && (
                  <p className="agx-helper">{selectedModel.description}</p>
                )}
                <div id="agent-editor-model-issues"><FieldIssues copies={identityIssues.modelId} /></div>
              </div>
            </>
          )}
        </div>
      )
    }

    if (activeTab === 'responsibility') {
      return (
        <div className="agx-form-stack">
          <div className="agx-field">
            <label htmlFor="agent-editor-description">{t('field.description')}</label>
            <textarea
              id="agent-editor-description"
              className="agx-textarea"
              value={draft.description}
              disabled={pending !== null}
              placeholder={t('placeholder.description')}
              aria-describedby="agent-editor-description-helper"
              onChange={(event) => {
                mutateDraft(current => ({ ...current, description: event.target.value }))
              }}
            />
            <p id="agent-editor-description-helper" className="agx-helper">{t('helper.description')}</p>
            <FieldIssues copies={responsibilityIssues.description} />
          </div>
          <div className="agx-field">
            <label htmlFor="agent-editor-prompt">{t('field.systemPrompt')}</label>
            <textarea
              id="agent-editor-prompt"
              className="agx-textarea agx-textarea-large"
              value={draft.systemPrompt}
              disabled={pending !== null}
              placeholder={t('placeholder.systemPrompt')}
              aria-describedby="agent-editor-prompt-helper"
              onChange={(event) => {
                mutateDraft(current => ({ ...current, systemPrompt: event.target.value }))
              }}
            />
            <p id="agent-editor-prompt-helper" className="agx-helper">{t('helper.systemPrompt')}</p>
            <FieldIssues copies={responsibilityIssues.systemPrompt} />
          </div>
        </div>
      )
    }

    if (activeTab === 'permissions') {
      return (
        <div className="agx-form-stack">
          <section className="agx-policy-intro" aria-labelledby="agent-editor-policy-title">
            <h3 id="agent-editor-policy-title">{t('permissions.policyTitle')}</h3>
            <p>{t('permissions.policyHelper')}</p>
          </section>
          <div className="agx-field">
            <label htmlFor="agent-editor-tool">{t('field.tools')}</label>
            <div className="agx-inline-add">
              <Input
                id="agent-editor-tool"
                value={newTool}
                disabled={pending !== null}
                placeholder={t('placeholder.tool')}
                onChange={(event) => { setNewTool(event.target.value) }}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addTool()
                }}
              />
              <Button
                variant="outline"
                icon={<IconPlusOutlineRegular />}
                disabled={pending !== null || newTool.trim() === ''}
                onClick={addTool}
              >
                {t('tool.add')}
              </Button>
            </div>
            <p className="agx-helper">{t('helper.tools')}</p>
            <FieldIssues copies={toolIssues} />
          </div>
          {toolIds.length === 0
            ? <p className="agx-empty">{t('tool.empty')}</p>
            : (
              <ul className="agx-policy-list">
                {toolIds.map((toolId) => {
                  const policy = toolPolicyFor(draft, toolId)
                  const meta = catalogueById.get(toolId)
                  return (
                    <li key={toolId} className="agx-policy-row">
                      <div className="agx-policy-row-main">
                        <div className="agx-policy-tool">
                          <code className="agx-mono">{toolId}</code>
                          <span className="agx-policy-current">
                            {t('permissions.currentPolicy')}: {t(policyCopyKey(policy))}
                          </span>
                        </div>
                        <div className="agx-policy-options" role="group" aria-label={toolId}>
                          <Button
                            size="sm"
                            variant={policyVariant(policy, 'allowed')}
                            aria-pressed={policy === 'allowed'}
                            disabled={pending !== null}
                            onClick={() => { mutateDraft(current => setToolPolicy(current, toolId, 'allowed')) }}
                          >
                            {t('tool.allowed')}
                          </Button>
                          <Button
                            size="sm"
                            variant={policyVariant(policy, 'denied')}
                            aria-pressed={policy === 'denied'}
                            disabled={pending !== null}
                            onClick={() => { mutateDraft(current => setToolPolicy(current, toolId, 'denied')) }}
                          >
                            {t('tool.denied')}
                          </Button>
                          <Button
                            size="sm"
                            variant={policyVariant(policy, 'default')}
                            aria-pressed={policy === 'default'}
                            disabled={pending !== null}
                            onClick={() => { mutateDraft(current => setToolPolicy(current, toolId, 'default')) }}
                          >
                            {t('tool.default')}
                          </Button>
                        </div>
                      </div>
                      {meta === undefined
                        ? <p className="agx-policy-migration is-unknown">{t('permissions.unknownTool')}</p>
                        : (
                          <>
                            <dl className="agx-policy-metadata">
                              <div>
                                <dt>{t('permissions.descriptionLabel')}</dt>
                                <dd>{meta.description === '' ? t('permissions.metadataUnavailable') : meta.description}</dd>
                              </div>
                              <div>
                                <dt>{t('permissions.domainLabel')}</dt>
                                <dd>{meta.allowedDomains.length === 0
                                  ? t('permissions.domainsNone')
                                  : meta.allowedDomains.join(', ')}</dd>
                              </div>
                              <div>
                                <dt>{t('permissions.approvalLabel')}</dt>
                                <dd>{meta.requiresHumanApproval
                                  ? t('permissions.approvalRequired')
                                  : t('permissions.approvalNotRequired')}</dd>
                              </div>
                            </dl>
                            <p className={`agx-policy-migration is-${meta.migrated ? 'migrated' : 'unmigrated'}`}>
                              {meta.migrated
                                ? t('permissions.migratedTo', {
                                  plugin: meta.mappedPlugin ?? '',
                                  tool: meta.mappedTool ?? '',
                                })
                                : t('permissions.notMigrated', { note: meta.note ?? '' })}
                            </p>
                          </>
                        )}
                    </li>
                  )
                })}
              </ul>
            )}
          <section className="agx-tool-catalogue" aria-labelledby="agent-editor-catalogue-title">
            <div className="agx-section-heading">
              <h3 id="agent-editor-catalogue-title">{t('permissions.catalogueTitle')}</h3>
              {toolCatalogLoadFailed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={toolCatalogLoading}
                  onClick={() => { setToolCatalogVersion(value => value + 1) }}
                >
                  {t('permissions.catalogueRetry')}
                </Button>
              )}
            </div>
            <p className="agx-helper">{t('permissions.catalogueHelper')}</p>
            {toolCatalogLoading && (
              <p className="agx-empty" role="status">{t('permissions.catalogueLoading')}</p>
            )}
            {toolCatalogLoadFailed && (
              <p className="agx-form-error" role="alert">{t('permissions.catalogueFailed')}</p>
            )}
            {toolCatalog !== undefined && toolCatalog.missing && (
              <p className="agx-empty">{t('permissions.catalogueMissing')}</p>
            )}
            {toolCatalog !== undefined && !toolCatalog.missing && (
              <>
                <div className="agx-field">
                  <label htmlFor="agent-editor-tool-search">{t('permissions.catalogueSearch')}</label>
                  <Input
                    id="agent-editor-tool-search"
                    value={toolQuery}
                    disabled={pending !== null}
                    placeholder={t('permissions.catalogueSearchPlaceholder')}
                    onChange={(event) => { setToolQuery(event.target.value) }}
                  />
                </div>
                {filteredCatalogue.length === 0
                  ? <p className="agx-empty">{t('permissions.catalogueEmpty')}</p>
                  : (
                    <ul className="agx-catalogue-list">
                      {filteredCatalogue.map((tool) => {
                        const policy = toolPolicyFor(draft, tool.id)
                        return (
                          <li key={tool.id} className="agx-catalogue-row">
                            <div className="agx-catalogue-row-main">
                              <div className="agx-policy-tool">
                                <code className="agx-mono">{tool.id}</code>
                                <span className="agx-policy-current">{tool.displayName}</span>
                              </div>
                              <div className="agx-policy-options" role="group" aria-label={tool.id}>
                                <Button
                                  size="sm"
                                  variant={policyVariant(policy, 'allowed')}
                                  aria-pressed={policy === 'allowed'}
                                  disabled={pending !== null}
                                  onClick={() => { mutateDraft(current => setToolPolicy(current, tool.id, 'allowed')) }}
                                >
                                  {t('tool.allowed')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant={policyVariant(policy, 'denied')}
                                  aria-pressed={policy === 'denied'}
                                  disabled={pending !== null}
                                  onClick={() => { mutateDraft(current => setToolPolicy(current, tool.id, 'denied')) }}
                                >
                                  {t('tool.denied')}
                                </Button>
                              </div>
                            </div>
                            {tool.description !== '' && (
                              <p className="agx-catalogue-description">{tool.description}</p>
                            )}
                            <p className="agx-catalogue-meta">
                              <span>{t('permissions.domainLabel')}: {tool.allowedDomains.length === 0
                                ? t('permissions.domainsNone')
                                : tool.allowedDomains.join(', ')}</span>
                              <span>{t('permissions.approvalLabel')}: {tool.requiresHumanApproval
                                ? t('permissions.approvalRequired')
                                : t('permissions.approvalNotRequired')}</span>
                              <span>{tool.migrated
                                ? t('permissions.migratedTo', {
                                  plugin: tool.mappedPlugin ?? '',
                                  tool: tool.mappedTool ?? '',
                                })
                                : t('permissions.notMigrated', { note: tool.note ?? '' })}</span>
                            </p>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </>
            )}
          </section>
        </div>
      )
    }

    if (activeTab === 'knowledge') {
      return (
        <div className="agx-form-stack">
          <div className="agx-field">
            <label htmlFor="agent-editor-knowledge">{t('field.knowledgeBases')}</label>
            <div className="agx-inline-add">
              <Input
                id="agent-editor-knowledge"
                value={newKnowledge}
                disabled={pending !== null}
                placeholder={t('placeholder.knowledge')}
                onChange={(event) => { setNewKnowledge(event.target.value) }}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addKnowledge()
                }}
              />
              <Button
                variant="outline"
                icon={<IconPlusOutlineRegular />}
                disabled={pending !== null || newKnowledge.trim() === ''}
                onClick={addKnowledge}
              >
                {t('knowledge.add')}
              </Button>
            </div>
            <p className="agx-helper">{t('helper.knowledge')}</p>
            <FieldIssues copies={knowledgeIssues} />
          </div>
          {draft.knowledgeBases.length === 0
            ? <p className="agx-empty">{t('knowledge.empty')}</p>
            : (
              <ul className="agx-chip-list">
                {draft.knowledgeBases.map(knowledgeBase => (
                  <li key={knowledgeBase} className="agx-chip">
                    <code className="agx-mono">{knowledgeBase}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="agx-icon-button"
                      aria-label={t('knowledge.removeAria', { name: knowledgeBase })}
                      disabled={pending !== null}
                      icon={<IconTrashOutlineRegular />}
                      onClick={() => { mutateDraft(current => removeKnowledgeBase(current, knowledgeBase)) }}
                    />
                  </li>
                ))}
              </ul>
            )}
        </div>
      )
    }

    return (
      <div className="agx-form-stack">
        <div className="agx-form-grid">
          <div className="agx-field">
            <label htmlFor="agent-editor-timeout">{t('field.timeoutSeconds')}</label>
            <Input
              id="agent-editor-timeout"
              inputMode="numeric"
              value={draft.timeoutSeconds}
              disabled={pending !== null}
              placeholder={t('placeholder.timeout')}
              aria-invalid={runtimeIssues.timeoutSeconds.length > 0}
              aria-describedby="agent-editor-timeout-helper"
              onChange={(event) => {
                mutateDraft(current => ({ ...current, timeoutSeconds: event.target.value }))
              }}
            />
            <p id="agent-editor-timeout-helper" className="agx-helper">{t('helper.timeout')}</p>
            <FieldIssues copies={runtimeIssues.timeoutSeconds} />
          </div>
          <div className="agx-field">
            <label htmlFor="agent-editor-concurrency">{t('field.maxConcurrentRuns')}</label>
            <Input
              id="agent-editor-concurrency"
              inputMode="numeric"
              value={draft.maxConcurrentRuns}
              disabled={pending !== null}
              placeholder={t('placeholder.maxConcurrent')}
              aria-invalid={runtimeIssues.maxConcurrentRuns.length > 0}
              aria-describedby="agent-editor-concurrency-helper"
              onChange={(event) => {
                mutateDraft(current => ({ ...current, maxConcurrentRuns: event.target.value }))
              }}
            />
            <p id="agent-editor-concurrency-helper" className="agx-helper">{t('helper.maxConcurrent')}</p>
            <FieldIssues copies={runtimeIssues.maxConcurrentRuns} />
          </div>
          <div className="agx-field agx-field-wide">
            <label htmlFor="agent-editor-cost">{t('field.costLimitPerRun')}</label>
            <Input
              id="agent-editor-cost"
              inputMode="decimal"
              value={draft.costLimitPerRun}
              disabled={pending !== null || draft.costUnlimited}
              placeholder={t('placeholder.cost')}
              aria-invalid={runtimeIssues.costLimitPerRun.length > 0}
              aria-describedby="agent-editor-cost-helper"
              onChange={(event) => {
                mutateDraft(current => ({ ...current, costLimitPerRun: event.target.value }))
              }}
            />
            <Checkbox
              checked={draft.costUnlimited}
              disabled={pending !== null}
              label={t('runtime.unlimited')}
              title={t('runtime.unlimitedDescription')}
              onChange={(checked) => {
                mutateDraft(current => ({ ...current, costUnlimited: checked }))
              }}
            />
            <p id="agent-editor-cost-helper" className="agx-helper">{t('helper.cost')}</p>
            <FieldIssues copies={runtimeIssues.costLimitPerRun} />
          </div>
        </div>

        <section className="agx-output-section" aria-labelledby="agent-editor-output-title">
          <div className="agx-section-heading">
            <h3 id="agent-editor-output-title">{t('field.outputFiles')}</h3>
            <Button
              size="sm"
              variant="outline"
              icon={<IconPlusOutlineRegular />}
              disabled={pending !== null}
              onClick={addOutput}
            >
              {t('output.add')}
            </Button>
          </div>
          <p className="agx-helper">{t('helper.output')}</p>
          <FieldIssues copies={runtimeIssues.outputFiles} />
          {draft.outputFiles.length === 0
            ? <p className="agx-empty">{t('output.empty')}</p>
            : (
              <ul className="agx-output-list">
                {draft.outputFiles.map(output => (
                  <li key={output.key} className="agx-output-row">
                    <div className="agx-field">
                      <label htmlFor={`agent-output-port-${output.key}`}>{t('field.port')}</label>
                      <Input
                        id={`agent-output-port-${output.key}`}
                        value={output.port}
                        disabled={pending !== null}
                        placeholder={t('placeholder.port')}
                        onChange={(event) => {
                          const port = event.target.value
                          mutateDraft(current => ({
                            ...current,
                            outputFiles: current.outputFiles.map(item => item.key === output.key ? { ...item, port } : item),
                          }))
                        }}
                      />
                    </div>
                    <div className="agx-field">
                      <label htmlFor={`agent-output-path-${output.key}`}>{t('field.path')}</label>
                      <Input
                        id={`agent-output-path-${output.key}`}
                        value={output.path}
                        disabled={pending !== null}
                        placeholder={t('placeholder.path')}
                        onChange={(event) => {
                          const path = event.target.value
                          mutateDraft(current => ({
                            ...current,
                            outputFiles: current.outputFiles.map(item => item.key === output.key ? { ...item, path } : item),
                          }))
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="agx-icon-button"
                      aria-label={t('output.removeAria', { name: output.port || t('field.port') })}
                      disabled={pending !== null}
                      icon={<IconTrashOutlineRegular />}
                      onClick={() => {
                        mutateDraft(current => ({
                          ...current,
                          outputFiles: current.outputFiles.filter(item => item.key !== output.key),
                        }))
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className="agx-workflow-section" aria-labelledby="agent-editor-workflows-title">
          <div className="agx-section-heading">
            <h3 id="agent-editor-workflows-title">{t('workflowBindings.title')}</h3>
            {workflowLoadFailed && (
              <Button
                size="sm"
                variant="outline"
                disabled={workflowLoading}
                onClick={() => { setWorkflowCatalogVersion(value => value + 1) }}
              >
                {t('workflowBindings.retry')}
              </Button>
            )}
          </div>
          <p className="agx-helper">{t('workflowBindings.helper')}</p>
          {workflowLoading ? (
            <p className="agx-workflow-status" role="status">{t('workflowBindings.loading')}</p>
          ) : null}
          {workflowLoadFailed ? (
            <p className="agx-workflow-status is-error" role="alert">{t('workflowBindings.loadFailed')}</p>
          ) : null}
          {!workflowLoading && workflowCatalog !== null && workflowBindings.length === 0 ? (
            <p className="agx-empty">
              {draft.agentId.trim() === '' ? t('workflowBindings.noAgentId') : t('workflowBindings.empty')}
            </p>
          ) : null}
          {workflowBindings.length > 0 ? (
            <ul className="agx-workflow-binding-list">
              {workflowBindings.map(({ workflow, node }) => (
                <li key={`${workflow.id}:${node.id}`} className="agx-workflow-binding">
                  <div className="agx-workflow-binding-main">
                    <span className="agx-workflow-binding-name">{workflow.name}</span>
                    <code>{node.id}</code>
                  </div>
                  <div className="agx-workflow-binding-meta">
                    {node.displayName !== undefined ? <span>{node.displayName}</span> : null}
                    {node.businessRole !== undefined ? <span>{node.businessRole}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="agx-run-stats" aria-labelledby="agent-editor-run-stats-title">
          <div className="agx-section-heading">
            <h3 id="agent-editor-run-stats-title">{t('runStats.title')}</h3>
            {runStatsState.kind === 'failed' && runStatsState.key === runStatsKey ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setRunStatsVersion(value => value + 1) }}
              >
                {t('runStats.retry')}
              </Button>
            ) : null}
          </div>
          <p className="agx-helper">{t('runStats.helper')}</p>
          {workflowLoading ? (
            <p className="agx-workflow-status" role="status">{t('runStats.loading')}</p>
          ) : workflowLoadFailed ? null : draft.agentId.trim() === '' ? (
            <p className="agx-empty">{t('runStats.noAgentId')}</p>
          ) : workflowBindingIds.length === 0 ? (
            <p className="agx-empty">{t('runStats.noBindings')}</p>
          ) : runStatsState.kind === 'idle'
            || runStatsState.kind === 'loading'
            || runStatsState.key !== runStatsKey ? (
              <p className="agx-workflow-status" role="status">{t('runStats.loading')}</p>
            ) : runStatsState.kind === 'failed' ? (
              <p className="agx-workflow-status is-error" role="alert">{t('runStats.loadFailed')}</p>
            ) : (
              <>
                <dl className="agx-run-stat-grid">
                  <div className="agx-run-stat">
                    <dt>{t('runStats.workflows')}</dt>
                    <dd>{runStatsState.value.workflowCount}</dd>
                  </div>
                  <div className="agx-run-stat">
                    <dt>{t('runStats.total')}</dt>
                    <dd>{runStatsState.value.total}</dd>
                  </div>
                  <div className="agx-run-stat">
                    <dt>{t('runStats.running')}</dt>
                    <dd>{runStatsState.value.running}</dd>
                  </div>
                  <div className="agx-run-stat">
                    <dt>{t('runStats.completed')}</dt>
                    <dd>{runStatsState.value.completed}</dd>
                  </div>
                  <div className="agx-run-stat">
                    <dt>{t('runStats.failed')}</dt>
                    <dd>{runStatsState.value.failed}</dd>
                  </div>
                  <div className="agx-run-stat">
                    <dt>{t('runStats.cancelled')}</dt>
                    <dd>{runStatsState.value.cancelled}</dd>
                  </div>
                </dl>
                {runStatsState.value.total === 0 ? (
                  <p className="agx-empty">{t('runStats.empty')}</p>
                ) : runStatsState.value.latest === undefined ? (
                  <div className="agx-run-latest">
                    <span>{t('runStats.latest')}</span>
                    <span className="agx-run-latest-empty">{t('runStats.never')}</span>
                  </div>
                ) : (
                  <div className="agx-run-latest">
                    <span>{t('runStats.latest')}</span>
                    <code className="agx-mono">{runStatsState.value.latest.runId}</code>
                    <span className={`agx-run-status is-${runStatsState.value.latest.status}`}>
                      {t(runStatusCopyKey(runStatsState.value.latest.status))}
                    </span>
                    <time dateTime={runStatsState.value.latest.startedAt}>
                      {runStatsState.value.latest.startedAt}
                    </time>
                  </div>
                )}
              </>
            )}
        </section>
      </div>
    )
  }

  const footer = (
    <div className="agx-editor-footer">
      {!isCreate && (
        <Button
          variant="ghost"
          className="agx-delete-action"
          disabled={pending !== null || loading || loadFailed}
          onClick={() => { setConfirmDelete(true) }}
        >
          {pending === 'deleting' ? t('editor.deleting') : t('editor.delete')}
        </Button>
      )}
      <div className="agx-footer-actions">
        <Button variant="outline" disabled={pending !== null} onClick={close}>
          {t('editor.cancel')}
        </Button>
        <Button
          type="submit"
          form="agent-editor-form"
          variant="primary"
          disabled={pending !== null || loading || loadFailed}
        >
          {pending === 'saving' ? t('editor.saving') : t('editor.save')}
        </Button>
      </div>
    </div>
  )

  const body = loading
    ? (
      <div className="agx-editor-loading" role="status">
        <span className="agx-spinner" aria-hidden="true" />
        <span>{t('editor.loading')}</span>
      </div>
    )
    : loadFailed
      ? (
        <div className="agx-editor-load-error" role="alert">
          <p>{t('editor.loadFailed')}</p>
          <Button variant="outline" onClick={() => { setLoadVersion(value => value + 1) }}>
            {t('page.retry')}
          </Button>
        </div>
      )
      : (
        <form id="agent-editor-form" className="agx-editor-form" onSubmit={submit} aria-busy={pending !== null}>
          <SegmentedControl
            id="agent-editor-tabs"
            value={activeTab}
            options={tabOptions}
            onChange={setActiveTab}
            label={t('tabs.aria')}
            disabled={pending !== null}
            className="agx-tabs"
          />
          {issues.length > 0 && (
            <p className="agx-form-error" role="alert">
              {t('validation.summary', { count: String(issues.length) })}
            </p>
          )}
          {operationError !== null && (
            <p className="agx-form-error" role="alert">{t(operationError)}</p>
          )}
          <div
            id={`agent-editor-tabs-${activeTab}-panel`}
            role="tabpanel"
            aria-labelledby={`agent-editor-tabs-${activeTab}`}
            className="agx-tab-panel"
          >
            {renderTab()}
          </div>
        </form>
      )

  return (
    <>
      <Modal
        open
        onClose={close}
        title={t(isCreate ? 'editor.createTitle' : 'editor.editTitle')}
        closeLabel={t('editor.close')}
        className="agentops-theme-scope agx-editor-dialog"
        contentClassName="agx-editor-content"
        footer={footer}
      >
        {body}
      </Modal>
      <Modal
        open={confirmDelete}
        onClose={() => {
          if (pending === null) setConfirmDelete(false)
        }}
        title={t('editor.deleteTitle')}
        closeLabel={t('common.close')}
        className="agentops-theme-scope agx-confirm-dialog"
        footer={(
          <div className="agx-footer-actions">
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => { setConfirmDelete(false) }}
            >
              {t('editor.cancel')}
            </Button>
            <Button
              variant="primary"
              className="agx-confirm-delete"
              disabled={pending !== null}
              onClick={() => { void deleteAgent() }}
            >
              {pending === 'deleting' ? t('editor.deleting') : t('editor.deleteConfirm')}
            </Button>
          </div>
        )}
      >
        <p className="agx-delete-description">
          {t('editor.deleteDescription', { name: draft.displayName || draft.agentId })}
        </p>
      </Modal>
    </>
  )
}
