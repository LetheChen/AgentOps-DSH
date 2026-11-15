/**
 * Generative-UI publication records and their in-page previews.
 *
 * Agents publish a board through the `present_content` tool. The record page
 * opens a selected board in the main content area, so previewing does not
 * depend on opening a conversation or its right sidebar.
 *
 * @module @agentops/dsh-client/a2ui-panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { PAGE_NS } from './page-locales.js'
import { PageRequestError, PageResponseError, isRecord, readJson } from './page-api.js'
import { SurfaceScreen } from './surface-screen/ScreenBody.tsx'

/** Browser-supplied services for the generative-UI page. */
export type A2uiPanelProps = PropsLocale<typeof PAGE_NS> & {
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
  /** Renders below the unified run-log shell instead of drawing another page header. */
  readonly embedded?: boolean
}

/** One published board. */
interface SurfaceRow {
  readonly id: number
  readonly viewId: string
  readonly title: string
  readonly createdAt: string
  readonly componentCount: number
  readonly renderable: boolean
}

/**
 * Parse one published board.
 * @param value - one entry of the views array.
 * @returns the row, or undefined when the entry does not match the route.
 */
function parseSurface(value: unknown): SurfaceRow | undefined {
  if (!isRecord(value)) return undefined
  const { id, viewId, title, createdAt, surface } = value
  if (typeof id !== 'number' || typeof viewId !== 'string') return undefined
  if (typeof title !== 'string' || typeof createdAt !== 'string') return undefined
  const components = isRecord(surface) && Array.isArray(surface.components) ? surface.components : []
  const renderable = components.length > 0
    && components.every(entry => isRecord(entry) && typeof entry.component === 'string')
  return { id, viewId, title, createdAt, componentCount: components.length, renderable }
}

/**
 * Describe a failed request in the page's own vocabulary.
 * @param error - error thrown by the request.
 * @param t - page translate function.
 * @returns the message to show.
 */
function reasonText(error: unknown, t: A2uiPanelProps['t']): string {
  if (error instanceof PageRequestError) {
    return error.reason === '' ? t('page.error.http', { status: String(error.status) }) : error.reason
  }
  if (error instanceof PageResponseError) return t('page.error.invalid')
  return t('page.error.unknown')
}

function displayTimestamp(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value.slice(0, 19).replace('T', ' ') : value
}

/**
 * Render the generative-UI publication page.
 * @param props - page translate function, injectable fetch, and embedded layout flag.
 * @returns the generative-UI page.
 */
