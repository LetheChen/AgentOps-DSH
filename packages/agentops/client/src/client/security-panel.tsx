/**
 * Read-only security administration pages: users, roles, sessions, and tokens.
 *
 * Each page loads one route. A failed refresh keeps the last successful rows
 * visible, while a first failure offers a retry. Credential issuance and access
 * mutations stay in audited Agent tools; this UI never fabricates write controls.
 *
 * @module @agentops/dsh-client/security-panel
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  SecurityRequestError,
  SecurityResponseError,
  loadSecurityRoles,
  loadSecuritySessions,
  loadSecurityTokens,
  loadSecurityUsers,
  type SecurityRole,
  type SecuritySession,
  type SecurityToken,
  type SecurityUser,
} from './security-api.js'
import { SECURITY_NS, type SecurityKey } from './security-locales.js'

/** Browser-supplied services for a read-only security page. */
export type SecurityPanelProps = PropsLocale<typeof SECURITY_NS> & {
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
}

interface Column<T> {
  readonly key: string
  readonly label: SecurityKey
  readonly cell: (row: T, t: SecurityPanelProps['t']) => ReactNode
}

interface SecurityReadOnlyPageProps<T> extends SecurityPanelProps {
  readonly titleKey: SecurityKey
  readonly subtitleKey: SecurityKey
  readonly tableAriaKey: SecurityKey
  readonly emptyKey: SecurityKey
  readonly load: (fetchImpl: typeof fetch) => Promise<readonly T[]>
  readonly columns: readonly Column<T>[]
  readonly rowKey: (row: T) => string
  readonly wide?: boolean
  readonly noteKey?: SecurityKey
}

const SKELETON_ROWS = ['one', 'two', 'three', 'four', 'five'] as const

function requestErrorText(error: unknown, t: SecurityPanelProps['t']): string {
  if (error instanceof SecurityRequestError) return t('error.http', { status: String(error.status) })
  if (error instanceof SecurityResponseError) return t('error.invalidResponse')
  return t('error.unknown')
}

function displayTimestamp(value: string | null, t: SecurityPanelProps['t']): string {
  if (value === null) return t('value.none')
  return Number.isFinite(Date.parse(value)) ? value.slice(0, 19).replace('T', ' ') : value
}

function Chips({
  values,
  t,
}: {
  readonly values: readonly string[]
  readonly t: SecurityPanelProps['t']
}): ReactElement {
  if (values.length === 0) return <span className="sec-muted">{t('value.none')}</span>
  return (
    <span className="sec-chips">
      {values.map(value => <span key={value} className="sec-chip sec-mono">{value}</span>)}
    </span>
  )
}

function StatusPill({
  tone,
  children,
}: {
  readonly tone: 'success' | 'neutral'
  readonly children: ReactNode
}): ReactElement {
  return <span className={`status-pill sec-pill sec-pill-${tone}`}>{children}</span>
}

