/**
 * Memory nebula: a combined task + decision constellation.
 *
 * The surface intentionally separates two kinds of truth: tasks are operational
 * work, decision memories are durable project knowledge. Both are rendered in a
 * deterministic star field with age decay, search, focus, detail and execution
 * precheck.
 *
 * @module @agentops/dsh-client/memory-nebula-panel
 */

import { Brain, Maximize2, Minimize2, Search, Sparkles, Telescope, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import { MemoryNebulaCanvas } from './memory-nebula-canvas.tsx'
import { layoutNebula } from './memory-nebula-3d.ts'

import {
  MEMORY_CATEGORY_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_STATUS_LABELS,
  buildMemoryNebula,
  modeVisible,
  nodeColor,
  nodeMatches,
  precheckTask,
  type DecisionMemory,
  type MemoryGraphEdge,
  type MemoryKind,
  type MemoryMode,
  type NebulaNode,
} from './memory-nebula-model.ts'
import type { TaskCenterProject, TaskCenterTask } from './task-center-model.ts'
import { createTaskRpcClient } from './task-rpc-api.ts'
import { fetchKnowledgeMemory, type KnowledgeMemoryNode } from './knowledge-wiki-api.ts'

const client = createTaskRpcClient()

interface DecisionDetail {
  decision: DecisionMemory
  evidence: readonly { evidenceId: string; kind: string; ref: string; verifiedAt: string }[]
  audit: readonly { auditId: string; eventType: string; actorId: string; createdAt: string }[]
}

function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
}

/**
 * Render the memory nebula workbench inside knowledge management.
 * It selects a project, loads admitted tasks, durable decisions and searchable
 * knowledge nodes, and keeps the star-field interaction in one place.
 * @returns the nebula panel.
 */
