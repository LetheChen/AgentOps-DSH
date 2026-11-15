/**
 * Persisted-run collaboration panel.
 *
 * A run's activity is the only source of truth: business lanes and nodes,
 * scheduling dependencies, declared data flow, persisted timelines, and node
 * execution details all come from one validated activity payload.
 *
 * @module @agentops/dsh-client/collaboration-panel
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Menu, MenuItemButton, Modal, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  CollaborationRequestError,
  loadRunActivity,
  requestNodeRerun,
  RerunRequestError,
  type ActivityLane,
  type ActivityNode,
  type ActivityNodeStatus,
  type ActivityNodeType,
  type ActivityRunStatus,
  type ActivityTimelineEntry,
  type ActivityTimelineType,
  type RerunErrorCode,
  type RunActivity,
} from './collaboration-api.js'
import { takeCollaborationRun } from './collaboration-target.js'
import { scheduleLevels } from './collaboration-layout.js'
import {
  browserScheduler,
  browserVisibility,
  createCollaborationPoller,
} from './collaboration-polling.js'
import { COLLAB_NS, type CollaborationKey } from './collaboration-locales.js'
import { loadActorRegistry, type ActorRegistryEntry } from './registry-api.js'
import { loadRunHistory, type RunSummary } from './run-history-api.js'
import { appendRunSummaries } from './run-summary-page.js'
import { WorkflowDagCanvas } from './workflow-dag-canvas.js'

const PAGE_SIZE = 50

type CollaborationTranslate = PropsLocale<typeof COLLAB_NS>['t']
type CollaborationView = 'graph' | 'lanes' | 'actors' | 'timeline'

type RunListLoadMode = 'replace' | 'append'

type CollaborationPanelNotice =
  | { readonly kind: 'refresh'; readonly reason: unknown }
  | { readonly kind: 'poll'; readonly reason: unknown }

/** Browser-supplied collaboration settings and component dependencies. */
export type CollaborationPanelProps = PropsLocale<typeof COLLAB_NS> & {
  /** Delay between settled activity polls. */
  readonly pollIntervalMs: number
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
  /** Publish a localized success notice outside the panel lifetime. */
  readonly publishRerunNotice: (text: string) => void
  /** Run selected by the URL when the panel first loads. */
  readonly initialRunId?: string
}

interface RerunTarget {
  readonly node: ActivityNode
  readonly onlyNode: boolean
}

const RUN_STATUS_KEYS: Record<ActivityRunStatus, CollaborationKey> = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
}

const NODE_STATUS_KEYS: Record<ActivityNodeStatus, CollaborationKey> = {
  pending: 'nodeStatus.pending',
  ready: 'nodeStatus.ready',
  running: 'nodeStatus.running',
  completed: 'nodeStatus.completed',
  failed: 'nodeStatus.failed',
  skipped: 'nodeStatus.skipped',
}

const NODE_TYPE_KEYS: Record<ActivityNodeType, CollaborationKey> = {
  agent: 'type.agent',
  command: 'type.command',
  await_command: 'type.awaitCommand',
  gateway: 'type.gateway',
  parallel_branch: 'type.parallelBranch',
  while: 'type.while',
}

const TIMELINE_KEYS: Record<ActivityTimelineType, CollaborationKey> = {
  'run.started': 'timeline.runStarted',
  'node.started': 'timeline.nodeStarted',
  'node.completed': 'timeline.nodeCompleted',
  'node.failed': 'timeline.nodeFailed',
  'node.skipped': 'timeline.nodeSkipped',
  'run.completed': 'timeline.runCompleted',
  'run.failed': 'timeline.runFailed',
  'run.cancelled': 'timeline.runCancelled',
}

const ERROR_KEYS = {
  invalid_query: 'error.invalidQuery',
  unknown_run: 'error.unknownRun',
  workflow_missing: 'error.workflowMissing',
  workflow_mismatch: 'error.workflowMismatch',
  workflow_invalid: 'error.workflowInvalid',
  internal_error: 'error.internalError',
} as const satisfies Record<string, CollaborationKey>

const RERUN_ERROR_KEYS: Record<RerunErrorCode, CollaborationKey> = {
  invalid_request: 'rerun.error.invalidRequest',
  unknown_run: 'rerun.error.unknownRun',
  node_missing: 'rerun.error.nodeMissing',
  workflow_mismatch: 'rerun.error.workflowMismatch',
  run_running: 'rerun.error.runRunning',
  workflow_invalid: 'rerun.error.workflowInvalid',
  invalid_inputs: 'rerun.error.invalidInputs',
  session_unavailable: 'rerun.error.sessionUnavailable',
  internal_error: 'rerun.error.internalError',
}

const RUN_STATUS_CLASSES: Record<ActivityRunStatus, string> = {
  running: 'status-pill status-pill-info',
  completed: 'status-pill status-pill-success',
  failed: 'status-pill status-pill-error',
  cancelled: 'status-pill status-pill-neutral',
}

const NODE_STATUS_CLASSES: Record<ActivityNodeStatus, string> = {
  pending: 'status-pill status-pill-neutral',
  ready: 'status-pill status-pill-info',
  running: 'status-pill status-pill-info',
  completed: 'status-pill status-pill-success',
  failed: 'status-pill status-pill-error',
  skipped: 'status-pill status-pill-neutral',
}

function localizedReason(reason: unknown, t: CollaborationTranslate): string {
  if (reason instanceof CollaborationRequestError) {
    return t(ERROR_KEYS[reason.code])
  }
  return t('error.unknown')
}

function localizedRerunError(reason: unknown, t: CollaborationTranslate): string {
  if (reason instanceof RerunRequestError) return t(RERUN_ERROR_KEYS[reason.code])
  return t('rerun.error.unknown')
}

