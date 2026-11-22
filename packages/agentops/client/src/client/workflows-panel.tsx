/**
 * Workflow catalog page with YAML editing, validation, and a source-backed DAG editor.
 *
 * The catalogue and the open editor are separate selections: filtering the
 * cards never closes the editor for the workflow currently being inspected.
 *
 * @module @agentops/dsh-client/workflows-panel
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import {
  Button,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconListPenOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { loadAgentCatalog, type AgentCatalogEntry } from './agent-catalogue-api.js'
import type { NS } from './locales.js'
import { loadRunHistory, type RunSummary } from './run-history-api.js'
import {
  WorkflowDagCanvas,
  type WorkflowDagEdgeSelection,
} from './workflow-dag-canvas.js'
import {
  createWorkflowSource,
  deleteWorkflowSource,
  editWorkflowSource,
  loadWorkflowCatalog,
  loadWorkflowRunHint,
  loadWorkflowSource,
  saveWorkflowSource,
  validateWorkflowSource,
  type WorkflowCompiledArtifact,
  type WorkflowDataEdge,
  type WorkflowEditOperation,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowIssue,
  type WorkflowNodeType,
  type WorkflowSummary,
  type WorkflowValidationResult,
} from './workflow-editor-api.js'
import {
  createValidationSequence,
  findWorkflowById,
  nodeIdsForIssue,
} from './workflow-editor-logic.js'
import { WorkflowRunForm } from './workflow-run-form.js'
import { WorkflowYamlEditor } from './workflow-yaml-editor.js'

interface ValidatedGraph {
  readonly nodes: readonly WorkflowGraphNode[]
  readonly edges: readonly WorkflowGraphEdge[]
  readonly dataEdges: readonly WorkflowDataEdge[]
}

interface CompiledPreview {
  readonly compiled: WorkflowCompiledArtifact
  readonly source: string
}

type EditorTab = 'canvas' | 'yaml' | 'compiled'
type WorkbenchPanel = 'library' | 'inspector' | null
type SaveStatus = 'idle' | 'saved' | 'conflict'
type WorkflowSort = 'updated' | 'name' | 'nodes'
type WorkflowView = 'cards' | 'table'
type WorkflowSelection =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'schedule-edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'data-edge'; readonly from: string; readonly to: string; readonly port: string }

type LastRunState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly run?: RunSummary }
  | { readonly kind: 'error' }

type WorkflowsTranslate = PropsLocale<typeof NS>['t']

/** Browser services and optional request override for the workflow page. */
export type WorkflowsPanelProps = PropsLocale<typeof NS> & {
  /** Publish a localized success notice outside the panel lifetime. */
  readonly publishSuccess: (text: string) => void
  /** Publish a localized failure notice outside the panel lifetime. */
  readonly publishFailure: (text: string) => void
  /** Fetch implementation, injectable for tests and embedding hosts. */
  readonly fetchImpl?: typeof fetch
}

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DEFAULT_WORKFLOW_ID = 'demo'
const DEFAULT_WORKFLOW_SOURCE = `workflow_id: ${DEFAULT_WORKFLOW_ID}
version: 1
nodes:
  - id: scan
    agent: log_analyst
    role_prompt: 扫描日志
`
const SKELETON_KEYS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] as const
const DEFAULT_AWAIT_COMMAND_PORT = 'command'
const DEFAULT_AWAIT_EXPIRY_SECONDS = '86400'
const DEFAULT_AWAIT_MAX_COMMANDS = '10'

const LOADING_LAST_RUN: LastRunState = { kind: 'loading' }

const RUN_STATUS_KEYS = {
  running: 'page.history.status.running',
  completed: 'page.history.status.completed',
  failed: 'page.history.status.failed',
  cancelled: 'page.history.status.cancelled',
} as const

const NODE_TYPE_KEYS = {
  agent: 'canvas.nodeType.agent',
  command: 'canvas.nodeType.command',
  await_command: 'canvas.nodeType.awaitCommand',
  gateway: 'canvas.nodeType.gateway',
  parallel_branch: 'canvas.nodeType.parallelBranch',
  while: 'canvas.nodeType.while',
} as const satisfies Record<WorkflowNodeType, string>

const NODE_TYPE_DESCRIPTION_KEYS = {
  agent: 'canvas.library.template.agent.description',
  command: 'canvas.library.template.command.description',
  await_command: 'canvas.library.template.awaitCommand.description',
  gateway: 'canvas.library.template.gateway.description',
  parallel_branch: 'canvas.library.template.parallelBranch.description',
  while: 'canvas.library.template.while.description',
} as const satisfies Record<WorkflowNodeType, string>

const NODE_TEMPLATE_GROUPS = [
  { labelKey: 'canvas.library.group.agent', types: ['agent'] },
  { labelKey: 'canvas.library.group.command', types: ['command', 'await_command'] },
  { labelKey: 'canvas.library.group.control', types: ['while', 'parallel_branch', 'gateway'] },
] as const satisfies readonly {
  readonly labelKey: string
  readonly types: readonly WorkflowNodeType[]
}[]

const WORKFLOW_NODE_DRAG_MIME = 'application/agentops-workflow-node'

function isWorkflowNodeType(value: string): value is WorkflowNodeType {
  switch (value) {
    case 'agent':
    case 'command':
    case 'await_command':
    case 'gateway':
    case 'parallel_branch':
    case 'while':
      return true
    default:
      return false
  }
}

function parseNodeIds(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/).map(item => item.trim()).filter(item => item !== ''))]
}

