/**
 * Session replay page: read-only list of DSH sessions and one session's events.
 *
 * Reads through `/api/agentops/sessions` and `/api/agentops/session-log`, both
 * backed by DSH's session query service. Events are shown as type plus preview;
 * the page never re-executes anything and never writes to a session.
 *
 * @module @agentops/dsh-client/session-replay-panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { PAGE_NS } from './page-locales.js'
import { PageRequestError, PageResponseError, isRecord, readJson } from './page-api.js'

/** Browser-supplied services for the session replay page. */
export type SessionReplayPanelProps = PropsLocale<typeof PAGE_NS> & {
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
  /** Renders below the unified run-log shell instead of drawing another page header. */
  readonly embedded?: boolean
}

/** One replayable DSH session. */
interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly live: boolean
  readonly persisted: boolean
  readonly updatedAt: string | null
}

/** One recorded session event. */
interface LogEvent {
  readonly type: string
  readonly at: string | null
  readonly preview: string
}

/**
 * Parse the session list body.
 * @param payload - response body.
 * @returns the sessions, or undefined when the body does not match the route.
 */
function parseSessions(payload: unknown): readonly SessionSummary[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) return undefined
  const sessions: SessionSummary[] = []
  for (const raw of payload.sessions) {
    if (!isRecord(raw)) return undefined
    const { id, title, live, persisted, updatedAt } = raw
    if (typeof id !== 'string' || typeof title !== 'string') return undefined
    if (typeof live !== 'boolean' || typeof persisted !== 'boolean') return undefined
    if (updatedAt !== null && typeof updatedAt !== 'string') return undefined
    sessions.push({ id, title, live, persisted, updatedAt })
  }
  return sessions
}

/**
 * Parse the session log body.
 * @param payload - response body.
 * @returns the log fields, or undefined when the body does not match the route.
 */
function parseLog(payload: unknown): { readonly title: string; readonly total: number; readonly events: readonly LogEvent[] } | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.error === 'string') return undefined
  const { title, total, events } = payload
  if (typeof title !== 'string' || typeof total !== 'number' || !Array.isArray(events)) return undefined
  const parsed: LogEvent[] = []
  for (const raw of events) {
    if (!isRecord(raw)) return undefined
    const { type, at, preview } = raw
    if (typeof type !== 'string' || typeof preview !== 'string') return undefined
    if (at !== null && typeof at !== 'string') return undefined
    parsed.push({ type, at, preview })
  }
  return { title, total, events: parsed }
}

/**
 * Describe a failed request in the page's own vocabulary.
 * @param error - error thrown by the request.
 * @param t - page translate function.
 * @returns the message to show.
 */
function reasonText(error: unknown, t: SessionReplayPanelProps['t']): string {
  if (error instanceof PageRequestError) {
    return error.reason === '' ? t('page.error.http', { status: String(error.status) }) : error.reason
  }
  if (error instanceof PageResponseError) return t('page.error.invalid')
  return t('page.error.unknown')
}

function displayTimestamp(value: string | null): string {
  if (value === null) return ''
  return Number.isFinite(Date.parse(value)) ? value.slice(0, 19).replace('T', ' ') : value
}

/**
 * Render the read-only session replay page.
 * @param props - page translate function and injectable fetch.
 * @returns the session replay page.
 */