function SecurityReadOnlyPage<T>({
  t,
  fetchImpl,
  titleKey,
  subtitleKey,
  tableAriaKey,
  emptyKey,
  load,
  columns,
  rowKey,
  wide = false,
  noteKey,
}: SecurityReadOnlyPageProps<T>): ReactElement {
  const [rows, setRows] = useState<readonly T[] | null>(null)
  const [initialError, setInitialError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const rowsRef = useRef<readonly T[] | null>(null)
  const requestId = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    const currentRows = rowsRef.current
    if (currentRows === null) setInitialError(null)
    else setRefreshing(true)
    setRefreshError(null)

    try {
      const next = await load(fetchImpl ?? fetch)
      if (id !== requestId.current) return
      rowsRef.current = next
      setRows(next)
      setInitialError(null)
    } catch (error) {
      if (id !== requestId.current) return
      const message = requestErrorText(error, t)
      if (currentRows === null) setInitialError(message)
      else setRefreshError(message)
    } finally {
      if (id === requestId.current && currentRows !== null) setRefreshing(false)
    }
  }, [fetchImpl, load, t])

  useEffect(() => {
    void reload()
    return () => { requestId.current += 1 }
  }, [reload])

  const loading = rows === null && initialError === null
  const count = rows?.length ?? 0

  return (
    <section className="ao-page agentops-surface sec-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">{t(titleKey)}</h1>
          <p className="ao-page-description">{t(subtitleKey)}</p>
        </div>
        <div className="ao-page-actions">
          {rows !== null && (
            <span className="status-pill status-pill-neutral sec-count" aria-live="polite">
              {t('page.count', { count: String(count) })}
            </span>
          )}
          <Button
            className="sec-refresh"
            variant="outline"
            icon={<IconRefreshOutlineRegular />}
            disabled={loading || refreshing}
            onClick={() => { void reload() }}
          >
            {t('page.refresh')}
          </Button>
        </div>
      </header>

      {refreshError !== null && (
        <div className="sec-feedback sec-feedback-warning" role="alert">
          {t('page.refreshFailed', { message: refreshError })}
        </div>
      )}

      {loading && (
        <div className="sec-card sec-skeleton" role="status" aria-live="polite">
          <span className="sec-sr-only">{t('page.loading')}</span>
          {SKELETON_ROWS.map(row => <span key={row} className="sec-skeleton-row" aria-hidden="true" />)}
        </div>
      )}

      {initialError !== null && (
        <div className="sec-card sec-feedback sec-feedback-error" role="alert">
          <div>
            <h2>{t('page.loadFailed', { message: initialError })}</h2>
          </div>
          <Button variant="outline" onClick={() => { void reload() }}>{t('page.retry')}</Button>
        </div>
      )}

      {rows !== null && (
        <div className="sec-card">
          {rows.length === 0
            ? <p className="sec-empty">{t(emptyKey)}</p>
            : (
              <div className="sec-table-wrap">
                <table
                  className={wide ? 'data-table sec-table sec-table-wide' : 'data-table sec-table'}
                  aria-label={t(tableAriaKey)}
                >
                  <thead>
                    <tr>
                      {columns.map(column => <th key={column.key} scope="col">{t(column.label)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={rowKey(row)}>
                        {columns.map(column => (
                          <td key={column.key}>{column.cell(row, t)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {noteKey !== undefined && <p className="sec-note">{t(noteKey)}</p>}
    </section>
  )
}

const USER_COLUMNS: readonly Column<SecurityUser>[] = [
  {
    key: 'name',
    label: 'table.name',
    cell: user => <span className="sec-primary">{user.name}</span>,
  },
  {
    key: 'id',
    label: 'table.id',
    cell: user => <span className="sec-mono">{user.id}</span>,
  },
  {
    key: 'email',
    label: 'table.email',
    cell: (user, t) => user.email === null
      ? <span className="sec-muted">{t('value.none')}</span>
      : <span>{user.email}</span>,
  },
  {
    key: 'roles',
    label: 'table.roles',
    cell: (user, t) => <Chips values={user.roleIds} t={t} />,
  },
  {
    key: 'status',
    label: 'table.status',
    cell: (user, t) => (
      <StatusPill tone={user.status === 'active' ? 'success' : 'neutral'}>
        {t(user.status === 'active' ? 'userStatus.active' : 'userStatus.disabled')}
      </StatusPill>
    ),
  },
  {
    key: 'createdAt',
    label: 'table.createdAt',
    cell: (user, t) => <span className="sec-mono">{displayTimestamp(user.createdAt, t)}</span>,
  },
]

const ROLE_COLUMNS: readonly Column<SecurityRole>[] = [
  {
    key: 'name',
    label: 'table.name',
    cell: role => <span className="sec-primary">{role.name}</span>,
  },
  {
    key: 'id',
    label: 'table.id',
    cell: role => <span className="sec-mono">{role.id}</span>,
  },
  {
    key: 'description',
    label: 'table.description',
    cell: (role, t) => role.description === ''
      ? <span className="sec-muted">{t('value.none')}</span>
      : <span className="sec-description">{role.description}</span>,
  },
  {
    key: 'permissions',
    label: 'table.permissions',
    cell: (role, t) => <Chips values={role.permissions} t={t} />,
  },
]

const SESSION_COLUMNS: readonly Column<SecuritySession>[] = [
  {
    key: 'id',
    label: 'table.id',
    cell: session => <span className="sec-mono">{session.id}</span>,
  },
  {
    key: 'userId',
    label: 'table.userId',
    cell: session => <span className="sec-mono">{session.userId}</span>,
  },
  {
    key: 'agent',
    label: 'table.agent',
    cell: session => <span>{session.agent}</span>,
  },
  {
    key: 'status',
    label: 'table.status',
    cell: (session, t) => (
      <StatusPill tone={session.status === 'active' ? 'success' : 'neutral'}>
        {t(session.status === 'active' ? 'sessionStatus.active' : 'sessionStatus.ended')}
      </StatusPill>
    ),
  },
  {
    key: 'startedAt',
    label: 'table.startedAt',
    cell: (session, t) => <span className="sec-mono">{displayTimestamp(session.startedAt, t)}</span>,
  },
  {
    key: 'endedAt',
    label: 'table.endedAt',
    cell: (session, t) => <span className="sec-mono">{displayTimestamp(session.endedAt, t)}</span>,
  },
]

const TOKEN_COLUMNS: readonly Column<SecurityToken>[] = [
  {
    key: 'name',
    label: 'table.name',
    cell: token => <span className="sec-primary">{token.name}</span>,
  },
  {
    key: 'id',
    label: 'table.id',
    cell: token => <span className="sec-mono">{token.id}</span>,
  },
  {
    key: 'userId',
    label: 'table.userId',
    cell: token => <span className="sec-mono">{token.userId}</span>,
  },
  {
    key: 'prefix',
    label: 'table.prefix',
    cell: token => <span className="sec-mono sec-prefix">{token.prefix}…</span>,
  },
  {
    key: 'status',
    label: 'table.status',
    cell: (token, t) => {
      const active = token.revokedAt === null
      return (
        <StatusPill tone={active ? 'success' : 'neutral'}>
          {t(active ? 'tokenStatus.active' : 'tokenStatus.revoked')}
        </StatusPill>
      )
    },
  },
  {
    key: 'createdAt',
    label: 'table.createdAt',
    cell: (token, t) => <span className="sec-mono">{displayTimestamp(token.createdAt, t)}</span>,
  },
  {
    key: 'revokedAt',
    label: 'table.revokedAt',
    cell: (token, t) => <span className="sec-mono">{displayTimestamp(token.revokedAt, t)}</span>,
  },
]

/**
 * Render the read-only user list with assigned role ids.
 * @param props - locale and injectable fetch.
 * @returns the users page.
 */
export function SecurityUsersPanel(props: SecurityPanelProps): ReactElement {
  return (
    <SecurityReadOnlyPage
      {...props}
      titleKey="page.users.title"
      subtitleKey="page.users.subtitle"
      tableAriaKey="table.usersAria"
      emptyKey="empty.users"
      load={loadSecurityUsers}
      columns={USER_COLUMNS}
      rowKey={user => user.id}
      wide
    />
  )
}

/**
 * Render the built-in roles and their permission ids.
 * @param props - locale and injectable fetch.
 * @returns the roles page.
 */
export function SecurityRolesPanel(props: SecurityPanelProps): ReactElement {
  return (
    <SecurityReadOnlyPage
      {...props}
      titleKey="page.roles.title"
      subtitleKey="page.roles.subtitle"
      tableAriaKey="table.rolesAria"
      emptyKey="empty.roles"
      load={loadSecurityRoles}
      columns={ROLE_COLUMNS}
      rowKey={role => role.id}
    />
  )
}

/**
 * Render recorded login sessions.
 * @param props - locale and injectable fetch.
 * @returns the sessions page.
 */
export function SecuritySessionsPanel(props: SecurityPanelProps): ReactElement {
  return (
    <SecurityReadOnlyPage
      {...props}
      titleKey="page.sessions.title"
      subtitleKey="page.sessions.subtitle"
      tableAriaKey="table.sessionsAria"
      emptyKey="empty.sessions"
      load={loadSecuritySessions}
      columns={SESSION_COLUMNS}
      rowKey={session => session.id}
    />
  )
}

/**
 * Render API-token descriptors without plaintext or hashes.
 * @param props - locale and injectable fetch.
 * @returns the tokens page.
 */
export function SecurityTokensPanel(props: SecurityPanelProps): ReactElement {
  return (
    <SecurityReadOnlyPage
      {...props}
      titleKey="page.tokens.title"
      subtitleKey="page.tokens.subtitle"
      tableAriaKey="table.tokensAria"
      emptyKey="empty.tokens"
      load={loadSecurityTokens}
      columns={TOKEN_COLUMNS}
      rowKey={token => token.id}
      wide
      noteKey="token.issueNote"
    />
  )
}

/**
 * Render the security glyph used by the roles menu entry.
 * @param props.size - square icon size in CSS pixels.
 * @returns the shield SVG.
 */
export function SecurityIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l7 2.5V11c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V5.5L12 3Z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
