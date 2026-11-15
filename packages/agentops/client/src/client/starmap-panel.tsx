/**
 * Star map view of the task dependency graph.
 *
 * The map is a read-only projection: projects are cluster centres, canonical
 * task relations decide the links, and the layout is deterministic. This panel
 * only owns visual filtering, navigation and task-detail handoff.
 *
 * @module @agentops/dsh-client/starmap-panel
 */

import {
  Maximize2,
  RefreshCw,
  RotateCcw,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'

import { TaskDetail } from './panel.tsx'
import { buildStarMap, type GraphEdge, type GraphNode, type StarMap, type StarPoint } from './starmap-layout.ts'
import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()

type StatusFilter = 'all' | StarPoint['statusGroup']
type RiskFilter = 'all' | 'high' | 'medium' | 'low'

interface ViewState {
  readonly x: number
  readonly y: number
  readonly scale: number
}

interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly originX: number
  readonly originY: number
  readonly unitsPerPixel: number
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  idea: '想法',
  backlog: '待办',
  discussing: '讨论中',
  reviewing: '评审中',
  decomposing: '拆解中',
  in_progress: '执行中',
  validating: '验收中',
  closing: '收尾中',
  closed: '已完成',
  blocked: '阻塞',
  paused: '暂停',
  failed: '失败',
  canceled: '已取消',
  abandoned: '已归档',
}

const STATUS_GROUP_LABELS: Readonly<Record<StarPoint['statusGroup'], string>> = {
  active: '推进中',
  attention: '需关注',
  waiting: '等待中',
  done: '已完成',
}

const RISK_LABELS: Readonly<Record<string, string>> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
  unknown: '未评估',
}


const MIN_SCALE = 0.55
const MAX_SCALE = 3

/** Deterministic starfield specks in normalised map coordinates. */
function specks(count: number): { x: number; y: number; r: number; o: number }[] {
  let seed = 17
  const next = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  return Array.from({ length: count }, () => ({
    x: next(),
    y: next(),
    r: 0.45 + next() * 1.35,
    o: 0.12 + next() * 0.32,
  }))
}

const SPECK_FIELD = specks(132)

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk
}


function truncate(text: string, limit: number): string {
  const characters = [...text]
  return characters.length <= limit ? text : `${characters.slice(0, limit).join('')}…`
}

function matchesFilter(
  point: StarPoint,
  search: string,
  statusFilter: StatusFilter,
  riskFilter: RiskFilter,
): boolean {
  if (statusFilter !== 'all' && point.statusGroup !== statusFilter) return false
  if (riskFilter !== 'all' && point.riskLevel !== riskFilter) return false
  if (search === '') return true
  const haystack = `${point.title} ${point.status} ${point.projectName}`.toLocaleLowerCase()
  return haystack.includes(search)
}

/**
 * Render the star map.
 * @returns the panel.
 */