function rerunUnavailableReason(
  activity: RunActivity,
  node: ActivityNode,
  t: CollaborationTranslate,
): string | undefined {
  if (activity.status === 'running' || node.status === 'running') {
    return t('rerun.unavailableRunning')
  }
  if (node.status !== 'completed' && node.status !== 'failed') {
    return t('rerun.unavailableStatus')
  }
  return undefined
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return '—'
  return value.slice(0, 19).replace('T', ' ')
}

function formatDuration(milliseconds: number | undefined, t: CollaborationTranslate): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return t('value.none')
  }
  if (milliseconds < 1_000) {
    return t('duration.milliseconds', { value: String(milliseconds) })
  }
  if (milliseconds < 60_000) {
    return t('duration.seconds', { value: (milliseconds / 1_000).toFixed(1) })
  }
  return t('duration.minutes', { value: (milliseconds / 60_000).toFixed(1) })
}

function nodeDuration(node: ActivityNode): number | undefined {
  if (node.durationMs !== undefined) return node.durationMs
  if (node.startedAt === undefined || node.finishedAt === undefined) return undefined
  const started = Date.parse(node.startedAt)
  const finished = Date.parse(node.finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined
  return finished - started
}

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactElement {
  return (
    <div className="collab-inspector-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function NodeInspector({
  node,
  lanes,
  t,
  rerunUnavailable,
  rerunPending,
  onRequestRerun,
}: {
  readonly node: ActivityNode | undefined
  readonly lanes: readonly ActivityLane[]
  readonly t: CollaborationTranslate
  readonly rerunUnavailable: string | undefined
  readonly rerunPending: boolean
  readonly onRequestRerun: (node: ActivityNode) => void
}): ReactElement {
  if (node === undefined) {
    return (
      <aside
        className="card collab-inspector"
        role="complementary"
        aria-label={t('inspector.title')}
      >
        <h2>{t('inspector.title')}</h2>
        <p className="collab-muted">{t('inspector.empty')}</p>
      </aside>
    )
  }

  const lane = lanes.find(item => item.id === node.laneId)
  const outputs = node.outputs === undefined
    ? t('value.none')
    : JSON.stringify(node.outputs, null, 2)

  return (
    <aside
      className="card collab-inspector"
      role="complementary"
      aria-label={t('inspector.title')}
    >
      <h2>{t('inspector.title')}</h2>
      <dl className="collab-inspector-fields">
        <Field label={t('field.id')}>{node.id}</Field>
        <Field label={t('field.displayName')}>{node.displayName}</Field>
        <Field label={t('field.type')}>{t(NODE_TYPE_KEYS[node.type])}</Field>
        <Field label={t('field.lane')}>{lane?.label ?? node.laneId}</Field>
        <Field label={t('field.status')}>{t(NODE_STATUS_KEYS[node.status])}</Field>
        <Field label={t('field.attempts')}>{String(node.attempts)}</Field>
        <Field label={t('field.agentRef')}>{node.agentRef ?? t('value.none')}</Field>
        <Field label={t('field.businessRole')}>{node.businessRole ?? t('value.none')}</Field>
        <Field label={t('field.harness')}>{node.harness ?? t('value.none')}</Field>
        <Field label={t('field.model')}>{node.model ?? t('value.none')}</Field>
        <Field label={t('field.startedAt')}>{formatTimestamp(node.startedAt)}</Field>
        <Field label={t('field.finishedAt')}>{formatTimestamp(node.finishedAt)}</Field>
        <Field label={t('field.duration')}>{formatDuration(nodeDuration(node), t)}</Field>
        <Field label={t('field.chosenPort')}>{node.chosenPort ?? t('value.none')}</Field>
        <Field label={t('field.error')}>{node.error ?? t('value.none')}</Field>
        <Field label={t('field.outputs')}>
          <pre className="collab-json">{outputs}</pre>
        </Field>
      </dl>
      <div className="collab-inspector-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={rerunPending || rerunUnavailable !== undefined}
          onClick={() => { onRequestRerun(node) }}
        >
          {t('rerun.action')}
        </Button>
        {rerunUnavailable === undefined ? null : (
          <p className="collab-rerun-unavailable">{rerunUnavailable}</p>
        )}
      </div>
    </aside>
  )
}

function LaneNode({
  node,
  t,
  onSelect,
}: {
  readonly node: ActivityNode
  readonly t: CollaborationTranslate
  readonly onSelect: (id: string) => void
}): ReactElement {
  return (
    <button
      type="button"
      className="collab-lane-node"
      aria-label={t('graph.nodeAria', { id: node.id })}
      onClick={() => { onSelect(node.id) }}
    >
      <span className="collab-lane-node-name">{node.displayName}</span>
      <span className="collab-lane-node-id font-mono">{node.id}</span>
      <span className={NODE_STATUS_CLASSES[node.status]}>{t(NODE_STATUS_KEYS[node.status])}</span>
    </button>
  )
}

function LanesView({
  activity,
  t,
  onNodeSelect,
  selectedNode,
  rerunUnavailable,
  rerunPending,
  onRequestRerun,
}: {
  readonly activity: RunActivity
  readonly t: CollaborationTranslate
  readonly onNodeSelect: (id: string) => void
  readonly selectedNode: ActivityNode | undefined
  readonly rerunUnavailable: string | undefined
  readonly rerunPending: boolean
  readonly onRequestRerun: (node: ActivityNode) => void
}): ReactElement {
  const nodesById = new Map(activity.nodes.map(node => [node.id, node]))
  const shown = new Set<string>()

  if (activity.nodes.length === 0) {
    return <p className="collab-empty">{t('graph.empty')}</p>
  }

  return (
    <div className="collab-lanes-view">
      <div className="collab-lanes">
        {activity.lanes.map((lane) => {
          const laneNodes = lane.nodeIds.flatMap((id) => {
            const node = nodesById.get(id)
            if (node === undefined || shown.has(node.id)) return []
            shown.add(node.id)
            return [node]
          })
          return (
            <section className="card collab-lane" key={lane.id}>
              <header className="collab-lane-header">
                <h2>{lane.label}</h2>
                <code>{lane.id}</code>
              </header>
              <div className="collab-lane-nodes">
                {laneNodes.map(node => (
                  <LaneNode key={node.id} node={node} t={t} onSelect={onNodeSelect} />
                ))}
              </div>
            </section>
          )
        })}
        {activity.nodes.some(node => !shown.has(node.id)) ? (
          <section className="card collab-lane">
            <div className="collab-lane-nodes">
              {activity.nodes.filter(node => !shown.has(node.id)).map(node => (
                <LaneNode key={node.id} node={node} t={t} onSelect={onNodeSelect} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <NodeInspector
        node={selectedNode}
        lanes={activity.lanes}
        t={t}
        rerunUnavailable={rerunUnavailable}
        rerunPending={rerunPending}
        onRequestRerun={onRequestRerun}
      />
    </div>
  )
}

/**
 * Render the registered Actor profiles and the views each Actor may publish.
 * @param props - localized copy and the fetch implementation used for the registry.
 * @returns the Actor profile section.
 */
function ActorProfiles({
  t,
  fetchImpl,
}: {
  readonly t: CollaborationTranslate
  readonly fetchImpl: typeof fetch
}): ReactElement {
  const [entries, setEntries] = useState<readonly ActorRegistryEntry[]>([])
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let active = true
    loadActorRegistry(fetchImpl)
      .then((loaded) => {
        if (!active) return
        setEntries(loaded)
        setLoadFailed(false)
      })
      .catch(() => {
        if (!active) return
        setEntries([])
        setLoadFailed(true)
      })
    return () => { active = false }
  }, [fetchImpl])

  return (
    <section className="card collab-actor-profiles" aria-labelledby="collab-actor-profiles-title">
      <header className="collab-section-header">
        <h2 id="collab-actor-profiles-title">{t('actorProfiles.title')}</h2>
        <span>{t('actorProfiles.subtitle')}</span>
      </header>
      {loadFailed && <p className="collab-empty">{t('actorProfiles.loadFailed')}</p>}
      {!loadFailed && entries.length === 0 && (
        <p className="collab-empty">{t('actorProfiles.empty')}</p>
      )}
      {entries.length > 0 && (
        <ul className="collab-actor-profile-list">
          {entries.map(entry => (
            <li key={entry.actorId} className="collab-actor-profile" data-actor-id={entry.actorId}>
              <div className="collab-actor-profile-head">
                <code>{entry.actorId}</code>
                {!entry.valid && (
                  <span className="collab-status is-failed">{t('actorProfiles.invalid')}</span>
                )}
              </div>
              <p className="collab-actor-profile-description">
                {entry.description || t('value.none')}
              </p>
              <p className="collab-actor-profile-views-label">{t('actorProfiles.views')}</p>
              {entry.views.length === 0 && (
                <p className="collab-empty">{t('actorProfiles.noViews')}</p>
              )}
              {entry.views.length > 0 && (
                <ul className="collab-actor-view-list">
                  {entry.views.map(view => (
                    <li
                      key={view.viewId}
                      className="collab-actor-view"
                      aria-label={t('actorProfiles.viewAria', {
                        actor: entry.actorId,
                        view: view.viewId,
                      })}
                    >
                      <code>{view.viewId}</code>
                      <span className="collab-actor-view-meta">
                        {t('actorProfiles.contract')}: {view.outputContract || t('value.none')}
                      </span>
                      <span className="collab-actor-view-meta">
                        {t('actorProfiles.phases')}: {view.requiredPhases.length === 0
                          ? t('value.none')
                          : view.requiredPhases.join(', ')}
                      </span>
                      <span className="collab-actor-view-meta">
                        {t('actorProfiles.fields', { count: String(view.fieldCount) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ActorsView({
  activity,
  t,
  fetchImpl,
  onNodeSelect,
  selectedNode,
  rerunUnavailable,
  rerunPending,
  onRequestRerun,
}: {
  readonly activity: RunActivity
  readonly t: CollaborationTranslate
  readonly fetchImpl: typeof fetch
  readonly onNodeSelect: (id: string) => void
  readonly selectedNode: ActivityNode | undefined
  readonly rerunUnavailable: string | undefined
  readonly rerunPending: boolean
  readonly onRequestRerun: (node: ActivityNode) => void
}): ReactElement {
  if (activity.nodes.length === 0) {
    return (
      <>
        <ActorProfiles t={t} fetchImpl={fetchImpl} />
        <p className="collab-empty">{t('actors.empty')}</p>
      </>
    )
  }

  return (
    <>
      <ActorProfiles t={t} fetchImpl={fetchImpl} />
      <div className="collab-actors-view">
        <section className="card collab-actors">
          <header className="collab-section-header">
            <h2>{t('actors.title')}</h2>
            <span>{t('actors.count', { count: String(activity.nodes.length) })}</span>
          </header>
          <div className="collab-actors-scroll">
            <table
              className="collab-actors-table"
              aria-label={t('actors.aria', { id: activity.runId })}
            >
              <thead>
                <tr>
                  <th scope="col">{t('field.id')}</th>
                  <th scope="col">{t('field.agentRef')}</th>
                  <th scope="col">{t('field.businessRole')}</th>
                  <th scope="col">{t('field.model')}</th>
                  <th scope="col">{t('field.harness')}</th>
                  <th scope="col">{t('field.status')}</th>
                  <th scope="col">{t('field.duration')}</th>
                  <th scope="col">{t('field.error')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.nodes.map(node => (
                  <tr
                    key={node.id}
                    className={node.id === selectedNode?.id ? 'is-selected' : ''}
                    tabIndex={0}
                    aria-selected={node.id === selectedNode?.id}
                    aria-label={t('actors.rowAria', { id: node.id })}
                    onClick={() => { onNodeSelect(node.id) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onNodeSelect(node.id)
                    }}
                  >
                    <td><code>{node.id}</code></td>
                    <td>{node.agentRef ?? t('value.none')}</td>
                    <td>{node.businessRole ?? t('value.none')}</td>
                    <td><code>{node.model ?? t('value.none')}</code></td>
                    <td><code>{node.harness ?? t('value.none')}</code></td>
                    <td>
                      <span className={NODE_STATUS_CLASSES[node.status]}>
                        {t(NODE_STATUS_KEYS[node.status])}
                      </span>
                    </td>
                    <td><code>{formatDuration(nodeDuration(node), t)}</code></td>
                    <td className="collab-actor-error">{node.error ?? t('value.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <NodeInspector
          node={selectedNode}
          lanes={activity.lanes}
          t={t}
          rerunUnavailable={rerunUnavailable}
          rerunPending={rerunPending}
          onRequestRerun={onRequestRerun}
        />
      </div>
    </>
  )
}

function GanttBar({
  node,
  rangeStart,
  rangeEnd,
  t,
}: {
  readonly node: ActivityNode
  readonly rangeStart: number
  readonly rangeEnd: number
  readonly t: CollaborationTranslate
}): ReactElement | null {
  if (node.startedAt === undefined) return null
  const start = Date.parse(node.startedAt)
  if (!Number.isFinite(start)) return null

  const finished = node.finishedAt === undefined ? Number.NaN : Date.parse(node.finishedAt)
  const hasFinish = Number.isFinite(finished)
  const measuredDuration = nodeDuration(node)
  const duration = hasFinish
    ? Math.max(0, finished - start)
    : measuredDuration
  const end = hasFinish
    ? Math.max(start, finished)
    : start + Math.max(1, measuredDuration ?? 1)
  const span = Math.max(1, rangeEnd - rangeStart)
  const left = Math.max(0, Math.min(100, ((start - rangeStart) / span) * 100))
  const width = Math.max(2, Math.min(100 - left, ((end - start) / span) * 100))
  const durationLabel = hasFinish
    ? formatDuration(duration, t)
    : t('gantt.startOnly')
  const status = t(NODE_STATUS_KEYS[node.status])
  const barClass = hasFinish ? 'collab-gantt-bar' : 'collab-gantt-bar is-start-only'
  const style: CSSProperties = {
    marginLeft: `${left}%`,
    width: `${width}%`,
  }

  return (
    <div
      className={barClass}
      data-node-id={node.id}
      style={style}
      aria-label={t('gantt.barAria', {
        id: node.id,
        status,
        duration: durationLabel,
      })}
    >
      <span>{durationLabel}</span>
    </div>
  )
}

function Gantt({
  activity,
  t,
}: {
  readonly activity: RunActivity
  readonly t: CollaborationTranslate
}): ReactElement {
  const timed = activity.nodes.filter(node => node.startedAt !== undefined)
  const bounds = timed.flatMap((node) => {
    const start = Date.parse(node.startedAt ?? '')
    if (!Number.isFinite(start)) return []
    const finished = node.finishedAt === undefined ? Number.NaN : Date.parse(node.finishedAt)
    const duration = nodeDuration(node)
    const end = Number.isFinite(finished)
      ? Math.max(start, finished)
      : start + Math.max(1, duration ?? 1)
    return [{ start, end }]
  })
  const rangeStart = bounds.length === 0 ? 0 : Math.min(...bounds.map(bound => bound.start))
  const rangeEnd = bounds.length === 0 ? 1 : Math.max(...bounds.map(bound => bound.end))

  return (
    <section className="card collab-gantt" aria-label={t('gantt.aria', { id: activity.runId })}>
      <h2>{t('gantt.title')}</h2>
      {timed.length === 0 ? (
        <p className="collab-empty">{t('gantt.empty')}</p>
      ) : (
        <div className="collab-gantt-rows">
          {timed.map(node => (
            <div className="collab-gantt-row" key={node.id}>
              <div className="collab-gantt-label">
                <span>{node.displayName}</span>
                <code>{node.id}</code>
              </div>
              <div className="collab-gantt-track">
                <GanttBar node={node} rangeStart={rangeStart} rangeEnd={rangeEnd} t={t} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function TimelineEntry({
  entry,
  nodes,
  t,
}: {
  readonly entry: ActivityTimelineEntry
  readonly nodes: readonly ActivityNode[]
  readonly t: CollaborationTranslate
}): ReactElement {
  const node = entry.nodeId === undefined ? undefined : nodes.find(item => item.id === entry.nodeId)
  return (
    <li className="collab-timeline-item">
      <time className="font-mono" dateTime={entry.occurredAt}>
        {formatTimestamp(entry.occurredAt)}
      </time>
      <div>
        <span>{t(TIMELINE_KEYS[entry.type])}</span>
        {node === undefined ? null : <code>{node.displayName}</code>}
        {entry.error === undefined ? null : <p className="collab-error-text">{entry.error}</p>}
      </div>
    </li>
  )
}

function TimelineView({
  activity,
  t,
}: {
  readonly activity: RunActivity
  readonly t: CollaborationTranslate
}): ReactElement {
  return (
    <div className="collab-timeline-view">
      <Gantt activity={activity} t={t} />
      <section className="card collab-timeline">
        <h2>{t('timeline.title')}</h2>
        {activity.timeline.length === 0 ? (
          <p className="collab-empty">{t('timeline.empty')}</p>
        ) : (
          <ol
            className="collab-timeline-list"
            aria-label={t('timeline.aria', { id: activity.runId })}
          >
            {activity.timeline.map(entry => (
              <TimelineEntry key={entry.id} entry={entry} nodes={activity.nodes} t={t} />
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function Handoffs({
  activity,
  t,
}: {
  readonly activity: RunActivity
  readonly t: CollaborationTranslate
}): ReactElement {
  return (
    <section className="card collab-handoffs">
      <h2>{t('handoff.title')}</h2>
      {activity.handoffs.length === 0 ? (
        <p className="collab-empty">{t('handoff.empty')}</p>
      ) : (
        <ul className="collab-handoff-list">
          {activity.handoffs.map(handoff => (
            <li key={handoff.id}>
              <span>{handoff.fromRole}</span>
              <span aria-hidden="true">→</span>
              <span>{handoff.toRole}</span>
              <code>{handoff.fromNodeId} → {handoff.toNodeId}</code>
              <code>{handoff.port}</code>
              <span>{handoff.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ActivityError({
  error,
  t,
}: {
  readonly error: unknown
  readonly t: CollaborationTranslate
}): ReactElement {
  const requestError = error instanceof CollaborationRequestError ? error : undefined
  return (
    <div className="card collab-activity-error" role="alert">
      <h2>{t('error.title')}</h2>
      <p>{localizedReason(error, t)}</p>
      {requestError !== undefined && requestError.issues.length > 0 ? (
        <div className="collab-validation-issues">
          <header>
            <h3>{t('error.issueTitle')}</h3>
            <span>{t('error.issueCount', { count: String(requestError.issues.length) })}</span>
          </header>
          <ul>
            {requestError.issues.map(issue => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Render persisted workflow collaboration and explicit node-rerun controls.
 * @param props - locale-bound translator, polling and fetch settings, initial run, and notice publisher.
 * @returns the collaboration panel.
 */
export function CollaborationPanel({
  t,
  pollIntervalMs,
  fetchImpl,
  publishRerunNotice,
  initialRunId,
}: CollaborationPanelProps): ReactElement {
  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runPickerOpen, setRunPickerOpen] = useState(false)
  const [runNotInPage, setRunNotInPage] = useState(false)
  const [activity, setActivity] = useState<RunActivity | null>(null)
  const [view, setView] = useState<CollaborationView>('graph')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<unknown>(undefined)
  const [loadingActivity, setLoadingActivity] = useState(false)
  const [activityError, setActivityError] = useState<unknown>(undefined)
  const [notice, setNotice] = useState<CollaborationPanelNotice | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [rerunTarget, setRerunTarget] = useState<RerunTarget | undefined>(undefined)
  const [rerunPending, setRerunPending] = useState(false)
  const [rerunError, setRerunError] = useState<unknown>(undefined)

  const runsRef = useRef<readonly RunSummary[]>([])
  const selectedRunIdRef = useRef<string | null>(null)
  const listRequestId = useRef(0)
  const activityRequestId = useRef(0)
  const refreshController = useRef<AbortController | undefined>(undefined)
  const rerunPendingRef = useRef(false)
  const initialRunApplied = useRef(false)
  // The run history panel parks a run id before the layout switches here; this
  // panel claims it on mount. The URL run id is the fallback.
  const requestedRunRef = useRef<string | null>(null)
  const requestedRunRead = useRef(false)
  if (!requestedRunRead.current) {
    requestedRunRead.current = true
    requestedRunRef.current = takeCollaborationRun() ?? initialRunId ?? null
  }

  const selectRun = useCallback((runId: string) => {
    selectedRunIdRef.current = runId
    setSelectedRunId(runId)
    setRunNotInPage(false)
    setView('graph')
    setSelectedNodeId(undefined)
    setRerunTarget(undefined)
    setRerunError(undefined)
  }, [])

  const loadRuns = useCallback(async (mode: RunListLoadMode): Promise<void> => {
    const requestId = ++listRequestId.current
    const offset = mode === 'append' ? runsRef.current.length : 0
    if (mode === 'append') setLoadingMore(true)
    else setLoadingRuns(true)
    setListError(undefined)

    try {
      const page = await loadRunHistory({
        limit: PAGE_SIZE,
        offset,
      }, fetchImpl ?? fetch)
      if (requestId !== listRequestId.current) return
      const next = mode === 'append' ? appendRunSummaries(runsRef.current, page.runs) : page.runs
      runsRef.current = next
      setRuns(next)
      setTotal(page.total)
      if (mode === 'replace') {
        let appliedInitialRun = false
        const requestedRun = requestedRunRef.current
        if (!initialRunApplied.current) {
          initialRunApplied.current = true
          if (requestedRun !== null) {
            appliedInitialRun = true
            if (next.some(run => run.runId === requestedRun)) {
              selectRun(requestedRun)
            } else {
              selectedRunIdRef.current = null
              setSelectedRunId(null)
              setActivity(null)
              setRunNotInPage(true)
            }
          }
        }

        if (!appliedInitialRun) {
          const selected = selectedRunIdRef.current
          const keepSelection = selected !== null && next.some(run => run.runId === selected)
          if (!keepSelection) {
            const first = next[0]
            if (first === undefined) {
              selectedRunIdRef.current = null
              setSelectedRunId(null)
              setActivity(null)
              setRunNotInPage(false)
            } else {
              selectRun(first.runId)
            }
          }
        }
      }
    } catch (reason) {
      if (requestId !== listRequestId.current) return
      setListError(reason)
    } finally {
      if (requestId === listRequestId.current) {
        if (mode === 'append') setLoadingMore(false)
        else setLoadingRuns(false)
      }
    }
  }, [fetchImpl, initialRunId, selectRun])

  useEffect(() => {
    void loadRuns('replace')
  }, [loadRuns])

  useEffect(() => () => {
    listRequestId.current += 1
    activityRequestId.current += 1
    refreshController.current?.abort()
  }, [])

  useEffect(() => {
    if (selectedRunId === null) return
    const requestId = ++activityRequestId.current
    const controller = new AbortController()
    refreshController.current?.abort()
    setActivity(null)
    setActivityError(undefined)
    setNotice(null)
    setLoadingActivity(true)

    void loadRunActivity(selectedRunId, {
      fetchImpl: fetchImpl ?? fetch,
      signal: controller.signal,
    }).then((next) => {
      if (requestId !== activityRequestId.current || selectedRunIdRef.current !== selectedRunId) return
      setActivity(next)
    }).catch((reason: unknown) => {
      if (requestId !== activityRequestId.current || selectedRunIdRef.current !== selectedRunId) return
      if (reason instanceof Error && reason.name === 'AbortError') return
      setActivityError(reason)
    }).finally(() => {
      if (requestId === activityRequestId.current) setLoadingActivity(false)
    })

    return () => { controller.abort() }
  }, [fetchImpl, selectedRunId])

  const activeStatus = activity !== null && activity.runId === selectedRunId
    ? activity.status
    : undefined

  useEffect(() => {
    if (selectedRunId === null || activeStatus === undefined) return
    const runId = selectedRunId
    const poller = createCollaborationPoller({
      intervalMs: pollIntervalMs,
      fetchActivity: signal => loadRunActivity(runId, {
        fetchImpl: fetchImpl ?? fetch,
        signal,
      }),
      onActivity: (next) => {
        if (selectedRunIdRef.current !== runId) return
        setActivity(next)
        setNotice(current => current?.kind === 'poll' ? null : current)
      },
      onError: (reason) => {
        if (selectedRunIdRef.current === runId) setNotice({ kind: 'poll', reason })
      },
      scheduler: browserScheduler,
      visibility: browserVisibility,
    })
    poller.start(runId, activeStatus)
    return () => { poller.dispose() }
  }, [activeStatus, fetchImpl, pollIntervalMs, selectedRunId])

  const refreshActivity = async (): Promise<void> => {
    if (selectedRunId === null) return
    const runId = selectedRunId
    const requestId = ++activityRequestId.current
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setRefreshing(true)
    setNotice(null)

    try {
      const next = await loadRunActivity(runId, {
        fetchImpl: fetchImpl ?? fetch,
        signal: controller.signal,
      })
      if (requestId !== activityRequestId.current || selectedRunIdRef.current !== runId) return
      setActivity(next)
      setActivityError(undefined)
    } catch (reason) {
      if (requestId !== activityRequestId.current || selectedRunIdRef.current !== runId) return
      if (reason instanceof Error && reason.name === 'AbortError') return
      setNotice({ kind: 'refresh', reason })
    } finally {
      if (requestId === activityRequestId.current) setRefreshing(false)
    }
  }

  const openRerunConfirmation = (node: ActivityNode): void => {
    setRerunError(undefined)
    setRerunTarget({ node, onlyNode: true })
  }

  const closeRerunConfirmation = (): void => {
    if (rerunPendingRef.current) return
    setRerunTarget(undefined)
    setRerunError(undefined)
  }

  const submitRerun = async (): Promise<void> => {
    if (rerunPendingRef.current || rerunTarget === undefined || activity === null) return
    rerunPendingRef.current = true
    setRerunPending(true)
    setRerunError(undefined)

    try {
      await requestNodeRerun({
        runId: activity.runId,
        workflowId: activity.workflowId,
        nodeId: rerunTarget.node.id,
        onlyNode: rerunTarget.onlyNode,
        inputs: activity.inputs,
      }, { fetchImpl: fetchImpl ?? fetch })
      flushSync(() => { setRerunTarget(undefined) })
      publishRerunNotice(t('rerun.queued'))
      await refreshActivity()
    } catch (reason) {
      setRerunError(reason)
    } finally {
      rerunPendingRef.current = false
      setRerunPending(false)
    }
  }

  const levels = useMemo(
    () => activity === null
      ? new Map<string, number>()
      : scheduleLevels(activity.nodes, activity.scheduleEdges),
    [activity],
  )
  const outputPortsByNode = useMemo(() => {
    const portsByNode = new Map<string, string[]>()
    for (const edge of activity?.dataEdges ?? []) {
      const ports = portsByNode.get(edge.from) ?? []
      if (!ports.includes(edge.port)) ports.push(edge.port)
      portsByNode.set(edge.from, ports)
    }
    return portsByNode
  }, [activity])
  const dagNodes = useMemo(
    () => activity === null
      ? []
      : activity.nodes.map(node => ({
        id: node.id,
        level: levels.get(node.id) ?? 0,
        displayName: node.displayName,
        type: node.type,
        ...(node.businessRole === undefined ? {} : { businessRole: node.businessRole }),
        ...(node.agentRef === undefined ? {} : { agentRef: node.agentRef }),
        outputs: Object.fromEntries(
          (outputPortsByNode.get(node.id) ?? []).map(port => [port, []]),
        ),
      })),
    [activity, levels, outputPortsByNode],
  )
  const dagEdges = useMemo(
    () => activity === null
      ? []
      : [
        ...activity.scheduleEdges.map(edge => ({ ...edge, domain: 'schedule' as const })),
        ...activity.dataEdges.map(edge => ({ ...edge, domain: 'data' as const })),
      ],
    [activity],
  )

  const selectedNode = activity?.nodes.find(node => node.id === selectedNodeId)
  const rerunUnavailable = activity !== null && selectedNode !== undefined
    ? rerunUnavailableReason(activity, selectedNode, t)
    : undefined
  const canShowMore = runs.length < total
  const selectedRun = runs.find(run => run.runId === selectedRunId)
  const runMenuItems: readonly MenuEntry[] = runs.map(run => ({
    id: run.runId,
    label: (
      <span className="collab-run-option">
        <span className="collab-run-option-copy">
          <span className="collab-run-workflow">{run.workflowId}</span>
          <span className="collab-run-id font-mono">{run.runId}</span>
        </span>
        <span className={RUN_STATUS_CLASSES[run.status]}>{t(RUN_STATUS_KEYS[run.status])}</span>
      </span>
    ),
  }))
  const showListError = listError !== undefined && runs.length === 0
  const showRunNotInPage = runNotInPage && !loadingRuns && listError === undefined

  return (
    <div className="ao-page agentops-surface collab-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">{t('page.title')}</h1>
          <p className="ao-page-description">{t('page.description')}</p>
        </div>
      </header>

      <div className="collab-layout">
        <section className="card collab-run-picker-bar" aria-label={t('run.listAria')}>
          <div className="collab-run-picker-meta">
            <h2>{t('run.label')}</h2>
            <span>{t('run.count', { shown: String(runs.length), total: String(total) })}</span>
          </div>

          <Menu
            open={runPickerOpen}
            portal
            className="collab-run-picker-control"
            minWidthFromAnchor
            selectedId={selectedRunId ?? undefined}
            items={runMenuItems}
            listClassName="collab-run-menu"
            onSelect={(runId) => {
              selectRun(runId)
              setRunPickerOpen(false)
            }}
            onClose={() => { setRunPickerOpen(false) }}
            anchor={(
              <button
                type="button"
                className="collab-run-trigger"
                aria-label={t('run.listAria')}
                aria-haspopup="menu"
                aria-expanded={runPickerOpen}
                disabled={loadingRuns || runs.length === 0}
                onClick={() => { setRunPickerOpen(open => !open) }}
              >
                <span className="collab-run-trigger-copy">
                  {selectedRun === undefined ? (
                    <span className="collab-run-trigger-empty">
                      {loadingRuns ? t('run.loading') : t('run.noSelection')}
                    </span>
                  ) : (
                    <>
                      <span className="collab-run-trigger-workflow">{selectedRun.workflowId}</span>
                      <span className="collab-run-trigger-id font-mono">{selectedRun.runId}</span>
                    </>
                  )}
                </span>
                {selectedRun === undefined ? null : (
                  <span className={RUN_STATUS_CLASSES[selectedRun.status]}>{t(RUN_STATUS_KEYS[selectedRun.status])}</span>
                )}
                <svg className="collab-run-trigger-chevron" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          >
            {canShowMore ? (
              <MenuItemButton
                separatorBefore
                disabled={loadingMore}
                onSelect={() => { void loadRuns('append') }}
              >
                {loadingMore ? t('run.loadingMore') : t('run.loadMore')}
              </MenuItemButton>
            ) : null}
          </Menu>

          {showListError ? (
            <div className="collab-run-error">
              <p>{t('run.loadFailed', { message: localizedReason(listError, t) })}</p>
              <button type="button" className="btn-sm btn-secondary" onClick={() => { void loadRuns('replace') }}>
                {t('run.retry')}
              </button>
            </div>
          ) : null}
          {!loadingRuns && listError === undefined && runs.length === 0 ? (
            <p className="collab-empty">{t('run.empty')}</p>
          ) : null}
        </section>

        <main className="collab-content">
          {selectedRunId === null && !loadingRuns && listError === undefined && !runNotInPage && runs.length > 0 ? (
            <p className="collab-empty">{t('run.noSelection')}</p>
          ) : null}
          {showRunNotInPage ? (
            <p className="collab-empty" role="status">{t('run.notInPage')}</p>
          ) : null}
          {loadingActivity ? <p className="card collab-empty">{t('run.loadingActivity')}</p> : null}
          {activityError !== undefined && !loadingActivity ? (
            <ActivityError error={activityError} t={t} />
          ) : null}

          {activity !== null && !loadingActivity && activityError === undefined ? (
            <>
              <div className="collab-toolbar">
                <div className="collab-view-switch" role="group" aria-label={t('view.aria')}>
                  <button
                    type="button"
                    className={`btn-sm ${view === 'graph' ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={view === 'graph'}
                    onClick={() => { setView('graph') }}
                  >
                    {t('view.graph')}
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${view === 'lanes' ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={view === 'lanes'}
                    onClick={() => { setView('lanes') }}
                  >
                    {t('view.lanes')}
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${view === 'actors' ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={view === 'actors'}
                    onClick={() => { setView('actors') }}
                  >
                    {t('view.actors')}
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${view === 'timeline' ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={view === 'timeline'}
                    onClick={() => { setView('timeline') }}
                  >
                    {t('view.timeline')}
                  </button>
                </div>
                <div className="collab-run-meta" role="group" aria-label={t('run.summaryAria')}>
                  <div className="collab-run-facts">
                    <span className="collab-run-fact">
                      <span className="collab-run-fact-label">{t('run.id')}</span>
                      <code>{activity.runId}</code>
                    </span>
                    <span className="collab-run-fact">
                      <span className="collab-run-fact-label">{t('run.workflow')}</span>
                      <code>{activity.workflowId}</code>
                    </span>
                    <span className="collab-run-fact">
                      <span className="collab-run-fact-label">{t('run.startedAt')}</span>
                      <time dateTime={activity.startedAt}>{formatTimestamp(activity.startedAt)}</time>
                    </span>
                  </div>
                  <div className="collab-run-actions">
                    <span className={RUN_STATUS_CLASSES[activity.status]}>{t(RUN_STATUS_KEYS[activity.status])}</span>
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      disabled={refreshing}
                      onClick={() => { void refreshActivity() }}
                    >
                      {t('run.refresh')}
                    </button>
                  </div>
                </div>
              </div>

              {notice === null ? null : (
                <div className="collab-notice" role="alert">
                  {notice.kind === 'refresh'
                    ? t('run.refreshFailed', { message: localizedReason(notice.reason, t) })
                    : t('run.pollFailed', { message: localizedReason(notice.reason, t) })}
                </div>
              )}

              <section className="collab-activity" aria-label={t('run.activityAria', { id: activity.runId })}>
                {view === 'lanes' ? (
                  <LanesView
                    activity={activity}
                    t={t}
                    onNodeSelect={setSelectedNodeId}
                    selectedNode={selectedNode}
                    rerunUnavailable={rerunUnavailable}
                    rerunPending={rerunPending}
                    onRequestRerun={openRerunConfirmation}
                  />
                ) : null}

                {view === 'graph' ? (
                  <div className="collab-graph-view">
                    <section className="card collab-graph">
                      <header className="collab-section-header">
                        <div>
                          <h2>{t('graph.title')}</h2>
                          <div className="collab-legend">
                            <span>{t('graph.schedule')}</span>
                            <span>{t('graph.data')}</span>
                          </div>
                        </div>
                      </header>
                      <div className="collab-graph-scroll">
                        <WorkflowDagCanvas
                          workflowId={activity.workflowId}
                          nodes={dagNodes}
                          edges={dagEdges}
                          emptyText={t('graph.empty')}
                          tooManyText={t('graph.tooMany')}
                          ariaLabel={t('graph.aria', { id: activity.runId })}
                          layerLabel={level => t('graph.level', { level: String(level) })}
                          selectable
                          {...(selectedNodeId === undefined ? {} : { selectedNodeId })}
                          onNodeSelect={setSelectedNodeId}
                          nodeTypeLabel={type => t(NODE_TYPE_KEYS[type])}
                          nodeInputsLabel={count => t('graph.nodeInputs', { count: String(count) })}
                          nodeOutputsLabel={ports => t('graph.nodeOutputs', { ports: ports.join(', ') })}
                          nodeNoOutputsLabel={t('graph.nodeNoOutputs')}
                          nodeAriaLabel={id => t('graph.nodeAria', { id })}
                          edgeAriaLabel={edge => edge.domain === 'schedule'
                            ? t('graph.scheduleEdgeAria', { from: edge.from })
                            : t('graph.dataEdgeAria', { from: edge.from })}
                          zoomLabels={{
                            controlsAria: t('graph.zoom.controlsAria'),
                            zoomIn: t('graph.zoom.in'),
                            zoomOut: t('graph.zoom.out'),
                            fit: t('graph.zoom.fit'),
                            reset: t('graph.zoom.reset'),
                            value: percent => t('graph.zoom.value', { percent: String(percent) }),
                          }}
                        />
                      </div>
                    </section>
                    <NodeInspector
                      node={selectedNode}
                      lanes={activity.lanes}
                      t={t}
                      rerunUnavailable={rerunUnavailable}
                      rerunPending={rerunPending}
                      onRequestRerun={openRerunConfirmation}
                    />
                  </div>
                ) : null}

                {view === 'actors' ? (
                  <ActorsView
                    activity={activity}
                    t={t}
                    fetchImpl={fetchImpl ?? fetch}
                    onNodeSelect={setSelectedNodeId}
                    selectedNode={selectedNode}
                    rerunUnavailable={rerunUnavailable}
                    rerunPending={rerunPending}
                    onRequestRerun={openRerunConfirmation}
                  />
                ) : null}
                {view === 'timeline' ? <TimelineView activity={activity} t={t} /> : null}

                <Handoffs activity={activity} t={t} />
              </section>
            </>
          ) : null}
        </main>
      </div>

      <Modal
        open={rerunTarget !== undefined}
        onClose={closeRerunConfirmation}
        title={t('rerun.title')}
        description={t('rerun.description')}
        closeLabel={t('common.close')}
        className="agentops-theme-scope collab-rerun-dialog"
        contentClassName="collab-rerun-content"
        footer={(
          <div className="collab-rerun-footer">
            <Button
              variant="outline"
              data-modal-autofocus
              disabled={rerunPending}
              onClick={closeRerunConfirmation}
            >
              {t('rerun.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={rerunPending}
              onClick={() => { void submitRerun() }}
            >
              {rerunPending ? t('rerun.submitting') : t('rerun.confirm')}
            </Button>
          </div>
        )}
      >
        <div className="collab-rerun-options" role="radiogroup" aria-label={t('rerun.title')}>
          <label className="collab-rerun-option">
            <input
              type="radio"
              name="rerun-scope"
              checked={rerunTarget?.onlyNode === true}
              disabled={rerunPending}
              onChange={() => {
                setRerunTarget(current => current === undefined ? current : { ...current, onlyNode: true })
              }}
            />
            <span>{t('rerun.onlyNode')}</span>
          </label>
          <label className="collab-rerun-option">
            <input
              type="radio"
              name="rerun-scope"
              checked={rerunTarget?.onlyNode === false}
              disabled={rerunPending}
              onChange={() => {
                setRerunTarget(current => current === undefined ? current : { ...current, onlyNode: false })
              }}
            />
            <span>{t('rerun.downstream')}</span>
          </label>
        </div>
        <p className="collab-rerun-inputs">{t('rerun.inputsNotice')}</p>
        {rerunError === undefined ? null : (
          <p className="collab-rerun-error" role="alert">
            <span className="collab-rerun-error-title">{t('rerun.failed')}</span>
            <span>{localizedRerunError(rerunError, t)}</span>
          </p>
        )}
      </Modal>
    </div>
  )
}

/**
 * Render the collaboration sidebar glyph.
 * @param props - optional glyph size in pixels.
 * @returns the collaboration icon.
 */
export function CollaborationIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="7" r="3" />
      <circle cx="12" cy="17" r="3" />
      <path d="M9.5 8.5 11 15M14.5 8.5 13 15" strokeLinecap="round" />
    </svg>
  )
}
