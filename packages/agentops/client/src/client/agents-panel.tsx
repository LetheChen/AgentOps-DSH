/**
 * Agent catalogue with search, Domain and Harness filters, and the create/edit surface.
 *
 * @module @agentops/dsh-client/agents-panel
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  loadAgentCatalog,
  type AgentCatalog,
  type AgentCatalogEntry,
} from './agent-catalogue-api.js'
import {
  loadDomainRegistry,
  type DomainRegistryEntry,
} from './registry-api.js'
import { AGENTS_NS } from './agent-locales/index.js'
import { AgentsEditor, type AgentEditorTarget } from './agents-editor.js'

/** Browser-supplied services for the Agent catalogue page. */
export type AgentsPanelProps = PropsLocale<typeof AGENTS_NS> & {
  /** Publish a localized success notice outside the panel lifetime. */
  readonly publishSuccess: (text: string) => void
  /** Publish a localized failure notice outside the panel lifetime. */
  readonly publishFailure: (text: string) => void
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
}

const SKELETON_KEYS = ['one', 'two', 'three', 'four', 'five', 'six'] as const

const USD_COST_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

function formatUsdCost(value: number): string {
  return USD_COST_FORMAT.format(value)
}

function domainOptions(
  entries: readonly AgentCatalogEntry[],
  registry: readonly DomainRegistryEntry[],
): readonly string[] {
  const names = [
    ...entries.map(entry => entry.domain),
    ...registry.map(entry => entry.domain),
  ]
  return [...new Set(names.filter(Boolean))].sort()
}

function harnessOptions(entries: readonly AgentCatalogEntry[]): readonly string[] {
  return [...new Set(entries.map(entry => entry.executionBackend).filter(Boolean))].sort()
}

function matchesQuery(entry: AgentCatalogEntry, query: string): boolean {
  if (query === '') return true
  return [entry.name, entry.id, entry.domain, entry.description]
    .some(value => value.toLowerCase().includes(query))
}

function AgentCard({
  entry,
  t,
  onOpen,
}: {
  readonly entry: AgentCatalogEntry
  readonly t: AgentsPanelProps['t']
  readonly onOpen: (agentId: string) => void
}): ReactElement {
  const invalidDescriptionId = `agent-invalid-description-${entry.id}`
  return (
    <button
      type="button"
      className={entry.valid ? 'agx-card' : 'agx-card agx-card-invalid'}
      disabled={!entry.valid}
      aria-label={entry.valid ? t('page.openAria', { name: entry.name }) : t('page.invalid')}
      aria-describedby={entry.valid ? undefined : invalidDescriptionId}
      data-agent-id={entry.id}
      data-valid={entry.valid ? 'true' : 'false'}
      onClick={() => { onOpen(entry.id) }}
    >
      <span className="agx-card-top">
        <span className="agx-card-idblock">
          <span className="agx-card-name">{entry.name}</span>
          <span className="agx-card-id agx-mono">{entry.id}</span>
        </span>
        <span className="agx-card-badges">
          {entry.executionBackend !== 'auto' && <span className="agx-badge">{entry.executionBackend}</span>}
          {!entry.valid && (
            <span className="agx-badge agx-badge-invalid">
              <IconWarningOutlineRegular size={12} />
              {t('page.invalid')}
            </span>
          )}
        </span>
      </span>
      <span className="agx-card-tags">
        <span className="agx-card-domain">
          <span className="agx-card-domain-dot" aria-hidden="true" />
          {entry.domain || t('card.none')}
        </span>
        <span className="agx-card-model agx-mono">{entry.model || t('card.none')}</span>
      </span>
      <span className="agx-card-description">
        {entry.valid ? (entry.description || t('card.none')) : t('page.invalidDescription')}
      </span>
      {entry.valid && (
        <>
          <span className="agx-card-permissions">
            <span className="agx-card-permission">
              <span className="agx-card-permission-dot agx-card-permission-dot-allow" aria-hidden="true" />
              {t('tool.allowed')} {entry.allowed_tools.length}
            </span>
            <span className="agx-card-permission">
              <span className="agx-card-permission-dot agx-card-permission-dot-deny" aria-hidden="true" />
              {t('tool.denied')} {entry.denied_tools.length}
            </span>
            <span className="agx-card-permission">{t('card.knowledge')} {entry.knowledge_bases.length}</span>
          </span>
          <span className="agx-card-config">
            <span className="agx-config-item">
              <span className="agx-config-label">{t('card.timeout')}</span>
              <span className="agx-config-value agx-mono">
                {entry.timeout_seconds > 0 ? `${String(entry.timeout_seconds)}s` : t('card.none')}
              </span>
            </span>
            <span className="agx-config-item">
              <span className="agx-config-label">{t('card.concurrency')}</span>
              <span className="agx-config-value agx-mono">
                {entry.max_concurrent_runs > 0 ? String(entry.max_concurrent_runs) : t('card.none')}
              </span>
            </span>
            <span className="agx-config-item">
              <span className="agx-config-label">{t('card.cost')}</span>
              <span className="agx-config-value agx-mono">
                {entry.cost_limit_per_run === null
                  ? t('card.unlimited')
                  : formatUsdCost(entry.cost_limit_per_run)}
              </span>
            </span>
          </span>
          <span className="agx-card-action">
            {t('card.manage')}
            <span aria-hidden="true">→</span>
          </span>
        </>
      )}
      {!entry.valid && <span id={invalidDescriptionId} className="sr-only">{t('page.invalidDescription')}</span>}
    </button>
  )
}

