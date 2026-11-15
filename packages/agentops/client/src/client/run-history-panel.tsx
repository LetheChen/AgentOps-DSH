/**
 * Read-only run history with filtering, search, paging, refresh, and details.
 *
 * The panel keeps existing rows visible when refresh or load-more fails, and
 * request ids prevent late list or detail responses from replacing newer state.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  loadRunDetail,
  loadRunHistory,
  type RunDetail,
  type RunHistoryPage,
  type RunNodeDetail,
  type RunNodeStatus,
  type RunStatus,
  type RunSummary,
} from './run-history-api.js'
import { RUNS_NS, type RunHistoryKey } from './run-history-locales.js'
import { appendRunSummaries } from './run-summary-page.js'

const PAGE_SIZE = 50

type RunHistoryPanelProps = PropsLocale<typeof RUNS_NS> & {
  /** Opens the collaboration panel on the given run; absent when the panel is embedded elsewhere. */
  readonly openCollaboration?: (runId: string) => void
}
type RunHistoryTranslate = RunHistoryPanelProps['t']
type StatusFilter = 'all' | 'completed' | 'failed' | 'running'
type ListLoadMode = 'replace' | 'append'

const RUN_STATUS_KEYS: Record<RunStatus, RunHistoryKey> = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
}

const RUN_NODE_STATUS_KEYS: Record<RunNodeStatus, RunHistoryKey> = {
  pending: 'node.pending',
  ready: 'node.ready',
  running: 'node.running',
  completed: 'node.completed',
  failed: 'node.failed',
  skipped: 'node.skipped',
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return '—'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return value.slice(0, 19).replace('T', ' ')
}

function formatDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  t: RunHistoryTranslate,
): string {
  if (startedAt === undefined || finishedAt === undefined) return '—'
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return '—'
  const milliseconds = finish - start
  if (milliseconds < 1_000) {
    return t('page.durationMilliseconds', { value: String(milliseconds) })
  }
  if (milliseconds < 60_000) {
    return t('page.durationSeconds', { value: (milliseconds / 1_000).toFixed(1) })
  }
  return t('page.durationMinutes', { value: (milliseconds / 60_000).toFixed(1) })
}

const RUN_STATUS_PILL_CLASS: Record<RunStatus, string> = {
  running: 'status-pill status-pill-info',
  completed: 'status-pill status-pill-success',
  failed: 'status-pill status-pill-error',
  cancelled: 'status-pill status-pill-neutral',
}

const RUN_NODE_STATUS_PILL_CLASS: Record<RunNodeStatus, string> = {
  pending: 'status-pill status-pill-neutral',
  ready: 'status-pill status-pill-info',
  running: 'status-pill status-pill-info',
  completed: 'status-pill status-pill-success',
  failed: 'status-pill status-pill-error',
  skipped: 'status-pill status-pill-neutral',
}