export function MemoryNebulaPanel(): ReactElement {
  const [projects, setProjects] = useState<readonly TaskCenterProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [tasks, setTasks] = useState<readonly TaskCenterTask[]>([])
  const [edges, setEdges] = useState<readonly MemoryGraphEdge[]>([])
  const [decisions, setDecisions] = useState<readonly DecisionMemory[]>([])
  const [knowledge, setKnowledge] = useState<readonly KnowledgeMemoryNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<MemoryMode>('overview')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | MemoryKind>('all')
  const [maxAgeDays, setMaxAgeDays] = useState(365)
  const [stress, setStress] = useState(false)
  const [opacity, setOpacity] = useState(1)
  const [immersive, setImmersive] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [decisionDetail, setDecisionDetail] = useState<DecisionDetail | null>(null)
  const [precheck, setPrecheck] = useState<Array<{ level: 'block' | 'warn' | 'info'; text: string }> | null>(null)
  const loadProjects = useCallback(async (): Promise<void> => {
    const result = await client.listProjects()
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    const rows = result.value as { projects: readonly TaskCenterProject[] }
    setProjects(rows.projects)
    setProjectId(current => rows.projects.some(project => project.project_id === current)
      ? current
      : rows.projects[0]?.project_id ?? '')
  }, [])

  const load = useCallback(async () => {
    if (projectId === '') {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [graphResult, decisionResult, knowledgeNodes, tasksResult] = await Promise.all([
        client.getGraph({ project_id: projectId }),
        client.searchDecisions({ project_id: projectId, collection: 'all', limit: '500' }),
        fetchKnowledgeMemory().catch(() => []),
        client.listTasks({ projectId }),
      ])
      if (!graphResult.ok) throw new Error(`${graphResult.error.code}: ${graphResult.error.message}`)
      if (!decisionResult.ok) throw new Error(`${decisionResult.error.code}: ${decisionResult.error.message}`)
      if (!tasksResult.ok) throw new Error(`${tasksResult.error.code}: ${tasksResult.error.message}`)
      const graph = graphResult.value as { edges: MemoryGraphEdge[] }
      const memory = decisionResult.value as { decisions: DecisionMemory[] }
      const projectTasks = tasksResult.value as { tasks: readonly TaskCenterTask[] }
      setEdges(graph.edges)
      setDecisions(memory.decisions)
      setKnowledge(knowledgeNodes)
      setTasks(projectTasks.tasks)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void loadProjects().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }, [loadProjects])
  useEffect(() => { void load() }, [load])

  const taskIds = useMemo(() => new Set(tasks.map(task => task.taskId)), [tasks])
  const projectEdges = useMemo(
    () => edges.filter(edge => taskIds.has(edge.source_task_id) && taskIds.has(edge.target_task_id)),
    [edges, taskIds],
  )
  const flatGraph = useMemo(() => buildMemoryNebula(tasks, projectEdges, decisions, knowledge), [decisions, knowledge, projectEdges, tasks])
  const fullGraph = useMemo(() => layoutNebula(flatGraph), [flatGraph])
  // Freeze the age cutoff per project load; Date.now() here would rebuild the
  // graph every render and tear down the WebGL canvas.
  const [ageAnchor] = useState(() => Date.now())
  const cutoff = ageAnchor - maxAgeDays * 86_400_000
  const visibleNodes = useMemo(() => fullGraph.nodes.filter((node) => {
    if (!modeVisible(node, mode)) return false
    if (kind !== 'all' && node.kind !== kind) return false
    if (node.timestamp < cutoff) return false
    return nodeMatches(node, query)
  }), [cutoff, fullGraph.nodes, kind, mode, query])
  const nodeMap = useMemo(() => new Map(fullGraph.nodes.map(node => [node.id, node])), [fullGraph.nodes])
  const searchSet = useMemo(() => query.trim() === '' ? null : new Set(visibleNodes.map(node => node.id)), [query, visibleNodes])
  const focus = focusId === null ? null : nodeMap.get(focusId) ?? null
  const detail = detailId === null ? null : nodeMap.get(detailId) ?? null
  const shown = detail ?? focus
  const stats = useMemo(() => {
    const memoryNodes = fullGraph.nodes.filter(node => node.kind === 'memory')
    const categoryCounts = Object.fromEntries(
      Object.keys(MEMORY_CATEGORY_LABELS).map(key => [
        key,
        memoryNodes.filter(node => node.category === key).length,
      ]),
    )
    return {
      tasks: fullGraph.nodes.filter(node => node.kind === 'task').length,
      memories: memoryNodes.length,
      knowledge: fullGraph.nodes.filter(node => node.kind === 'knowledge').length,
      domains: fullGraph.nodes.filter(node => node.kind === 'domain').length,
      subdomains: fullGraph.nodes.filter(node => node.kind === 'subdomain').length,
      tags: fullGraph.nodes.filter(node => node.kind === 'tag').length,
      active: memoryNodes.filter(node => node.status === 'implemented').length,
      candidate: memoryNodes.filter(node => node.status === 'proposed').length,
      links: fullGraph.links.length,
      categories: categoryCounts,
      recent: [...fullGraph.nodes].sort((left, right) => right.timestamp - left.timestamp).slice(0, 4),
    }
  }, [fullGraph])

  const openDetail = async (node: NebulaNode): Promise<void> => {
    setDetailId(node.id)
    setFocusId(node.id)
    setPrecheck(null)
    setDecisionDetail(null)
    if (node.kind === 'memory' && node.sourceRef !== undefined) {
      const result = await client.getDecision(node.sourceRef)
      if (result.ok) setDecisionDetail(result.value as DecisionDetail)
    }
  }

  // Stable identity for the canvas effect: otherwise every state change tears
  // down and recreates the WebGL context, causing visible flicker.
  const pickHandler = useRef<(node: NebulaNode | null) => void>(() => undefined)
  pickHandler.current = (node) => { setFocusId(node?.id ?? null); setDetailId(null); setPrecheck(null) }
  const doubleHandler = useRef<(node: NebulaNode) => void>(() => undefined)
  doubleHandler.current = (node) => { void openDetail(node) }

  const runPrecheck = (): void => {
    if (shown === null) return
    setPrecheck(precheckTask(shown, fullGraph))
  }

  if (loading) return <div className="mn-state">记忆星云加载中…</div>
  if (error !== '') return <div className="mn-state mn-error">{error}</div>

  return (
    <section className={`mn-root${immersive ? ' is-immersive' : ''}`}>
      {!immersive ? (
        <header className="mn-toolbar">
          <span className="mn-brand"><Sparkles size={15} /> 记忆星云</span>
          <label className="mn-project">
            <span>项目</span>
            <select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value); setFocusId(null); setDetailId(null); setPrecheck(null)
              }}
            >
              {projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
            </select>
          </label>
          <div className="mn-modes">
            {([['overview', '全景'], ['tasks', '任务'], ['memories', '记忆']] as const).map(([value, label]) => (
              <button key={value} type="button" className={mode === value ? 'is-active' : ''} onClick={() => { setMode(value) }}>{label}</button>
            ))}
          </div>
          <label className="mn-search"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder="搜索任务、决策、知识…" /></label>
          <select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind) }} aria-label="节点类型">
            <option value="all">全部节点</option>
            <option value="task">任务</option>
            <option value="memory">记忆</option>
            <option value="knowledge">知识</option>
            <option value="domain">知识域</option>
            <option value="subdomain">细分领域</option>
            <option value="tag">标签</option>
          </select>
          <label className="mn-age">时间 <input type="range" min={7} max={730} value={maxAgeDays} onChange={(event) => { setMaxAgeDays(Number(event.target.value)) }} /><b>{maxAgeDays}天</b></label>
          <label className="mn-check"><input type="checkbox" checked={stress} onChange={(event) => { setStress(event.target.checked) }} />压力模式</label>
          <button type="button" className="mn-btn" onClick={() => { setImmersive(true) }}><Maximize2 size={14} />沉浸</button>
          <button type="button" className="mn-btn" onClick={() => { void load() }}>刷新</button>
        </header>
      ) : null}

      <div className="mn-canvas-wrap">
        {!immersive ? (
          <div className="mn-hud mn-hud-left">
            <div className="mn-panel">
              <div className="mn-panel-head"><span><Telescope size={13} /> 数据构成</span><em>MIX</em></div>
              <div className="mn-metric"><b>{stats.tasks}</b><span>任务节点</span></div>
              <div className="mn-metric"><b>{stats.memories}</b><span>记忆节点</span></div>
              <div className="mn-metric"><b>{stats.knowledge}</b><span>知识节点</span></div>
              <div className="mn-metric"><b>{stats.domains}</b><span>知识域</span></div>
              <div className="mn-metric"><b>{stats.subdomains}</b><span>细分领域</span></div>
              <div className="mn-metric"><b>{stats.tags}</b><span>标签节点</span></div>
              <div className="mn-metric"><b>{stats.links}</b><span>关系边</span></div>
              <div className="mn-mix-bar">
                {Object.entries(stats.categories).map(([category, count]) => (
                  <i key={category} style={{ width: `${stats.memories === 0 ? 0 : (count / stats.memories) * 100}%`, background: nodeColor({ kind: 'memory', category }) }} />
                ))}
              </div>
              <div className="mn-category-list">
                {Object.entries(MEMORY_CATEGORY_LABELS).map(([category, label]) => (
                  <span key={category}><i style={{ background: nodeColor({ kind: 'memory', category }) }} />{label}<b>{stats.categories[category] ?? 0}</b></span>
                ))}
              </div>
            </div>
            <div className="mn-panel">
              <div className="mn-panel-head"><span>星体透明</span><em>OPACITY</em></div>
              <input className="mn-opacity" type="range" min={0.4} max={1.4} step={0.05} value={opacity} onChange={(event) => { setOpacity(Number(event.target.value)) }} />
              <div className="mn-panel-foot">星体透明度 {Math.round(opacity * 100)}%</div>
            </div>
          </div>
        ) : null}

        <MemoryNebulaCanvas
          graph={fullGraph}
          focusId={focusId}
          searchSet={searchSet}
          opacityScale={opacity}
          stress={stress}
          onPick={pickHandler.current}
          onDoubleClick={doubleHandler.current}
          onHover={() => undefined}
        />

        {!immersive ? (
          <div className="mn-hud mn-hud-right">
            <div className="mn-panel">
              <div className="mn-panel-head"><span><Brain size={13} /> 记忆内核</span><em>CORE</em></div>
              <div className="mn-core-row"><span>当前有效</span><i><b style={{ width: `${stats.memories === 0 ? 0 : (stats.active / stats.memories) * 100}%` }} /></i><strong>{stats.active}</strong></div>
              <div className="mn-core-row"><span>候选待审</span><i><b style={{ width: `${stats.memories === 0 ? 0 : (stats.candidate / stats.memories) * 100}%` }} /></i><strong>{stats.candidate}</strong></div>
            </div>
            <div className="mn-panel">
              <div className="mn-panel-head"><span>认知流</span><em>LIVE</em><i className="mn-live">LIVE</i></div>
              {stats.recent.map(node => (
                <button key={node.id} type="button" className="mn-stream-row" onClick={() => { setFocusId(node.id) }}>
                  <i style={{ background: nodeColor(node) }} /><span>{clampText(node.title, 20)}</span><em>{formatDate(node.timestamp)}</em>
                </button>
              ))}
            </div>
            <div className="mn-panel">
              <div className="mn-panel-head"><span>关联内核</span><em>RETRIEVAL</em></div>
              <div className="mn-retrieval">
                <div><b>{fullGraph.links.filter(link => link.kind === 'contains').length}</b><span>结构</span></div>
                <div><b>{fullGraph.links.filter(link => link.kind === 'tagged').length}</b><span>标签</span></div>
                <div><b>{fullGraph.links.filter(link => link.kind === 'related' || link.kind === 'originated_from').length}</b><span>关联</span></div>
              </div>
            </div>
          </div>
        ) : null}

        {immersive ? (
          <button type="button" className="mn-exit-immersive" onClick={() => { setImmersive(false) }}><Minimize2 size={15} />退出沉浸</button>
        ) : null}

        {shown !== null ? (
          <article className="mn-memory-card">
            <header>
              <div><span className="mn-card-kicker">{MEMORY_KIND_LABELS[shown.kind].toUpperCase()} · {shown.cluster}</span><h3>{shown.title}</h3></div>
              <button type="button" onClick={() => { setFocusId(null); setDetailId(null); setPrecheck(null); setDecisionDetail(null) }} aria-label="关闭"><X size={16} /></button>
            </header>
            <div className="mn-card-meta">
              <span>{formatDate(shown.timestamp)}</span>
              <span>{shown.kind === 'memory' ? MEMORY_CATEGORY_LABELS[shown.category] ?? shown.category : shown.kind === 'knowledge' ? shown.category : shown.kind === 'tag' ? shown.summary : shown.status}</span>
              {shown.kind === 'memory' ? <span>{MEMORY_STATUS_LABELS[shown.status] ?? shown.status}</span> : <span>{shown.kind === 'knowledge' ? shown.status : shown.risk}</span>}
              <span>重要度 {Math.round(shown.importance * 100)}%</span>
            </div>
            <p>{shown.summary || '（无摘要）'}</p>
            <div className="mn-card-actions">
              {shown.kind === 'task' ? <button type="button" className="btn-secondary btn-sm" onClick={runPrecheck}>执行预检</button> : null}
              {shown.kind === 'memory' ? <button type="button" className="btn-secondary btn-sm" onClick={() => { void openDetail(shown) }}>查看决策详情</button> : null}
            </div>
            {precheck !== null ? <div className="mn-precheck">{precheck.map((item, index) => <div key={index} className={`is-${item.level}`}>{item.text}</div>)}</div> : null}
          </article>
        ) : null}
      </div>

      {detail !== null && detail.kind === 'memory' ? (
        <aside className="mn-drawer">
          <header><div><span>DECISION MEMORY</span><h2>{detail.title}</h2></div><button type="button" onClick={() => { setDetailId(null); setDecisionDetail(null) }} aria-label="关闭详情"><X size={16} /></button></header>
          <p className="mn-drawer-summary">{detail.summary}</p>
          {decisionDetail === null ? <p className="mn-muted">正在读取决策证据…</p> : (
            <>
              <section>
                <h3>决策内容</h3>
                <dl>
                  <dt>状态</dt><dd>{MEMORY_STATUS_LABELS[decisionDetail.decision.status] ?? decisionDetail.decision.status}</dd>
                  <dt>范围</dt><dd>{decisionDetail.decision.authorityScope}</dd>
                  <dt>层级</dt><dd>{decisionDetail.decision.authorityLevel}</dd>
                  <dt>提案</dt><dd>{decisionDetail.decision.proposal}</dd>
                  <dt>理由</dt><dd>{decisionDetail.decision.rationale}</dd>
                </dl>
              </section>
              <section><h3>证据 {decisionDetail.evidence.length}</h3>{decisionDetail.evidence.map(item => <div key={item.evidenceId} className="mn-evidence"><b>{item.kind}</b><span>{item.ref}</span></div>)}</section>
              <section><h3>审计 {decisionDetail.audit.length}</h3>{decisionDetail.audit.map(item => <div key={item.auditId} className="mn-audit"><b>{item.eventType}</b><span>{item.actorId} · {item.createdAt.slice(0, 19).replace('T', ' ')}</span></div>)}</section>
            </>
          )}
        </aside>
      ) : null}
    </section>
  )
}

/** @param props - icon size. @returns memory-nebula glyph. */
export function MemoryNebulaIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="5" cy="7" r="1.3" />
      <circle cx="19" cy="6" r="1.3" />
      <circle cx="18" cy="18" r="1.3" />
      <circle cx="6" cy="17" r="1.3" />
      <path d="M6.3 7.8 10 10.3M17.7 7.1 13.8 10.5M17 17l-3.8-3M7.2 16.2 10.8 13" strokeLinecap="round" />
    </svg>
  )
}