export function SessionReplayPanel({ t, fetchImpl, embedded = false }: SessionReplayPanelProps): ReactElement {
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState('')
  const [sessionQuery, setSessionQuery] = useState('')
  const [events, setEvents] = useState<readonly LogEvent[] | null>(null)
  const [eventsTitle, setEventsTitle] = useState('')
  const [eventsTotal, setEventsTotal] = useState(0)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const sessionsRequest = useRef(0)
  const eventsRequest = useRef(0)

  const loadSessions = useCallback(async (): Promise<void> => {
    const id = ++sessionsRequest.current
    setSessionsError(null)
    setRefreshing(true)
    try {
      const payload = await readJson(fetchImpl ?? fetch, '/api/agentops/sessions')
      if (id !== sessionsRequest.current) return
      const parsed = parseSessions(payload)
      if (parsed === undefined) throw new PageResponseError()
      setSessions(parsed)
      setSelected(current => (parsed.some(session => session.id === current) ? current : (parsed[0]?.id ?? '')))
    } catch (error) {
      if (id !== sessionsRequest.current) return
      setSessionsError(reasonText(error, t))
    } finally {
      if (id === sessionsRequest.current) setRefreshing(false)
    }
  }, [fetchImpl, t])

  const loadEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (sessionId === '') return
    const id = ++eventsRequest.current
    setEventsError(null)
    try {
      const payload = await readJson(fetchImpl ?? fetch, `/api/agentops/session-log?id=${encodeURIComponent(sessionId)}`)
      if (id !== eventsRequest.current) return
      if (isRecord(payload) && typeof payload.error === 'string') {
        setEventsError(payload.error)
        return
      }
      const parsed = parseLog(payload)
      if (parsed === undefined) throw new PageResponseError()
      setEvents(parsed.events)
      setEventsTitle(parsed.title)
      setEventsTotal(parsed.total)
    } catch (error) {
      if (id !== eventsRequest.current) return
      setEventsError(reasonText(error, t))
    }
  }, [fetchImpl, t])

  useEffect(() => {
    void loadSessions()
    return () => { sessionsRequest.current += 1 }
  }, [loadSessions])

  useEffect(() => {
    void loadEvents(selected)
    return () => { eventsRequest.current += 1 }
  }, [loadEvents, selected])

  const visibleSessions = useMemo(() => {
    const normalized = sessionQuery.trim().toLocaleLowerCase()
    if (normalized === '') return sessions ?? []
    return (sessions ?? []).filter(session => session.title.toLocaleLowerCase().includes(normalized)
      || session.id.toLocaleLowerCase().includes(normalized))
  }, [sessionQuery, sessions])

  useEffect(() => {
    const first = visibleSessions[0]
    if (first === undefined) return
    if (!visibleSessions.some(session => session.id === selected)) setSelected(first.id)
  }, [selected, visibleSessions])

  const loading = sessions === null && sessionsError === null
  const count = sessions?.length ?? 0
  const truncated = events !== null && events.length < eventsTotal
  const actions = (
    <>
      <span className="ao-count">{t('replay.count', { count: String(count) })}</span>
      <Button
        variant="outline"
        icon={<IconRefreshOutlineRegular />}
        disabled={loading || refreshing}
        onClick={() => { void loadSessions() }}
      >
        {t('page.refresh')}
      </Button>
    </>
  )

  return (
    <section className="agentops-surface ao-page ao-runlog-panel">
      {embedded
        ? (
          <header className="ao-runlog-section-toolbar">
            <div className="ao-runlog-section-heading">
              <h2>{t('replay.title')}</h2>
              <p>{t('replay.description')}</p>
            </div>
            <div className="ao-page-actions">{actions}</div>
          </header>
        )
        : (
          <header className="ao-page-header">
            <div className="ao-page-heading">
              <h1 className="ao-page-title">{t('replay.title')}</h1>
              <p className="ao-page-description">{t('replay.description')}</p>
            </div>
            <div className="ao-page-actions">{actions}</div>
          </header>
        )}

      {sessionsError !== null && (
        <div className="ao-card ao-state ao-state-error" role="alert">
          <div>{t('replay.loadFailed', { message: sessionsError })}</div>
          <div className="ao-state-actions">
            <Button variant="outline" onClick={() => { void loadSessions() }}>{t('page.retry')}</Button>
          </div>
        </div>
      )}

      {loading && (
        <div className="ao-card ao-skeleton" role="status" aria-live="polite">
          <span className="ao-sr-only">{t('page.loading')}</span>
          {['one', 'two', 'three'].map(row => <span key={row} className="ao-skeleton-row" aria-hidden="true" />)}
        </div>
      )}

      {sessions !== null && sessions.length === 0 && (
        <div className="ao-card ao-state">{t('replay.empty')}</div>
      )}

      {sessions !== null && sessions.length > 0 && visibleSessions.length === 0 && (
        <div className="ao-card ao-state">{t('replay.noMatches')}</div>
      )}

      {sessions !== null && visibleSessions.length > 0 && (
        <div className="ao-split ao-replay-split">
          <div className="ao-card ao-replay-list-card">
            <div className="ao-replay-list-toolbar">
              <input
                className="input-base"
                type="search"
                aria-label={t('replay.search')}
                placeholder={t('replay.search')}
                value={sessionQuery}
                onChange={(event) => { setSessionQuery(event.target.value) }}
              />
            </div>
            <div className="ao-list" role="list" aria-label={t('replay.listAria')}>
              {visibleSessions.map(session => (
                <button
                  key={session.id}
                  type="button"
                  className="ao-list-item"
                  aria-current={session.id === selected}
                  onClick={() => { setSelected(session.id) }}
                >
                  <span className="ao-list-title">{session.title === '' ? t('replay.untitled') : session.title}</span>
                  <span className="ao-list-meta">
                    {session.id.slice(0, 16)}
                    {session.live ? ` · ${t('replay.live')}` : ''}
                    {session.persisted ? ` · ${t('replay.persisted')}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="ao-card ao-replay-events-card">
            <div className="ao-card-title">
              {eventsTitle === '' ? t('replay.untitled') : eventsTitle}
              {events !== null && (
                <span className="ao-muted"> · {t('replay.events', { count: String(events.length) })}</span>
              )}
            </div>

            {eventsError !== null && (
              <div className="ao-feedback ao-feedback-error" role="alert">
                <span>{t('replay.eventsFailed', { message: eventsError })}</span>
                <Button variant="outline" onClick={() => { void loadEvents(selected) }}>{t('page.retry')}</Button>
              </div>
            )}

            {eventsError === null && events === null && (
              <div className="ao-skeleton" role="status" aria-live="polite">
                <span className="ao-sr-only">{t('page.loading')}</span>
                {['one', 'two'].map(row => <span key={row} className="ao-skeleton-row" aria-hidden="true" />)}
              </div>
            )}

            {events !== null && events.length === 0 && (
              <p className="ao-state">{t('replay.emptyEvents')}</p>
            )}

            {events !== null && events.length > 0 && (
              <>
                {truncated && (
                  <div className="ao-feedback ao-feedback-warning" role="alert">
                    {t('replay.truncated', { shown: String(events.length), total: String(eventsTotal) })}
                  </div>
                )}
                <div className="ao-table-wrap ao-replay-table-wrap">
                  <table className="ao-table ao-replay-table" aria-label={t('replay.eventsAria')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('replay.col.index')}</th>
                        <th scope="col">{t('replay.col.type')}</th>
                        <th scope="col">{t('replay.col.time')}</th>
                        <th scope="col">{t('replay.col.preview')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event, index) => (
                        <tr key={`${event.type}-${index}`}>
                          <td className="ao-mono ao-replay-index">{index + 1}</td>
                          <td className="ao-mono ao-replay-type" title={event.type}>{event.type}</td>
                          <td className="ao-mono ao-replay-time">{displayTimestamp(event.at)}</td>
                          <td className="ao-replay-preview"><div>{event.preview}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}


          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Render the session glyph used by the menu entry.
 * @param props.size - square icon size in CSS pixels.
 * @returns the session SVG.
 */
export function SessionReplayIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5h16v14H4z" strokeLinejoin="round" />
      <path d="M8 9h8M8 13h5" strokeLinecap="round" />
    </svg>
  )
}