export function StarMapPanel({
  embedded = false,
  onOpenTask,
}: { embedded?: boolean; onOpenTask?: (taskId: string) => void } = {}): ReactElement {
  const [map, setMap] = useState<StarMap | null>(null)
  const [projects, setProjects] = useState<readonly { project_id: string; name: string }[]>([])
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all')
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 })
  const [dragging, setDragging] = useState<DragState | null>(null)
  const canvasRef = useRef<SVGSVGElement>(null)
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null)

  const load = useCallback(async (wantedProjectId = projectId) => {
    setLoading(true)
    try {
      if (wantedProjectId === '') {
        const projectsResult = await client.listProjects()
        if (!projectsResult.ok) throw new Error(`${projectsResult.error.code}: ${projectsResult.error.message}`)
        const rows = (projectsResult.value as { projects: { project_id: string; name: string }[] }).projects
        setProjects(rows)
        const nextProjectId = rows[0]?.project_id ?? ''
        setProjectId(nextProjectId)
        if (nextProjectId === '') {
          setError('no_project')
          return
        }
        wantedProjectId = nextProjectId
      }
      const result = await client.getGraph({ project_id: wantedProjectId })
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const value = result.value as { nodes: GraphNode[]; edges: GraphEdge[] }
      setMap(buildStarMap(value.nodes, value.edges))
      setError('')
      setHovered(null)
      setView({ x: 0, y: 0, scale: 1 })
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }, [load])

  const points = map?.points ?? []
  const normalisedSearch = search.trim().toLocaleLowerCase()
  const visiblePoints = useMemo(
    () => points.filter(point => matchesFilter(point, normalisedSearch, statusFilter, riskFilter)),
    [normalisedSearch, points, riskFilter, statusFilter],
  )
  const visibleIds = useMemo(() => new Set(visiblePoints.map(point => point.id)), [visiblePoints])
  const visibleLinks = useMemo(
    () => (map?.links ?? []).filter(link => visibleIds.has(link.from) && visibleIds.has(link.to)),
    [map, visibleIds],
  )
  const visibleCountByCluster = useMemo(() => {
    const counts = new Map<string, number>()
    for (const point of visiblePoints) counts.set(point.clusterId, (counts.get(point.clusterId) ?? 0) + 1)
    return counts
  }, [visiblePoints])
  const visibleClusters = useMemo(
    () => (map?.clusters ?? []).filter(cluster => (visibleCountByCluster.get(cluster.id) ?? 0) > 0),
    [map, visibleCountByCluster],
  )
  const statusCounts = useMemo(() => {
    const counts: Record<StarPoint['statusGroup'], number> = { active: 0, attention: 0, waiting: 0, done: 0 }
    for (const point of points) counts[point.statusGroup] += 1
    return counts
  }, [points])
  const attentionCount = statusCounts.attention
  const hoveredPoint = useMemo(
    () => visiblePoints.find(point => point.id === hovered) ?? null,
    [hovered, visiblePoints],
  )
  const dense = map?.dense ?? false

  useEffect(() => {
    if (hovered !== null && !visibleIds.has(hovered)) setHovered(null)
  }, [hovered, visibleIds])

  const resetView = useCallback(() => {
    setView({ x: 0, y: 0, scale: 1 })
    setDragging(null)
  }, [])

  const resetAll = useCallback(() => {
    setSearch('')
    setStatusFilter('all')
    setRiskFilter('all')
    resetView()
  }, [resetView])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined) return
      const previous = canvasSizeRef.current
      canvasSizeRef.current = { width: rect.width, height: rect.height }
      if (
        previous === null
        || (Math.abs(previous.width - rect.width) < 2 && Math.abs(previous.height - rect.height) < 2)
      ) return
      resetView()
    })
    observer.observe(canvas)
    return () =>{  observer.disconnect() }
  }, [map, resetView, selected])

  const zoomBy = useCallback((factor: number) => {
    if (map === null) return
    setView((current) => {
      const scale = clampScale(current.scale * factor)
      const centreX = map.width / 2
      const centreY = map.height / 2
      return {
        scale,
        x: current.x + (current.scale - scale) * centreX,
        y: current.y + (current.scale - scale) * centreY,
      }
    })
  }, [map])

  const handlePointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (map === null || event.button !== 0) return
    if ((event.target as Element).closest('[data-star-node]') !== null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fittedScale = Math.min(rect.width / map.width, rect.height / map.height)
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      unitsPerPixel: fittedScale > 0 ? 1 / fittedScale : 1,
    })
  }, [map, view.x, view.y])

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging === null || dragging.pointerId !== event.pointerId) return
    setView(current => ({
      ...current,
      x: dragging.originX + (event.clientX - dragging.startX) * dragging.unitsPerPixel,
      y: dragging.originY + (event.clientY - dragging.startY) * dragging.unitsPerPixel,
    }))
  }, [dragging])

  const finishDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging === null || dragging.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(null)
  }, [dragging])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomBy(Math.exp(-event.deltaY * 0.0012))
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => { canvas.removeEventListener('wheel', handleWheel) }
  }, [zoomBy])

  const activatePoint = useCallback((point: StarPoint) => {
    setSelected(point.id)
  }, [])

  const handleNodeKeyDown = useCallback((event: KeyboardEvent<SVGGElement>, point: StarPoint) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activatePoint(point)
      return
    }
    if (event.key === 'Escape') {
      setHovered(null)
      event.currentTarget.blur()
    }
  }, [activatePoint])

  if (selected !== null && onOpenTask !== undefined) {
    onOpenTask(selected)
    setSelected(null)
    return <></>
  }

  if (selected !== null) {
    return <TaskDetail id={selected} onBack={() => { setSelected(null) }} />
  }

  const body = (
    <>
      {error !== '' ? <p className="sm-error" role="alert">{error}</p> : null}

      <div className="sm-toolbar" role="toolbar" aria-label="任务星图工具栏">
        <label className="sm-field">
          <span className="sm-field-label">项目</span>
          <select
            value={projectId}
            onChange={(event) => { void load(event.target.value) }}
            aria-label="选择项目"
          >
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label className="sm-field sm-search-field">
          <span className="sm-field-label">搜索</span>
          <span className="sm-input-wrap">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => { setSearch(event.target.value) }}
              placeholder="任务标题、项目、状态"
              aria-label="搜索任务"
            />
          </span>
        </label>
        <label className="sm-field">
          <span className="sm-field-label">状态</span>
          <select
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value as StatusFilter) }}
            aria-label="按状态筛选"
          >
            <option value="all">全部状态</option>
            <option value="active">推进中</option>
            <option value="attention">需关注</option>
            <option value="waiting">等待中</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <label className="sm-field">
          <span className="sm-field-label">风险</span>
          <select
            value={riskFilter}
            onChange={(event) => { setRiskFilter(event.target.value as RiskFilter) }}
            aria-label="按风险筛选"
          >
            <option value="all">全部风险</option>
            <option value="high">高风险</option>
            <option value="medium">中风险</option>
            <option value="low">低风险</option>
          </select>
        </label>

        <div className="sm-toolbar-spacer" />

        <div className="sm-zoom-controls" role="group" aria-label="缩放控制">
          <button type="button" className="sm-icon-button" onClick={() => { zoomBy(0.82) }} aria-label="缩小星图">
            <ZoomOut size={15} aria-hidden="true" />
          </button>
          <span className="sm-zoom-value" aria-live="polite">{Math.round(view.scale * 100)}%</span>
          <button type="button" className="sm-icon-button" onClick={() => { zoomBy(1.22) }} aria-label="放大星图">
            <ZoomIn size={15} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={resetView}>
          <Maximize2 size={14} aria-hidden="true" />
          适配视图
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={resetAll}>
          <RotateCcw size={14} aria-hidden="true" />
          重置
        </button>
      </div>

      {map !== null && map.points.length === 0 ? (
        <div className="sm-empty">
          <span className="sm-empty-icon"><StarMapIcon size={26} /></span>
          <strong>星图还是空的</strong>
          <p>任务通过准入后，会以项目星团出现在这里。</p>
        </div>
      ) : null}

      {map !== null && map.points.length > 0 ? (
        <div className="sm-workspace">
          <section className="sm-canvas" aria-label="任务关系星图">
            {dense ? <span className="sm-density-badge">高密度视图 · 已关闭光晕</span> : null}
            <svg
              ref={canvasRef}
              viewBox={`0 0 ${map.width} ${map.height}`}
              className={dragging === null ? 'sm-svg' : 'sm-svg is-dragging'}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              role="img"
              aria-label={`任务星图，共 ${visiblePoints.length} 个可见任务，${visibleClusters.length} 个星团`}
            >
              <defs>
                <filter id="sm-node-glow" x="-140%" y="-140%" width="380%" height="380%">
                  <feGaussianBlur stdDeviation="7" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <rect className="sm-space" x={0} y={0} width={map.width} height={map.height} rx={18} />

              <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                <g className="sm-starfield" aria-hidden="true">
                  {SPECK_FIELD.map((speck, index) => (
                    <circle
                      key={index}
                      cx={speck.x * map.width}
                      cy={speck.y * map.height}
                      r={speck.r}
                      opacity={speck.o}
                    />
                  ))}
                </g>

                {visibleClusters.map((cluster) => {
                  const clusterLabelWidth = Math.max(122, Math.min(240, 54 + cluster.name.length * 16))
                  const clusterVisibleCount = visibleCountByCluster.get(cluster.id) ?? 0
                  return (
                    <g className="sm-cluster" key={cluster.id}>
                      {cluster.rings.map(radius => (
                        <circle
                          key={radius}
                          className="sm-orbit"
                          cx={cluster.x}
                          cy={cluster.y}
                          r={radius}
                        />
                      ))}
                      <circle className="sm-cluster-halo" cx={cluster.x} cy={cluster.y} r={cluster.radius} />
                      <circle className="sm-cluster-core" cx={cluster.x} cy={cluster.y} r={4} />
                      <g transform={`translate(${cluster.x} ${cluster.y - cluster.radius - 14})`}>
                        <rect
                          className="sm-cluster-label-bg"
                          x={-clusterLabelWidth / 2}
                          y={-14}
                          width={clusterLabelWidth}
                          height={28}
                          rx={14}
                        />
                        <text className="sm-cluster-label" textAnchor="middle" dominantBaseline="middle">
                          {truncate(cluster.name, 20)} · {clusterVisibleCount}
                        </text>
                      </g>
                    </g>
                  )
                })}

                <g className="sm-links" aria-hidden="true">
                  {visibleLinks.map((link) => {
                    const from = visiblePoints.find(point => point.id === link.from)
                    const to = visiblePoints.find(point => point.id === link.to)
                    if (from === undefined || to === undefined) return null
                    return (
                      <path
                        key={`${link.from}-${link.to}-${link.relation}`}
                        className={`sm-link sm-link-${link.relation}`}
                        d={`M ${from.x} ${from.y} Q ${link.midX} ${link.midY} ${to.x} ${to.y}`}
                      />
                    )
                  })}
                </g>

                <g className="sm-nodes">
                  {visiblePoints.map((point) => {
                    const active = hovered === point.id
                    const showLabel = !dense || point.degree >= 2 || active
                    return (
                      <g
                        key={point.id}
                        data-star-node={point.id}
                        className={`sm-node sm-node-${point.statusGroup}${active ? ' is-active' : ''}`}
                        tabIndex={0}
                        role="button"
                        aria-label={`${point.title}，${statusLabel(point.status)}，${riskLabel(point.riskLevel)}，${point.projectName}`}
                        onMouseEnter={() => { setHovered(point.id) }}
                        onMouseLeave={() => { setHovered(null) }}
                        onFocus={() => { setHovered(point.id) }}
                        onBlur={() => { setHovered(null) }}
                        onClick={() => { activatePoint(point) }}
                        onKeyDown={(event) => { handleNodeKeyDown(event, point) }}
                      >
                        <circle className="sm-node-focus" cx={point.x} cy={point.y} r={point.radius + 11} />
                        <circle className="sm-node-halo" cx={point.x} cy={point.y} r={point.radius + 9} />
                        <circle
                          className="sm-node-core"
                          cx={point.x}
                          cy={point.y}
                          r={point.radius}
                          filter={dense ? undefined : 'url(#sm-node-glow)'}
                        />
                        <circle
                          className={`sm-node-risk sm-risk-${point.riskLevel}`}
                          cx={point.x}
                          cy={point.y}
                          r={point.radius + 3}
                        />
                        {showLabel ? (
                          <g className="sm-node-label">
                            <rect
                              x={point.labelX}
                              y={point.labelY - 11}
                              width={point.labelWidth}
                              height={22}
                              rx={8}
                            />
                            <text x={point.labelX + 8} y={point.labelY + 4}>
                              {truncate(point.title, dense ? 10 : 18)}
                            </text>
                          </g>
                        ) : null}
                      </g>
                    )
                  })}
                </g>

                {hoveredPoint !== null ? (
                  <g
                    className="sm-tooltip"
                    transform={`translate(${
                      hoveredPoint.x > map.width * 0.72 ? hoveredPoint.x - 258 : hoveredPoint.x + 18
                    } ${hoveredPoint.y > map.height * 0.72 ? hoveredPoint.y - 92 : hoveredPoint.y + 20}) scale(${1 / view.scale})`}
                    aria-hidden="true"
                  >
                    <rect width={240} height={80} rx={10} />
                    <text className="sm-tooltip-title" x={12} y={20}>{truncate(hoveredPoint.title, 26)}</text>
                    <text className="sm-tooltip-meta" x={12} y={39}>
                      {statusLabel(hoveredPoint.status)} · {riskLabel(hoveredPoint.riskLevel)} · {hoveredPoint.degree} 条关联
                    </text>
                    <text className="sm-tooltip-meta" x={12} y={57}>{truncate(hoveredPoint.projectName, 20)} · 第 {hoveredPoint.depth + 1} 层</text>
                    <text className="sm-tooltip-hint" x={12} y={72}>Enter 打开详情</text>
                  </g>
                ) : null}
              </g>
            </svg>

            {visiblePoints.length === 0 ? (
              <div className="sm-no-results">
                <strong>没有匹配的任务</strong>
                <span>换一个关键词或清除筛选条件。</span>
                <button type="button" className="btn-secondary btn-sm" onClick={resetAll}>清除筛选</button>
              </div>
            ) : null}
          </section>

          <aside className="sm-insights" aria-label="星图统计与图例">
            <section className="sm-insight-card">
              <div className="sm-insight-heading">
                <span>当前视图</span>
                <span className="sm-insight-total">{visiblePoints.length} / {points.length}</span>
              </div>
              <div className="sm-stat-grid">
                <div><strong>{visibleClusters.length}</strong><span>星团</span></div>
                <div><strong>{visibleLinks.length}</strong><span>关联</span></div>
                <div><strong>{attentionCount}</strong><span>需关注</span></div>
              </div>
            </section>

            <section className="sm-insight-card">
              <div className="sm-insight-heading"><span>任务状态</span></div>
              <ul className="sm-legend-list">
                {(['active', 'attention', 'waiting', 'done'] as const).map(group => (
                  <li key={group}>
                    <span className={`sm-legend-dot sm-dot-${group}`} />
                    <span>{STATUS_GROUP_LABELS[group]}</span>
                    <b>{statusCounts[group]}</b>
                  </li>
                ))}
              </ul>
            </section>

            <section className="sm-insight-card">
              <div className="sm-insight-heading"><span>关系与风险</span></div>
              <ul className="sm-legend-list sm-legend-lines">
                <li><span className="sm-line sm-line-parent" />父子关系</li>
                <li><span className="sm-line sm-line-blocks" />阻塞关系</li>
                <li><span className="sm-line sm-line-related" />关联关系</li>
              </ul>
              <div className="sm-risk-legend">
                <span><i className="sm-risk-ring sm-risk-high" />高风险</span>
                <span><i className="sm-risk-ring sm-risk-medium" />中风险</span>
                <span><i className="sm-risk-ring sm-risk-low" />低风险</span>
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </>
  )

  if (embedded) return <div className="sm-page sm-page-embedded">{body}</div>

  return (
    <div className="ao-page agentops-surface sm-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务星图</h1>
          <p className="ao-page-description">
            项目作为星团中心，父子关系决定轨道层级。拖动空白区域平移，滚轮或工具栏缩放。
          </p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm sm-refresh" onClick={() => { void load() }} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'sm-spin' : undefined} />
            {loading ? '刷新中' : '刷新'}
          </button>
        </div>
      </header>
      {body}
    </div>
  )
}

/**
 * Render the star map sidebar glyph.
 * @param props - icon size in pixels.
 * @returns the glyph.
 */
export function StarMapIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="5" cy="7" r="1.2" />
      <circle cx="19" cy="6" r="1.2" />
      <circle cx="18" cy="18" r="1.2" />
      <circle cx="6" cy="17" r="1.2" />
      <path d="M6 8l4.4 2.8M17.6 7.2 13.6 11M17 17l-3.8-3M7.2 16.2 10.8 13" strokeLinecap="round" />
    </svg>
  )
}