function RunHistorySkeleton({ label }: { readonly label: string }): ReactElement {
  return (
    <div className="card rh-skeleton" role="status">
      <span className="rh-visually-hidden">{label}</span>
      {[0, 1, 2, 3, 4].map(row => (
        <span key={row} className="rh-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  )
}

function RunNodeTable({
  nodes,
  t,
}: {
  readonly nodes: readonly RunNodeDetail[]
  readonly t: RunHistoryTranslate
}): ReactElement {
  if (nodes.length === 0) {
    return <div className="rh-empty-detail">{t('page.noNodes')}</div>
  }
  return (
    <div className="rh-table-scroll">
      <table className="data-table rh-node-table">
        <thead>
          <tr>
            <th>{t('page.nodes')}</th>
            <th>{t('page.status')}</th>
            <th>{t('page.attempts')}</th>
            <th>{t('page.started')}</th>
            <th>{t('page.finished')}</th>
            <th>{t('page.duration')}</th>
            <th>{t('page.port')}</th>
            <th>{t('page.error')}</th>
            <th>{t('page.outputs')}</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(node => (
            <tr key={node.id}>
              <td className="font-mono rh-node-id">{node.id}</td>
              <td>
                <span className={RUN_NODE_STATUS_PILL_CLASS[node.status]}>
                  {t(RUN_NODE_STATUS_KEYS[node.status])}
                </span>
              </td>
              <td className="font-mono">{node.attempts}</td>
              <td className="font-mono">{formatTimestamp(node.startedAt)}</td>
              <td className="font-mono">{formatTimestamp(node.finishedAt)}</td>
              <td className="font-mono">{formatDuration(node.startedAt, node.finishedAt, t)}</td>
              <td className="font-mono">{node.chosenPort ?? '—'}</td>
              <td className="rh-node-error">{node.error ?? '—'}</td>
              <td>
                {node.outputs === undefined
                  ? '—'
                  : (
                    <pre className="rh-outputs">{JSON.stringify(node.outputs, null, 2)}</pre>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunDetailPanel({
  run,
  detail,
  loading,
  error,
  onRetry,
  t,
}: {
  readonly run: RunSummary
  readonly detail: RunDetail | null
  readonly loading: boolean
  readonly error: string
  readonly onRetry: () => void
  readonly t: RunHistoryTranslate
}): ReactElement {
  return (
    <section className="rh-detail" aria-label={t('page.detailAria', { id: run.runId })}>
      <div className="rh-detail-heading">
        <h3>{t('page.detail')}</h3>
        <span className="font-mono rh-node-id">{run.runId}</span>
      </div>

      {loading && <div className="rh-detail-loading">{t('page.loadingDetail')}</div>}

      {!loading && error !== '' && (
        <div className="rh-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sm btn-secondary" onClick={onRetry}>
            {t('page.retry')}
          </button>
        </div>
      )}

      {!loading && error === '' && detail !== null && (
        <>
          {detail.error !== undefined && (
            <div className="rh-detail-root-error" role="alert">
              <strong>{t('page.error')}</strong>
              <span>{detail.error}</span>
            </div>
          )}

          <div className="rh-detail-summary">
            <div>
              <span>{t('page.runId')}</span>
              <code>{detail.runId}</code>
            </div>
            <div>
              <span>{t('page.workflow')}</span>
              <code>{detail.workflowId}</code>
            </div>
            <div>
              <span>{t('page.status')}</span>
              <span className={RUN_STATUS_PILL_CLASS[detail.status]}>
                {t(RUN_STATUS_KEYS[detail.status])}
              </span>
            </div>
            <div>
              <span>{t('page.started')}</span>
              <code>{formatTimestamp(detail.startedAt)}</code>
            </div>
            <div>
              <span>{t('page.finished')}</span>
              <code>{formatTimestamp(detail.finishedAt)}</code>
            </div>
            <div>
              <span>{t('page.duration')}</span>
              <code>{formatDuration(detail.startedAt, detail.finishedAt, t)}</code>
            </div>
          </div>

          <RunNodeTable nodes={detail.nodes} t={t} />
        </>
      )}
    </section>
  )
}

/**
 * Render the paged, read-only run history screen.
 * @param props - locale-bound translator supplied by the slot renderer.
 * @returns the run history panel.
 */
export function RunHistoryPanel({ t, openCollaboration }: RunHistoryPanelProps): ReactElement {
  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState('')
  const [listRetryMode, setListRetryMode] = useState<ListLoadMode>('replace')
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const runsRef = useRef<readonly RunSummary[]>([])
  const listRequestId = useRef(0)
  const detailRequestId = useRef(0)

  const loadRuns = useCallback(async (mode: ListLoadMode): Promise<void> => {
    const requestId = ++listRequestId.current
    const offset = mode === 'append' ? runsRef.current.length : 0
    if (mode === 'append') {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setLoadingMore(false)
    }
    setListError('')

    try {
      const page: RunHistoryPage = await loadRunHistory({
        limit: PAGE_SIZE,
        offset,
        ...(statusFilter === 'all' ? {} : { status: statusFilter }),
      })
      if (requestId !== listRequestId.current) return
      const next = mode === 'append' ? appendRunSummaries(runsRef.current, page.runs) : page.runs
      runsRef.current = next
      setRuns(next)
      setTotal(page.total)
    } catch (reason) {
      if (requestId !== listRequestId.current) return
      const message = errorMessage(reason)
      setListError(mode === 'append'
        ? t('page.loadMoreFailed', { message })
        : runsRef.current.length > 0
          ? t('page.refreshFailed', { message })
          : t('page.loadFailed', { message }))
      setListRetryMode(mode)
    } finally {
      if (requestId === listRequestId.current) {
        if (mode === 'append') setLoadingMore(false)
        else setLoading(false)
      }
    }
  }, [statusFilter, t])

  useEffect(() => {
    runsRef.current = []
    setRuns([])
    setTotal(0)
    setExpandedRunId(null)
    setDetail(null)
    setDetailError('')
    setDetailLoading(false)
    detailRequestId.current += 1
    void loadRuns('replace')
  }, [loadRuns])

  useEffect(() => () => {
    listRequestId.current += 1
    detailRequestId.current += 1
  }, [])

  const requestDetail = useCallback(async (runId: string): Promise<void> => {
    const requestId = ++detailRequestId.current
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    try {
      const nextDetail = await loadRunDetail(runId)
      if (requestId !== detailRequestId.current) return
      setDetail(nextDetail)
    } catch (reason) {
      if (requestId !== detailRequestId.current) return
      setDetailError(t('page.detailLoadFailed', { message: errorMessage(reason) }))
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false)
    }
  }, [t])

  const toggleDetail = (runId: string): void => {
    if (expandedRunId === runId) {
      detailRequestId.current += 1
      setExpandedRunId(null)
      setDetail(null)
      setDetailError('')
      setDetailLoading(false)
      return
    }
    setExpandedRunId(runId)
    void requestDetail(runId)
  }

  const shown = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized.length === 0) return runs
    return runs.filter(run => run.runId.toLowerCase().includes(normalized)
      || run.workflowId.toLowerCase().includes(normalized))
  }, [query, runs])

  const countLabel = t('page.count', {
    shown: String(shown.length),
    total: String(total),
  })
  const canShowMore = runs.length < total
  const showInitialError = listError !== '' && runs.length === 0 && !loading

  return (
    <div className="ao-page agentops-surface rh-page" aria-busy={loading || loadingMore}>
      <div className="rh-toolbar">
        <input
          className="input-base rh-search"
          type="search"
          aria-label={t('page.searchLabel')}
          placeholder={t('page.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <select
          className="input-base rh-filter"
          aria-label={t('page.statusFilter')}
          value={statusFilter}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'all' || value === 'completed' || value === 'failed' || value === 'running') {
              setStatusFilter(value)
            }
          }}
        >
          <option value="all">{t('page.filter.all')}</option>
          <option value="completed">{t('page.filter.completed')}</option>
          <option value="failed">{t('page.filter.failed')}</option>
          <option value="running">{t('page.filter.running')}</option>
        </select>
        <button
          type="button"
          className="btn-secondary rh-refresh"
          disabled={loading || loadingMore}
          onClick={() => { void loadRuns('replace') }}
        >
          {t('page.refresh')}
        </button>
        <span className="rh-count">{countLabel}</span>
      </div>

      {showInitialError && (
        <div className="card rh-error" role="alert">
          <span>{listError}</span>
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={() => { void loadRuns(listRetryMode) }}
          >
            {t('page.retry')}
          </button>
        </div>
      )}

      {!showInitialError && listError !== '' && runs.length > 0 && (
        <div className="card rh-notice-error" role="alert">
          <span>{listError}</span>
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={() => { void loadRuns(listRetryMode) }}
          >
            {t('page.retry')}
          </button>
        </div>
      )}

      {loading && runs.length === 0 && <RunHistorySkeleton label={t('page.loading')} />}

      {!loading && listError === '' && runs.length === 0 && (
        <div className="card rh-empty">{t('page.noRuns')}</div>
      )}

      {!loading && runs.length > 0 && shown.length === 0 && (
        <div className="card rh-empty">{t('page.noMatches')}</div>
      )}

      {shown.length > 0 && (
        <div className="card rh-table-card">
          <div className="rh-table-scroll">
            <table className="data-table rh-run-table" aria-label={t('page.tableAria')}>
              <caption className="rh-visually-hidden">{t('page.tableAria')}</caption>
              <thead>
                <tr>
                  <th>{t('page.actions')}</th>
                  <th>{t('page.runId')}</th>
                  <th>{t('page.workflow')}</th>
                  <th>{t('page.status')}</th>
                  <th>{t('page.started')}</th>
                  <th>{t('page.finished')}</th>
                  <th>{t('page.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((run) => {
                  const expanded = expandedRunId === run.runId
                  return (
                    <Fragment key={run.runId}>
                      <tr>
                        <td>
                          <div className="rh-actions">
                            <button
                              type="button"
                              className="btn-sm btn-secondary rh-expand"
                              aria-expanded={expanded}
                              aria-label={expanded
                                ? t('page.collapseFor', { id: run.runId })
                                : t('page.expandFor', { id: run.runId })}
                              onClick={() => { toggleDetail(run.runId) }}
                            >
                              {expanded ? t('page.collapse') : t('page.expand')}
                            </button>
                            {openCollaboration !== undefined && (
                              <button
                                type="button"
                                className="btn-sm btn-secondary rh-open-collaboration"
                                aria-label={t('page.openInCollaborationFor', { id: run.runId })}
                                title={t('page.openInCollaboration')}
                                onClick={() => { openCollaboration(run.runId) }}
                              >
                                {t('page.openInCollaboration')}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="font-mono rh-run-id" title={run.runId}>{run.runId}</td>
                        <td className="font-mono rh-workflow-id" title={run.workflowId}>{run.workflowId}</td>
                        <td>
                          <span className={RUN_STATUS_PILL_CLASS[run.status]}>
                            {t(RUN_STATUS_KEYS[run.status])}
                          </span>
                        </td>
                        <td className="font-mono">{formatTimestamp(run.startedAt)}</td>
                        <td className="font-mono">{formatTimestamp(run.finishedAt)}</td>
                        <td className="font-mono">{formatDuration(run.startedAt, run.finishedAt, t)}</td>
                      </tr>
                      {expanded && (
                        <tr className="rh-detail-row">
                          <td colSpan={7}>
                            <RunDetailPanel
                              run={run}
                              detail={detail}
                              loading={detailLoading}
                              error={detailError}
                              onRetry={() => { void requestDetail(run.runId) }}
                              t={t}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {canShowMore && (
            <div className="rh-more">
              <button
                type="button"
                className="btn-sm btn-secondary"
                disabled={loadingMore || loading}
                onClick={() => { void loadRuns('append') }}
              >
                {loadingMore ? t('page.loadingMore') : t('page.showMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Render the run history sidebar icon.
 * @param props - icon edge length.
 * @returns the run history glyph.
 */
export function RunHistoryIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
    </svg>
  )
}
