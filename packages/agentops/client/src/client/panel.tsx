/**
 * Task board panel — the first original page migrated with a live data path.
 *
 * Layout follows the legacy Task Center kanban (four lanes, card metadata),
 * while the styles are inline so the panel does not depend on the old global
 * stylesheet yet. Data comes from the authenticated exact route
 * the v1 task surface through `/api/agentops/task-rpc`, which is read-only here.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()

interface TaskRecord {
  taskId: string
  title: string
  description: string
  status: string
  riskLevel: string
  version: number
  updatedAt: string
}

const LANES: { title: string; statuses: string[] }[] = [
  { title: '待规划', statuses: ['idea', 'discussing', 'decomposing', 'reviewing'] },
  { title: '进行中', statuses: ['backlog', 'in_progress', 'blocked', 'paused', 'failed'] },
  { title: '待验收', statuses: ['validating', 'closing'] },
  { title: '已完成', statuses: ['closed'] },
]

const STATUS_LABEL: Record<string, string> = {
  idea: '灵感', discussing: '讨论中', decomposing: '拆解中', reviewing: '评审中',
  backlog: '待办', in_progress: '执行中', blocked: '阻塞', paused: '暂停', failed: '失败',
  validating: '验收中', closing: '关闭中', closed: '已关闭',
  canceled: '已取消', abandoned: '已归档',
}

type LoadState = 'loading' | 'ready' | 'error'

export function AgentOpsPanel(): ReactElement {
  const [selected, setSelected] = useState<string | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [projects, setProjects] = useState<{ project_id: string; name: string }[]>([])
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftProject, setDraftProject] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    const result = await client.listTasks()
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      setState('error')
      return
    }
    setTasks((result.value as { tasks?: TaskRecord[] }).tasks ?? [])
    setState('ready')
  }, [])

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setState('error')
    })
  }, [load])

  useEffect(() => {
    void client.listProjects().then((result) => {
      if (!result.ok) return
      const rows = (result.value as { projects: { project_id: string; name: string }[] }).projects
      setProjects(rows)
      setDraftProject(current => (current === '' ? (rows[0]?.project_id ?? '') : current))
    }).catch(() => undefined)
  }, [])

  const createTask = useCallback(async () => {
    if (draftTitle.trim() === '' || draftProject === '') return
    const result = await client.createTask({ project_id: draftProject, title: draftTitle.trim(), status: 'backlog' })
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setDraftTitle('')
    setCreating(false)
    await load()
  }, [draftTitle, draftProject, load])

  if (selected !== null) return <TaskDetail id={selected} onBack={() => { setSelected(null) }} />

  return (
    <div className="ao-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务管理</h1>
          <p className="ao-page-description">AgentOps 任务的看板视图。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setCreating(value => !value) }}>
            {creating ? '取消' : '新建任务'}
          </button>
          <span className="ao-count">
            {state === 'loading' ? '加载中…' : state === 'error' ? '读取失败' : `共 ${tasks.length} 个任务`}
          </span>
        </div>
      </header>

      {creating && (
        <div className="card" style={{ padding: 12, display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select className="input-base" value={draftProject} onChange={(event) => { setDraftProject(event.target.value) }}>
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>{project.name}</option>
            ))}
          </select>
          <input
            className="input-base"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="任务标题"
            value={draftTitle}
            onChange={(event) => { setDraftTitle(event.target.value) }}
          />
          <button type="button" className="btn-primary btn-sm" onClick={() => { void createTask() }}>创建</button>
        </div>
      )}

      {state === 'error' && (
        <div style={{
          padding: '10px 12px', border: '1px solid rgba(239,68,68,.4)',
          background: 'rgba(239,68,68,.12)', color: 'var(--state-error)', borderRadius: 8, fontSize: 12,
        }}>
          无法读取任务：{error}
        </div>
      )}

      {state !== 'error' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, alignItems: 'start' }}>
          {LANES.map((lane) => {
            const items = tasks.filter(task => lane.statuses.includes(task.status))
            return (
              <section key={lane.title} style={{
                background: 'var(--color-bg-base)', border: '1px solid #1e293b', borderRadius: 8, padding: 9,
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 11, fontWeight: 550, color: 'var(--color-text-secondary)', padding: '2px 3px 9px',
                }}>
                  <span>{lane.title}</span>
                  <span style={{ fontSize: 10, background: 'var(--color-border-subtle)', padding: '1px 5px', borderRadius: 3 }}>
                    {items.length}
                  </span>
                </div>
                {items.map(task => (
                  <TaskCard key={task.taskId} task={task} onOpen={() => { setSelected(task.taskId) }} />
                ))}
                {items.length === 0 && state === 'ready' && (
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', padding: '8px 3px' }}>暂无任务</div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <footer style={{ marginTop: 14, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
        数据来自 v1 任务面（`/api/agentops/task-rpc` 桥接，只读）；推进通过同一路由提交，需用户确认的边不会被模型自动批准。
      </footer>
    </div>
  )
}

interface TaskDetailPayload {
  task: TaskRecord & { riskLevel: string }
  stages: { seq: number; name: string; status: string; note?: string; enteredAt: string }[]
  events: { seq: number; kind: string; fromStatus?: string; toStatus?: string; actor: string; reason?: string; at: string }[]
  allowed: { to: string; action: string; requiresUser: boolean }[]
}

/** 任务详情：阶段、事件、验收标准、评论与报告文档。 */
export function TaskDetail({ id, onBack }: { id: string; onBack: () => void }): ReactElement {
  const [data, setData] = useState<TaskDetailPayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [criteria, setCriteria] = useState<{ criterion_id: string; description: string; status: string }[]>([])
  const [comments, setComments] = useState<{ comment_id: string; body: string; created_at: string }[]>([])
  const [reports, setReports] = useState<{ report_id: string; status: string; created_at: string }[]>([])
  const [document, setDocument] = useState('')
  const [runs, setRuns] = useState<{ linkId: string; role: string; status: string; linkedAt: string }[]>([])
  const [draftCriterion, setDraftCriterion] = useState('')
  const [draftComment, setDraftComment] = useState('')
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [draftReport, setDraftReport] = useState('')

  const load = useCallback(() => {
    let cancelled = false
    void client.getTask(id).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setData(result.value as TaskDetailPayload)
    }).catch((reason: unknown) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [id])

  useEffect(() => load(), [load])

  const loadDetail = useCallback(async () => {
    const [criterionList, commentList, reportList, runList] = await Promise.all([
      client.listCriteria(id),
      client.listComments(id),
      client.listReports(id),
      client.listRuns(id),
    ])
    if (criterionList.ok) {
      setCriteria((criterionList.value as { criteria: { criterion_id: string; description: string; status: string }[] }).criteria)
    }
    if (commentList.ok) {
      setComments((commentList.value as { comments: { comment_id: string; body: string; created_at: string }[] }).comments)
    }
    if (reportList.ok) {
      setReports((reportList.value as { reports: { report_id: string; status: string; created_at: string }[] }).reports)
    }
    if (runList.ok) {
      setRuns((runList.value as { runs: { linkId: string; role: string; status: string; linkedAt: string }[] }).runs)
    }
  }, [id])

  useEffect(() => {
    void loadDetail().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [loadDetail])

  const freshVersion = useCallback(async (): Promise<number | undefined> => {
    const result = await client.getTask(id)
    return result.ok ? (result.value as TaskDetailPayload).task.version : undefined
  }, [id])

  const addCriterion = useCallback(async () => {
    if (draftCriterion.trim() === '') return
    const result = await client.addCriterion(id, { description: draftCriterion.trim(), if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    setDraftCriterion('')
    await loadDetail()
  }, [draftCriterion, id, data, loadDetail])

  const addComment = useCallback(async () => {
    if (draftComment.trim() === '') return
    const result = await client.addComment(id, { body: draftComment.trim(), if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    setDraftComment('')
    await loadDetail()
  }, [draftComment, id, data, loadDetail])

  const openReport = useCallback(async (reportId: string) => {
    const result = await client.getReportDocument(id, reportId)
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    const payload = result.value as { export: { content?: string } }
    setDocument(payload.export.content ?? '')
  }, [id])

  const exportReport = useCallback(async (reportId: string) => {
    const result = await client.exportReport(id, reportId)
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    await openReport(reportId)
  }, [id, openReport])

  const claim = useCallback(async () => {
    const result = await client.claimTask(id, { thread_id: `web:${id}`, if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    await loadDetail()
  }, [id, data, loadDetail])

  const startRun = useCallback(async () => {
    const version = await freshVersion()
    if (version === undefined) {
      setNotice('无法读取最新任务版本')
      return
    }
    const response = await fetch('/api/agentops/task-execute', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_id: id,
        if_version: version,
        role: 'main_execution',
        idempotency_key: `web-${id}-${Date.now().toString(36)}`,
      }),
    })
    const result = await response.json() as {
      ok?: boolean
      code?: string
      message?: string
      sessionId?: string
      execution?: { agentPreset?: string; workspaceId?: string; leaseId?: string }
    }
    if (!response.ok || result.ok !== true) {
      setNotice(`${result.code ?? `http_${response.status}`}: ${result.message ?? response.statusText}`)
      return
    }
    setNotice(`执行已启动 · ${result.execution?.agentPreset ?? 'agent'} · ${result.execution?.workspaceId ?? 'workspace'} · session ${result.sessionId ?? ''}`)
    await loadDetail()
  }, [id, freshVersion, loadDetail])

  const finishRun = useCallback(async (runId: string) => {
    const result = await client.finishRun(id, runId, { status: 'succeeded' })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    await loadDetail()
  }, [id, loadDetail])

  const markCriterion = useCallback(async (criterionId: string, status: 'passed' | 'failed') => {
    const result = await client.setCriterionStatus(id, criterionId, { status, if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    await loadDetail()
  }, [id, data, loadDetail])

  const reviewReport = useCallback(async (reportId: string, decision: 'approve' | 'request_changes') => {
    const comment = window.prompt(decision === 'approve' ? '审批意见' : '退回原因', decision === 'approve' ? '验收通过' : '')
    if (comment === null || comment.trim() === '') return
    const result = await client.reviewReport(id, reportId, { decision, comment: comment.trim(), if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    await loadDetail()
  }, [id, data, loadDetail])

  const saveEdit = useCallback(async () => {
    const result = await client.updateTask(id, {
      patch: { title: editTitle.trim(), description: editDescription },
      if_version: await freshVersion(),
    })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    setEditing(false)
    load()
    await loadDetail()
  }, [id, editTitle, editDescription, data, load, loadDetail])

  const submitReport = useCallback(async () => {
    if (draftReport.trim() === '') return
    const result = await client.submitReport(id, { content: draftReport.trim(), if_version: await freshVersion() })
    if (!result.ok) {
      setNotice(`${result.error.code}: ${result.error.message}`)
      return
    }
    setDraftReport('')
    await loadDetail()
  }, [id, draftReport, data, loadDetail])

  const advance = useCallback(async (item: { to: string; action: string; requiresUser: boolean }) => {
    if (item.requiresUser && !window.confirm(`该转移需要你确认：${item.action}\n\n确认推进到「${item.to}」？`)) return
    setBusy(item.to)
    setNotice('')
    try {
      const result = await client.advanceTask(id, {
        target_status: item.to,
        if_version: await freshVersion(),
      })
      setNotice(result.ok
        ? `已推进到 ${STATUS_LABEL[item.to] ?? item.to}`
        : `未推进：${result.error.code} ${result.error.message}`)
      if (result.ok) load()
    } catch (reason) {
      setNotice(`请求失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy('')
    }
  }, [data, id, load])

  return (
    <div className="ao-page agentops-surface">
      <button type="button" className="btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>← 返回看板</button>
      {error !== '' && <div style={{ color: 'var(--state-error)' }}>加载失败：{error}</div>}
      {data === null && error === '' && <div style={{ color: 'var(--color-text-secondary)' }}>加载中…</div>}
      {data !== null && (
        <>
          {!editing && <h1 className="ao-page-title">{data.task.title}</h1>}
          {editing && (
            <div className="card" style={{ padding: 12, display: 'grid', gap: 8, marginBottom: 12 }}>
              <input
                className="input-base"
                value={editTitle}
                placeholder={data.task.title}
                onChange={(event) => { setEditTitle(event.target.value) }}
              />
              <textarea
                className="input-base"
                style={{ minHeight: 72 }}
                value={editDescription}
                placeholder={data.task.description}
                onChange={(event) => { setEditDescription(event.target.value) }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn-primary btn-sm" onClick={() => { void saveEdit() }}>保存</button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => { setEditing(false) }}>取消</button>
              </div>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 18 }}>
            {data.task.taskId} · v{data.task.version} · 风险 {data.task.riskLevel} · 状态 {STATUS_LABEL[data.task.status] ?? data.task.status}
            <button
              type="button"
              className="btn-secondary btn-sm"
              style={{ marginLeft: 10 }}
              onClick={() => {
                setEditTitle(data.task.title)
                setEditDescription(data.task.description)
                setEditing(value => !value)
              }}
            >
              {editing ? '取消编辑' : '编辑'}
            </button>
          </div>
          {data.task.description !== '' && (
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7, marginBottom: 18 }}>{data.task.description}</p>
          )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>阶段时间线</h2>
          {data.stages.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>尚无阶段记录</div>
            : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
                {data.stages.map(stage => (
                  <span key={stage.seq} className="status-pill status-pill-neutral" style={{ fontSize: 10 }}>
                    {stage.seq}. {stage.name} · {stage.status}
                  </span>
                ))}
              </div>
            )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>允许的下一步</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {data.allowed.length === 0
              ? <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>终态，无可用转移</span>
              : data.allowed.map(item => (
                <button
                  key={item.to}
                  type="button"
                  className={`btn-sm ${item.requiresUser ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busy !== ''}
                  onClick={() => { void advance(item) }}
                  title={item.action}
                >
                  {busy === item.to ? '处理中…' : `${item.action} → ${STATUS_LABEL[item.to] ?? item.to}`}
                  {item.requiresUser ? '（需确认）' : ''}
                </button>
              ))}
          </div>
          {notice !== '' && (
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10 }}>{notice}</div>
          )}
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>
            页面直接写库（actor 记为 web-ui）；需用户确认的边会先弹确认框，取消则不发送。
          </div>

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>事件流</h2>
          <table className="data-table">
            <thead><tr><th>#</th><th>类型</th><th>变更</th><th>操作者</th><th>原因</th><th>时间</th></tr></thead>
            <tbody>
              {data.events.map(event => (
                <tr key={event.seq}>
                  <td className="font-mono">{event.seq}</td>
                  <td className="font-mono">{event.kind}</td>
                  <td className="font-mono">{event.fromStatus === undefined ? '—' : `${event.fromStatus} → ${event.toStatus ?? '?'}`}</td>
                  <td className="font-mono">{event.actor}</td>
                  <td className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>{event.reason ?? '—'}</td>
                  <td className="font-mono">{event.at.slice(0, 19).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>验收标准</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              className="input-base"
              style={{ flex: 1 }}
              placeholder="新增一条验收标准"
              value={draftCriterion}
              onChange={(event) => { setDraftCriterion(event.target.value) }}
            />
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void addCriterion() }}>添加</button>
          </div>
          {criteria.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>尚无验收标准</div>
            : (
              <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12 }}>
                {criteria.map(item => (
                  <li key={item.criterion_id}>
                    {item.description} <span className="font-mono" style={{ fontSize: 10 }}>[{item.status}]</span>
                    <button type="button" className="btn-secondary btn-sm" style={{ marginLeft: 8 }} onClick={() => { void markCriterion(item.criterion_id, 'passed') }}>通过</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { void markCriterion(item.criterion_id, 'failed') }}>不通过</button>
                  </li>
                ))}
              </ul>
            )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>评论</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <textarea
              className="input-base"
              style={{ flex: 1, minHeight: 56 }}
              placeholder="写一条评论"
              value={draftComment}
              onChange={(event) => { setDraftComment(event.target.value) }}
            />
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void addComment() }}>发表</button>
          </div>
          {comments.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>还没有评论</div>
            : (
              <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12 }}>
                {comments.map(item => (
                  <li key={item.comment_id}>
                    {item.body}
                    <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}> · {item.created_at.slice(0, 16).replace('T', ' ')}</span>
                  </li>
                ))}
              </ul>
            )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>报告文档</h2>
          {reports.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>尚无正式报告</div>
            : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {reports.map(report => (
                  <span key={report.report_id} style={{ display: 'inline-flex', gap: 4 }}>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { void openReport(report.report_id) }}>
                      {report.report_id}（{report.status}）
                    </button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { void reviewReport(report.report_id, 'approve') }}>通过</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { void reviewReport(report.report_id, 'request_changes') }}>退回</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => { void exportReport(report.report_id) }}>生成文档</button>
                  </span>
                ))}
              </div>
            )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <textarea
              className="input-base"
              style={{ flex: 1, minHeight: 56 }}
              placeholder="提交一份正式报告…"
              value={draftReport}
              onChange={(event) => { setDraftReport(event.target.value) }}
            />
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void submitReport() }}>提交报告</button>
          </div>
          {document !== '' && (
            <pre style={{ fontSize: 11, lineHeight: 1.6, background: 'var(--color-bg-base)', padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: 360 }}>
              {document}
            </pre>
          )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>执行记录</h2>
          {data.task.status === 'backlog' || data.task.status === 'in_progress' ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button type="button" className="btn-secondary btn-sm" onClick={() => { void claim() }}>认领任务</button>
              <button type="button" className="btn-primary btn-sm" onClick={() => { void startRun() }}>开始执行</button>
            </div>
          ) : null}
          {runs.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>尚无执行绑定</div>
            : (
              <table className="data-table">
                <thead><tr><th>运行</th><th>角色</th><th>状态</th><th>绑定时间</th><th>操作</th></tr></thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.linkId}>
                      <td className="font-mono">{run.linkId}</td>
                      <td className="font-mono">{run.role}</td>
                      <td className="font-mono">{run.status}</td>
                      <td className="font-mono">{run.linkedAt.slice(0, 19).replace('T', ' ')}</td>
                      <td>
                        {run.status === 'pending' || run.status === 'running' ? (
                          <button type="button" className="btn-secondary btn-sm" onClick={() => { void finishRun(run.linkId) }}>完成执行</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </>
      )}
    </div>
  )
}