/**
 * Render the business-domain registry with the defaults each Domain inherits.
 * @param props - registry rows, load state, localized copy, and the filter action.
 * @returns the Domain registry section.
 */
function DomainRegistrySection({
  entries,
  loadFailed,
  t,
  onSelect,
}: {
  readonly entries: readonly DomainRegistryEntry[]
  readonly loadFailed: boolean
  readonly t: AgentsPanelProps['t']
  readonly onSelect: (domain: string) => void
}): ReactElement {
  return (
    <section className="agx-domain-registry" aria-labelledby="agent-domain-registry-title">
      <div className="agx-section-heading">
        <h3 id="agent-domain-registry-title">{t('domain.registryTitle')}</h3>
        <span className="agx-domain-count">{entries.length}</span>
      </div>
      {loadFailed && <p className="agx-helper" role="status">{t('domain.registryLoadFailed')}</p>}
      {!loadFailed && entries.length === 0 && <p className="agx-empty">{t('domain.registryEmpty')}</p>}
      {entries.length > 0 && (
        <ul className="agx-domain-list">
          {entries.map(entry => (
            <li key={entry.domain} className="agx-domain-card" data-domain={entry.domain}>
              <button type="button" className="agx-domain-card-main" onClick={() => { onSelect(entry.domain) }} title={entry.description || entry.domain}>
                <span className="agx-domain-card-title">
                  <span className="agx-domain-name">{entry.displayName || entry.domain}</span>
                  <code className="agx-mono agx-domain-id">{entry.domain}</code>
                  {!entry.valid && <span className="agx-badge agx-badge-invalid">{t('domain.invalid')}</span>}
                </span>
                <span className="agx-domain-summary">
                  <span><b>{entry.defaultAllowedTools.length}</b><small>{t('domain.allowedTools')}</small></span>
                  <span><b>{entry.defaultDeniedTools.length}</b><small>{t('domain.deniedTools')}</small></span>
                </span>
              </button>
              <details className="agx-domain-details">
                <summary>查看默认配置</summary>
                <p>{entry.description || t('common.none')}</p>
                <dl className="agx-domain-defaults">
                  <div><dt>{t('domain.costLimit')}</dt><dd className="agx-mono">{formatUsdCost(entry.costLimitPerRun)}</dd></div>
                  <div><dt>{t('domain.knowledgeBases')}</dt><dd className="agx-mono">{entry.defaultKnowledgeBases.length === 0 ? t('common.none') : entry.defaultKnowledgeBases.join(', ')}</dd></div>
                </dl>
                <div className="agx-domain-tools">
                  <span className="agx-domain-tool-group">
                    <span className="agx-config-label">{t('domain.allowedTools')}</span>
                    {entry.defaultAllowedTools.length === 0 ? <span className="agx-helper">{t('common.none')}</span> : entry.defaultAllowedTools.map(tool => <code key={tool}>{tool}</code>)}
                  </span>
                  <span className="agx-domain-tool-group">
                    <span className="agx-config-label">{t('domain.deniedTools')}</span>
                    {entry.defaultDeniedTools.length === 0 ? <span className="agx-helper">{t('common.none')}</span> : entry.defaultDeniedTools.map(tool => <code key={tool}>{tool}</code>)}
                  </span>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
/**
 * Render the Agent directory and its create/edit dialog.
 * @param props - localized copy, external toast publishers, and optional fetch implementation.
 * @returns the Agent management page.
 */
export function AgentsPanel({
  t,
  publishSuccess,
  publishFailure,
  fetchImpl,
}: AgentsPanelProps): ReactElement {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('all')
  const [harness, setHarness] = useState('all')
  const [editorTarget, setEditorTarget] = useState<AgentEditorTarget | null>(null)
  const [domainRegistry, setDomainRegistry] = useState<readonly DomainRegistryEntry[]>([])
  const [domainRegistryFailed, setDomainRegistryFailed] = useState(false)
  const catalogRef = useRef<AgentCatalog | null>(null)
  const requestSequence = useRef(0)
  const registryRequestSequence = useRef(0)

  const refresh = useCallback(async (initial: boolean): Promise<void> => {
    const sequence = ++requestSequence.current
    if (initial) {
      setLoading(true)
      setLoadFailed(false)
    } else {
      setRefreshing(true)
    }
    try {
      const next = await loadAgentCatalog(fetchImpl ?? fetch)
      if (sequence !== requestSequence.current) return
      catalogRef.current = next
      setCatalog(next)
      setLoadFailed(false)
    } catch {
      if (sequence !== requestSequence.current) return
      if (catalogRef.current === null) {
        setLoadFailed(true)
      } else {
        publishFailure(t('page.refreshFailed'))
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [fetchImpl, publishFailure, t])

  useEffect(() => {
    void refresh(true)
    return () => { requestSequence.current += 1 }
  }, [refresh])

  useEffect(() => {
    const sequence = ++registryRequestSequence.current
    setDomainRegistryFailed(false)
    loadDomainRegistry(fetchImpl ?? fetch)
      .then((entries) => {
        if (sequence !== registryRequestSequence.current) return
        setDomainRegistry(entries)
      })
      .catch(() => {
        if (sequence !== registryRequestSequence.current) return
        setDomainRegistry([])
        setDomainRegistryFailed(true)
      })
    return () => { registryRequestSequence.current += 1 }
  }, [fetchImpl])

  const domains = useMemo(
    () => domainOptions(catalog?.entries ?? [], domainRegistry),
    [catalog, domainRegistry],
  )
  const harnesses = useMemo(() => harnessOptions(catalog?.entries ?? []), [catalog])
  const shown = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (catalog?.entries ?? []).filter(entry =>
      (domain === 'all' || entry.domain === domain)
      && (harness === 'all' || entry.executionBackend === harness)
      && matchesQuery(entry, normalizedQuery))
  }, [catalog, domain, harness, query])

  const showSkeleton = loading && catalog === null && !loadFailed
  const catalogMissing = catalog?.missing === true
  const hasFilters = query.trim() !== '' || domain !== 'all' || harness !== 'all'
  const openEditor = (agentId: string): void => {
    setEditorTarget({ kind: 'edit', agentId })
  }
  const closeEditor = (): void => { setEditorTarget(null) }
  const editorSaved = (): void => {
    closeEditor()
    void refresh(false)
  }
  const editorDeleted = (): void => {
    closeEditor()
    void refresh(false)
  }

  return (
    <div className="ao-page agx-page agentops-surface">
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
            onClick={() => { void refresh(false) }}
          >
            {t('page.refresh')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlusOutlineRegular />}
            disabled={catalog === null || catalogMissing || loading}
            onClick={() => { setEditorTarget({ kind: 'create' }) }}
          >
            {t('page.create')}
          </Button>
        </div>
      </header>

      {catalog !== null && (
        <div className="agx-toolbar" role="search" aria-label={t('page.filterAria')}>
          <Input
            className="agx-search"
            icon={<IconSearchOutlineRegular />}
            aria-label={t('page.searchLabel')}
            placeholder={t('page.searchPlaceholder')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <div className="agx-filters">
            <label className="agx-filter">
              <span>{t('page.domainFilter')}</span>
              <select
                className="agx-select"
                aria-label={t('page.domainFilter')}
                value={domain}
                onChange={(event) => { setDomain(event.target.value) }}
              >
                <option value="all">{t('page.allDomains')}</option>
                {domains.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="agx-filter">
              <span>{t('page.harnessFilter')}</span>
              <select
                className="agx-select"
                aria-label={t('page.harnessFilter')}
                value={harness}
                onChange={(event) => { setHarness(event.target.value) }}
              >
                <option value="all">{t('page.allHarnesses')}</option>
                {harnesses.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <span className="agx-count" aria-live="polite">
            {t('page.count', { shown: String(shown.length), total: String(catalog.entries.length) })}
          </span>
        </div>
      )}

      <DomainRegistrySection
        entries={domainRegistry}
        loadFailed={domainRegistryFailed}
        t={t}
        onSelect={(value) => { setDomain(value) }}
      />

      {showSkeleton && (
        <div className="agx-grid" aria-label={t('page.loading')} aria-busy="true">
          {SKELETON_KEYS.map(key => <span key={key} className="agx-skeleton" aria-hidden="true" />)}
        </div>
      )}

      {!showSkeleton && loadFailed && catalog === null && (
        <section className="agx-error-state" role="alert">
          <h2>{t('page.loadFailed')}</h2>
          <Button variant="outline" onClick={() => { void refresh(true) }}>{t('page.retry')}</Button>
        </section>
      )}

      {!showSkeleton && catalogMissing && (
        <section className="agx-empty-state">
          <h2>{t('page.catalogMissing')}</h2>
          <p>{t('page.catalogMissingDescription')}</p>
        </section>
      )}

      {!showSkeleton && catalog !== null && !catalogMissing && shown.length === 0 && (
        <section className="agx-empty-state">
          <h2>{catalog.entries.length === 0 ? t('page.empty') : t('page.noMatches')}</h2>
          {hasFilters && catalog.entries.length > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setQuery('')
                setDomain('all')
                setHarness('all')
              }}
            >
              {t('page.clearFilters')}
            </Button>
          )}
        </section>
      )}

      {!showSkeleton && shown.length > 0 && (
        <div className="agx-grid">
          {shown.map(entry => (
            <AgentCard key={entry.id} entry={entry} t={t} onOpen={openEditor} />
          ))}
        </div>
      )}

      {editorTarget !== null && (
        <AgentsEditor
          t={t}
          target={editorTarget}
          onClose={closeEditor}
          onSaved={editorSaved}
          onDeleted={editorDeleted}
          publishSuccess={publishSuccess}
          publishFailure={publishFailure}
          domainSuggestions={domains}
          domainRegistry={domainRegistry}
          {...(fetchImpl === undefined ? {} : { fetchImpl })}
        />
      )}
    </div>
  )
}

/**
 * Render the sidebar glyph for Agent management.
 * @param props.size - square icon size in CSS pixels.
 * @returns the Agent silhouette SVG.
 */
export function AgentsIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" strokeLinecap="round" />
    </svg>
  )
}
