/**
 * Knowledge hub page: LLM Wiki workbench, domain dashboard, retrieval, search,
 * document browser, archive and lint. The Wiki workbench is the write path; the
 * remaining tabs inspect the same searchable knowledge store.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'

import { WikiWorkbench } from './knowledge-wiki-panel.tsx'
import { MemoryNebulaPanel } from './memory-nebula-panel.tsx'
import { createKnowledgeSpace } from './knowledge-wiki-api.ts'
import { buildKnowledgeCategoryTree, countCategoryDocuments, type KnowledgeCategoryNode, type KnowledgeTreeDocument } from './knowledge-tree.ts'
import { KnowledgeMarkdown } from './knowledge-markdown.tsx'

interface DomainSummary {
  id: string
  name: string
  display_name: string
  description: string
  page_count: number
  categories: readonly { path: string; page_count: number }[]
  last_ingest_at: string | null
  supports_lint: boolean
  lint_summary: { critical: number; warning: number; info: number; total: number }
}

type TabKey = 'wiki' | 'nebula' | 'dashboard' | 'ask' | 'search' | 'vault' | 'archive' | 'lint'

const ICONS: Record<TabKey, ReactElement> = {
  wiki: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3" cy="4" r="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="4" r="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="12" r="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3" cy="12" r="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.1 4.8 6.7 6.9M11.9 4.8 9.3 6.9M11.4 11.2 9.3 9.1M4.6 11.2 6.7 9.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  nebula: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <circle cx="8" cy="8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3" cy="4" r="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="4" r="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="12" r="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3" cy="12" r="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 4.9 6.7 7M12 4.9 9.3 7M12 11.1 9.3 9M4 11.1 6.7 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="2" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  ask: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path d="M8 2.5a4.5 4.5 0 0 1 4.5 4.5c0 1.6-.8 3-2 3.8v2.2a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-2.2c-1.2-.8-2-2.2-2-3.8A4.5 4.5 0 0 1 8 2.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 14.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  vault: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <ellipse cx="8" cy="3.5" rx="5.5" ry="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 3.5v9c0 1 2.5 1.8 5.5 1.8s5.5-.8 5.5-1.8v-9M2.5 8c0 1 2.5 1.8 5.5 1.8s5.5-.8 5.5-1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  archive: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="2" y="3" width="12" height="3" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 6v7.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V6M6.5 9h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  lint: (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path d="M8 1.5l5.5 2v4.5c0 3.4-2.3 6-5.5 6.5C4.8 14 2.5 11.4 2.5 8V3.5l5.5-2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.8 8l1.6 1.6L10.4 6.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'wiki', label: 'Wiki 工作台' },
  { key: 'nebula', label: '记忆星云' },
  { key: 'dashboard', label: '仪表盘' },
  { key: 'ask', label: '智能问答' },
  { key: 'search', label: '搜索中心' },
  { key: 'vault', label: 'Vault 浏览' },
  { key: 'archive', label: 'Agent 归档' },
  { key: 'lint', label: 'Lint 处置' },
]

export function KnowledgePanel(): ReactElement {
  const [tab, setTab] = useState<TabKey>('wiki')
  const [domains, setDomains] = useState<DomainSummary[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [spaceId, setSpaceId] = useState('')
  const [spaceName, setSpaceName] = useState('')
  const [spaceBusy, setSpaceBusy] = useState(false)
  const [spaceError, setSpaceError] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)

  const loadDomains = useCallback((): Promise<void> => {
    setState('loading')
    setError('')
    return fetch('/api/agentops/knowledge', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ domains: DomainSummary[] }>
      })
      .then((data) => {
        setDomains(data.domains)
        setState('ready')
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setState('error')
      })
  }, [])

  useEffect(() => { void loadDomains() }, [loadDomains])

  useEffect(() => {
    if (contentRef.current !== null) contentRef.current.scrollTop = 0
  }, [tab])

  const createSpace = async (): Promise<void> => {
    setSpaceBusy(true)
    setSpaceError('')
    try {
      await createKnowledgeSpace({ id: spaceId.trim(), name: spaceName.trim(), visibility: 'shared' })
      setCreateOpen(false)
      setSpaceId('')
      setSpaceName('')
      await loadDomains()
    } catch (reason) {
      setSpaceError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSpaceBusy(false)
    }
  }

  return (
    <div className="ao-page kh-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">知识库管理</h1>
          <p className="ao-page-description">统一浏览、检索与治理 Agent 可使用的知识资料。</p>
        </div>
      </header>

      <div className="kh-tabs">
        {TABS.map(item => (
          <button
            key={item.key}
            type="button"
            className={`kh-tab${tab === item.key ? ' active' : ''}`}
            onClick={() =>{  setTab(item.key) }}
          >
            <span className="kh-tab-icon">{ICONS[item.key]}</span>
            <span className="kh-tab-label">{item.label}</span>
          </button>
        ))}
      </div>

      <div className="kh-content" ref={contentRef}>
        {tab === 'wiki' ? <WikiWorkbench /> : null}
        {tab === 'nebula' ? <MemoryNebulaPanel /> : null}
        {tab === 'ask' ? <AskCenter /> : null}
        {tab === 'search' ? <SearchCenter /> : null}
        {tab === 'vault' ? <VaultBrowser /> : null}
        {tab === 'lint' ? <LintDisposal /> : null}
        {tab === 'archive' ? <ArchivePanel /> : null}
        {tab === 'dashboard'
          ? (
            <div className="kh-domain-dashboard">
              <div className="kh-domain-dashboard-header">
                <div>
                  <h2 className="kh-domain-dashboard-title">知识域仪表盘</h2>
                  <p className="kh-domain-dashboard-subtitle">
                    共 {domains.length} 个知识域 · 支持新建与查看统计
                  </p>
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={() => { setCreateOpen(value => !value); setSpaceError('') }}>新建知识域</button>
              </div>
              {createOpen ? (
                <form className="kh-domain-create" onSubmit={(event) => { event.preventDefault(); void createSpace() }}>
                  <label><span>知识域 ID</span><input value={spaceId} onChange={(event) => { setSpaceId(event.target.value) }} placeholder="project-analysis" /></label>
                  <label><span>显示名称</span><input value={spaceName} onChange={(event) => { setSpaceName(event.target.value) }} placeholder="项目分析" /></label>
                  <button type="submit" className="btn-primary btn-sm" disabled={spaceBusy || spaceId.trim() === '' || spaceName.trim() === ''}>{spaceBusy ? '创建中…' : '创建'}</button>
                  {spaceError === '' ? null : <div className="kh-error">{spaceError}</div>}
                </form>
              ) : null}
              {state === 'loading' && <div className="kh-loading"><span>加载知识域列表...</span></div>}
              {state === 'error' && <div className="kh-error"><p>{error}</p></div>}
              {state === 'ready' && domains.length === 0 && (
                <div className="kh-empty"><p>暂无知识域</p></div>
              )}
              {state === 'ready' && domains.length > 0 && (
                <div className="kh-domains-grid">
                  {domains.map(domain => (
                    <div className="kh-domain-card" key={domain.id}>
                      <div className="kh-domain-card-header">
                        <span className="kh-domain-card-icon">📁</span>
                        <span className="kh-domain-card-name">{domain.display_name || domain.name}</span>
                        <span className="kh-domain-card-id font-mono">{domain.id}</span>
                        <span className="kh-lint-badge kh-lint-badge-off">无 Lint</span>
                      </div>
                      {domain.description === '' ? null : (
                        <p className="kh-domain-card-description">{domain.description}</p>
                      )}
                      {domain.categories.length === 0 ? null : (
                        <div className="kh-domain-card-categories">
                          {domain.categories.map(category => (
                            <span className="kh-category-tag" key={category.path}>
                              {category.path} · {category.page_count}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="kh-domain-card-stats">
                        <div className="kh-domain-card-stat">
                          <span className="kh-domain-card-stat-label">页面数</span>
                          <span className="kh-domain-card-stat-value font-mono">{domain.page_count}</span>
                        </div>
                        <div className="kh-domain-card-stat">
                          <span className="kh-domain-card-stat-label">最近 ingest</span>
                          <span className="kh-domain-card-stat-value">{formatTime(domain.last_ingest_at)}</span>
                        </div>
                      </div>
                      <div className="kh-domain-card-lint">
                        <span className="kh-lint-na">不支持 Lint</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
          : null}
      </div>
    </div>
  )
}

interface SearchMatch { path: string; line?: string; context?: string; score?: number }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(context: string, query: string): ReactNode[] {
  const q = query.trim()
  if (q.length === 0) return [context]
  return context.split(new RegExp(`(${escapeRegExp(q)})`, 'gi')).map((part, index) =>
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={index} className="kh-search-highlight">{part}</mark>
      : <span key={index}>{part}</span>)
}

/** 搜索中心：沿用原组件的搜索栏、结果列表与高亮。 */
function SearchCenter(): ReactElement {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'keyword' | 'tag'>('keyword')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async (q: string) => {
    if (q.trim().length === 0) {
      setMatches([]); setTotal(0); setSearched(false); setError('')
      return
    }
    setLoading(true); setError(''); setSearched(true)
    try {
      const response = await fetch(`/api/agentops/knowledge/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { total: number; matches: SearchMatch[] }
      setMatches(data.matches); setTotal(data.total)
    } catch (reason) {
      setError(`搜索失败: ${reason instanceof Error ? reason.message : String(reason)}`)
      setMatches([]); setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void run(query)
  }

  return (
    <div className="kh-search">
      <div className="kh-search-bar">
        <div className="kh-search-type-toggle">
          <button type="button" className={mode === 'keyword' ? 'active' : ''} onClick={() => { setMode('keyword'); void run(query) }}>关键词</button>
          <button type="button" className={mode === 'tag' ? 'active' : ''} onClick={() =>{  setMode('tag') }}>标签</button>
        </div>
        <input
          className="kh-search-input"
          type="text"
          value={query}
          onChange={(event) =>{  setQuery(event.target.value) }}
          onKeyDown={onKeyDown}
          placeholder={mode === 'keyword' ? '输入关键词搜索知识库内容…' : '标签检索尚未接入'}
          disabled={mode === 'tag'}
          autoFocus
        />
        <button type="button" className="btn-primary" onClick={() => void run(query)} disabled={loading || mode === 'tag'}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </div>

      {error !== '' && <div className="kh-error">{error}</div>}

      <div className="kh-search-results">
        {mode === 'tag'
          ? <div className="kh-empty">标签检索需要 tag 索引，尚未迁移</div>
          : loading
            ? <div className="kh-empty">搜索中…</div>
            : !searched
              ? <div className="kh-empty">输入关键词开始搜索</div>
              : matches.length === 0
                ? <div className="kh-empty">未找到匹配结果</div>
                : (
                  <>
                    <div className="kh-search-summary">共 {total} 条结果</div>
                    {matches.map((match, index) => (
                      <div key={`${match.path}-${index}`} className="kh-search-result">
                        <div className="kh-search-result-header">
                          <span className="kh-link font-mono">{match.path}</span>
                          {match.line !== undefined && <span className="kh-search-result-line">{match.line}</span>}
                          {match.score !== undefined && <span className="kh-search-result-line">{match.score}</span>}
                        </div>
                        {match.context !== undefined && (
                          <div className="kh-search-result-context">{highlight(match.context, query)}</div>
                        )}
                      </div>
                    ))}
                  </>
                )}
      </div>
    </div>
  )
}

interface VaultSpace { id: string; name: string; documents: KnowledgeTreeDocument[] }
interface VaultDocument {
  id: string
  spaceId: string
  categoryPath: string
  title: string
  version: number
  chunks: { ordinal: number; section: string | null; text: string }[]
}

interface VaultDocumentRowProps {
  spaceId: string
  document: KnowledgeTreeDocument
  selectedId: string | null
  onOpen: (id: string) => void
}

function VaultDocumentRow({ spaceId, document, selectedId, onOpen }: VaultDocumentRowProps): ReactElement {
  const open = (): void => { onOpen(document.id) }
  return (
    <li className="kh-tree-node" role="treeitem">
      <div
        className={`kh-tree-node-row${selectedId === document.id ? ' kh-tree-node-selected' : ''}`}
        role="button"
        tabIndex={0}
        title={`${spaceId}/${document.categoryPath}${document.categoryPath === '' ? '' : '/'}${document.id}`}
        onClick={open}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }}
      >
        <span className="kh-tree-chevron-spacer" />
        <span className="kh-tree-node-name">{document.title}</span>
      </div>
    </li>
  )
}

interface VaultCategoryRowsProps {
  spaceId: string
  categories: readonly KnowledgeCategoryNode[]
  expanded: Record<string, boolean>
  selectedId: string | null
  onToggle: (key: string) => void
  onOpen: (id: string) => void
}

function VaultCategoryRows({ spaceId, categories, expanded, selectedId, onToggle, onOpen }: VaultCategoryRowsProps): ReactElement {
  return (
    <ul className="kh-tree-list" role="group">
      {categories.map((category) => {
        const key = `category:${spaceId}:${category.path}`
        const open = expanded[key] === true
        return (
          <li className="kh-tree-node" role="treeitem" aria-expanded={open} key={category.path}>
            <div
              className="kh-tree-node-row"
              role="button"
              tabIndex={0}
              onClick={() => { onToggle(key) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(key) } }}
            >
              <span className="kh-tree-chevron">{open ? '▾' : '▸'}</span>
              <span className="kh-tree-node-name">{category.name}</span>
              <span className="kh-tree-count">{countCategoryDocuments(category)}</span>
            </div>
            {open ? (
              <ul className="kh-tree-list" role="group">
                {category.documents.map(document => (
                  <VaultDocumentRow
                    key={document.id}
                    spaceId={spaceId}
                    document={document}
                    selectedId={selectedId}
                    onOpen={onOpen}
                  />
                ))}
                {category.children.length === 0 ? null : (
                  <VaultCategoryRows
                    spaceId={spaceId}
                    categories={category.children}
                    expanded={expanded}
                    selectedId={selectedId}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                )}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Vault 浏览：左侧知识域/分类/文档树，右侧原文预览。 */
function VaultBrowser(): ReactElement {
  const [spaces, setSpaces] = useState<VaultSpace[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<VaultDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/agentops/knowledge/documents', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ spaces: VaultSpace[] }>
      })
      .then((data) => {
        if (cancelled) return
        setSpaces(data.spaces)
        setExpanded(Object.fromEntries(data.spaces.map(space => [space.id, true])))
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const openDocument = useCallback(async (id: string) => {
    const response = await fetch(`/api/agentops/knowledge/document?id=${encodeURIComponent(id)}`, { credentials: 'include' })
    if (response.ok) setSelected(await response.json() as VaultDocument)
  }, [])

  const toggle = useCallback((key: string): void => {
    setExpanded(previous => ({ ...previous, [key]: previous[key] !== true }))
  }, [])

  return (
    <div className="kh-vault">
      <div className="kh-vault-tree">
        <div className="kh-vault-toolbar"><span className="kh-vault-toolbar-title">Vault 文件树</span></div>
        <div className="kh-vault-tree-body">
          {loading && <div className="kh-loading"><span>加载中...</span></div>}
          {error !== '' && <div className="kh-error"><p>{error}</p></div>}
          {!loading && spaces.length === 0 && <div className="kh-tree-empty">知识库为空</div>}
          {spaces.map((space) => {
            const tree = buildKnowledgeCategoryTree(space.documents)
            return (
              <div key={space.id}>
                <div className="kh-tree-node" role="treeitem" aria-expanded={expanded[space.id] === true}>
                  <div
                    className="kh-tree-node-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => { toggle(space.id) }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(space.id) } }}
                  >
                    <span className="kh-tree-chevron">{expanded[space.id] === true ? '▾' : '▸'}</span>
                    <span className="kh-tree-node-name">{space.name}</span>
                    <span className="kh-tree-count">{space.documents.length}</span>
                  </div>
                </div>
                {expanded[space.id] === true && (
                  <ul className="kh-tree-list" role="group">
                    {tree.documents.map(document => (
                      <VaultDocumentRow
                        key={document.id}
                        spaceId={space.id}
                        document={document}
                        selectedId={selected?.id ?? null}
                        onOpen={(id) => { void openDocument(id) }}
                      />
                    ))}
                    <VaultCategoryRows
                      spaceId={space.id}
                      categories={tree.categories}
                      expanded={expanded}
                      selectedId={selected?.id ?? null}
                      onToggle={toggle}
                      onOpen={(id) => { void openDocument(id) }}
                    />
                    {space.documents.length === 0 && <li className="kh-tree-empty">（空知识域）</li>}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="kh-vault-preview">
        {selected === null
          ? <div className="kh-empty">选择左侧文件查看内容</div>
          : (
            <>
              <div className="kh-vault-breadcrumb">
                <span className="kh-vault-breadcrumb-label">路径</span>
                <span className="kh-vault-breadcrumb-path">{selected.spaceId}</span>
                {selected.categoryPath === '' ? null : (
                  <>
                    <span className="kh-vault-breadcrumb-sep">/</span>
                    <span className="kh-vault-breadcrumb-path">{selected.categoryPath}</span>
                  </>
                )}
                <span className="kh-vault-breadcrumb-sep">/</span>
                <span className="kh-vault-breadcrumb-path">{selected.title}</span>
                <span className="kh-vault-breadcrumb-sep">v{selected.version}</span>
              </div>
              <div className="kh-vault-preview-body">
                <pre className="kh-preview-md">{selected.chunks.map(chunk => chunk.text).join(String.fromCharCode(10, 10))}</pre>
              </div>
            </>
          )}
      </div>
    </div>
  )
}

interface ArchiveEntry {
  name: string
  path: string
  bytes: number
  mtime: string
  ext: string
}

/** Agent 归档：只列产物文件（名称/大小/时间），不解析内容。 */
function ArchivePanel(): ReactElement {
  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [dir, setDir] = useState('')
  const [missing, setMissing] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/agentops/archive', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ dir: string; entries: ArchiveEntry[]; truncated: boolean; missing: boolean }>
      })
      .then((data) => {
        if (cancelled) return
        setEntries(data.entries)
        setDir(data.dir)
        setTruncated(data.truncated)
        setMissing(data.missing)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const shown = entries.filter(entry =>
    query.trim().length === 0 || entry.path.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div>
      <div className="kh-search-bar" style={{ marginBottom: 12 }}>
        <input
          className="kh-search-input"
          placeholder="搜索产物文件名..."
          value={query}
          onChange={(event) =>{  setQuery(event.target.value) }}
        />
        <span className="kh-lint-domain-meta">
          {loading ? '加载中…' : `${shown.length} / ${entries.length} 个文件`}
        </span>
      </div>

      {error !== '' && <div className="kh-error">{error}</div>}
      {missing && <div className="kh-empty">未配置产物目录：<span className="font-mono">{dir}</span></div>}
      {truncated && <div className="kh-stats" style={{ marginBottom: 8 }}>已截断：目录文件过多，仅显示前 {entries.length} 个</div>}
      {!loading && !missing && shown.length === 0 && <div className="kh-empty">暂无产物文件</div>}

      {shown.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr><th>文件</th><th>类型</th><th>大小</th><th>更新时间</th></tr>
            </thead>
            <tbody>
              {shown.map(entry => (
                <tr key={entry.path}>
                  <td className="font-mono" title={entry.path}>{entry.path}</td>
                  <td className="font-mono">{entry.ext || '—'}</td>
                  <td className="font-mono">{formatBytes(entry.bytes)}</td>
                  <td className="font-mono">{formatTime(entry.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface LintIssue {
  id: string
  domain: string
  type: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  page: string
  auto_fixable: boolean
}

const SEVERITY_LABEL: Record<LintIssue['severity'], string> = { critical: '严重', warning: '警告', info: '提示' }
const SEVERITY_COLOR: Record<LintIssue['severity'], string> = { critical: 'var(--state-error)', warning: 'var(--state-warning)', info: '#3b82f6' }
const TYPE_LABEL: Record<string, string> = {
  contradictions: '内容矛盾', orphans: '孤儿页面', missing_pages: '缺失页面',
  stale: '过期内容', index_sync: '索引不同步', dead_links: '死链',
}

/** Lint 处置：本地确定性检查（重复内容、空切片），语义类检查不臆造。 */
function LintDisposal(): ReactElement {
  const [issues, setIssues] = useState<LintIssue[]>([])
  const [severity, setSeverity] = useState<'all' | LintIssue['severity']>('all')
  const [type, setType] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/agentops/knowledge/lint', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ issues: LintIssue[] }>
      })
      .then((data) => {
        if (cancelled) return
        setIssues(data.issues)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const shown = issues.filter(issue =>
    (severity === 'all' || issue.severity === severity) && (type === 'all' || issue.type === type))

  return (
    <div className="kh-lint">
      <div className="kh-lint-toolbar">
        <div className="kh-lint-filters">
          <select value={severity} onChange={(event) =>{  setSeverity(event.target.value as typeof severity) }}>
            <option value="all">全部严重度</option>
            <option value="critical">严重</option>
            <option value="warning">警告</option>
            <option value="info">提示</option>
          </select>
          <select value={type} onChange={(event) =>{  setType(event.target.value) }}>
            <option value="all">全部类型</option>
            {Object.entries(TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <span className="kh-lint-domain-meta">共 {shown.length} / {issues.length} 条</span>
        </div>
      </div>

      {error !== '' && <div className="kh-error">{error}</div>}
      {loading && <div className="kh-empty">加载中…</div>}

      <div className="kh-lint-issues">
        {!loading && shown.length === 0 && <div className="kh-empty">暂无 issue</div>}
        {shown.map(issue => (
          <div className="kh-lint-issue" key={issue.id}>
            <div className="kh-lint-issue-top">
              <span className="kh-lint-badge" style={{ color: SEVERITY_COLOR[issue.severity] }}>
                {SEVERITY_LABEL[issue.severity]}
              </span>
              <span className="kh-lint-issue-title">{issue.title}</span>
              {issue.auto_fixable && <span className="kh-lint-issue-fixable">可自动修复</span>}
            </div>
            <div className="kh-lint-issue-desc">{issue.description}</div>
            <div className="kh-lint-issue-meta">
              <span>{TYPE_LABEL[issue.type] ?? issue.type}</span>
              <span className="font-mono">{issue.domain} / {issue.page}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface AskCitation {
  marker: number
  text: string
  score: number
  citation: {
    chunkId: string
    documentId: string
    spaceId: string
    version: number
    title: string
    section: string | null
  }
}

/** 智能问答（检索模式）：返回带版本化引用的片段，不做生成式改写。 */
export function AskCenter(): ReactElement {
  const [question, setQuestion] = useState('')
  const [citations, setCitations] = useState<AskCitation[]>([])
  const [asked, setAsked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const ask = async (value: string): Promise<void> => {
    if (value.trim().length === 0) return
    setLoading(true); setError(''); setAsked(true)
    try {
      const response = await fetch(`/api/agentops/knowledge/ask?q=${encodeURIComponent(value)}`, { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { citations: AskCitation[] }
      setCitations(data.citations)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setCitations([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="kh-ask">
      <div className="kh-ask-bar">
        <input
          className="kh-search-input"
          placeholder="输入问题，将在知识库中检索并标注出处（检索模式，未经生成模型改写）"
          value={question}
          onChange={(event) =>{  setQuestion(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void ask(question) }}
          autoFocus
        />
        <button type="button" className="btn-primary" onClick={() => void ask(question)} disabled={loading || question.trim().length === 0}>
          {loading ? '检索中…' : '提问'}
        </button>
      </div>

      {error !== '' && <div className="kh-error">{error}</div>}

      {loading && <div className="kh-ask-loading"><span>检索中…</span></div>}

      {!loading && !asked && (
        <div className="kh-empty">输入问题，将从知识库检索片段并标注出处</div>
      )}

      {!loading && asked && citations.length === 0 && <div className="kh-empty">未返回结果</div>}

      {citations.length > 0 && (
        <div className="kh-ask-results">
          <div className="kh-ask-answer-section">
            <div className="kh-ask-section-title">📖 检索结果（按相关度排序）</div>
            <div className="kh-ask-answer-body">
              {citations.map(item => (
                <div key={item.citation.chunkId} className="kh-ask-result">
                  <span className="kh-ask-citation-icon">[{item.marker}]</span>
                  <KnowledgeMarkdown className="kh-ask-markdown" text={item.text} />
                </div>
              ))}
            </div>
            <div className="kh-ask-stats">
              共 {citations.length} 条引用 · 检索模式，不含生成答案
            </div>
          </div>

          <div className="kh-ask-citations-section">
            <div className="kh-ask-section-title">📚 引用原文</div>
            <div className="kh-ask-citations-list">
              {citations.map(item => (
                <div key={`c-${item.citation.chunkId}`} className="kh-ask-citation">
                  <div className="kh-ask-citation-header">
                    <span className="kh-ask-citation-icon">📄</span>
                    <span className="font-mono">
                      [{item.marker}] {item.citation.spaceId}/{item.citation.title}
                      {item.citation.section === null ? '' : ` · ${item.citation.section}`} · v{item.citation.version}
                    </span>
                  </div>
                  <KnowledgeMarkdown className="kh-ask-citation-snippet" text={`${item.text.slice(0, 200)}${item.text.length > 200 ? '…' : ''}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '从未'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function KnowledgeIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Z" />
      <path d="M8 7.5h8M8 11h5" strokeLinecap="round" />
    </svg>
  )
}