function TaskCard({ task, onOpen }: { task: TaskRecord; onOpen: () => void }): ReactElement {
  const risk = task.riskLevel === 'high' ? 'var(--state-error)' : task.riskLevel === 'low' ? 'var(--state-success)' : 'var(--state-warning)'
  return (
    <article
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen() }}
      style={{
        background: 'var(--color-bg-surface)', border: '1px solid #1e293b', borderRadius: 4,
        padding: 10, marginBottom: 8, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 9 }}>
        <span style={{ color: risk, border: `1px solid ${risk}55`, borderRadius: 3, padding: '0 4px' }}>
          {task.riskLevel}
        </span>
        <span style={{ color: 'var(--color-text-tertiary)' }}>{STATUS_LABEL[task.status] ?? task.status}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }}>v{task.version}</span>
      </div>
      <h4 style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.55, margin: '6px 0 6px' }}>{task.title}</h4>
      {task.description !== '' && (
        <p style={{
          fontSize: 9.5, color: 'var(--color-text-secondary)', lineHeight: 1.55, margin: '0 0 7px',
          display: '-webkit-box', WebkitLineClamp: 2, overflow: 'hidden', maxHeight: 30,
        }}>{task.description}</p>
      )}
      <div style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{task.updatedAt.slice(0, 16).replace('T', ' ')}</div>
    </article>
  )
}

export function AgentOpsIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="m8 9 2 2 4-4M8 15h8" />
    </svg>
  )
}