export function A2uiPanel({ t, fetchImpl, embedded = false }: A2uiPanelProps): ReactElement {
  const [rows, setRows] = useState<readonly SurfaceRow[] | null>(null)
  const [initialError, setInitialError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [previewViewId, setPreviewViewId] = useState<string | null>(null)
  const rowsRef = useRef<readonly SurfaceRow[] | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    const current = rowsRef.current
    if (current === null) setInitialError(null)
    else setRefreshing(true)
    setRefreshError(null)
    try {
      const payload = await readJson(fetchImpl ?? fetch, '/api/agentops/surfaces/views')
      if (id !== requestId.current) return
      if (!isRecord(payload) || !Array.isArray(payload.views)) throw new PageResponseError()
      const parsed: SurfaceRow[] = []
      for (const raw of payload.views) {
        const row = parseSurface(raw)
        if (row === undefined) throw new PageResponseError()
        parsed.push(row)
      }
      rowsRef.current = parsed
      setRows(parsed)
      setInitialError(null)
    } catch (error) {
      if (id !== requestId.current) return
      const message = reasonText(error, t)
      if (current === null) setInitialError(message)
      else setRefreshError(message)
    } finally {
      if (id === requestId.current && current !== null) setRefreshing(false)
    }
  }, [fetchImpl, t])

  useEffect(() => {
    void load()
    return () => { requestId.current += 1 }
  }, [load])

  const loading = rows === null && initialError === null
  const count = rows?.length ?? 0
  const preview = previewViewId === null ? null : rows?.find(row => row.viewId === previewViewId) ?? null
  const actions = useMemo(() => (
    <>
      <span className="ao-count">{t('a2ui.count', { count: String(count) })}</span>
      <Button
        variant="outline"
        icon={<IconRefreshOutlineRegular />}
        disabled={loading || refreshing}
        onClick={() => { void load() }}
      >
        {t('page.refresh')}
      </Button>
    </>
  ), [count, load, loading, refreshing, t])

  return (
    <section className="agentops-surface ao-page ao-runlog-panel">
      {embedded
        ? (
          <header className="ao-runlog-section-toolbar">
            <div className="ao-runlog-section-heading">
              <h2>{t('a2ui.title')}</h2>
              <p>{t('a2ui.previewHint')}</p>
            </div>
            <div className="ao-page-actions">{actions}</div>
          </header>
        )
        : (
          <header className="ao-page-header">
            <div className="ao-page-heading">
              <h1 className="ao-page-title">{t('a2ui.title')}</h1>
              <p className="ao-page-description">{t('a2ui.description')}</p>
            </div>
            <div className="ao-page-actions">{actions}</div>
          </header>
        )}

      {refreshError !== null && (
        <div className="ao-feedback ao-feedback-warning" role="alert">{refreshError}</div>
      )}

      {loading && (
        <div className="ao-card ao-skeleton" role="status" aria-live="polite">
          <span className="ao-sr-only">{t('page.loading')}</span>
          {['one', 'two', 'three'].map(row => <span key={row} className="ao-skeleton-row" aria-hidden="true" />)}
        </div>
      )}

      {initialError !== null && (
        <div className="ao-card ao-state ao-state-error" role="alert">
          <div>{initialError}</div>
          <div className="ao-state-actions">
            <Button variant="outline" onClick={() => { void load() }}>{t('page.retry')}</Button>
          </div>
        </div>
      )}

      {rows !== null && preview === null && (
        <>
          <div className="ao-card ao-surface-card">
            {rows.length === 0
              ? <p className="ao-state">{t('a2ui.empty')}</p>
              : (
                <div className="ao-surface-list" role="list">
                  {rows.map(row => (
                    <article className="ao-surface-item" role="listitem" key={row.id}>
                      <span className="ao-surface-item-icon" aria-hidden="true"><A2uiPanelIcon size={18} /></span>
                      <div className="ao-surface-item-main">
                        <div className="ao-surface-item-title-row">
                          <strong>{row.title}</strong>
                          <span className={`status-pill ${row.renderable ? 'status-pill-success' : 'status-pill-neutral'}`}>
                            {t(row.renderable ? 'a2ui.status.renderable' : 'a2ui.status.skipped')}
                          </span>
                        </div>
                        <div className="ao-surface-item-meta">
                          <code>{row.viewId}</code>
                          <span>{t('a2ui.componentCount', { count: String(row.componentCount) })}</span>
                          <time dateTime={row.createdAt}>{displayTimestamp(row.createdAt)}</time>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-primary btn-sm ao-surface-preview-action"
                        disabled={!row.renderable}
                        onClick={() => { setPreviewViewId(row.viewId) }}
                      >
                        {t('a2ui.preview')}
                      </button>
                    </article>
                  ))}
                </div>
              )}
          </div>
          <p className="ao-note">{t('a2ui.note')}</p>
        </>
      )}

      {preview !== null && (
        <section className="ao-card ao-a2ui-inline-preview">
          <header className="ao-a2ui-preview-head">
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setPreviewViewId(null) }}>
              ← {t('a2ui.back')}
            </button>
            <div className="ao-a2ui-preview-heading">
              <h2>{preview.title}</h2>
              <div>
                <span className="ao-mono">{preview.viewId}</span>
                <span>{t('a2ui.componentCount', { count: String(preview.componentCount) })}</span>
                <span>{displayTimestamp(preview.createdAt)}</span>
              </div>
            </div>
            <span className={`status-pill ${preview.renderable ? 'status-pill-success' : 'status-pill-neutral'}`}>
              {t(preview.renderable ? 'a2ui.status.renderable' : 'a2ui.status.skipped')}
            </span>
          </header>
          <div className="ao-a2ui-preview-body">
            <SurfaceScreen viewId={preview.viewId} readOnly chrome={false} showCardHeader={false} />
          </div>
        </section>
      )}
    </section>
  )
}

/**
 * Render the generative-UI glyph used by the menu entry and record rows.
 * @param props.size - square icon size in CSS pixels.
 * @returns the board SVG.
 */
export function A2uiPanelIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 17.5h7M17.5 14v7" strokeLinecap="round" />
    </svg>
  )
}
