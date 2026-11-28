/**
 * The generative-UI board renderer used by the right sidebar and record preview.
 *
 * The board is a stable SET of cards, not a feed: each card is identified by
 * `view_id`, and publishing the same id replaces that card in place. Cards can
 * be dragged with the mouse into a new order, which is persisted through the
 * reorder route. A preview may filter the set to one publication and disables
 * board mutations.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import { A2uiRenderer } from '../a2ui/components/A2uiRenderer.tsx'
import type { AgentopsA2uiSurfaceV1 } from '../a2ui/lib/a2ui.ts'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
} from '../a2ui/lib/types.ts'

interface ViewRow {
  id: number
  viewId: string
  title: string
  surface: unknown
  content: unknown
  createdAt: string
}

function buildNode(surface: AgentopsA2uiSurfaceV1, content: unknown, title: string, revision: number): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1 as const,
    id: 'agentops-surface',
    kind: 'com.agentops.core/report_surface',
    kind_version: 1,
    owner: { id: 'com.agentops.core', version: '1' },
    surface: 'result',
    importance: 'primary',
    content: (content ?? {}) as Record<string, unknown>,
    a2ui: surface,
    fallback: { title },
    revision,
    updated_at: new Date().toISOString(),
  }
}

interface CardDragProps {
  /** Marks the card currently being dragged. */
  dragging?: boolean
  /** Marks the card the pointer is hovering over as the drop target. */
  dropTarget?: boolean
  onDragStart?: (viewId: string) => void
  onDragOver?: (viewId: string) => void
  onDrop?: (viewId: string) => void
  onDragEnd?: () => void
  onRemove?: (viewId: string) => void
}

function Card({
  row,
  index,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRemove,
  showHeader = true,
}: CardDragProps & {
  row: ViewRow
  index: number
  showHeader?: boolean
}): ReactElement {
  const node = useMemo(
    () => buildNode(row.surface as AgentopsA2uiSurfaceV1, row.content, row.title, row.id),
    [row],
  )
  const placement: GenerativeUiCompositionItemV1 = useMemo(() => ({
    node_id: `board-card-${index}`,
    node_revision: index,
    surface: 'result',
    variant: 'summary',
    rank: index + 1,
    placement: 'primary',
    pinned: false,
    visibility: 'visible',
  }), [index])
  const context: GenerativeUiSurfaceContextV1 = useMemo(() => ({
    device: 'desktop',
    input: 'mouse',
    viewport: 'regular',
    attention: 'focused',
  }), [])

  return (
    <section
      data-agentops-card=""
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart === undefined ? undefined : (event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(row.viewId)
      }}
      onDragOver={onDragOver === undefined ? undefined : (event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOver(row.viewId)
      }}
      onDrop={onDrop === undefined ? undefined : (event) => {
        event.preventDefault()
        onDrop(row.viewId)
      }}
      onDragEnd={onDragEnd}
      style={{
        border: dragging || dropTarget ? '1px solid var(--color-primary)' : '1px solid var(--color-border-subtle)',
        borderRadius: 10,
        background: dropTarget ? 'var(--color-bg-hover)' : 'var(--color-bg-surface)',
        opacity: dragging ? 0.6 : 1,
        overflow: 'hidden',
        minWidth: 0,
        breakInside: 'avoid',
        marginBottom: 10,
      }}
    >
      {showHeader && (
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-border-subtle)',
          cursor: onDragStart === undefined ? 'default' : 'grab',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{row.title}</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span className="font-mono" style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
              {row.viewId} · {row.createdAt.slice(11, 19)}
            </span>
            {onRemove === undefined ? null : (
              <button
                type="button"
                className="btn-sm btn-secondary"
                style={{ fontSize: 10, padding: '1px 6px' }}
                title="从看板删除这张卡片"
                onClick={() =>{  onRemove(row.viewId) }}
              >
                ×
              </button>
            )}
          </span>
        </header>
      )}
      {/* A card can carry a long surface; cap it so one card cannot push every
          other card off the board, and scroll inside instead. */}
      <div className="agentops-a2ui" style={{ padding: 10 }}>
        <A2uiRenderer node={node} placement={placement} context={context} locale="zh-CN" expanded />
      </div>
    </section>
  )
}

export interface SurfaceScreenProps {
  readonly address?: string
  readonly viewId?: string
  /** Removes card reordering and deletion from embedded previews. */
  readonly readOnly?: boolean
  /** Draws the board header and footer; false leaves only the rendered cards. */
  readonly chrome?: boolean
  /** Draws each card's title and metadata header; false leaves only its surface. */
  readonly showCardHeader?: boolean
}

