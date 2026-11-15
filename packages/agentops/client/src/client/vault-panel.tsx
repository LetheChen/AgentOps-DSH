/**
 * Credential management page: database and server connections.
 *
 * Secrets never come back from the server, so the table only shows whether a
 * password is stored. The dialog sends a password once (a blank field keeps
 * the stored one), and the test button asks the host to connect for real.
 *
 * @module @agentops/dsh-client/vault-panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { PAGE_NS } from './page-locales.js'
import { PageRequestError, PageResponseError, isRecord, postJson, readJson } from './page-api.js'

/** Browser-supplied services for the credential page. */
export type VaultPanelProps = PropsLocale<typeof PAGE_NS> & {
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
}

/** The two connection families the vault stores. */
type Tab = 'database' | 'server'

/** One stored connection, as the list route reports it. */
interface ConnectionView {
  readonly id: string
  readonly kind: Tab
  readonly name: string
  readonly driver: string
  readonly host: string
  readonly port: number | null
  readonly username: string
  readonly defaultDatabase: string | null
  readonly enabled: boolean
  readonly hasSecret: boolean
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
}

/** One audited credential change. */
interface AuditEvent {
  readonly action: string
  readonly target: string
  readonly at: string
  readonly detail: string
}

/** The editable form state behind the connection dialog. */
interface Draft {
  readonly id: string
  readonly kind: Tab
  readonly name: string
  readonly driver: string
  readonly host: string
  readonly port: string
  readonly username: string
  readonly defaultDatabase: string
  readonly enabled: boolean
  readonly password: string
  readonly isNew: boolean
}

/** A transient page-level message. */
interface Notice {
  readonly tone: 'success' | 'warning' | 'error'
  readonly text: string
}

const DRIVERS: Record<Tab, readonly string[]> = {
  database: ['mysql', 'sqlite'],
  server: ['ssh'],
}

const ID_PATTERN = /^[a-z0-9_-]{2,64}$/i

function emptyDraft(kind: Tab): Draft {
  return {
    id: '',
    kind,
    name: '',
    driver: DRIVERS[kind][0] ?? '',
    host: '',
    port: kind === 'database' ? '3306' : '22',
    username: '',
    defaultDatabase: '',
    enabled: true,
    password: '',
    isNew: true,
  }
}

function draftOf(connection: ConnectionView): Draft {
  return {
    id: connection.id,
    kind: connection.kind,
    name: connection.name,
    driver: connection.driver,
    host: connection.host,
    port: connection.port === null ? '' : String(connection.port),
    username: connection.username,
    defaultDatabase: connection.defaultDatabase ?? '',
    enabled: connection.enabled,
    password: '',
    isNew: false,
  }
}

function parseConnection(value: unknown): ConnectionView | undefined {
  if (!isRecord(value)) return undefined
  const { id, kind, name, driver, host, port, username, defaultDatabase, enabled, hasSecret, lastTestAt, lastTestOk } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof driver !== 'string') return undefined
  if (kind !== 'database' && kind !== 'server') return undefined
  if (typeof host !== 'string' || typeof username !== 'string') return undefined
  if (port !== null && typeof port !== 'number') return undefined
  if (defaultDatabase !== null && typeof defaultDatabase !== 'string') return undefined
  if (typeof enabled !== 'boolean' || typeof hasSecret !== 'boolean') return undefined
  if (lastTestAt !== null && typeof lastTestAt !== 'string') return undefined
  if (lastTestOk !== null && typeof lastTestOk !== 'boolean') return undefined
  return {
    id,
    kind,
    name,
    driver,
    host,
    port,
    username,
    defaultDatabase,
    enabled,
    hasSecret,
    lastTestAt,
    lastTestOk,
  }
}

function parseAuditEvent(value: unknown): AuditEvent | undefined {
  if (!isRecord(value)) return undefined
  const { action, target, at, detail } = value
  if (typeof action !== 'string' || typeof target !== 'string' || typeof at !== 'string') return undefined
  return { action, target, at, detail: describeDetail(detail) }
}