function parsePositiveInteger(value: string): number | null {
  const text = value.trim()
  if (!/^[1-9][0-9]*$/.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatUpdatedAt(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().slice(0, 19).replace('T', ' ')
}

function LastRunSummary({
  state,
  t,
}: {
  readonly state: LastRunState
  readonly t: WorkflowsTranslate
}): ReactElement {
  const run = state.kind === 'loaded' ? state.run : undefined
  return (
    <div className={`wfx-last-run is-${state.kind}`} data-last-run-state={state.kind}>
      <IconClockOutlineRegular aria-hidden="true" />
      <span className="wfx-last-run-label">{t('page.lastRun')}</span>
      {state.kind === 'loading' ? <span>{t('page.lastRunLoading')}</span> : null}
      {state.kind === 'error' ? (
        <span className="wfx-last-run-error">{t('page.lastRunFailed')}</span>
      ) : null}
      {state.kind === 'loaded' && run === undefined ? <span>{t('page.neverRun')}</span> : null}
      {run === undefined ? null : (
        <>
          <span className={`wfx-run-status is-${run.status}`}>{t(RUN_STATUS_KEYS[run.status])}</span>
          <time dateTime={run.startedAt}>
            {t('page.lastRunAt', {
              time: formatUpdatedAt(run.startedAt) ?? t('page.updatedUnknown'),
            })}
          </time>
        </>
      )}
    </div>
  )
}

function selectionExists(graph: ValidatedGraph, selection: WorkflowSelection): boolean {
  switch (selection.kind) {
    case 'node':
      return graph.nodes.some(node => node.id === selection.id)
    case 'schedule-edge':
      return graph.edges.some(edge => edge.from === selection.from && edge.to === selection.to)
    case 'data-edge':
      return graph.dataEdges.some(edge =>
        edge.from === selection.from
        && edge.to === selection.to
        && edge.port === selection.port,
      )
  }
}

function canvasEdgeSelection(selection: WorkflowSelection | null): WorkflowDagEdgeSelection | null {
  if (selection?.kind === 'schedule-edge') {
    return { domain: 'schedule', from: selection.from, to: selection.to }
  }
  if (selection?.kind === 'data-edge') {
    return { domain: 'data', from: selection.from, to: selection.to, port: selection.port }
  }
  return null
}

/**
 * Render the workflow catalogue, source editor, validation issues, and DAG.
 * @param props - localized copy, external toast publishers, and optional fetch implementation.
 * @returns the workflow management page.
 */
export function WorkflowsPanel({
  t,
  publishSuccess,
  publishFailure,
  fetchImpl,
}: WorkflowsPanelProps): ReactElement {
  const requestFetch = fetchImpl ?? fetch
  const [entries, setEntries] = useState<readonly WorkflowSummary[]>([])
  const [dir, setDir] = useState('')
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [sortBy, setSortBy] = useState<WorkflowSort>('updated')
  const [view, setView] = useState<WorkflowView>('cards')
  const [runEntry, setRunEntry] = useState<WorkflowSummary | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createId, setCreateId] = useState(DEFAULT_WORKFLOW_ID)
  const [createSource, setCreateSource] = useState(DEFAULT_WORKFLOW_SOURCE)
  const [createSourceTouched, setCreateSourceTouched] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createIssues, setCreateIssues] = useState<readonly WorkflowIssue[]>([])
  const [creating, setCreating] = useState(false)
  const [deleteEntry, setDeleteEntry] = useState<WorkflowSummary | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [historyEntry, setHistoryEntry] = useState<WorkflowSummary | null>(null)
  const [historyRuns, setHistoryRuns] = useState<readonly RunSummary[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [lastRuns, setLastRuns] = useState<ReadonlyMap<string, LastRunState>>(() => new Map())
  const [dirtyCloseOpen, setDirtyCloseOpen] = useState(false)
  const [pendingEditorAction, setPendingEditorAction] = useState<
    | { readonly kind: 'close' }
    | { readonly kind: 'open'; readonly id: string }
    | null
  >(null)

  const [agents, setAgents] = useState<readonly AgentCatalogEntry[]>([])
  const [agentDir, setAgentDir] = useState('')
  const [agentsMissing, setAgentsMissing] = useState(false)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsError, setAgentsError] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<EditorTab>('canvas')
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState('')
  const [digest, setDigest] = useState<string | null>(null)
  const [sourceReady, setSourceReady] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationOk, setValidationOk] = useState<boolean | null>(null)
  const [issues, setIssues] = useState<readonly WorkflowIssue[]>([])
  const [compileIssues, setCompileIssues] = useState<readonly WorkflowIssue[]>([])
  const [activeIssue, setActiveIssue] = useState<number | null>(null)
  const [issueFocusRequest, setIssueFocusRequest] = useState(0)
  const [graph, setGraph] = useState<ValidatedGraph | null>(null)
  const [compiledPreview, setCompiledPreview] = useState<CompiledPreview | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState('')
  const [reloadRevision, setReloadRevision] = useState(0)
  const [selection, setSelection] = useState<WorkflowSelection | null>(null)
  const [workbenchPanel, setWorkbenchPanel] = useState<WorkbenchPanel>(null)
  const [editingCanvas, setEditingCanvas] = useState(false)
  const [editError, setEditError] = useState('')
  const [editIssues, setEditIssues] = useState<readonly WorkflowIssue[]>([])
  const [newNodeId, setNewNodeId] = useState('')
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>('agent')
  const [newNodeSearch, setNewNodeSearch] = useState('')
  const [newNodeAgent, setNewNodeAgent] = useState('')
  const [newNodeRolePrompt, setNewNodeRolePrompt] = useState('')
  const [newNodeCliTemplate, setNewNodeCliTemplate] = useState('')
  const [newNodeAwaitTargets, setNewNodeAwaitTargets] = useState('')
  const [newNodeAwaitCommandPort, setNewNodeAwaitCommandPort] = useState(DEFAULT_AWAIT_COMMAND_PORT)
  const [newNodeAwaitExpiry, setNewNodeAwaitExpiry] = useState(DEFAULT_AWAIT_EXPIRY_SECONDS)
  const [newNodeAwaitMaxCommands, setNewNodeAwaitMaxCommands] = useState(DEFAULT_AWAIT_MAX_COMMANDS)
  const [newNodeCondition, setNewNodeCondition] = useState('')
  const [newNodeBranches, setNewNodeBranches] = useState('')
  const [newNodeBody, setNewNodeBody] = useState('')
  const [newNodeContinueIf, setNewNodeContinueIf] = useState('')
  const [newNodeMaxIterations, setNewNodeMaxIterations] = useState('10')
  const [nodeFormError, setNodeFormError] = useState('')
  const [dropTargetActive, setDropTargetActive] = useState(false)
  const [dropSelectedType, setDropSelectedType] = useState<WorkflowNodeType | null>(null)
  const [edgeKind, setEdgeKind] = useState<'schedule' | 'data'>('schedule')
  const [edgeFrom, setEdgeFrom] = useState('')
  const [edgeTo, setEdgeTo] = useState('')
  const [edgePort, setEdgePort] = useState('')

  const dirty = sourceReady && draft !== baseline
  const filteredNodeTemplateGroups = useMemo(() => {
    const keyword = newNodeSearch.trim().toLocaleLowerCase()
    return NODE_TEMPLATE_GROUPS.map(group => ({
      labelKey: group.labelKey,
      types: group.types.filter(type => keyword === ''
        || `${t(NODE_TYPE_KEYS[type])} ${t(NODE_TYPE_DESCRIPTION_KEYS[type])} ${type}`.toLocaleLowerCase().includes(keyword)),
    })).filter(group => group.types.length > 0)
  }, [newNodeSearch, t])
  const selectedNodeTemplateVisible = filteredNodeTemplateGroups.some(group =>
    group.types.includes(newNodeType),
  )

  const sessionGeneration = useRef(0)
  const catalogRequest = useRef(0)
  const catalogLoadedRef = useRef(false)
  const historyRequest = useRef(0)
  const lastRunRequest = useRef(0)
  const draftRef = useRef('')
  const editedDuringLoad = useRef(false)
  const validationSequence = useRef(createValidationSequence())
  const loadedId = useRef<string | null>(null)
  const newNodeIdInputRef = useRef<HTMLInputElement | null>(null)
  const nodeFocusFrame = useRef<number | null>(null)

  const loadCatalog = useCallback(async (initial: boolean): Promise<void> => {
    const request = ++catalogRequest.current
    const showInitialLoading = initial && !catalogLoadedRef.current
    if (showInitialLoading) {
      setLoading(true)
      setLoadError('')
    } else {
      setRefreshing(true)
    }
    try {
      const data = await loadWorkflowCatalog(requestFetch)
      if (request !== catalogRequest.current) return
      setEntries(data.entries)
      setDir(data.dir)
      setMissing(data.missing)
      setLoadError('')
      catalogLoadedRef.current = true
    } catch (reason) {
      if (request !== catalogRequest.current) return
      if (catalogLoadedRef.current) {
        publishFailure(t('page.refreshFailed', { message: errorMessage(reason) }))
      } else {
        setLoadError(errorMessage(reason))
      }
    } finally {
      if (request === catalogRequest.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [publishFailure, requestFetch, t])

  useEffect(() => {
    void loadCatalog(true)
    return () => { catalogRequest.current += 1 }
  }, [loadCatalog])

  useEffect(() => {
    const request = ++lastRunRequest.current
    const ids = new Set(entries.map(entry => entry.id))
    setLastRuns((current) => {
      const next = new Map<string, LastRunState>()
      for (const [id] of current) {
        if (ids.has(id)) next.set(id, LOADING_LAST_RUN)
      }
      for (const id of ids) next.set(id, LOADING_LAST_RUN)
      return next
    })

    for (const entry of entries) {
      void loadRunHistory({ workflowId: entry.id, limit: 1 }, requestFetch)
        .then((page) => {
          if (request !== lastRunRequest.current) return
          const run = page.runs[0]
          setLastRuns((current) => {
            const next = new Map(current)
            next.set(entry.id, run === undefined
              ? { kind: 'loaded' }
              : { kind: 'loaded', run })
            return next
          })
        })
        .catch(() => {
          if (request !== lastRunRequest.current) return
          setLastRuns((current) => {
            const next = new Map(current)
            next.set(entry.id, { kind: 'error' })
            return next
          })
        })
    }

    return () => {
      if (lastRunRequest.current === request) lastRunRequest.current += 1
    }
  }, [entries, requestFetch])

  const loadAgents = useCallback(async (): Promise<void> => {
    setAgentsLoading(true)
    setAgentsError('')
    try {
      const catalog = await loadAgentCatalog(requestFetch)
      setAgents(catalog.entries)
      setAgentDir(catalog.dir)
      setAgentsMissing(catalog.missing)
    } catch (reason) {
      setAgentsError(errorMessage(reason))
    } finally {
      setAgentsLoading(false)
    }
  }, [requestFetch])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (agents.length === 0) return
    setNewNodeAgent(current => current === '' ? agents[0]?.id ?? '' : current)
  }, [agents])

  const commitValidation = useCallback((result: WorkflowValidationResult, source: string): void => {
    setValidating(false)
    setEditorError('')
    setValidationOk(result.ok)
    setActiveIssue(null)
    setIssues(result.issues)
    setCompileIssues(result.compileIssues ?? [])
    if (result.nodes !== undefined && result.edges !== undefined && result.dataEdges !== undefined) {
      setGraph({ nodes: result.nodes, edges: result.edges, dataEdges: result.dataEdges })
    }
    if (result.compiled !== undefined) {
      setCompiledPreview({ compiled: result.compiled, source })
    }
  }, [])

  useEffect(() => {
    const sequence = validationSequence.current
    sequence.begin()
    editedDuringLoad.current = false
    if (loadedId.current !== selectedId) setActiveTab('canvas')
    loadedId.current = selectedId
    setDraft('')
    draftRef.current = ''
    setBaseline('')
    setDigest(null)
    setSourceReady(false)
    setEditorLoading(false)
    setEditorError('')
    setValidating(false)
    setValidationOk(null)
    setIssues([])
    setCompileIssues([])
    setActiveIssue(null)
    setIssueFocusRequest(0)
    setGraph(null)
    setCompiledPreview(null)
    setSaving(false)
    setSaveStatus('idle')
    setSaveError('')
    setSelection(null)
    setWorkbenchPanel(null)
    setEditingCanvas(false)
    setEditError('')
    setEditIssues([])
    setNewNodeId('')
    setNewNodeSearch('')
    setDropTargetActive(false)
    setDropSelectedType(null)
    setNewNodeRolePrompt('')
    setNewNodeAwaitTargets('')
    setNewNodeAwaitCommandPort(DEFAULT_AWAIT_COMMAND_PORT)
    setNewNodeAwaitExpiry(DEFAULT_AWAIT_EXPIRY_SECONDS)
    setNewNodeAwaitMaxCommands(DEFAULT_AWAIT_MAX_COMMANDS)
    setEdgeFrom('')
    setEdgeTo('')
    setEdgePort('')

    if (selectedId === null) return

    const generation = ++sessionGeneration.current
    setEditorLoading(true)

    const load = async (): Promise<void> => {
      try {
        const source = await loadWorkflowSource(selectedId, requestFetch)
        if (generation !== sessionGeneration.current) return
        setBaseline(source.text)
        setDigest(source.digest)
        if (!editedDuringLoad.current) {
          draftRef.current = source.text
          setDraft(source.text)
        }
        setSourceReady(true)
        setEditorLoading(false)

        const token = sequence.begin()
        setValidating(true)
        try {
          const result = await validateWorkflowSource(source.text, requestFetch)
          if (generation !== sessionGeneration.current || !sequence.isCurrent(token)) return
          commitValidation(result, source.text)
        } catch (reason) {
          if (generation !== sessionGeneration.current || !sequence.isCurrent(token)) return
          setValidating(false)
          setEditorError(errorMessage(reason))
          setValidationOk(false)
        }
      } catch (reason) {
        if (generation !== sessionGeneration.current) return
        setEditorLoading(false)
        setEditorError(errorMessage(reason))
        setValidationOk(false)
      }
    }

    void load()

    return () => {
      sequence.begin()
      if (sessionGeneration.current === generation) sessionGeneration.current += 1
    }
  }, [commitValidation, reloadRevision, selectedId])

  useEffect(() => {
    if (selectedId === null || !sourceReady || draft === baseline) return
    const sequence = validationSequence.current
    const token = sequence.begin()
    const generation = sessionGeneration.current
    const timer = window.setTimeout(() => {
      if (generation !== sessionGeneration.current || !sequence.isCurrent(token)) return
      setValidating(true)
      void validateWorkflowSource(draft, requestFetch)
        .then((result) => {
          if (generation !== sessionGeneration.current || !sequence.isCurrent(token)) return
          commitValidation(result, draft)
        })
        .catch((reason: unknown) => {
          if (generation !== sessionGeneration.current || !sequence.isCurrent(token)) return
          setValidating(false)
          setEditorError(errorMessage(reason))
          setValidationOk(false)
        })
    }, 350)

    return () => {
      window.clearTimeout(timer)
      if (sequence.isCurrent(token)) sequence.begin()
    }
  }, [baseline, commitValidation, draft, requestFetch, selectedId, sourceReady])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q.length === 0
      ? entries
      : entries.filter(entry =>
        entry.id.toLowerCase().includes(q)
        || entry.file.toLowerCase().includes(q)
        || entry.name.toLowerCase().includes(q),
      )
    return [...filtered].sort((left, right) => {
      switch (sortBy) {
        case 'updated': {
          const leftTime = left.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left.updatedAt)
          const rightTime = right.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right.updatedAt)
          const leftValue = Number.isNaN(leftTime) ? Number.NEGATIVE_INFINITY : leftTime
          const rightValue = Number.isNaN(rightTime) ? Number.NEGATIVE_INFINITY : rightTime
          return rightValue - leftValue || left.name.localeCompare(right.name)
        }
        case 'name':
          return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        case 'nodes':
          return right.nodeCount - left.nodeCount || left.name.localeCompare(right.name)
      }
    })
  }, [entries, query, sortBy])

  const selectedEntry = useMemo(
    () => findWorkflowById(entries, selectedId),
    [entries, selectedId],
  )

  const highlightedNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const issue of issues) {
      for (const id of nodeIdsForIssue(issue)) ids.add(id)
    }
    return ids
  }, [issues])

  useEffect(() => {
    if (selection === null || graph === null) return
    if (!selectionExists(graph, selection)) setSelection(null)
  }, [graph, selection])

  useEffect(() => () => {
    if (nodeFocusFrame.current !== null) cancelAnimationFrame(nodeFocusFrame.current)
  }, [])

  const canvasEdges = useMemo(() => {
    if (graph === null) return []
    return [
      ...graph.edges.map(edge => ({ ...edge, domain: 'schedule' as const })),
      ...graph.dataEdges.map(edge => ({ ...edge, domain: 'data' as const })),
    ]
  }, [graph])

  const selectedCanvasEdge = useMemo(() => canvasEdgeSelection(selection), [selection])
  const selectedNode = useMemo(
    () => selection?.kind === 'node'
      ? graph?.nodes.find(node => node.id === selection.id) ?? null
      : null,
    [graph, selection],
  )

  const canEditCanvas = graph !== null
    && sourceReady
    && !editorLoading
    && !validating
    && validationOk === true
    && !saving
    && saveStatus !== 'conflict'
    && !editingCanvas

  const copyPrompt = useCallback(async (entry: WorkflowSummary) => {
    try {
      const hint = await loadWorkflowRunHint(entry.id, requestFetch)
      await navigator.clipboard.writeText(hint.prompt)
      publishSuccess(t('page.copy.done', { id: entry.id }))
    } catch (reason) {
      publishFailure(t('page.copy.failed', { message: errorMessage(reason) }))
    }
  }, [publishFailure, publishSuccess, requestFetch, t])

  const changeDraft = useCallback((text: string): void => {
    validationSequence.current.begin()
    editedDuringLoad.current = true
    draftRef.current = text
    setDraft(text)
    setValidationOk(null)
    setCompileIssues([])
    setSaveStatus(current => current === 'conflict' ? current : 'idle')
    setSaveError('')
  }, [])

  const saveDraft = useCallback(async (): Promise<void> => {
    if (selectedId === null || !sourceReady || saving || saveStatus === 'conflict') return
    const text = draftRef.current
    setSaving(true)
    setSaveStatus('idle')
    setSaveError('')
    try {
      const result = await saveWorkflowSource(selectedId, text, digest, requestFetch)
      if (result.kind === 'saved') {
        setDigest(result.digest)
        setBaseline(text)
        setSaveStatus('saved')
        if (draftRef.current === text) {
          setValidationOk(true)
          setIssues([])
        }
        publishSuccess(t('page.saved', { id: selectedId }))
        await loadCatalog(false)
      } else if (result.kind === 'conflict') {
        setSaveStatus('conflict')
      } else {
        setValidationOk(false)
        setCompileIssues([])
        setActiveIssue(null)
        setIssues(result.issues)
      }
    } catch (reason) {
      setSaveError(t('editor.saveFailed', { message: errorMessage(reason) }))
    } finally {
      setSaving(false)
    }
  }, [digest, loadCatalog, publishSuccess, requestFetch, saveStatus, saving, selectedId, sourceReady, t])

  const applyCanvasEdit = useCallback(async (operation: WorkflowEditOperation): Promise<boolean> => {
    if (!canEditCanvas) return false
    setEditingCanvas(true)
    setEditError('')
    setEditIssues([])
    try {
      const result = await editWorkflowSource(draftRef.current, operation, requestFetch)
      const hasGraph = result.nodes !== undefined
        && result.edges !== undefined
        && result.dataEdges !== undefined
      if (result.text !== undefined) {
        validationSequence.current.begin()
        editedDuringLoad.current = true
        draftRef.current = result.text
        setDraft(result.text)
      }
      if (hasGraph) {
        setGraph({ nodes: result.nodes, edges: result.edges, dataEdges: result.dataEdges })
      }
      if (result.compiled !== undefined && result.text !== undefined) {
        setCompiledPreview({ compiled: result.compiled, source: result.text })
      }
      setIssues(result.issues)
      setCompileIssues(result.compileIssues ?? [])
      setActiveIssue(null)
      setValidationOk(result.ok)
      setValidating(false)
      setActiveIssue(null)
      setSaveStatus('idle')
      setSaveError('')
      setEditIssues(result.ok ? [] : result.issues)
      if (!result.ok) {
        setEditError(t('canvas.editRejected'))
        return false
      }
      setEditorError('')

      switch (operation.kind) {
        case 'add-node':
          setSelection({ kind: 'node', id: operation.id })
          setWorkbenchPanel('inspector')
          break
        case 'remove-node':
          setSelection(null)
          break
        case 'add-schedule-edge':
          setSelection({ kind: 'schedule-edge', from: operation.from, to: operation.to })
          break
        case 'remove-schedule-edge':
        case 'remove-data-edge':
          setSelection(null)
          break
        case 'add-data-edge':
          setSelection({
            kind: 'data-edge',
            from: operation.from,
            to: operation.to,
            port: operation.port,
          })
          break
      }
      return true
    } catch (reason) {
      setEditError(t('canvas.editFailed', { message: errorMessage(reason) }))
      return false
    } finally {
      setEditingCanvas(false)
    }
  }, [canEditCanvas, requestFetch, t])

  const addNode = useCallback(async (): Promise<void> => {
    const id = newNodeId.trim()
    if (id === '') return
    setNodeFormError('')

    let operation: WorkflowEditOperation
    switch (newNodeType) {
      case 'agent': {
        const agent = newNodeAgent.trim()
        if (agent === '') {
          setNodeFormError(t('canvas.library.requiredField'))
          return
        }
        operation = { kind: 'add-node', id, agent, rolePrompt: newNodeRolePrompt }
        break
      }
      case 'command': {
        const cliTemplate = newNodeCliTemplate.trim()
        if (cliTemplate === '') {
          setNodeFormError(t('canvas.library.requiredField'))
          return
        }
        operation = { kind: 'add-node', id, type: 'command', cliTemplate }
        break
      }
      case 'await_command': {
        if (graph?.nodes.some(node => node.type === 'await_command')) {
          setNodeFormError(t('canvas.library.duplicateAwait'))
          return
        }
        const commandPort = newNodeAwaitCommandPort.trim()
        if (commandPort === '') {
          setNodeFormError(t('canvas.library.requiredField'))
          return
        }
        const expirySeconds = parsePositiveInteger(newNodeAwaitExpiry)
        const maxCommands = parsePositiveInteger(newNodeAwaitMaxCommands)
        if (expirySeconds === null || maxCommands === null) {
          setNodeFormError(t('canvas.library.invalidAwaitNumber'))
          return
        }
        operation = {
          kind: 'add-node',
          id,
          type: 'await_command',
          targetActors: parseNodeIds(newNodeAwaitTargets),
          commandPort,
          expirySeconds,
          maxCommands,
        }
        break
      }
      case 'gateway': {
        const condition = newNodeCondition.trim()
        if (condition === '') {
          setNodeFormError(t('canvas.library.requiredField'))
          return
        }
        operation = { kind: 'add-node', id, type: 'gateway', condition }
        break
      }
      case 'parallel_branch': {
        const branches = parseNodeIds(newNodeBranches)
        if (branches.length === 0) {
          setNodeFormError(t('canvas.library.invalidList'))
          return
        }
        operation = { kind: 'add-node', id, type: 'parallel_branch', branches }
        break
      }
      case 'while': {
        const body = parseNodeIds(newNodeBody)
        const maxIterations = parsePositiveInteger(newNodeMaxIterations)
        if (body.length === 0) {
          setNodeFormError(t('canvas.library.invalidList'))
          return
        }
        if (maxIterations === null) {
          setNodeFormError(t('canvas.library.invalidMaxIterations'))
          return
        }
        operation = {
          kind: 'add-node',
          id,
          type: 'while',
          body,
          continueIf: newNodeContinueIf.trim(),
          maxIterations,
        }
        break
      }
    }

    const applied = await applyCanvasEdit(operation)
    if (!applied) return
    setNewNodeId('')
    setNewNodeAgent('')
    setNewNodeRolePrompt('')
    setNewNodeCliTemplate('')
    setNewNodeAwaitTargets('')
    setNewNodeAwaitCommandPort(DEFAULT_AWAIT_COMMAND_PORT)
    setNewNodeAwaitExpiry(DEFAULT_AWAIT_EXPIRY_SECONDS)
    setNewNodeAwaitMaxCommands(DEFAULT_AWAIT_MAX_COMMANDS)
    setNewNodeCondition('')
    setNewNodeBranches('')
    setNewNodeBody('')
    setNewNodeContinueIf('')
    setNewNodeMaxIterations('10')
    setNodeFormError('')
  }, [
    applyCanvasEdit,
    graph,
    newNodeAgent,
    newNodeAwaitCommandPort,
    newNodeAwaitExpiry,
    newNodeAwaitMaxCommands,
    newNodeAwaitTargets,
    newNodeBody,
    newNodeBranches,
    newNodeCliTemplate,
    newNodeCondition,
    newNodeContinueIf,
    newNodeId,
    newNodeMaxIterations,
    newNodeRolePrompt,
    newNodeType,
    t,
  ])

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(WORKFLOW_NODE_DRAG_MIME)) return
    const payload = event.dataTransfer.getData(WORKFLOW_NODE_DRAG_MIME)
    if (payload !== '' && !isWorkflowNodeType(payload)) {
      setDropTargetActive(false)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTargetActive(true)
  }, [])

  const handleCanvasDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDropTargetActive(false)
  }, [])

  const handleCanvasDrop = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    setDropTargetActive(false)
    if (!event.dataTransfer.types.includes(WORKFLOW_NODE_DRAG_MIME)) return
    const payload = event.dataTransfer.getData(WORKFLOW_NODE_DRAG_MIME)
    if (!isWorkflowNodeType(payload)) return
    event.preventDefault()
    setNewNodeType(payload)
    setNewNodeSearch('')
    setNodeFormError('')
    setWorkbenchPanel('library')
    setDropSelectedType(payload)
    if (nodeFocusFrame.current !== null) cancelAnimationFrame(nodeFocusFrame.current)
    nodeFocusFrame.current = requestAnimationFrame(() => {
      nodeFocusFrame.current = null
      newNodeIdInputRef.current?.focus()
    })
  }, [])

  const removeSelectedNode = useCallback(async (): Promise<void> => {
    if (selection?.kind !== 'node') return
    await applyCanvasEdit({ kind: 'remove-node', id: selection.id })
  }, [applyCanvasEdit, selection])

  const addEdge = useCallback(async (): Promise<void> => {
    const from = edgeFrom.trim()
    const to = edgeTo.trim()
    if (from === '' || to === '') return
    if (edgeKind === 'schedule') {
      await applyCanvasEdit({ kind: 'add-schedule-edge', from, to })
      return
    }
    const port = edgePort.trim()
    if (port === '') return
    await applyCanvasEdit({ kind: 'add-data-edge', from, to, port })
  }, [applyCanvasEdit, edgeFrom, edgeKind, edgePort, edgeTo])

  const removeSelectedEdge = useCallback(async (): Promise<void> => {
    if (selection?.kind === 'schedule-edge') {
      await applyCanvasEdit({
        kind: 'remove-schedule-edge',
        from: selection.from,
        to: selection.to,
      })
      return
    }
    if (selection?.kind === 'data-edge') {
      await applyCanvasEdit({
        kind: 'remove-data-edge',
        from: selection.from,
        to: selection.to,
        port: selection.port,
      })
    }
  }, [applyCanvasEdit, selection])

  const selectNode = useCallback((id: string): void => {
    setSelection({ kind: 'node', id })
    setWorkbenchPanel('inspector')
    setEditError('')
    setEditIssues([])
  }, [])

  const selectEdge = useCallback((edge: WorkflowDagEdgeSelection): void => {
    setSelection(edge.domain === 'data'
      ? { kind: 'data-edge', from: edge.from, to: edge.to, port: edge.port }
      : { kind: 'schedule-edge', from: edge.from, to: edge.to })
    setWorkbenchPanel('inspector')
    setEditError('')
    setEditIssues([])
  }, [])

  const resetCreateForm = useCallback((): void => {
    setCreateId(DEFAULT_WORKFLOW_ID)
    setCreateSource(DEFAULT_WORKFLOW_SOURCE)
    setCreateSourceTouched(false)
    setCreateError('')
    setCreateIssues([])
  }, [])

  const openCreate = useCallback((): void => {
    resetCreateForm()
    setCreateOpen(true)
  }, [resetCreateForm])

  const changeCreateId = useCallback((id: string): void => {
    setCreateId(id)
    setCreateError('')
    if (createSourceTouched) return
    setCreateSource((current) => {
      if (/^workflow_id:\s*.*$/m.test(current)) {
        return current.replace(/^workflow_id:\s*.*$/m, `workflow_id: ${id}`)
      }
      return `workflow_id: ${id}\n${current}`
    })
  }, [createSourceTouched])

  const createWorkflow = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (creating) return
    const id = createId.trim()
    if (!WORKFLOW_ID_PATTERN.test(id)) {
      setCreateError(t('page.workflowIdInvalid'))
      setCreateIssues([])
      return
    }
    setCreating(true)
    setCreateError('')
    setCreateIssues([])
    try {
      const result = await createWorkflowSource(id, createSource, requestFetch)
      if (result.kind === 'conflict') {
        setCreateError(t('page.createConflict'))
        return
      }
      if (result.kind === 'invalid') {
        setCreateIssues(result.issues)
        setCreateError(t('page.createInvalid'))
        return
      }
      publishSuccess(t('page.created', { id }))
      setCreateOpen(false)
      resetCreateForm()
      await loadCatalog(false)
      setSelectedId(id)
      setActiveTab('canvas')
    } catch (reason) {
      setCreateError(t('page.createFailed', { message: errorMessage(reason) }))
    } finally {
      setCreating(false)
    }
  }, [createId, createSource, creating, loadCatalog, publishSuccess, requestFetch, resetCreateForm, t])

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (deleteEntry === null || deleting) return
    const id = deleteEntry.id
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteWorkflowSource(id, requestFetch)
      setEntries(current => current.filter(entry => entry.id !== id))
      setDeleteEntry(null)
      if (selectedId === id) setSelectedId(null)
      publishSuccess(t('page.deleted', { id }))
      await loadCatalog(false)
    } catch (reason) {
      const message = t('page.deleteFailed', { message: errorMessage(reason) })
      setDeleteError(message)
      publishFailure(message)
    } finally {
      setDeleting(false)
    }
  }, [deleteEntry, deleting, loadCatalog, publishFailure, publishSuccess, requestFetch, selectedId, t])

  const loadHistory = useCallback(async (id: string): Promise<void> => {
    const request = ++historyRequest.current
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const page = await loadRunHistory({ workflowId: id }, requestFetch)
      if (request !== historyRequest.current) return
      setHistoryRuns(page.runs)
      setHistoryTotal(page.total)
    } catch (reason) {
      if (request !== historyRequest.current) return
      setHistoryRuns([])
      setHistoryTotal(0)
      setHistoryError(t('page.historyLoadFailed', { message: errorMessage(reason) }))
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false)
    }
  }, [requestFetch, t])

  const openHistory = useCallback((entry: WorkflowSummary): void => {
    setHistoryEntry(entry)
    setHistoryRuns([])
    setHistoryTotal(0)
    setHistoryError('')
    void loadHistory(entry.id)
  }, [loadHistory])

  const closeHistory = useCallback((): void => {
    historyRequest.current += 1
    setHistoryEntry(null)
    setHistoryLoading(false)
  }, [])

  const requestEditorClose = useCallback((): void => {
    if (selectedId === null) return
    setWorkbenchPanel(null)
    if (dirty) {
      setPendingEditorAction({ kind: 'close' })
      setDirtyCloseOpen(true)
      return
    }
    setSelectedId(null)
  }, [dirty, selectedId])

  const openEditor = useCallback((id: string): void => {
    if (selectedId === id) {
      requestEditorClose()
      return
    }
    if (dirty) {
      setPendingEditorAction({ kind: 'open', id })
      setDirtyCloseOpen(true)
      return
    }
    setSelectedId(id)
  }, [dirty, requestEditorClose, selectedId])

  const keepEditing = useCallback((): void => {
    setWorkbenchPanel(null)
    setDirtyCloseOpen(false)
    setPendingEditorAction(null)
  }, [])

  const discardChanges = useCallback((): void => {
    const action = pendingEditorAction
    setWorkbenchPanel(null)
    setDirtyCloseOpen(false)
    setPendingEditorAction(null)
    if (action?.kind === 'open') {
      setSelectedId(action.id)
    } else {
      setSelectedId(null)
    }
  }, [pendingEditorAction])

  const handleEditorKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && workbenchPanel !== null && !dirtyCloseOpen) {
      event.preventDefault()
      event.stopPropagation()
      setWorkbenchPanel(null)
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      void saveDraft()
      return
    }
    if (
      event.key !== 'Delete'
      || activeTab !== 'canvas'
      || selection === null
      || !canEditCanvas
      || createOpen
      || deleteEntry !== null
      || historyEntry !== null
      || runEntry !== null
      || dirtyCloseOpen
    ) {
      return
    }
    const target = event.target
    if (
      target instanceof HTMLElement
      && target.closest('input, textarea, select, [contenteditable="true"]') !== null
    ) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (selection.kind === 'node') {
      void removeSelectedNode()
    } else {
      void removeSelectedEdge()
    }
  }, [
    activeTab,
    canEditCanvas,
    createOpen,
    deleteEntry,
    dirtyCloseOpen,
    historyEntry,
    removeSelectedEdge,
    removeSelectedNode,
    runEntry,
    saveDraft,
    selection,
    workbenchPanel,
  ])

  const compiledStale = compiledPreview !== null
    && (compiledPreview.source !== draft
      || validating
      || validationOk !== true
      || compileIssues.length > 0)
  const status = editorLoading
    ? t('page.loading')
    : validating
      ? t('editor.validating')
      : validationOk === true && compileIssues.length > 0
        ? t('editor.compileInvalid')
        : validationOk === true && issues.length > 0
          ? t('editor.validWithHints', { count: String(issues.length) })
          : validationOk === true
            ? t('editor.valid')
            : validationOk === false
              ? t('editor.invalid')
              : dirty ? t('editor.dirty') : ''

  const focusFirstIssue = useCallback((): void => {
    if (issues.length === 0) return
    setActiveTab('yaml')
    setWorkbenchPanel(null)
    setActiveIssue(0)
    setIssueFocusRequest(current => current + 1)
  }, [issues.length])

  return (
    <div className="ao-page wf-page wfx-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">{t('page.title')}</h1>
          <p className="ao-page-description">{t('page.description')}</p>
        </div>
        <div className="ao-page-actions">
          <Button
            variant="outline"
            icon={<IconRefreshOutlineRegular />}
            disabled={loading || refreshing}
            onClick={() => { void loadCatalog(false) }}
          >
            {refreshing ? t('page.refreshing') : t('page.refresh')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlusOutlineRegular />}
            disabled={loading || missing}
            onClick={openCreate}
          >
            {t('page.create')}
          </Button>
        </div>
      </header>

      <div className="wfx-toolbar" role="search" aria-label={t('page.filterAria')}>
        <Input
          className="wfx-search"
          icon={<IconSearchOutlineRegular />}
          aria-label={t('page.search')}
          placeholder={t('page.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <label className="wfx-sort">
          <span>{t('page.sort')}</span>
          <select
            className="wfx-select"
            aria-label={t('page.sort')}
            value={sortBy}
            onChange={(event) => { setSortBy(event.target.value as WorkflowSort) }}
          >
            <option value="updated">{t('page.sortUpdated')}</option>
            <option value="name">{t('page.sortName')}</option>
            <option value="nodes">{t('page.sortNodes')}</option>
          </select>
        </label>
        <div className="wfx-view-switch" role="group" aria-label={t('page.viewAria')}>
          <Button
            size="sm"
            variant={view === 'cards' ? 'toolbar' : 'ghost'}
            aria-pressed={view === 'cards'}
            onClick={() => { setView('cards') }}
          >
            {t('page.viewCards')}
          </Button>
          <Button
            size="sm"
            variant={view === 'table' ? 'toolbar' : 'ghost'}
            aria-pressed={view === 'table'}
            onClick={() => { setView('table') }}
          >
            {t('page.viewTable')}
          </Button>
        </div>
        <div className="wfx-count">
          {loading && entries.length === 0
            ? t('page.loading')
            : t('page.count', {
              shown: String(shown.length),
              total: String(entries.length),
              dir,
            })}
        </div>
      </div>

      {loading && !catalogLoadedRef.current && (
        <div className="wfx-grid" aria-label={t('page.loading')} aria-busy="true">
          {SKELETON_KEYS.map(key => <span key={key} className="wfx-skeleton" aria-hidden="true" />)}
        </div>
      )}

      {!loading && loadError !== '' && entries.length === 0 && (
        <section className="wfx-error-state" role="alert">
          <IconWarningOutlineRegular />
          <div>
            <h2>{t('page.loadFailed', { message: loadError })}</h2>
            <Button variant="outline" onClick={() => { void loadCatalog(true) }}>
              {t('page.retry')}
            </Button>
          </div>
        </section>
      )}

      {!loading && missing && (
        <section className="wfx-empty-state">
          <h2>{t('page.catalogMissing')}</h2>
          <p>{t('page.missing')}</p>
        </section>
      )}

      {!loading && !missing && loadError === '' && shown.length === 0 && (
        <section className="wfx-empty-state">
          <h2>{query.trim().length > 0 ? t('page.noMatches') : t('page.empty')}</h2>
          {query.trim().length > 0 ? (
            <Button variant="outline" onClick={() => { setQuery('') }}>{t('page.clearSearch')}</Button>
          ) : null}
        </section>
      )}

      {!loading && !missing && loadError === '' && shown.length > 0 && (
        <section className="wfx-results" aria-label={t('page.resultsAria')}>
          {view === 'cards' ? (
            <div className="wfx-grid">
              {shown.map((entry) => {
                const updatedAt = formatUpdatedAt(entry.updatedAt)
                return (
                  <article
                    key={entry.id}
                    className={`wfx-card${selectedId === entry.id ? ' is-selected' : ''}`}
                    data-workflow-id={entry.id}
                  >
                    <header className="wfx-card-header">
                      <div className="wfx-card-heading">
                        <span className="wfx-card-icon" aria-hidden="true"><WorkflowsIcon size={18} /></span>
                        <div className="wfx-card-title-block">
                          <h2>{entry.name}</h2>
                          <p>{entry.id} · {entry.file}</p>
                        </div>
                      </div>
                      <span className={`wfx-status wfx-status-${entry.status}`}>
                        {entry.status === 'verified' ? t('page.verified') : t('page.invalid')}
                      </span>
                    </header>

                    <p className={`wfx-card-description${entry.ok ? '' : ' is-error'}`} title={entry.ok ? undefined : entry.errors.join('；')}>
                      {entry.ok
                        ? t('page.description.valid', {
                          levels: String(entry.levelCount),
                          nodes: String(entry.nodeCount),
                        })
                        : entry.errors.slice(0, 2).join('；')}
                    </p>

                    <div className="wfx-card-tags">
                      <span>{t('page.cardNodeCount', { count: String(entry.nodeCount) })}</span>
                      <span>{t('page.cardEdgeCount', { count: String(entry.edges.length) })}</span>
                      <span>{t('page.cardInputCount', { count: String(entry.inputs.length) })}</span>
                    </div>

                    <LastRunSummary state={lastRuns.get(entry.id) ?? LOADING_LAST_RUN} t={t} />

                    <div className="wfx-card-meta">
                      <span className="wfx-card-updated">
                        <IconClockOutlineRegular />
                        {updatedAt === null
                          ? t('page.updatedUnknown')
                          : t('page.updatedAt', { time: updatedAt })}
                      </span>
                      <code>{entry.id}</code>
                    </div>

                    <footer className="wfx-card-actions">
                      <div className="wfx-card-tools">
                        <Button
                          size="sm"
                          variant="outline"
                          className="wfx-edit-button"
                          icon={<IconEditOutlineRegular />}
                          aria-label={t('page.editWorkflow')}
                          title={t('page.editWorkflow')}
                          onClick={() => { openEditor(entry.id) }}
                        >
                          {t('page.editWorkflow')}
                        </Button>
                        <Tooltip label={t('page.copy.title')} side="bottom" delayMs={400} portal>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="wfx-icon-button"
                            icon={<IconCopyOutlineRegular />}
                            aria-label={t('page.copyInstruction')}
                            title={t('page.copy.title')}
                            onClick={() => { void copyPrompt(entry) }}
                          />
                        </Tooltip>
                        <Tooltip label={t('page.history')} side="bottom" delayMs={400} portal>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="wfx-icon-button"
                            icon={<IconListPenOutlineRegular />}
                            aria-label={t('page.history')}
                            title={t('page.history')}
                            onClick={() => { openHistory(entry) }}
                          />
                        </Tooltip>
                        <Tooltip label={t('page.delete')} side="bottom" delayMs={400} portal>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="wfx-icon-button wfx-icon-button-danger"
                            icon={<IconTrashOutlineRegular />}
                            aria-label={t('page.delete')}
                            title={t('page.delete')}
                            onClick={() => { setDeleteEntry(entry) }}
                          />
                        </Tooltip>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        className="wfx-run-button"
                        icon={<IconPlayOutlineRegular />}
                        aria-label={t('page.run')}
                        title={t('page.run.title')}
                        onClick={() => { setRunEntry(entry) }}
                      >
                        {t('page.run')}
                      </Button>
                    </footer>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="wfx-table-wrap">
              <table className="wfx-table">
                <caption className="wfx-visually-hidden">{t('page.resultsAria')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('page.name')}</th>
                    <th scope="col">{t('page.status')}</th>
                    <th scope="col">{t('page.nodesColumn')}</th>
                    <th scope="col">{t('page.levelsColumn')}</th>
                    <th scope="col">{t('page.inputsColumn')}</th>
                    <th scope="col">{t('page.lastRun')}</th>
                    <th scope="col">{t('page.updated')}</th>
                    <th scope="col">{t('page.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((entry) => {
                    const updatedAt = formatUpdatedAt(entry.updatedAt)
                    return (
                      <tr key={entry.id} className={selectedId === entry.id ? 'is-selected' : undefined}>
                        <td>
                          <button
                            type="button"
                            className="wfx-table-name"
                            onClick={() => { openEditor(entry.id) }}
                          >
                            <strong>{entry.name}</strong>
                            <span>{entry.id} · {entry.file}</span>
                          </button>
                        </td>
                        <td>
                          <span className={`wfx-status wfx-status-${entry.status}`}>
                            {entry.status === 'verified' ? t('page.verified') : t('page.invalid')}
                          </span>
                        </td>
                        <td>{entry.nodeCount}</td>
                        <td>{entry.levelCount}</td>
                        <td>{entry.inputs.length}</td>
                        <td><LastRunSummary state={lastRuns.get(entry.id) ?? LOADING_LAST_RUN} t={t} /></td>
                        <td>{updatedAt === null ? t('page.updatedUnknown') : updatedAt}</td>
                        <td>
                          <div className="wfx-table-actions">
                            <Button
                              size="sm"
                              variant="outline"
                              className="wfx-edit-button"
                              icon={<IconEditOutlineRegular />}
                              aria-label={t('page.editWorkflow')}
                              onClick={() => { openEditor(entry.id) }}
                            >
                              {t('page.editWorkflow')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<IconCopyOutlineRegular />}
                              aria-label={t('page.copyInstruction')}
                              onClick={() => { void copyPrompt(entry) }}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<IconListPenOutlineRegular />}
                              aria-label={t('page.history')}
                              onClick={() => { openHistory(entry) }}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="wfx-icon-button-danger"
                              icon={<IconTrashOutlineRegular />}
                              aria-label={t('page.delete')}
                              onClick={() => { setDeleteEntry(entry) }}
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              icon={<IconPlayOutlineRegular />}
                              aria-label={t('page.run')}
                              onClick={() => { setRunEntry(entry) }}
                            >
                              {t('page.run')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Modal
        headless
        open={selectedEntry !== null}
        onClose={requestEditorClose}
        title={t('page.editorTitle')}
        className="agentops-theme-scope wfx-editor-dialog"
        onKeyDownCapture={handleEditorKeyDownCapture}
      >      {selectedEntry !== null && (
          <section
            className="workflow-editor"
            role="region"
            aria-label={t('page.editorAria', { id: selectedEntry.id })}
          >
            <header className="workflow-editor-header">
              <div className="workflow-editor-title">
                <div className="workflow-card-name">{selectedEntry.name}</div>
                <div className="workflow-card-version">{selectedEntry.file}</div>
              </div>
              <div className="workflow-editor-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'canvas'}
                  className={activeTab === 'canvas' ? 'is-active' : ''}
                  onClick={() => {
                    setActiveTab('canvas')
                    setWorkbenchPanel(null)
                  }}
                >
                  {t('editor.tab.canvas')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'yaml'}
                  className={activeTab === 'yaml' ? 'is-active' : ''}
                  onClick={() => {
                    setActiveTab('yaml')
                    setWorkbenchPanel(null)
                  }}
                >
                  {t('editor.tab.yaml')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'compiled'}
                  className={activeTab === 'compiled' ? 'is-active' : ''}
                  onClick={() => {
                    setActiveTab('compiled')
                    setWorkbenchPanel(null)
                  }}
                >
                  {t('editor.tab.compiled')}
                </button>
              </div>
              <div className="workflow-editor-actions">
                <button
                  type="button"
                  className="btn-sm btn-primary workflow-editor-save-top"
                  disabled={!sourceReady || editorLoading || saving || saveStatus === 'conflict'}
                  onClick={() => { void saveDraft() }}
                >
                  {t('editor.saveTop')}
                </button>
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  onClick={requestEditorClose}
                >
                  {t('page.closeEditor')}
                </button>
              </div>
            </header>

            <div className="workflow-editor-meta">
              {status === '' ? null : (
                <span className={`workflow-editor-status${
                  status === t('editor.invalid')
                    ? ' is-invalid'
                    : status === t('editor.valid') || status === t('editor.validWithHints', { count: String(issues.length) })
                      ? ' is-valid'
                      : ''
                }`}>
                  {status}
                </span>
              )}
              {issues.length === 0 ? null : (
                <button
                  type="button"
                  className="workflow-editor-issue-link"
                  onClick={focusFirstIssue}
                >
                  {validationOk === true
                    ? t('editor.viewHints', { count: String(issues.length) })
                    : t('editor.viewIssues', { count: String(issues.length) })}
                </button>
              )}
              {saveStatus === 'saved' && <span className="workflow-editor-status is-valid">{t('editor.saved')}</span>}
              {saveStatus === 'conflict' && <span className="workflow-editor-status is-error">{t('editor.conflict')}</span>}
              {saveError !== '' && <span className="workflow-editor-status is-error">{saveError}</span>}
              {editorError !== '' && <span className="workflow-editor-status is-error">{t('editor.loadFailed', { message: editorError })}</span>}
              {digest === null ? null : (
                <span className="workflow-editor-digest">{t('editor.digest', { digest })}</span>
              )}
            </div>

            <div className="workflow-editor-panes">
              <div
                className="workflow-editor-pane workflow-editor-canvas-pane"
                hidden={activeTab !== 'canvas'}
              >
                <div
                  className="workflow-canvas-workbench"
                  data-workbench-panel={workbenchPanel ?? 'canvas'}
                >
                  <div className="workflow-canvas-mobile-bar">
                    <button
                      type="button"
                      aria-label={t('canvas.workbench.library')}
                      aria-pressed={workbenchPanel === 'library'}
                      className={workbenchPanel === 'library' ? 'is-active' : ''}
                      onClick={() => {
                        setWorkbenchPanel(current => current === 'library' ? null : 'library')
                      }}
                    >
                      <IconListPenOutlineRegular />
                      <span>{t('canvas.workbench.library')}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('canvas.workbench.inspector')}
                      aria-pressed={workbenchPanel === 'inspector'}
                      className={workbenchPanel === 'inspector' ? 'is-active' : ''}
                      onClick={() => {
                        setWorkbenchPanel(current => current === 'inspector' ? null : 'inspector')
                      }}
                    >
                      <IconEditOutlineRegular />
                      <span>{t('canvas.workbench.inspector')}</span>
                    </button>
                  </div>
                  {workbenchPanel === null ? null : (
                    <button
                      type="button"
                      className="workflow-canvas-scrim"
                      aria-label={workbenchPanel === 'library'
                        ? t('canvas.workbench.closeLibrary')
                        : t('canvas.workbench.closeInspector')}
                      onClick={() => { setWorkbenchPanel(null) }}
                    />
                  )}
                  <aside className="workflow-canvas-library" aria-label={t('canvas.library.title')}>
                    <div className="workflow-canvas-panel-header">
                      <h3>{t('canvas.library.title')}</h3>
                      {newNodeType === 'agent' && !agentsLoading && !agentsMissing && agentsError === ''
                        ? <span>{t('canvas.library.count', { count: String(agents.length) })}</span>
                        : null}
                      <button
                        type="button"
                        className="workflow-canvas-panel-close"
                        aria-label={t('canvas.workbench.closeLibrary')}
                        onClick={() => { setWorkbenchPanel(null) }}
                      >
                        <IconCloseOutlineRegular />
                      </button>
                    </div>
                    <div className="workflow-node-template-search">
                      <IconSearchOutlineRegular aria-hidden="true" />
                      <input
                        type="search"
                        aria-label={t('canvas.library.searchLabel')}
                        placeholder={t('canvas.library.searchPlaceholder')}
                        value={newNodeSearch}
                        onChange={(event) => { setNewNodeSearch(event.target.value) }}
                      />
                      {newNodeSearch === '' ? null : (
                        <Tooltip label={t('canvas.library.clearSearch')} side="bottom" delayMs={400} portal>
                          <button
                            type="button"
                            aria-label={t('canvas.library.clearSearch')}
                            title={t('canvas.library.clearSearch')}
                            onClick={() => { setNewNodeSearch('') }}
                          >
                            <IconCloseOutlineRegular aria-hidden="true" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                    {filteredNodeTemplateGroups.length === 0 ? null : (
                      <div className="workflow-node-template-groups">
                        {filteredNodeTemplateGroups.map(group => (
                          <section className="workflow-node-template-group" key={group.labelKey}>
                            <h4>{t(group.labelKey)}</h4>
                            <div className="workflow-node-template-list">
                              {group.types.map(type => (
                                <button
                                  key={type}
                                  type="button"
                                  className={`workflow-node-template${newNodeType === type ? ' is-active' : ''}`}
                                  draggable
                                  aria-pressed={newNodeType === type}
                                  aria-label={t('canvas.library.selectTemplate', {
                                    type: t(NODE_TYPE_KEYS[type]),
                                  })}
                                  onDragStart={(event) => {
                                    event.dataTransfer.setData(WORKFLOW_NODE_DRAG_MIME, type)
                                    event.dataTransfer.effectAllowed = 'copy'
                                    setDropSelectedType(null)
                                  }}
                                  onDragEnd={() => { setDropTargetActive(false) }}
                                  onClick={() => {
                                    setNewNodeType(type)
                                    setNodeFormError('')
                                    setDropSelectedType(null)
                                  }}
                                >
                                  <span className="workflow-node-template-name">{t(NODE_TYPE_KEYS[type])}</span>
                                  <span className="workflow-node-template-description">
                                    {t(NODE_TYPE_DESCRIPTION_KEYS[type])}
                                  </span>
                                  <span className="workflow-node-template-drag-hint">
                                    {t('canvas.library.dragHint')}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                    {filteredNodeTemplateGroups.length === 0 ? (
                      <p className="workflow-canvas-note workflow-node-template-search-empty">
                        {t('canvas.library.searchEmpty')}
                      </p>
                    ) : null}
                    {selectedNodeTemplateVisible && newNodeType === 'agent' && agentsLoading ? <p className="workflow-canvas-note">{t('canvas.library.loading')}</p> : null}
                    {selectedNodeTemplateVisible && newNodeType === 'agent' && agentsMissing ? <p className="workflow-canvas-note">{t('canvas.library.missing')}</p> : null}
                    {selectedNodeTemplateVisible && newNodeType === 'agent' && agentsError !== '' ? (
                      <div className="workflow-canvas-error" role="alert">
                        <p>{t('canvas.library.loadFailed', { message: agentsError })}</p>
                        <button type="button" className="btn-sm btn-secondary" onClick={() => { void loadAgents() }}>
                          {t('editor.retry')}
                        </button>
                      </div>
                    ) : null}
                    {selectedNodeTemplateVisible && newNodeType === 'agent' && !agentsLoading && agentsError === '' && !agentsMissing && agents.length === 0 ? (
                      <p className="workflow-canvas-note">{t('canvas.library.empty')}</p>
                    ) : null}
                    {selectedNodeTemplateVisible && newNodeType === 'agent' && agents.length > 0 ? (
                      <>
                        <p className="workflow-canvas-note">{t('canvas.library.hint', { dir: agentDir })}</p>
                        <div className="workflow-agent-list">
                          {agents.map(agent => (
                            <button
                              key={agent.id}
                              type="button"
                              className={`workflow-agent-card${newNodeAgent === agent.id ? ' is-active' : ''}`}
                              aria-pressed={newNodeAgent === agent.id}
                              onClick={() => { setNewNodeAgent(agent.id) }}
                            >
                              <span className="workflow-agent-name">{agent.name}</span>
                              <code>{agent.id}</code>
                              <span className="workflow-agent-domain">{agent.domain}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {selectedNodeTemplateVisible ? (
                      <form
                        className="workflow-canvas-form"
                        aria-label={t('canvas.library.addNode')}
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault()
                          void addNode()
                        }}
                      >
                        <label className="workflow-canvas-field">
                          <span>{t('canvas.library.nodeId')}</span>
                          <input
                            ref={newNodeIdInputRef}
                            type="text"
                            value={newNodeId}
                            placeholder={t('canvas.library.nodeIdPlaceholder')}
                            onChange={(event) => {
                              setNewNodeId(event.target.value)
                              setNodeFormError('')
                            }}
                          />
                        </label>
                        {newNodeType === 'agent' ? (
                          <>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.agent')}</span>
                              <select
                                value={newNodeAgent}
                                onChange={(event) => {
                                  setNewNodeAgent(event.target.value)
                                  setNodeFormError('')
                                }}
                              >
                                {agents.length === 0 ? <option value="">{t('canvas.library.noAgent')}</option> : null}
                                {agents.map(agent => (
                                  <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>
                                ))}
                              </select>
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.rolePrompt')}</span>
                              <textarea
                                value={newNodeRolePrompt}
                                rows={3}
                                placeholder={t('canvas.library.rolePromptPlaceholder')}
                                onChange={(event) => {
                                  setNewNodeRolePrompt(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                          </>
                        ) : null}
                        {newNodeType === 'command' ? (
                          <label className="workflow-canvas-field">
                            <span>{t('canvas.library.cliTemplate')}</span>
                            <textarea
                              value={newNodeCliTemplate}
                              rows={3}
                              placeholder={t('canvas.library.cliTemplatePlaceholder')}
                              onChange={(event) => {
                                setNewNodeCliTemplate(event.target.value)
                                setNodeFormError('')
                              }}
                            />
                          </label>
                        ) : null}
                        {newNodeType === 'await_command' ? (
                          <>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.awaitTargets')}</span>
                              <textarea
                                aria-label={t('canvas.library.awaitTargets')}
                                value={newNodeAwaitTargets}
                                rows={2}
                                placeholder={t('canvas.library.awaitListHint')}
                                onChange={(event) => {
                                  setNewNodeAwaitTargets(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                              <small>{t('canvas.library.awaitListHint')}</small>
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.awaitCommandPort')}</span>
                              <input
                                type="text"
                                value={newNodeAwaitCommandPort}
                                onChange={(event) => {
                                  setNewNodeAwaitCommandPort(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.awaitExpirySeconds')}</span>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={newNodeAwaitExpiry}
                                onChange={(event) => {
                                  setNewNodeAwaitExpiry(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.awaitMaxCommands')}</span>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={newNodeAwaitMaxCommands}
                                onChange={(event) => {
                                  setNewNodeAwaitMaxCommands(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                          </>
                        ) : null}
                        {newNodeType === 'gateway' ? (
                          <label className="workflow-canvas-field">
                            <span>{t('canvas.library.condition')}</span>
                            <textarea
                              value={newNodeCondition}
                              rows={3}
                              placeholder={t('canvas.library.conditionPlaceholder')}
                              onChange={(event) => {
                                setNewNodeCondition(event.target.value)
                                setNodeFormError('')
                              }}
                            />
                          </label>
                        ) : null}
                        {newNodeType === 'parallel_branch' ? (
                          <label className="workflow-canvas-field">
                            <span>{t('canvas.library.branches')}</span>
                            <input
                              type="text"
                              aria-label={t('canvas.library.branches')}
                              value={newNodeBranches}
                              placeholder={t('canvas.library.branchesPlaceholder')}
                              onChange={(event) => {
                                setNewNodeBranches(event.target.value)
                                setNodeFormError('')
                              }}
                            />
                            <small>{t('canvas.library.listSeparatorHint')}</small>
                          </label>
                        ) : null}
                        {newNodeType === 'while' ? (
                          <>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.body')}</span>
                              <textarea
                                aria-label={t('canvas.library.body')}
                                value={newNodeBody}
                                rows={3}
                                placeholder={t('canvas.library.bodyPlaceholder')}
                                onChange={(event) => {
                                  setNewNodeBody(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                              <small>{t('canvas.library.listSeparatorHint')}</small>
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.continueIf')}</span>
                              <input
                                type="text"
                                value={newNodeContinueIf}
                                placeholder={t('canvas.library.continueIfPlaceholder')}
                                onChange={(event) => {
                                  setNewNodeContinueIf(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                            <label className="workflow-canvas-field">
                              <span>{t('canvas.library.maxIterations')}</span>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={newNodeMaxIterations}
                                onChange={(event) => {
                                  setNewNodeMaxIterations(event.target.value)
                                  setNodeFormError('')
                                }}
                              />
                            </label>
                          </>
                        ) : null}
                        {newNodeType === 'agent' ? null : (
                          <p className="workflow-canvas-note">{t('canvas.library.agentOnlyNotice')}</p>
                        )}
                        {nodeFormError === '' ? null : (
                          <p className="workflow-canvas-error" role="alert">{nodeFormError}</p>
                        )}
                        <button
                          type="submit"
                          className="btn-sm btn-primary"
                          disabled={!canEditCanvas || newNodeId.trim() === ''}
                        >
                          {editingCanvas ? t('canvas.applying') : t('canvas.library.addNode')}
                        </button>
                      </form>
                    ) : null}
                  </aside>

                  <div
                    className={`workflow-canvas-stage${dropTargetActive ? ' is-drop-target' : ''}`}
                    onDragOver={handleCanvasDragOver}
                    onDragLeave={handleCanvasDragLeave}
                    onDrop={handleCanvasDrop}
                  >
                    <div className="workflow-canvas-drop-feedback" aria-live="polite" aria-atomic="true">
                      {dropTargetActive
                        ? t('canvas.library.dropReady')
                        : dropSelectedType === null
                          ? null
                          : t('canvas.library.dropSelected', {
                            type: t(NODE_TYPE_KEYS[dropSelectedType]),
                          })}
                    </div>
                    {graph === null ? (
                      <p className="workflow-editor-unavailable">{t('editor.graphUnavailable')}</p>
                    ) : (
                      <WorkflowDagCanvas
                        workflowId={selectedEntry.id}
                        nodes={graph.nodes}
                        edges={canvasEdges}
                        highlightedNodeIds={highlightedNodeIds}
                        caption={t('page.caption', {
                          file: selectedEntry.file,
                          nodes: String(graph.nodes.length),
                          levels: String(new Set(graph.nodes.map(node => node.level)).size),
                        })}
                        emptyText={t('page.graphEmpty')}
                        tooManyText={t('page.graphTooLarge')}
                        ariaLabel={t('page.graphAria', {
                          id: selectedEntry.id,
                          nodes: String(graph.nodes.length),
                          edges: String(graph.edges.length + graph.dataEdges.length),
                        })}
                        layerLabel={level => t('page.layer', { level: String(level) })}
                        nodeTypeLabel={type => t(NODE_TYPE_KEYS[type])}
                        nodeInputsLabel={count => t('canvas.node.inputs', { count: String(count) })}
                        nodeOutputsLabel={ports => t('canvas.node.outputs', { ports: ports.join(', ') })}
                        nodeNoOutputsLabel={t('canvas.node.noOutputs')}
                        editable={canEditCanvas}
                        selectable
                        {...(selection?.kind === 'node' ? { selectedNodeId: selection.id } : {})}
                        {...(selectedCanvasEdge === null ? {} : { selectedEdge: selectedCanvasEdge })}
                        onNodeSelect={selectNode}
                        onEdgeSelect={selectEdge}
                        nodeAriaLabel={(id) => {
                          const level = graph.nodes.find(node => node.id === id)?.level ?? -1
                          return t('canvas.nodeAria', { id, level: String(level) })
                        }}
                        edgeAriaLabel={edge => edge.domain === 'data'
                          ? t('canvas.dataEdgeAria', {
                            from: edge.from,
                            to: edge.to,
                            port: edge.port,
                          })
                          : t('canvas.scheduleEdgeAria', { from: edge.from, to: edge.to })}
                        zoomLabels={{
                          controlsAria: t('canvas.zoom.controlsAria'),
                          zoomIn: t('canvas.zoom.in'),
                          zoomOut: t('canvas.zoom.out'),
                          fit: t('canvas.zoom.fit'),
                          reset: t('canvas.zoom.reset'),
                          value: percent => t('canvas.zoom.value', { percent: String(percent) }),
                        }}
                      />
                    )}
                  </div>

                  <aside className="workflow-canvas-inspector" aria-label={t('canvas.inspector.title')}>
                    <div className="workflow-canvas-panel-header">
                      <h3>{t('canvas.inspector.title')}</h3>
                      <span>{t('canvas.inspector.sourceOnly')}</span>
                      <button
                        type="button"
                        className="workflow-canvas-panel-close"
                        aria-label={t('canvas.workbench.closeInspector')}
                        onClick={() => { setWorkbenchPanel(null) }}
                      >
                        <IconCloseOutlineRegular />
                      </button>
                    </div>

                    {selection === null ? (
                      <p className="workflow-canvas-note">{t('canvas.inspector.empty')}</p>
                    ) : null}

                    {selectedNode !== null ? (
                      <section className="workflow-inspector-section" aria-label={t('canvas.inspector.node')}>
                        <h4>{t('canvas.inspector.node')}</h4>
                        <dl className="workflow-inspector-grid">
                          <div><dt>{t('canvas.inspector.id')}</dt><dd><code>{selectedNode.id}</code></dd></div>
                          <div>
                            <dt>{t('canvas.inspector.displayName')}</dt>
                            <dd>{selectedNode.displayName ?? t('canvas.inspector.none')}</dd>
                          </div>
                          <div>
                            <dt>{t('canvas.inspector.type')}</dt>
                            <dd>
                              {selectedNode.type === undefined
                                ? t('canvas.inspector.none')
                                : t(NODE_TYPE_KEYS[selectedNode.type])}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('canvas.inspector.businessRole')}</dt>
                            <dd>{selectedNode.businessRole ?? t('canvas.inspector.none')}</dd>
                          </div>
                          <div><dt>{t('canvas.inspector.level')}</dt><dd>{selectedNode.level}</dd></div>
                          <div>
                            <dt>{t('canvas.inspector.agent')}</dt>
                            <dd>{selectedNode.agentRef ?? t('canvas.inspector.none')}</dd>
                          </div>
                          {selectedNode.timeoutMs === undefined ? null : (
                            <div><dt>{t('canvas.inspector.timeout')}</dt><dd>{selectedNode.timeoutMs} ms</dd></div>
                          )}
                          {selectedNode.gatewayKind === undefined ? null : (
                            <div><dt>{t('canvas.inspector.gatewayKind')}</dt><dd>{selectedNode.gatewayKind}</dd></div>
                          )}
                          {selectedNode.skipIf === undefined ? null : (
                            <div><dt>{t('canvas.inspector.skipIf')}</dt><dd><code>{selectedNode.skipIf}</code></dd></div>
                          )}
                          {selectedNode.joinStrategy === undefined ? null : (
                            <div><dt>{t('canvas.inspector.joinStrategy')}</dt><dd>{selectedNode.joinStrategy}</dd></div>
                          )}
                          {selectedNode.cancelOnFirstFail === undefined ? null : (
                            <div>
                              <dt>{t('canvas.inspector.cancelOnFirstFail')}</dt>
                              <dd>{selectedNode.cancelOnFirstFail ? 'true' : 'false'}</dd>
                            </div>
                          )}
                        </dl>
                        <div className="workflow-inspector-block">
                          <span>{t('canvas.inspector.rolePrompt')}</span>
                          <pre>{selectedNode.rolePrompt}</pre>
                        </div>
                        <div className="workflow-inspector-block">
                          <span>{t('canvas.inspector.after')}</span>
                          <p>{selectedNode.after.length === 0 ? t('canvas.inspector.none') : selectedNode.after.join(', ')}</p>
                        </div>
                        <div className="workflow-inspector-block">
                          <span>{t('canvas.inspector.inputs')}</span>
                          <p>{selectedNode.inputs.length === 0 ? t('canvas.inspector.none') : selectedNode.inputs.join(', ')}</p>
                        </div>
                        <div className="workflow-inspector-block">
                          <span>{t('canvas.inspector.outputs')}</span>
                          {Object.keys(selectedNode.outputs).length === 0 ? (
                            <p>{t('canvas.inspector.none')}</p>
                          ) : (
                            <ul>
                              {Object.entries(selectedNode.outputs).map(([port, targets]) => (
                                <li key={port}><code>{port}</code> → {targets.join(', ')}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        {selectedNode.condition === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.condition')}</span>
                            <pre>{selectedNode.condition}</pre>
                          </div>
                        )}
                        {selectedNode.branches === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.branches')}</span>
                            <p>{selectedNode.branches.length === 0 ? t('canvas.inspector.none') : selectedNode.branches.join(', ')}</p>
                          </div>
                        )}
                        {selectedNode.body === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.body')}</span>
                            <p>{selectedNode.body.length === 0 ? t('canvas.inspector.none') : selectedNode.body.join(', ')}</p>
                          </div>
                        )}
                        {selectedNode.continueIf === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.continueIf')}</span>
                            <pre>{selectedNode.continueIf}</pre>
                          </div>
                        )}
                        {selectedNode.maxIterations === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.maxIterations')}</span>
                            <p>{selectedNode.maxIterations}</p>
                          </div>
                        )}
                        {selectedNode.commandConfig === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.commandConfig')}</span>
                            <pre>{JSON.stringify(selectedNode.commandConfig, null, 2)}</pre>
                          </div>
                        )}
                        {selectedNode.awaitCommandConfig === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.awaitCommandConfig')}</span>
                            <dl className="workflow-inspector-grid">
                              <div>
                                <dt>{t('canvas.inspector.targetActors')}</dt>
                                <dd>
                                  {selectedNode.awaitCommandConfig.targetActors.length === 0
                                    ? t('canvas.inspector.none')
                                    : selectedNode.awaitCommandConfig.targetActors.join(', ')}
                                </dd>
                              </div>
                              <div>
                                <dt>{t('canvas.inspector.commandPort')}</dt>
                                <dd><code>{selectedNode.awaitCommandConfig.commandPort}</code></dd>
                              </div>
                              <div>
                                <dt>{t('canvas.inspector.expirySeconds')}</dt>
                                <dd>{selectedNode.awaitCommandConfig.expirySeconds}</dd>
                              </div>
                              <div>
                                <dt>{t('canvas.inspector.maxCommands')}</dt>
                                <dd>{selectedNode.awaitCommandConfig.maxCommands}</dd>
                              </div>
                            </dl>
                          </div>
                        )}
                        {selectedNode.whileConfig === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.whileConfig')}</span>
                            <pre>{JSON.stringify(selectedNode.whileConfig, null, 2)}</pre>
                          </div>
                        )}
                        {selectedNode.rawFields === undefined ? null : (
                          <div className="workflow-inspector-block">
                            <span>{t('canvas.inspector.rawFields')}</span>
                            <pre>{JSON.stringify(selectedNode.rawFields, null, 2)}</pre>
                          </div>
                        )}
                        <button
                          type="button"
                          className="btn-sm btn-secondary workflow-danger-button"
                          disabled={!canEditCanvas}
                          onClick={() => { void removeSelectedNode() }}
                        >
                          {t('canvas.inspector.removeNode')}
                        </button>
                      </section>
                    ) : null}

                    {selection?.kind === 'schedule-edge' || selection?.kind === 'data-edge' ? (
                      <section className="workflow-inspector-section" aria-label={t('canvas.inspector.edge')}>
                        <h4>{t('canvas.inspector.edge')}</h4>
                        <dl className="workflow-inspector-grid">
                          <div><dt>{t('canvas.inspector.edgeKind')}</dt><dd>{t(selection.kind === 'data-edge' ? 'canvas.edge.data' : 'canvas.edge.schedule')}</dd></div>
                          <div><dt>{t('canvas.inspector.from')}</dt><dd><code>{selection.from}</code></dd></div>
                          <div><dt>{t('canvas.inspector.to')}</dt><dd><code>{selection.to}</code></dd></div>
                          {selection.kind === 'data-edge' ? (
                            <div><dt>{t('canvas.inspector.port')}</dt><dd><code>{selection.port}</code></dd></div>
                          ) : null}
                        </dl>
                        <button
                          type="button"
                          className="btn-sm btn-secondary workflow-danger-button"
                          disabled={!canEditCanvas}
                          onClick={() => { void removeSelectedEdge() }}
                        >
                          {t('canvas.inspector.removeEdge')}
                        </button>
                      </section>
                    ) : null}

                    <form
                      className="workflow-canvas-form workflow-inspector-section"
                      aria-label={t('canvas.inspector.addEdge')}
                      onSubmit={(event) => {
                        event.preventDefault()
                        void addEdge()
                      }}
                    >
                      <h4>{t('canvas.inspector.addEdge')}</h4>
                      <label className="workflow-canvas-field">
                        <span>{t('canvas.inspector.edgeKind')}</span>
                        <select
                          value={edgeKind}
                          onChange={(event) => { setEdgeKind(event.target.value === 'data' ? 'data' : 'schedule') }}
                        >
                          <option value="schedule">{t('canvas.edge.schedule')}</option>
                          <option value="data">{t('canvas.edge.data')}</option>
                        </select>
                      </label>
                      <label className="workflow-canvas-field">
                        <span>{t('canvas.inspector.from')}</span>
                        <select value={edgeFrom} onChange={(event) => { setEdgeFrom(event.target.value) }}>
                          <option value="">{t('canvas.inspector.chooseNode')}</option>
                          {(graph?.nodes ?? []).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}
                        </select>
                      </label>
                      <label className="workflow-canvas-field">
                        <span>{t('canvas.inspector.to')}</span>
                        <select value={edgeTo} onChange={(event) => { setEdgeTo(event.target.value) }}>
                          <option value="">{t('canvas.inspector.chooseNode')}</option>
                          {(graph?.nodes ?? []).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}
                        </select>
                      </label>
                      {edgeKind === 'data' ? (
                        <label className="workflow-canvas-field">
                          <span>{t('canvas.inspector.port')}</span>
                          <input
                            type="text"
                            value={edgePort}
                            placeholder={t('canvas.inspector.portPlaceholder')}
                            onChange={(event) => { setEdgePort(event.target.value) }}
                          />
                        </label>
                      ) : null}
                      <button
                        type="submit"
                        className="btn-sm btn-primary"
                        disabled={!canEditCanvas
                        || edgeFrom.trim() === ''
                        || edgeTo.trim() === ''
                        || (edgeKind === 'data' && edgePort.trim() === '')}
                      >
                        {editingCanvas ? t('canvas.applying') : t('canvas.inspector.addEdge')}
                      </button>
                    </form>

                    {editError === '' ? null : <p className="workflow-canvas-error" role="alert">{editError}</p>}
                    {editIssues.length === 0 ? null : (
                      <ul className="workflow-canvas-issues" aria-label={t('canvas.editIssues')}>
                        {editIssues.map((issue, index) => (
                          <li key={`${issue.path}:${index}`}>{t('yaml.issue.path', { path: issue.path, message: issue.message })}</li>
                        ))}
                      </ul>
                    )}
                  </aside>
                </div>
                {graph !== null && validationOk === false && (
                  <p className="workflow-editor-stale">{t('editor.stale')}</p>
                )}
              </div>

              <div className="workflow-editor-pane" hidden={activeTab !== 'yaml'}>
                <WorkflowYamlEditor
                  text={draft}
                  onChange={changeDraft}
                  onSave={() => { void saveDraft() }}
                  issues={issues}
                  activeIssue={activeIssue}
                  onIssueSelect={setActiveIssue}
                  focusRequest={issueFocusRequest}
                  disabled={editorLoading || saving}
                  t={t}
                />
              </div>

              <div className="workflow-editor-pane" hidden={activeTab !== 'compiled'}>
                {compiledPreview === null ? (
                  <p className="workflow-editor-unavailable">{t('compiled.empty')}</p>
                ) : (
                  <section
                    className="workflow-compiled-preview"
                    role="region"
                    aria-label={t('compiled.title')}
                  >
                    <header className="workflow-compiled-header">
                      <h3>{t('compiled.title')}</h3>
                      {compiledStale ? (
                        <p className="workflow-compiled-stale" role="status">{t('compiled.stale')}</p>
                      ) : null}
                    </header>

                    <div className="workflow-compiled-facts">
                      <section className="workflow-compiled-layers">
                        <h4>{t('compiled.layers')}</h4>
                        <ol>
                          {compiledPreview.compiled.layers.map((layer, level) => (
                            <li key={String(level)}>
                              <span>{t('compiled.layer', { level: String(level) })}</span>
                              <div>
                                {layer.map(id => <code key={id}>{id}</code>)}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>
                      <section className="workflow-compiled-digest">
                        <h4>{t('compiled.digest')}</h4>
                        <code>{compiledPreview.compiled.digest}</code>
                      </section>
                    </div>

                    <section className="workflow-compiled-source">
                      <h4>{t('compiled.source')}</h4>
                      <pre><code>{compiledPreview.compiled.source}</code></pre>
                    </section>

                    <section className="workflow-compiled-limitations">
                      <h4>{t('compiled.limitations')}</h4>
                      <ul>
                        <li>{t('compiled.limitation.dataPorts')}</li>
                        <li>{t('compiled.limitation.retryTimeout')}</li>
                        <li>{t('compiled.limitation.ptc')}</li>
                        <li>{t('compiled.limitation.yamlAuthority')}</li>
                      </ul>
                    </section>
                  </section>
                )}
              </div>
            </div>

            <footer className="workflow-editor-footer">
              <span className={`workflow-editor-dirty${dirty ? ' is-dirty' : ''}`}>
                {dirty ? t('editor.dirty') : ''}
              </span>
              {saveStatus === 'conflict' && (
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  onClick={() => { setReloadRevision(value => value + 1) }}
                >
                  {t('editor.reloadDisk')}
                </button>
              )}
              <button
                type="button"
                className="btn-sm btn-primary"
                disabled={!sourceReady || editorLoading || saving || saveStatus === 'conflict'}
                onClick={() => { void saveDraft() }}
              >
                {saving ? t('editor.saving') : t('editor.save')}
              </button>
            </footer>
          </section>
        )}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => { if (!creating) setCreateOpen(false) }}
        title={t('page.create.title')}
        description={t('page.create.description')}
        closeLabel={t('page.close')}
        className="agentops-theme-scope wfx-form-dialog"
        contentClassName="wfx-form-content"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreateOpen(false) }} disabled={creating}>
              {t('page.create.cancel')}
            </Button>
            <Button type="submit" form="wfx-create-form" variant="primary" disabled={creating}>
              {creating ? t('page.create.submitting') : t('page.create.submit')}
            </Button>
          </>
        )}
      >
        <form id="wfx-create-form" className="wfx-form" onSubmit={(event) => { void createWorkflow(event) }}>
          <label className="wfx-field" htmlFor="wfx-create-id">
            <span>{t('page.create.id')}</span>
            <Input
              id="wfx-create-id"
              className="wfx-field-control"
              value={createId}
              placeholder={t('page.create.idPlaceholder')}
              autoComplete="off"
              aria-invalid={createError !== ''}
              onChange={(event) => { changeCreateId(event.target.value) }}
            />
          </label>
          <label className="wfx-field" htmlFor="wfx-create-source">
            <span>{t('page.create.source')}</span>
            <textarea
              id="wfx-create-source"
              className="wfx-textarea"
              value={createSource}
              placeholder={t('page.create.sourcePlaceholder')}
              spellCheck={false}
              aria-invalid={createError !== ''}
              onChange={(event) => {
                setCreateSourceTouched(true)
                setCreateSource(event.target.value)
                setCreateError('')
                setCreateIssues([])
              }}
            />
          </label>
          {createError === '' ? null : <p className="wfx-form-error" role="alert">{createError}</p>}
          {createIssues.length === 0 ? null : (
            <div className="wfx-issue-list" role="alert">
              <strong>{t('yaml.issues.title')}</strong>
              <ul>
                {createIssues.map(issue => (
                  <li key={`${issue.path}:${String(issue.line ?? '')}:${issue.message}`}>
                    {issue.line === undefined
                      ? t('yaml.issue.path', { path: issue.path, message: issue.message })
                      : t('yaml.issue.position', { line: String(issue.line), message: issue.message })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={deleteEntry !== null}
        onClose={() => { if (!deleting) setDeleteEntry(null) }}
        title={t('page.delete.title')}
        description={deleteEntry === null ? '' : t('page.delete.description', { name: deleteEntry.name })}
        closeLabel={t('page.close')}
        className="agentops-theme-scope wfx-form-dialog"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDeleteEntry(null) }} disabled={deleting}>
              {t('page.delete.cancel')}
            </Button>
            <Button
              variant="primary"
              className="wfx-danger-button"
              disabled={deleting}
              onClick={() => { void confirmDelete() }}
            >
              {deleting ? t('page.delete.deleting') : t('page.delete.confirm')}
            </Button>
          </>
        )}
      >
        {deleteError === '' ? null : <p className="wfx-form-error" role="alert">{deleteError}</p>}
      </Modal>

      <Modal
        open={historyEntry !== null}
        onClose={closeHistory}
        title={historyEntry === null ? t('page.history.title', { id: '' }) : t('page.history.title', { id: historyEntry.id })}
        description={t('page.history.description')}
        closeLabel={t('page.history.close')}
        className="agentops-theme-scope wfx-history-dialog"
        contentClassName="wfx-history-content"
        footer={(
          <>
            <Button variant="outline" onClick={closeHistory}>{t('page.history.close')}</Button>
            <Button
              variant="primary"
              disabled={historyLoading || historyEntry === null}
              onClick={() => { if (historyEntry !== null) void loadHistory(historyEntry.id) }}
            >
              {t('page.history.retry')}
            </Button>
          </>
        )}
      >
        {historyLoading ? (
          <div className="wfx-history-loading" aria-busy="true">
            <span className="wfx-skeleton" aria-hidden="true" />
            <span className="wfx-skeleton" aria-hidden="true" />
            <span className="wfx-skeleton" aria-hidden="true" />
          </div>
        ) : historyError !== '' ? (
          <div className="wfx-error-state" role="alert">
            <IconWarningOutlineRegular />
            <p>{historyError}</p>
          </div>
        ) : historyRuns.length === 0 ? (
          <div className="wfx-empty-state wfx-history-empty">
            <h2>{t('page.history.empty')}</h2>
            <p>{t('page.history.emptyHint')}</p>
          </div>
        ) : (
          <>
            <p className="wfx-history-count">
              {t('page.history.count', {
                shown: String(historyRuns.length),
                total: String(historyTotal),
              })}
            </p>
            <ul className="wfx-history-list">
              {historyRuns.map(run => (
                <li key={run.runId} className={`wfx-history-item is-${run.status}`}>
                  <div className="wfx-history-main">
                    <div>
                      <code>{run.runId}</code>
                      <span className={`wfx-run-status is-${run.status}`}>
                        {t(RUN_STATUS_KEYS[run.status])}
                      </span>
                    </div>
                    <p>
                      {t('page.history.startedAt', {
                        time: formatUpdatedAt(run.startedAt) ?? t('page.updatedUnknown'),
                      })}
                      {run.finishedAt === undefined
                        ? ` · ${t('page.history.notFinished')}`
                        : ` · ${t('page.history.finishedAt', {
                          time: formatUpdatedAt(run.finishedAt) ?? t('page.updatedUnknown'),
                        })}`}
                    </p>
                    {run.error === undefined ? null : (
                      <p className="wfx-history-error">{t('page.history.error', { message: run.error })}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>

      <Modal
        open={dirtyCloseOpen}
        onClose={keepEditing}
        title={t('page.dirty.title')}
        description={t('page.dirty.description')}
        closeLabel={t('page.close')}
        className="agentops-theme-scope wfx-form-dialog"
        footer={(
          <>
            <Button variant="outline" onClick={discardChanges}>{t('page.dirty.discard')}</Button>
            <Button variant="primary" onClick={keepEditing}>{t('page.dirty.keep')}</Button>
          </>
        )}
      >
        <p className="wfx-form-note">{t('page.dirty.warning')}</p>
      </Modal>

      {runEntry !== null && (
        <WorkflowRunForm
          t={t}
          entry={runEntry}
          fetchImpl={requestFetch}
          onClose={() => { setRunEntry(null) }}
          onStarted={(result) => {
            setRunEntry(null)
            publishSuccess(t('page.run.started', { id: result.sessionId }))
          }}
        />
      )}    </div>
  )
}

/**
 * Render the workflow-management sidebar icon.
 * @param props - icon edge length.
 * @returns the workflow glyph.
 */
export function WorkflowsIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="9" y="15" width="6" height="6" rx="1.5" />
      <path d="M6 9v3h12V9M12 12v3" strokeLinecap="round" />
    </svg>
  )
}
