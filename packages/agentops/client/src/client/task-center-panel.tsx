/**
 * Unified AgentOps task center.
 *
 * This panel restores the legacy task-center information architecture on top of
 * the DSH task service: one project context, stage cards, five views, task detail
 * and the blog-style report surface.
 *
 * @module @agentops/dsh-client/task-center-panel
 */

import {
  BarChart3,
  CalendarDays,
  Columns3,
  FileText,
  FolderPlus,
  List,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

import { TaskDetail } from './panel.tsx'
import type { DecisionMemory } from './memory-nebula-model.ts'
import {
  RISK_LABELS,
  STATUS_LABELS,
  TASK_STAGES,
  buildGanttRows,
  completionPercent,
  filterTaskCenterTasks,
  formatTimestamp,
  riskCounts,
  stageCounts,
  type TaskCenterProject,
  type TaskCenterTask,
  type TaskCenterView,
} from './task-center-model.ts'
import { createTaskRpcClient } from './task-rpc-api.ts'
import { createWikiDraft } from './knowledge-wiki-api.ts'

const client = createTaskRpcClient()

function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

const VIEWS: readonly { key: TaskCenterView; label: string; icon: typeof BarChart3 }[] = [
  { key: 'dashboard', label: '仪表盘', icon: BarChart3 },
  { key: 'board', label: '看板', icon: Columns3 },
  { key: 'list', label: '列表', icon: List },
  { key: 'gantt', label: '甘特图', icon: CalendarDays },
  { key: 'report', label: '任务报告', icon: FileText },
]

interface TaskFormState {
  title: string
  description: string
  risk: 'low' | 'medium' | 'high'
  type: 'code' | 'knowledge' | 'design' | 'hybrid'
}

interface CandidateRecord {
  candidateId: string
  version: number
  title: string
  status: string
}

interface CandidatePreview {
  readonly candidate: CandidateRecord
  readonly snapshotId: string
  readonly searchCoverage: 'complete' | 'partial' | 'failed'
  readonly decisions: readonly DecisionMemory[]
  readonly activeWork: readonly TaskCenterTask[]
  readonly selectedDecisionIds: readonly string[]
  readonly residualRisk: string
}

interface TaskDetailRecord {
  task: TaskCenterTask & { riskLevel: string }
  allowed: readonly { to: string; action: string; requiresUser: boolean }[]
}

interface ReportRecord {
  reportId: string
  content: string
  status: string
  submittedAt: string
}

interface CommentRecord {
  commentId: string
  body: string
  commentType: string
  authorName: string | null
  authorType: string
  createdAt: string
}

interface CriteriaRecord {
  criteriaId: string
  description: string
  status: string
}

interface RunRecord {
  linkId: string
  role: string
  status: string
  sessionId: string | null
  linkedAt: string
}

/** Preserve the previous array when a poll returns unchanged task content. */
function sameTaskContent(left: readonly TaskCenterTask[], right: readonly TaskCenterTask[]): boolean {
  if (left.length !== right.length) return false
  return left.every((task, index) => {
    const other = right[index]
    return other !== undefined
      && task.taskId === other.taskId
      && task.projectId === other.projectId
      && task.identifier === other.identifier
      && task.title === other.title
      && task.description === other.description
      && task.status === other.status
      && task.taskType === other.taskType
      && task.riskLevel === other.riskLevel
      && task.version === other.version
      && task.assigneeName === other.assigneeName
      && task.createdAt === other.createdAt
      && task.updatedAt === other.updatedAt
      && task.closedAt === other.closedAt
  })
}

async function unwrap<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const resolved = await result
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`)
  return resolved.value
}

/**
 * Render the unified task center.
 * @returns task management page.
 */
export function TaskCenterPanel(): ReactElement {
  const [projects, setProjects] = useState<TaskCenterProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [tasks, setTasks] = useState<TaskCenterTask[]>([])
  const [view, setView] = useState<TaskCenterView>('dashboard')
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [riskFilter, setRiskFilter] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [reportTaskId, setReportTaskId] = useState('')
  const [showProjectModal, setShowProjectModal] = useState(false)
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [candidatePreview, setCandidatePreview] = useState<CandidatePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const loadProjects = useCallback(async (preferred?: string) => {
    try {
      const value = await unwrap(client.listProjects()) as { projects: TaskCenterProject[] }
      setProjects(value.projects)
      setProjectId((current) => {
        const wanted = preferred ?? (current !== '' ? current : value.projects[0]?.project_id ?? '')
        return value.projects.some(project => project.project_id === wanted)
          ? wanted
          : value.projects[0]?.project_id ?? ''
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const loadTasks = useCallback(async (targetProject = projectId) => {
    if (targetProject === '') {
      setTasks([])
      return
    }
    try {
      const value = await unwrap(client.listTasks({ projectId: targetProject })) as { tasks: TaskCenterTask[] }
      setTasks(current => sameTaskContent(current, value.tasks) ? current : value.tasks)
      setReportTaskId(current => current !== '' && value.tasks.some(task => task.taskId === current)
        ? current
        : value.tasks.find(task => ['validating', 'closing'].includes(task.status))?.taskId
          ?? value.tasks[0]?.taskId
          ?? '')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [projectId])

  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => { void loadTasks(projectId) }, [loadTasks, projectId])

  useEffect(() => {
    const timer = setInterval(() => { void loadTasks(projectId) }, 15_000)
    return () =>{  clearInterval(timer) }
  }, [loadTasks, projectId])

  const visibleTasks = useMemo(
    () => filterTaskCenterTasks(tasks, { search, stage: stageFilter, risk: riskFilter }),
    [search, stageFilter, riskFilter, tasks],
  )
  const counts = useMemo(() => stageCounts(tasks), [tasks])
  const risks = useMemo(() => riskCounts(tasks), [tasks])

  if (selectedTaskId !== null) {
    return <TaskDetail id={selectedTaskId} onBack={() => { setSelectedTaskId(null) }} />
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await loadProjects(projectId)
      await loadTasks(projectId)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ao-page agentops-surface tc-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务中心</h1>
          <p className="ao-page-description">从灵感到关闭，统一管理项目、候选任务、执行、验收与报告。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setShowProjectModal(true) }}>
            <FolderPlus size={14} /> 新建项目
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={projectId === ''} onClick={() => { setShowTaskModal(true) }}>
            <Plus size={14} /> 新建任务
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => { void refresh() }}>
            <RefreshCw size={14} className={busy ? 'tc-spin' : ''} /> 刷新
          </button>
        </div>
      </header>

      {notice !== '' ? <div className="tc-notice" role="alert">{notice}</div> : null}

      <section className="tc-toolbar">
        <label className="tc-field tc-project-field">
          <span>项目</span>
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setStageFilter('') }}>
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>
                {project.name} · {project.task_count} 个任务
              </option>
            ))}
          </select>
        </label>
        <label className="tc-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
            placeholder="搜索任务标题、描述或标识符…"
            aria-label="搜索任务"
          />
        </label>
        <label className="tc-field">
          <span>风险</span>
          <select value={riskFilter} onChange={(event) => { setRiskFilter(event.target.value) }}>
            <option value="">全部风险</option>
            <option value="high">高风险</option>
            <option value="medium">中风险</option>
            <option value="low">低风险</option>
          </select>
        </label>
      </section>

      <section className="tc-stage-cards" aria-label="任务阶段">
        {TASK_STAGES.map(stage => (
          <button
            key={stage.key}
            type="button"
            className={`tc-stage-card${stageFilter === stage.key ? ' is-active' : ''}`}
            onClick={() => {
              setStageFilter(stageFilter === stage.key ? '' : stage.key)
              setView('list')
            }}
          >
            <i style={{ background: stage.color }} />
            <span>{stage.label}</span>
            <b>{counts[stage.key] ?? 0}</b>
            <small onClick={(event) => { event.stopPropagation(); setShowTaskModal(true) }}>+</small>
          </button>
        ))}
      </section>

      <nav className="tc-view-tabs" aria-label="任务视图">
        {VIEWS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              className={view === item.key ? 'is-active' : ''}
              onClick={() => { setView(item.key) }}
            >
              <Icon size={14} /> {item.label}
            </button>
          )
        })}
      </nav>

      <main className="tc-view-body">
        {view === 'dashboard' ? (
          <DashboardView tasks={visibleTasks} allTasks={tasks} risks={risks} onOpen={setSelectedTaskId} />
        ) : null}
        {view === 'board' ? (
          <BoardView tasks={visibleTasks} onOpen={setSelectedTaskId} />
        ) : null}
        {view === 'list' ? (
          <ListView tasks={visibleTasks} onOpen={setSelectedTaskId} />
        ) : null}
        {view === 'gantt' ? (
          <GanttView tasks={visibleTasks} onOpen={setSelectedTaskId} />
        ) : null}
        {view === 'report' ? (
          <ReportView
            tasks={tasks}
            taskId={reportTaskId}
            onSelectTask={setReportTaskId}
            onOpenTask={setSelectedTaskId}
            onRefresh={() => { void loadTasks(projectId) }}
          />
        ) : null}
      </main>

      {showProjectModal ? (
        <CreateProjectModal
          busy={busy}
          onClose={() => { setShowProjectModal(false) }}
          onCreate={async (form) => {
            setBusy(true)
            try {
              const value = await unwrap(client.createProject(form)) as { project_id: string }
              await loadProjects(value.project_id)
              setProjectId(value.project_id)
              setShowProjectModal(false)
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {showTaskModal ? (
        <CreateTaskModal
          projectId={projectId}
          busy={busy}
          onClose={() => { setShowTaskModal(false) }}
          onCreate={async (form) => {
            setBusy(true)
            try {
              const preview = await prepareCandidateForTask(projectId, form)
              setShowTaskModal(false)
              setCandidatePreview(preview)
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {candidatePreview !== null ? (
        <CandidateReviewModal
          preview={candidatePreview}
          busy={busy}
          onClose={() => { setCandidatePreview(null) }}
          onConfirm={async () => {
            setBusy(true)
            try {
              const task = await confirmCandidateTask(candidatePreview)
              setCandidatePreview(null)
              setStageFilter(task.status)
              setView('list')
              await loadTasks(projectId)
              setSelectedTaskId(task.taskId)
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}
    </div>
  )
}

async function prepareCandidateForTask(projectId: string, form: TaskFormState): Promise<CandidatePreview> {
  const captured = await unwrap(client.captureCandidate({
    project_id: projectId,
    title: form.title,
    description: form.description,
    source_type: 'manual',
    risk_level: form.risk,
    complexity: form.type === 'code' ? 'medium' : 'simple',
  })) as { candidate: CandidateRecord }
  let candidate = captured.candidate
  const first = await unwrap(client.analyzeCandidate(candidate.candidateId, {
    if_version: candidate.version,
    analysis_problem: form.description || form.title,
    analysis_deliverables: form.title,
    acceptance_criteria: [{ description: `${form.title} 已完成并通过验收` }],
    risk_level: form.risk,
  })) as { candidate: CandidateRecord }
  candidate = first.candidate
  const second = await unwrap(client.analyzeCandidate(candidate.candidateId, {
    if_version: candidate.version,
    analysis_non_goals: '',
    dependencies: [],
    risk_level: form.risk,
  })) as { candidate: CandidateRecord }
  candidate = second.candidate
  const [decisionResult, taskResult] = await Promise.all([
    client.searchDecisions({ project_id: projectId, q: form.title, collection: 'all', limit: '500' }),
    client.searchTasks({ projectId, q: form.title, limit: '200' }),
  ])
  if (!decisionResult.ok) throw new Error(`${decisionResult.error.code}: ${decisionResult.error.message}`)
  if (!taskResult.ok) throw new Error(`${taskResult.error.code}: ${taskResult.error.message}`)
  const decisionValue = decisionResult.value as { decisions: DecisionMemory[]; searchCoverage?: 'partial' }
  const taskValue = taskResult.value as { tasks: TaskCenterTask[] }
  const decisions = decisionValue.decisions
  const activeWork = taskValue.tasks
  const proposed = decisions.filter(item => item.status === 'proposed').map(item => item.decisionId)
  const authoritative = decisions.filter(item => item.status === 'implemented').map(item => item.decisionId)
  const historical = decisions.filter(item => item.status === 'rejected' || item.status === 'archived').map(item => item.decisionId)
  const coverage: CandidatePreview['searchCoverage'] = decisionValue.searchCoverage === 'partial' ? 'partial' : 'complete'
  const residualRisk = coverage === 'partial' ? '决策检索覆盖度不完整，需人工确认。' : proposed.length > 0 ? '存在待讨论决策，需确认是否冲突。' : ''
  const snapshot = await unwrap(client.preflightCandidate(candidate.candidateId, {
    if_version: candidate.version,
    query: { q: form.title, project_id: projectId },
    search_coverage: coverage,
    active_work: activeWork.map(task => ({
      entity_type: 'task',
      entity_id: task.taskId,
      project_id: task.projectId,
      title: task.title,
      status: task.status,
    })),
    proposed_decision_ids: proposed,
    authoritative_decision_ids: authoritative,
    historical_decision_ids: historical,
    selected_decision_ids: authoritative,
    residual_risk: residualRisk,
  })) as { snapshot: { snapshotId: string } }
  const current = await unwrap(client.getCandidate(candidate.candidateId)) as { candidate: CandidateRecord }
  return {
    candidate: current.candidate,
    snapshotId: snapshot.snapshot.snapshotId,
    searchCoverage: coverage,
    decisions,
    activeWork,
    selectedDecisionIds: authoritative,
    residualRisk,
  }
}

async function confirmCandidateTask(preview: CandidatePreview): Promise<TaskCenterTask> {
  const admitted = await unwrap(client.gateCandidate(preview.candidate.candidateId, {
    if_version: preview.candidate.version,
  })) as { task: TaskCenterTask }
  return admitted.task
}

function DashboardView({
  tasks,
  allTasks,
  risks,
  onOpen,
}: {
  tasks: readonly TaskCenterTask[]
  allTasks: readonly TaskCenterTask[]
  risks: Record<string, number>
  onOpen: (id: string) => void
}): ReactElement {
  const activities: readonly DashboardActivity[] = [...allTasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map(task => ({
      taskId: task.taskId,
      taskTitle: task.title,
      eventType: STATUS_LABELS[task.status] ?? task.status,
      createdAt: task.updatedAt,
    }))

  const percent = completionPercent(allTasks)
  const closed = allTasks.filter(task => task.status === 'closed').length
  const blocked = allTasks.filter(task => ['blocked', 'failed', 'paused'].includes(task.status)).length
  const validating = allTasks.filter(task => ['validating', 'closing'].includes(task.status)).length
  const highRisk = risks.high ?? 0
  const active = allTasks.filter(task => ['discussing', 'decomposing', 'in_progress'].includes(task.status)).length
  const groups = [
    { label: '处理中', count: active, color: '#60A5FA' },
    { label: '等你确认', count: allTasks.filter(task => ['reviewing', 'validating', 'closing'].includes(task.status)).length, color: '#F59E0B' },
    { label: '待执行', count: allTasks.filter(task => task.status === 'backlog').length, color: '#94A3B8' },
    { label: '遇到阻碍', count: blocked, color: '#EF4444' },
    { label: '已关闭', count: closed, color: '#10B981' },
    { label: '待立项', count: allTasks.filter(task => task.status === 'idea').length, color: '#6B7280' },
  ]

  const funnel = [
    ['idea', '灵感'], ['discussing', '讨论'], ['decomposing', '拆解'], ['reviewing', '评审'],
    ['backlog', '待办'], ['in_progress', '执行'], ['validating', '验收'], ['closing', '收尾'], ['closed', '关闭'],
  ] as const
  const funnelMax = Math.max(1, ...funnel.map(([status]) => allTasks.filter(task => task.status === status).length))
  const stageRisk = funnel.slice(0, 8).map(([status, label]) => ({
    label,
    total: allTasks.filter(task => task.status === status).length,
    high: allTasks.filter(task => task.status === status && task.riskLevel === 'high').length,
    blocked: allTasks.filter(task => task.status === status && ['blocked', 'failed', 'paused'].includes(task.status)).length,
  }))

  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (13 - index))
    return date
  })
  const dayKey = (date: Date): string => date.toISOString().slice(0, 10)
  const createdTrend = days.map(date => allTasks.filter(task => task.createdAt.slice(0, 10) === dayKey(date)).length)
  const closedTrend = days.map(date => allTasks.filter(task => task.closedAt?.slice(0, 10) === dayKey(date)).length)
  const trendMax = Math.max(1, ...createdTrend, ...closedTrend)
  const trendPoints = (values: readonly number[]): string => values.map((value, index) =>
    `${(index / 13) * 100},${36 - (value / trendMax) * 30}`,
  ).join(' ')

  const recent = activities
  const attention = tasks.filter(task => ['blocked', 'failed', 'paused'].includes(task.status) || task.riskLevel === 'high').slice(0, 8)

  return (
    <div className="tc-dashboard">
      <section className="tc-completion-card">
        <div><strong>{percent}%</strong><span>整体完成度</span></div>
        <div className="tc-progress-track"><i style={{ width: `${percent}%` }} /></div>
        <p>{closed} 个已关闭 · {allTasks.length - closed} 个尚未结束</p>
      </section>

      <section className="tc-cockpit-kpis">
        <div className="tc-kpi-card is-active"><span>活跃任务</span><b>{active}</b><small>讨论 / 拆解 / 执行</small></div>
        <div className="tc-kpi-card is-warn"><span>验收积压</span><b>{validating}</b><small>等待验收或关闭</small></div>
        <div className="tc-kpi-card is-danger"><span>执行风险</span><b>{blocked}</b><small>阻塞 / 失败 / 暂停</small></div>
        <div className="tc-kpi-card"><span>高风险占比</span><b>{allTasks.length === 0 ? 0 : Math.round(highRisk / allTasks.length * 100)}%</b><small>{highRisk} 个高风险任务</small></div>
      </section>

      <section className="tc-stat-cards">
        {groups.map(group => (
          <div key={group.label} className="tc-stat-card">
            <i style={{ background: group.color }} />
            <span>{group.label}</span>
            <strong>{group.count}</strong>
          </div>
        ))}
      </section>

      <section className="tc-cockpit-grid">
        <div className="tc-panel-card tc-funnel-card">
          <h3>阶段漏斗 <em>真实任务状态</em></h3>
          {funnel.map(([status, label]) => {
            const count = allTasks.filter(task => task.status === status).length
            return (
              <div className="tc-funnel-row" key={status}>
                <span>{label}</span>
                <div><i style={{ width: `${count / funnelMax * 100}%` }} /></div>
                <b>{count}</b>
              </div>
            )
          })}
        </div>

        <div className="tc-panel-card tc-trend-card">
          <h3>近 14 天流转 <em>新增 / 关闭</em></h3>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="近 14 天任务新增和关闭趋势">
            <polyline points={trendPoints(createdTrend)} className="tc-trend-line is-created" />
            <polyline points={trendPoints(closedTrend)} className="tc-trend-line is-closed" />
          </svg>
          <div className="tc-trend-legend"><span><i className="is-created" />新增 {createdTrend.reduce((sum, value) => sum + value, 0)}</span><span><i className="is-closed" />关闭 {closedTrend.reduce((sum, value) => sum + value, 0)}</span></div>
        </div>

        <div className="tc-panel-card tc-risk-stage-card">
          <h3>风险 × 阶段 <em>高风险 / 总量</em></h3>
          {stageRisk.map(item => (
            <div className="tc-stage-risk-row" key={item.label}>
              <span>{item.label}</span>
              <div><i style={{ width: `${item.total === 0 ? 0 : item.high / item.total * 100}%` }} /></div>
              <b>{item.high}/{item.total}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="tc-cockpit-grid is-bottom">
        <div className="tc-panel-card">
          <h3>执行关注 <em>阻塞 / 高风险</em></h3>
          {attention.length === 0 ? <p className="tc-muted">当前没有阻塞或高风险任务。</p> : attention.map(task => (
            <button key={task.taskId} type="button" className="tc-attention-row" onClick={() => { onOpen(task.taskId) }}>
              <span>{task.identifier ?? task.taskId.slice(-6)}</span>
              <b>{task.title}</b>
              <small>{STATUS_LABELS[task.status] ?? task.status}</small>
            </button>
          ))}
        </div>
        <div className="tc-panel-card">
          <h3>最近活动 <em>任务事实流</em></h3>
          {recent.length === 0 ? <p className="tc-muted">暂无活动记录。</p> : recent.map(activity => (
            <button key={`${activity.taskId}-${activity.createdAt ?? ''}`} type="button" className="tc-activity-row" onClick={() => { onOpen(activity.taskId) }}>
              <span>{activity.eventType ?? '更新'}</span>
              <b>{activity.taskTitle ?? activity.taskId}</b>
              <small>{activity.createdAt?.slice(5, 16).replace('T', ' ') ?? ''}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

interface DashboardActivity {
  activityId?: string
  taskId: string
  taskTitle?: string
  eventType?: string
  kind?: string
  createdAt?: string
}

function BoardView({ tasks, onOpen }: { tasks: readonly TaskCenterTask[]; onOpen: (id: string) => void }): ReactElement {
  return (
    <div className="tc-board">
      {TASK_STAGES.map(stage => (
        <section key={stage.key} className="tc-board-column">
          <header>
            <i style={{ background: stage.color }} />
            <span>{stage.label}</span>
            <b>{tasks.filter(task => task.status === stage.key).length}</b>
          </header>
          <div className="tc-board-cards">
            {tasks.filter(task => task.status === stage.key).map(task => <TaskCard key={task.taskId} task={task} onOpen={onOpen} />)}
          </div>
        </section>
      ))}
    </div>
  )
}

function TaskCard({ task, onOpen }: { task: TaskCenterTask; onOpen: (id: string) => void }): ReactElement {
  return (
    <button type="button" className={`tc-task-card risk-${task.riskLevel}`} onClick={() => { onOpen(task.taskId) }}>
      <div className="tc-task-card-top">
        <span>{task.identifier ?? task.taskId.slice(-6)}</span>
        <small>{RISK_LABELS[task.riskLevel] ?? task.riskLevel}</small>
      </div>
      <strong>{task.title}</strong>
      {task.description !== '' ? <p>{task.description}</p> : null}
      <footer><span>{task.assigneeName ?? '未分配'}</span><span>v{task.version}</span><span>{formatTimestamp(task.updatedAt)}</span></footer>
    </button>
  )
}

function ListView({ tasks, onOpen }: { tasks: readonly TaskCenterTask[]; onOpen: (id: string) => void }): ReactElement {
  return (
    <div className="tc-table-wrap">
      <table className="data-table tc-table">
        <thead><tr><th>标识</th><th>标题</th><th>阶段</th><th>风险</th><th>负责人</th><th>版本</th><th>更新时间</th></tr></thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.taskId} onClick={() => { onOpen(task.taskId) }}>
              <td className="font-mono">{task.identifier ?? task.taskId.slice(-6)}</td>
              <td>{task.title}</td>
              <td>{STATUS_LABELS[task.status] ?? task.status}</td>
              <td>{RISK_LABELS[task.riskLevel] ?? task.riskLevel}</td>
              <td>{task.assigneeName ?? '—'}</td>
              <td>v{task.version}</td>
              <td>{formatTimestamp(task.updatedAt)}</td>
            </tr>
          ))}
          {tasks.length === 0 ? <tr><td colSpan={7} className="tc-empty-cell">没有匹配的任务</td></tr> : null}
        </tbody>
      </table>
    </div>
  )
}

function GanttView({ tasks, onOpen }: { tasks: readonly TaskCenterTask[]; onOpen: (id: string) => void }): ReactElement {
  const { rows, min, max } = buildGanttRows(tasks)
  const span = Math.max(1, max - min)
  return (
    <div className="tc-gantt">
      <div className="tc-gantt-head"><span>任务（{rows.length}）</span><span>{new Date(min).toLocaleDateString('zh-CN')} → {new Date(max).toLocaleDateString('zh-CN')}</span></div>
      {rows.map(({ task, start, end }) => (
        <button key={task.taskId} type="button" className="tc-gantt-row" onClick={() => { onOpen(task.taskId) }}>
          <span>{task.identifier ?? task.taskId.slice(-6)} · {task.title}</span>
          <div>
            <i className={`risk-${task.riskLevel}`} style={{ left: `${((start - min) / span) * 100}%`, width: `${Math.max(2, ((end - start) / span) * 100)}%` }} />
          </div>
        </button>
      ))}
      {rows.length === 0 ? <p className="tc-muted">暂无任务</p> : null}
    </div>
  )
}

function ReportView({
  tasks,
  taskId,
  onSelectTask,
  onOpenTask,
  onRefresh,
}: {
  tasks: readonly TaskCenterTask[]
  taskId: string
  onSelectTask: (id: string) => void
  onOpenTask: (id: string) => void
  onRefresh: () => void
}): ReactElement {
  const [detail, setDetail] = useState<TaskDetailRecord | null>(null)
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [criteria, setCriteria] = useState<CriteriaRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [document, setDocument] = useState('')
  const [error, setError] = useState('')
  const [wikiBusy, setWikiBusy] = useState(false)
  const [wikiNotice, setWikiNotice] = useState('')

  const load = useCallback(async () => {
    if (taskId === '') return
    setError('')
    try {
      const [detailValue, reportValue, commentValue, criteriaValue, runValue] = await Promise.all([
        unwrap(client.getTask(taskId)),
        unwrap(client.listReports(taskId)),
        unwrap(client.listComments(taskId)),
        unwrap(client.listCriteria(taskId)),
        unwrap(client.listRuns(taskId)),
      ])
      const nextDetail = detailValue as TaskDetailRecord
      const nextReports = (reportValue as { reports: ReportRecord[] }).reports
      setDetail(nextDetail)
      setReports(nextReports)
      setComments((commentValue as { comments: CommentRecord[] }).comments)
      setCriteria((criteriaValue as { criteria: CriteriaRecord[] }).criteria)
      setRuns((runValue as { runs: RunRecord[] }).runs)
      const latest = [...nextReports].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0]
      if (latest === undefined) {
        setDocument('')
      } else {
        const exportValue = await unwrap(client.getReportDocument(taskId, latest.reportId)) as { export: { content?: string } }
        setDocument(exportValue.export.content ?? latest.content)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [taskId])

  useEffect(() => { void load() }, [load])

  const latest = [...reports].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0]
  const archiveToKnowledge = async (): Promise<void> => {
    if (detail === null || latest === undefined) return
    setWikiBusy(true)
    setWikiNotice('')
    try {
      const draft = await createWikiDraft({
        title: `${detail.task.title} · 知识归档`,
        content: document || latest.content,
        sourceKind: 'task_report',
        sourceRef: `${taskId}/${latest.reportId}`,
        sourceTaskId: taskId,
        sourceReportId: latest.reportId,
        pageType: 'source',
      })
      setWikiNotice(draft.status === 'conflicted'
        ? `已进入知识草稿箱：${draft.conflicts.length} 个检查项需要处理`
        : '已进入知识草稿箱并通过首次检查')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWikiBusy(false)
    }
  }
  const approve = async (): Promise<void> => {
    if (detail === null || latest === undefined) return
    try {
      await unwrap(client.reviewReport(taskId, latest.reportId, {
        decision: 'approve', comment: '验收通过', if_version: detail.task.version,
      }))
      const fresh = await unwrap(client.getTask(taskId)) as TaskDetailRecord
      await unwrap(client.closeTask(taskId, { if_version: fresh.task.version, comment: '验收通过并关闭' }))
      if (detail.task.taskType === 'knowledge' || detail.task.taskType === 'hybrid') await archiveToKnowledge()
      onRefresh()
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const requestChanges = async (): Promise<void> => {
    if (detail === null || latest === undefined) return
    const target = window.prompt('退回目标阶段：in_progress / decomposing / discussing', 'in_progress')
    if (target === null) return
    const reason = window.prompt('退回原因') ?? '请根据新反馈重新处理'
    try {
      await unwrap(client.reviewReport(taskId, latest.reportId, {
        decision: 'request_changes', comment: reason, if_version: detail.task.version,
      }))
      const fresh = await unwrap(client.getTask(taskId)) as TaskDetailRecord
      await unwrap(client.rollbackTask(taskId, { target_status: target, if_version: fresh.task.version, reason }))
      onRefresh()
      await load()
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : String(reasonValue))
    }
  }

  return (
    <div className="tc-report">
      <div className="tc-report-toolbar">
        <select value={taskId} onChange={(event) => { onSelectTask(event.target.value) }}>
          {tasks.map(task => (
            <option key={task.taskId} value={task.taskId}>
              {task.identifier ?? task.taskId.slice(-6)} · {task.title}
            </option>
          ))}
        </select>
        {detail !== null ? <button type="button" className="btn-secondary btn-sm" onClick={() => { onOpenTask(taskId) }}>打开详情</button> : null}
      </div>
      {error !== '' ? <div className="tc-notice" role="alert">{error}</div> : null}
      {detail === null ? <p className="tc-muted">选择任务查看报告。</p> : (
        <div className="tc-report-grid">
          <section className="tc-report-main">
            <div className="tc-panel-card">
              <h3>最新报告</h3>
              {latest === undefined ? <p className="tc-muted">暂无报告。Agent 完成执行后会在此提交。</p> : (
                <>
                  <div className="tc-report-meta">
                    <span>{latest.status}</span>
                    <span>{formatTimestamp(latest.submittedAt)}</span>
                    <span>{runs[0]?.sessionId ?? '无 Session'}</span>
                  </div>
                  <pre className="tc-report-document">{document || latest.content}</pre>
                </>
              )}
            </div>
            <div className="tc-panel-card">
              <h3>评论与决策</h3>
              {comments.length === 0 ? <p className="tc-muted">暂无评论</p> : comments.map(comment => (
                <article key={comment.commentId} className="tc-comment">
                  <div>
                    <b>{comment.authorName ?? comment.authorType}</b>
                    <span>{comment.commentType}</span>
                    <small>{formatTimestamp(comment.createdAt)}</small>
                  </div>
                  <p>{comment.body}</p>
                </article>
              ))}
            </div>
          </section>
          <aside className="tc-report-side">
            <div className="tc-panel-card">
              <h3>验收操作</h3>
              <button type="button" className="btn-primary btn-sm tc-full-button" disabled={latest === undefined || detail.task.status === 'closed'} onClick={() => { void approve() }}>通过并关闭</button>
              <button type="button" className="btn-secondary btn-sm tc-full-button" disabled={latest === undefined || detail.task.status === 'closed'} onClick={() => { void requestChanges() }}>退回修改</button>
              <button type="button" className="btn-secondary btn-sm tc-full-button" disabled={latest === undefined || wikiBusy} onClick={() => { void archiveToKnowledge() }}>{wikiBusy ? '归档中…' : '归档到知识库草稿箱'}</button>
              {wikiNotice === '' ? null : <p className="tc-muted">{wikiNotice}</p>}
            </div>
            <div className="tc-panel-card">
              <h3>验收标准 {criteria.length}</h3>
              {criteria.length === 0 ? <p className="tc-muted">暂无验收标准</p> : criteria.map(item => (
                <div key={item.criteriaId} className="tc-criteria-row"><span className={`is-${item.status}`}>{item.status}</span><p>{item.description}</p></div>
              ))}
            </div>
            <div className="tc-panel-card">
              <h3>执行记录</h3>
              {runs.length === 0 ? <p className="tc-muted">尚无执行记录</p> : runs.map(run => (
                <div key={run.linkId} className="tc-run-row"><span>{run.role}</span><b>{run.status}</b><small>{run.sessionId ?? run.linkId}</small></div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

interface ProjectFormState {
  readonly name: string
  readonly type: 'code' | 'knowledge' | 'hybrid'
  readonly workspaceId: string
  readonly localPath: string
  readonly githubUrl: string
  readonly branchRef: string
  readonly feishuDocToken: string
}

function CreateProjectModal({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean
  onClose: () => void
  onCreate: (form: {
    name: string
    type: 'code' | 'knowledge' | 'hybrid'
    workspace_id?: string
    local_path?: string
    github_url?: string
    branch_ref?: string
    feishu_doc_token?: string
  }) => Promise<void>
}): ReactElement {
  const [form, setForm] = useState<ProjectFormState>({
    name: '',
    type: 'code',
    workspaceId: '',
    localPath: '',
    githubUrl: '',
    branchRef: '',
    feishuDocToken: '',
  })
  const [workspaces, setWorkspaces] = useState<readonly { workspace_id: string; title: string; path: string }[]>([])
  useEffect(() => {
    void client.listWorkspaces().then((result) => {
      if (result.ok) {
        const response = result.value as { workspaces?: { workspace_id: string; title: string; path: string }[] }
        setWorkspaces(response.workspaces ?? [])
      }
    })
  }, [])
  const workspaceBound = form.type === 'knowledge'
    ? form.feishuDocToken.trim() !== ''
    : form.workspaceId.trim() !== '' || form.localPath.trim() !== ''
  const submit = (): void => {
    if (form.name.trim() === '' || !workspaceBound) return
    void onCreate({
      name: form.name.trim(),
      type: form.type,
      ...(form.workspaceId.trim() === '' ? {} : { workspace_id: form.workspaceId.trim() }),
      ...(form.localPath.trim() === '' ? {} : { local_path: form.localPath.trim() }),
      ...(form.githubUrl.trim() === '' ? {} : { github_url: form.githubUrl.trim() }),
      ...(form.branchRef.trim() === '' ? {} : { branch_ref: form.branchRef.trim() }),
      ...(form.feishuDocToken.trim() === '' ? {} : { feishu_doc_token: form.feishuDocToken.trim() }),
    })
  }
  return (
    <Modal title="新建项目" onClose={onClose}>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); submit() }}>
        <label className="tc-form-field"><span>项目名称</span><input autoFocus value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }) }} placeholder="例如：AgentOps 任务中心" /></label>
        <label className="tc-form-field"><span>项目类型</span><select value={form.type} onChange={(event) => { setForm({ ...form, type: event.target.value as ProjectFormState['type'] }) }}><option value="code">代码</option><option value="knowledge">知识</option><option value="hybrid">混合</option></select></label>
        <label className="tc-form-field">
          <span>DSH Workspace</span>
          <select
            value={form.workspaceId}
            onChange={(event) => {
              setForm({ ...form, workspaceId: event.target.value, localPath: '' })
            }}
          >
            <option value="">选择 Workspace（推荐）</option>
            {workspaces.map(workspace => (
              <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.title} · {workspace.path}</option>
            ))}
          </select>
        </label>
        <label className="tc-form-field"><span>项目目录</span><input value={form.localPath} onChange={(event) => { setForm({ ...form, localPath: event.target.value, workspaceId: '' }) }} placeholder="未注册 Workspace 时填绝对目录" /></label>
        <div className="tc-form-row">
          <label className="tc-form-field"><span>仓库地址</span><input value={form.githubUrl} onChange={(event) => { setForm({ ...form, githubUrl: event.target.value }) }} placeholder="可选" /></label>
          <label className="tc-form-field"><span>分支</span><input value={form.branchRef} onChange={(event) => { setForm({ ...form, branchRef: event.target.value }) }} placeholder="可选" /></label>
        </div>
        {form.type !== 'code' ? (
          <label className="tc-form-field"><span>飞书文档 Token</span><input value={form.feishuDocToken} onChange={(event) => { setForm({ ...form, feishuDocToken: event.target.value }) }} placeholder="知识/混合项目" /></label>
        ) : null}
        <p className="tc-form-hint">项目必须绑定 Workspace 或服务端可验证目录；未绑定项目可以建候选，但不能派发执行。</p>
        <div className="tc-modal-actions"><button type="button" className="btn-secondary" onClick={onClose}>取消</button><button type="submit" className="btn-primary" disabled={busy || form.name.trim() === '' || !workspaceBound}>{busy ? '创建中…' : '创建项目'}</button></div>
      </form>
    </Modal>
  )
}

function CandidateReviewModal({
  preview,
  busy,
  onClose,
  onConfirm,
}: {
  preview: CandidatePreview
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}): ReactElement {
  const proposed = preview.decisions.filter(item => item.status === 'proposed')
  const authoritative = preview.decisions.filter(item => item.status === 'implemented')
  const historical = preview.decisions.filter(item => item.status === 'rejected' || item.status === 'archived')
  return (
    <Modal title="准入快照确认" onClose={onClose}>
      <div className="tc-form-hint">创建任务前请复核真实检索快照；确认后才会执行 Candidate Gate。</div>
      <div className="tc-panel-card">
        <h3>检索覆盖</h3>
        <p><b>{preview.searchCoverage}</b> · 快照 {preview.snapshotId}</p>
        {preview.residualRisk !== '' ? <p style={{ color: 'var(--state-warning, #f59e0b)' }}>{preview.residualRisk}</p> : null}
      </div>
      <div className="tc-panel-card">
        <h3>互斥检索</h3>
        <p>待讨论 {proposed.length} · 当前权威 {authoritative.length} · 历史决策 {historical.length} · 活跃工作 {preview.activeWork.length}</p>
        {preview.decisions.slice(0, 8).map(item => (
          <div key={item.decisionId} className="tc-run-row">
            <span>{item.status}</span><b>{clampText(item.title, 42)}</b><small>{item.decisionId}</small>
          </div>
        ))}
      </div>
      <div className="tc-panel-card">
        <h3>将关联的权威决策</h3>
        <p>{preview.selectedDecisionIds.length === 0 ? '无：本次任务未关联已生效决策。' : preview.selectedDecisionIds.join('、')}</p>
      </div>
      <div className="tc-modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>返回修改</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => { void onConfirm() }}>{busy ? '创建中…' : '确认并创建任务'}</button>
      </div>
    </Modal>
  )
}

function CreateTaskModal({
  projectId,
  busy,
  onClose,
  onCreate,
}: {
  projectId: string
  busy: boolean
  onClose: () => void
  onCreate: (form: TaskFormState) => Promise<void>
}): ReactElement {
  const [form, setForm] = useState<TaskFormState>({ title: '', description: '', risk: 'medium', type: 'code' })
  return (
    <Modal title="新建任务" onClose={onClose}>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (form.title.trim() !== '') void onCreate({ ...form, title: form.title.trim() }) }}>
        <p className="tc-form-hint">任务会先进入 Candidate 分析，再经用户 Gate 批准创建；不会绕过准入直接写入 Task。</p>
        <label className="tc-form-field"><span>标题</span><input autoFocus value={form.title} onChange={(event) => { setForm({ ...form, title: event.target.value }) }} placeholder="需要完成什么？" /></label>
        <label className="tc-form-field"><span>描述</span><textarea value={form.description} onChange={(event) => { setForm({ ...form, description: event.target.value }) }} placeholder="目标、范围、验收标准…" /></label>
        <div className="tc-form-row">
          <label className="tc-form-field"><span>类型</span><select value={form.type} onChange={(event) => { setForm({ ...form, type: event.target.value as TaskFormState['type'] }) }}><option value="code">代码</option><option value="knowledge">知识</option><option value="design">设计</option><option value="hybrid">混合</option></select></label>
          <label className="tc-form-field"><span>风险</span><select value={form.risk} onChange={(event) => { setForm({ ...form, risk: event.target.value as TaskFormState['risk'] }) }}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
        </div>
        <div className="tc-modal-actions"><button type="button" className="btn-secondary" onClick={onClose}>取消</button><button type="submit" className="btn-primary" disabled={busy || form.title.trim() === '' || projectId === ''}>{busy ? '分析并创建中…' : '创建任务'}</button></div>
      </form>
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }): ReactElement {
  return (
    <div className="tc-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="tc-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
        {children}
      </section>
    </div>
  )
}

/** @param props - icon size. @returns task-center glyph. */
export function TaskCenterIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M8 7h8M8 12h2M12 12h4M8 17h2M12 17h4" strokeLinecap="round" />
    </svg>
  )
}