/**
 * Flatten an audit detail object into readable text.
 * @param detail - audit detail as reported by the vault.
 * @returns the scalar fields joined into one line.
 */
function describeDetail(detail: unknown): string {
  if (!isRecord(detail)) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined || typeof value === 'object') continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join(' ')
}

/**
 * Describe a failed request in the page's own vocabulary.
 * @param error - error thrown by the request.
 * @param t - page translate function.
 * @returns the message to show.
 */
function reasonText(error: unknown, t: VaultPanelProps['t']): string {
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
 * Validate a draft before it reaches the host.
 * @param draft - draft to validate.
 * @param t - page translate function.
 * @returns the first problem, or null when the draft is acceptable.
 */
function validateDraft(draft: Draft, t: VaultPanelProps['t']): string | null {
  if (!ID_PATTERN.test(draft.id)) return t('vault.error.id')
  if (draft.port !== '') {
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return t('vault.error.port')
  }
  if (draft.host.trim() === '') return t('vault.error.host')
  return null
}

/**
 * Render the credential management page.
 * @param props - page translate function and injectable fetch.
 * @returns the credential page.
 */
export function VaultPanel({ t, fetchImpl }: VaultPanelProps): ReactElement {
  const [rows, setRows] = useState<readonly ConnectionView[] | null>(null)
  const [initialError, setInitialError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [audit, setAudit] = useState<readonly AuditEvent[]>([])
  const [tab, setTab] = useState<Tab>('database')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ConnectionView | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const rowsRef = useRef<readonly ConnectionView[] | null>(null)
  const requestId = useRef(0)

  const loadAudit = useCallback(async (): Promise<void> => {
    try {
      const payload = await readJson(fetchImpl ?? fetch, '/api/agentops/connections/audit?limit=10')
      if (!isRecord(payload) || !Array.isArray(payload.events)) return
      const parsed: AuditEvent[] = []
      for (const raw of payload.events) {
        const event = parseAuditEvent(raw)
        if (event !== undefined) parsed.push(event)
      }
      setAudit(parsed)
    } catch {
      // The audit trail is supplementary: a failure here must not hide the connections.
    }
  }, [fetchImpl])

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    const current = rowsRef.current
    if (current === null) setInitialError(null)
    else setRefreshing(true)
    setRefreshError(null)
    try {
      const payload = await readJson(fetchImpl ?? fetch, '/api/agentops/connections')
      if (id !== requestId.current) return
      if (!isRecord(payload) || !Array.isArray(payload.connections)) throw new PageResponseError()
      const parsed: ConnectionView[] = []
      for (const raw of payload.connections) {
        const row = parseConnection(raw)
        if (row === undefined) throw new PageResponseError()
        parsed.push(row)
      }
      rowsRef.current = parsed
      setRows(parsed)
      setInitialError(null)
      void loadAudit()
    } catch (error) {
      if (id !== requestId.current) return
      const message = reasonText(error, t)
      if (current === null) setInitialError(message)
      else setRefreshError(message)
    } finally {
      if (id === requestId.current && current !== null) setRefreshing(false)
    }
  }, [fetchImpl, loadAudit, t])

  useEffect(() => {
    void load()
    return () => { requestId.current += 1 }
  }, [load])

  const counts = useMemo(() => ({
    database: rows?.filter(row => row.kind === 'database').length ?? 0,
    server: rows?.filter(row => row.kind === 'server').length ?? 0,
  }), [rows])

  const shown = useMemo(() => rows?.filter(row => row.kind === tab) ?? [], [rows, tab])

  const openNew = useCallback((kind: Tab): void => {
    setDraft(emptyDraft(kind))
    setDraftError(null)
  }, [])

  const save = useCallback(async (value: Draft): Promise<void> => {
    const problem = validateDraft(value, t)
    if (problem !== null) {
      setDraftError(problem)
      return
    }
    setBusy('save')
    setNotice(null)
    try {
      const payload = await postJson(fetchImpl ?? fetch, '/api/agentops/connections/save', {
        id: value.id,
        kind: value.kind,
        name: value.name,
        driver: value.driver,
        host: value.host,
        port: value.port === '' ? null : Number(value.port),
        username: value.username,
        defaultDatabase: value.defaultDatabase,
        enabled: value.enabled,
        ...(value.password === '' ? {} : { password: value.password }),
      })
      if (!isRecord(payload) || payload.ok !== true) {
        const reason = isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : t('page.error.unknown')
        setNotice({ tone: 'error', text: t('vault.notice.saveFailed', { message: reason }) })
        return
      }
      setDraft(null)
      setNotice({
        tone: 'success',
        text: t(value.isNew ? 'vault.notice.created' : 'vault.notice.saved', { id: value.id }),
      })
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: t('vault.notice.saveFailed', { message: reasonText(error, t) }) })
    } finally {
      setBusy('')
    }
  }, [fetchImpl, load, t])

  const test = useCallback(async (connection: ConnectionView): Promise<void> => {
    setBusy(`test:${connection.id}`)
    setNotice(null)
    try {
      const payload = await postJson(fetchImpl ?? fetch, '/api/agentops/connections/test', { id: connection.id })
      if (!isRecord(payload) || typeof payload.ok !== 'boolean' || typeof payload.detail !== 'string') {
        throw new PageResponseError()
      }
      setNotice(payload.ok
        ? { tone: 'success', text: t('vault.notice.testOk', { id: connection.id, detail: payload.detail }) }
        : { tone: 'warning', text: t('vault.notice.testFailed', { id: connection.id, detail: payload.detail }) })
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: t('vault.notice.testError', { message: reasonText(error, t) }) })
    } finally {
      setBusy('')
    }
  }, [fetchImpl, load, t])

  const remove = useCallback(async (connection: ConnectionView): Promise<void> => {
    setBusy(`remove:${connection.id}`)
    try {
      const payload = await postJson(fetchImpl ?? fetch, '/api/agentops/connections/remove', { id: connection.id })
      if (!isRecord(payload) || payload.ok !== true) {
        setNotice({ tone: 'error', text: t('vault.notice.removeFailed', { message: t('page.error.unknown') }) })
        return
      }
      setPendingDelete(null)
      setNotice({ tone: 'success', text: t('vault.notice.deleted', { id: connection.id }) })
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: t('vault.notice.removeFailed', { message: reasonText(error, t) }) })
    } finally {
      setBusy('')
    }
  }, [fetchImpl, load, t])

  const loading = rows === null && initialError === null
  const count = rows?.length ?? 0

  return (
    <section className="agentops-surface ao-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">{t('vault.title')}</h1>
          <p className="ao-page-description">{t('vault.description')}</p>
        </div>
        <div className="ao-page-actions">
          <span className="ao-count">{t('page.count', { count: String(count) })}</span>
          <Button
            variant="outline"
            icon={<IconRefreshOutlineRegular />}
            disabled={loading || refreshing}
            onClick={() => { void load() }}
          >
            {t('page.refresh')}
          </Button>
          <Button variant="primary" onClick={() => { openNew(tab) }}>{t('vault.new')}</Button>
        </div>
      </header>

      <div className="ao-toolbar">
        <div className="ao-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="ao-tab"
            aria-selected={tab === 'database'}
            onClick={() => { setTab('database') }}
          >
            {t('vault.tab.database')}
            <span className="ao-tab-count">{counts.database}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="ao-tab"
            aria-selected={tab === 'server'}
            onClick={() => { setTab('server') }}
          >
            {t('vault.tab.server')}
            <span className="ao-tab-count">{counts.server}</span>
          </button>
        </div>
      </div>

      {notice !== null && (
        <div
          className={`ao-feedback ao-feedback-${notice.tone}`}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          {notice.text}
        </div>
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

      {rows !== null && (
        <div className="ao-card">
          {shown.length === 0
            ? <p className="ao-state">{t('vault.empty', { label: t(tab === 'database' ? 'vault.tab.database' : 'vault.tab.server') })}</p>
            : (
              <div className="ao-table-wrap">
                <table className="ao-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('vault.col.name')}</th>
                      <th scope="col">{t('vault.col.driver')}</th>
                      <th scope="col">{t('vault.col.address')}</th>
                      <th scope="col">{t('vault.col.username')}</th>
                      <th scope="col">{t('vault.col.database')}</th>
                      <th scope="col">{t('vault.col.secret')}</th>
                      <th scope="col">{t('vault.col.test')}</th>
                      <th scope="col">{t('vault.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(row => (
                      <tr key={row.id}>
                        <td>
                          <div className="ao-primary-text">{row.name}</div>
                          <div className="ao-mono ao-muted">{row.id}</div>
                        </td>
                        <td>{row.driver}</td>
                        <td className="ao-mono">{row.host}{row.port === null ? '' : `:${row.port}`}</td>
                        <td>{row.username}</td>
                        <td>{row.defaultDatabase ?? ''}</td>
                        <td>
                          <span className={`status-pill ${row.hasSecret ? 'status-pill-success' : 'status-pill-neutral'}`}>
                            {t(row.hasSecret ? 'vault.secret.set' : 'vault.secret.missing')}
                          </span>
                          {!row.enabled && (
                            <span className="status-pill status-pill-warning">{t('vault.disabled')}</span>
                          )}
                        </td>
                        <td>
                          {row.lastTestOk === null
                            ? <span className="ao-muted">{t('vault.test.none')}</span>
                            : (
                              <span className={`status-pill ${row.lastTestOk ? 'status-pill-success' : 'status-pill-error'}`}>
                                {t(row.lastTestOk ? 'vault.test.ok' : 'vault.test.failed')}
                              </span>
                            )}
                        </td>
                        <td>
                          <div className="vp-actions">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== ''}
                              onClick={() => { void test(row) }}
                            >
                              {busy === `test:${row.id}` ? t('vault.testing') : t('vault.action.test')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== ''}
                              onClick={() => { setDraft(draftOf(row)); setDraftError(null) }}
                            >
                              {t('vault.action.edit')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== ''}
                              onClick={() => { setPendingDelete(row) }}
                            >
                              {t('vault.action.delete')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {rows !== null && (
        <div className="ao-card">
          <div className="ao-card-title">{t('vault.audit.title')}</div>
          {audit.length === 0
            ? <p className="ao-state">{t('vault.audit.empty')}</p>
            : (
              <div className="ao-table-wrap">
                <table className="ao-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('vault.audit.col.at')}</th>
                      <th scope="col">{t('vault.audit.col.action')}</th>
                      <th scope="col">{t('vault.audit.col.target')}</th>
                      <th scope="col">{t('vault.audit.col.detail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map(event => (
                      <tr key={`${event.at}-${event.action}-${event.target}`}>
                        <td className="ao-mono">{displayTimestamp(event.at)}</td>
                        <td className="ao-mono">{event.action}</td>
                        <td className="ao-mono">{event.target}</td>
                        <td className="ao-mono">{event.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      <p className="ao-note">{t('vault.note')}</p>

      {draft !== null && (
        <Modal
          open
          onClose={() => { setDraft(null); setDraftError(null) }}
          title={draft.isNew
            ? t(draft.kind === 'database' ? 'vault.dialog.newDatabase' : 'vault.dialog.newServer')
            : t('vault.dialog.edit', { id: draft.id })}
          closeLabel={t('vault.close')}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setDraft(null); setDraftError(null) }}>{t('vault.cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy !== ''}
                onClick={() => { void save(draft) }}
              >
                {busy === 'save' ? t('vault.saving') : t('vault.save')}
              </Button>
            </>
          )}
        >
          <div className="vp-form">
            <div className="vp-grid">
              <label className="vp-field">
                <span className="vp-field-label">{t('vault.field.id')}</span>
                <input
                  className="input-base"
                  data-modal-autofocus
                  value={draft.id}
                  disabled={!draft.isNew}
                  onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
                />
              </label>
              <label className="vp-field">
                <span className="vp-field-label">
                  {t(draft.kind === 'database' ? 'vault.field.driver' : 'vault.field.protocol')}
                </span>
                <select
                  className="input-base"
                  value={draft.driver}
                  disabled={!draft.isNew}
                  onChange={(event) => { setDraft({ ...draft, driver: event.target.value }) }}
                >
                  {DRIVERS[draft.kind].map(driver => <option key={driver} value={driver}>{driver}</option>)}
                </select>
              </label>
              <label className="vp-field">
                <span className="vp-field-label">{t('vault.field.name')}</span>
                <input
                  className="input-base"
                  value={draft.name}
                  onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
                />
              </label>
              <label className="vp-field">
                <span className="vp-field-label">{t('vault.field.host')}</span>
                <input
                  className="input-base"
                  value={draft.host}
                  onChange={(event) => { setDraft({ ...draft, host: event.target.value }) }}
                />
              </label>
              <label className="vp-field">
                <span className="vp-field-label">{t('vault.field.port')}</span>
                <input
                  className="input-base"
                  value={draft.port}
                  onChange={(event) => { setDraft({ ...draft, port: event.target.value }) }}
                />
              </label>
              <label className="vp-field">
                <span className="vp-field-label">{t('vault.field.username')}</span>
                <input
                  className="input-base"
                  value={draft.username}
                  onChange={(event) => { setDraft({ ...draft, username: event.target.value }) }}
                />
              </label>
              {draft.kind === 'database' && (
                <label className="vp-field">
                  <span className="vp-field-label">{t('vault.field.database')}</span>
                  <input
                    className="input-base"
                    value={draft.defaultDatabase}
                    onChange={(event) => { setDraft({ ...draft, defaultDatabase: event.target.value }) }}
                  />
                </label>
              )}
            </div>
            <label className="vp-field">
              <span className="vp-field-label">{t('vault.field.password')}</span>
              <input
                className="input-base"
                type="password"
                autoComplete="new-password"
                value={draft.password}
                onChange={(event) => { setDraft({ ...draft, password: event.target.value }) }}
              />
              <span className="vp-field-hint">{t('vault.field.passwordHint')}</span>
            </label>
            <label className="vp-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => { setDraft({ ...draft, enabled: event.target.checked }) }}
              />
              <span>{t('vault.field.enabled')}</span>
            </label>
            {draftError !== null && (
              <div className="ao-feedback ao-feedback-error" role="alert">{draftError}</div>
            )}
          </div>
        </Modal>
      )}

      {pendingDelete !== null && (
        <Modal
          open
          onClose={() => { setPendingDelete(null) }}
          title={t('vault.confirm.title')}
          closeLabel={t('vault.close')}
          description={t('vault.confirm.body', { name: pendingDelete.name, id: pendingDelete.id })}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setPendingDelete(null) }}>{t('vault.cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy !== ''}
                onClick={() => { void remove(pendingDelete) }}
              >
                {t('vault.confirm.action')}
              </Button>
            </>
          )}
        />
      )}
    </section>
  )
}

/**
 * Render the credential glyph used by the menu entry.
 * @param props.size - square icon size in CSS pixels.
 * @returns the vault SVG.
 */
export function VaultIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3v10c0 1.7-3.6 3-8 3s-8-1.3-8-3V7z" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}