export function SurfaceScreen({
  address = '',
  viewId,
  readOnly = false,
  chrome = true,
  showCardHeader = true,
}: SurfaceScreenProps): ReactElement {
  const [views, setViews] = useState<ViewRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [reordering, setReordering] = useState(false)
  const [dragViewId, setDragViewId] = useState<string | null>(null)
  const [dropViewId, setDropViewId] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const [columns, setColumns] = useState<number | null>(null)
  const shownViews = viewId === undefined ? views : views.filter(view => view.viewId === viewId)

  // Column count follows the pane width. CSS multi-column spills sideways in a
  // fixed-height scroller, so the split is computed here instead.
  useEffect(() => {
    const element = boardRef.current
    if (element === null) return
    const measure = (): void => {
      if (viewId !== undefined) {
        setColumns(1)
        return
      }
      const usable = element.clientWidth - 20
      setColumns(Math.max(1, Math.floor((usable + 10) / 330)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [loaded, viewId])

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/agentops/surfaces/views', { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { views: ViewRow[] }
      setViews(data.views)
      setLoaded(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoaded(true)
    }
  }, [])

  const commitOrder = useCallback(async (next: ViewRow[]): Promise<void> => {
    if (reordering) return
    setReordering(true)
    const previous = views
    // Apply the drop immediately so the pointer release feels instant; a failed
    // request restores the server order on the next load.
    setViews(next)
    try {
      const response = await fetch('/api/agentops/surfaces/reorder', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewIds: next.map(row => row.viewId) }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { ok?: unknown }
      if (data.ok !== true) throw new Error('reorder rejected')
    } catch {
      setViews(previous)
    } finally {
      setReordering(false)
    }
  }, [reordering, views])

  const dropOn = useCallback((targetViewId: string): void => {
    const sourceViewId = dragViewId
    setDragViewId(null)
    setDropViewId(null)
    if (sourceViewId === null || sourceViewId === targetViewId) return
    const source = views.find(row => row.viewId === sourceViewId)
    const target = views.find(row => row.viewId === targetViewId)
    if (source === undefined || target === undefined) return
    const sourceIndex = views.indexOf(source)
    const targetIndex = views.indexOf(target)
    const remaining = views.filter(row => row.viewId !== sourceViewId)
    const remainingTarget = remaining.findIndex(row => row.viewId === targetViewId)
    if (remainingTarget < 0) return
    // Dropping downward places the card after the target; dropping upward
    // places it before, so the dragged card occupies the target's old slot.
    const insertAt = sourceIndex < targetIndex ? remainingTarget + 1 : remainingTarget
    const next = remaining.slice()
    next.splice(insertAt, 0, source)
    void commitOrder(next)
  }, [dragViewId, views, commitOrder])

  const removeCard = useCallback(async (viewId: string): Promise<void> => {
    if (!window.confirm(`从看板删除「${viewId}」这张卡片？`)) return
    try {
      await fetch('/api/agentops/surfaces/remove', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewId }),
      })
      await load()
    } catch {
      // The next poll will show the real state.
    }
  }, [load])

  const clearBoard = useCallback(async (): Promise<void> => {
    if (!window.confirm('清空整个看板？所有卡片都会被删除。')) return
    try {
      await fetch('/api/agentops/surfaces/clear', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      await load()
    } catch {
      // Same: poll reflects reality.
    }
  }, [load])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // Do not poll while a drag is in progress or an order write is in flight,
    // otherwise a refresh could move the card out from under the pointer.
    if (dragViewId !== null || reordering) return
    const timer = setInterval(() => { void load() }, 4000)
    return () => { clearInterval(timer) }
  }, [load, dragViewId, reordering])

  if (!loaded) {
    return <div className="agentops-surface ao-surface-screen" style={{ padding: 16, fontSize: 12, color: 'var(--color-text-tertiary)' }}>加载中…</div>
  }
  if (error !== '') {
    return <div className="agentops-surface ao-surface-screen" style={{ padding: 16, fontSize: 12, color: 'var(--state-error)' }}>加载失败：{error}</div>
  }

  if (shownViews.length === 0) {
    return (
      <div className="agentops-surface ao-surface-screen" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.8 }}>
          {viewId === undefined
            ? <>还没有卡片。Agent 调用 <code>present_content</code> 后，卡片会出现在这里。</>
            : <>发布记录 <code>{viewId}</code> 不存在或已被删除。</>}
        </div>
      </div>
    )
  }

  return (
    <div className="agentops-surface ao-surface-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {chrome && (
        <div className="ao-surface-screen-head">
          <span>生成式 UI 看板</span>
          <span className="ao-surface-screen-head-meta">
            <span>{shownViews.length} 张卡片</span>
            {!readOnly && (
              <button type="button" className="btn-sm btn-secondary" style={{ fontSize: 10 }} onClick={() => { void clearBoard() }}>
                清空看板
              </button>
            )}
          </span>
        </div>
      )}
      <div
        ref={boardRef}
        data-agentops-board=""
        className="ao-surface-screen-board"
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: chrome ? 10 : 0,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}
      >
        {columns === null
          ? null
          : Array.from({ length: columns }, (_, column) => (
            <div key={column} style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 0', minWidth: 0 }}>
              {shownViews
                .filter((_, index) => index % columns === column)
                .map(row => (
                  <Card
                    key={row.viewId}
                    row={row}
                    index={views.indexOf(row)}
                    dragging={dragViewId === row.viewId}
                    dropTarget={dropViewId === row.viewId && dragViewId !== row.viewId}
                    {...(readOnly ? {} : {
                      onDragStart: (viewId: string) => {
                        if (reordering) return
                        setDragViewId(viewId)
                      },
                      onDragOver: (viewId: string) => {
                        if (dragViewId === null || dragViewId === viewId) return
                        setDropViewId(viewId)
                      },
                      onDrop: (viewId: string) => { dropOn(viewId) },
                      onDragEnd: () => {
                        setDragViewId(null)
                        setDropViewId(null)
                      },
                      onRemove: (viewId: string) => { void removeCard(viewId) },
                    })}
                    showHeader={showCardHeader}
                  />
                ))}
            </div>
          ))}
      </div>
      {chrome && (
        <div className="ao-surface-screen-foot">
          {readOnly ? '只读看板' : '拖动卡片可调整顺序'} · 数据来自 present_content · {address === '' ? (viewId ?? '当前会话') : address.slice(-24)}
        </div>
      )}
    </div>
  )
}
