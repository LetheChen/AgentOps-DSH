/**
 * Task dashboard, list and Gantt views.
 *
 * All three read the v1 surface through {@link createTaskRpcClient}: the
 * dashboard uses status/risk counts, the list renders the task table, and the
 * Gantt derives bars from `createdAt`/`updatedAt` because tasks carry no
 * planned dates yet.
 *
 * @module @agentops/dsh-client/task-views
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'

import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()

interface TaskRecord {
  taskId: string
  title: string
  status: string
  riskLevel: string
  version: number
  createdAt: string
  updatedAt: string
}

interface CountRow {
  status?: string
  risk_level?: string
  count: number
}

/**
 * Render status and risk counts.
 * @returns the dashboard panel.
 */
export function DashboardPanel(): ReactElement {
  const [statusRows, setStatusRows] = useState<CountRow[]>([])
  const [riskRows, setRiskRows] = useState<CountRow[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void client.getDashboard().then((result) => {
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const value = result.value as { byStatus: CountRow[]; byRisk: CountRow[] }
      setStatusRows(value.byStatus)
      setRiskRows(value.byRisk)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  const total = statusRows.reduce((sum, row) => sum + row.count, 0)
  const max = Math.max(1, ...statusRows.map(row => row.count))

  return (
    <div className="ao-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务仪表盘</h1>
          <p className="ao-page-description">按状态与风险统计当前任务。</p>
        </div>
      </header>
      {error !== '' && <p style={{ color: 'var(--state-error)', fontSize: 12 }} role="alert">{error}</p>}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>共 {total} 个任务</div>
        {statusRows.length === 0 ? <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>暂无任务</p> : null}
        {statusRows.map(row => (
          <div key={row.status ?? 'unknown'} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ width: 90, fontSize: 11, color: 'var(--color-text-secondary)' }}>{row.status ?? '—'}</span>
            <div style={{ flex: 1, height: 10, background: 'var(--color-border-subtle)', borderRadius: 5 }}>
              <div style={{ width: `${Math.round((row.count / max) * 100)}%`, height: '100%', borderRadius: 5, background: 'var(--color-accent)' }} />
            </div>
            <span style={{ width: 32, textAlign: 'right', fontSize: 11 }}>{row.count}</span>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>按风险</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {riskRows.map(row => (
            <div key={row.risk_level ?? 'unknown'}>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{row.risk_level ?? '—'}</div>
              <div className="font-mono" style={{ fontSize: 18 }}>{row.count}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Render the task table.
 * @returns the list panel.
 */
export function TaskListPanel(): ReactElement {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void client.listTasks().then((result) => {
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setTasks((result.value as { tasks: TaskRecord[] }).tasks)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  const shown = useMemo(
    () => tasks.filter(task => task.title.toLowerCase().includes(filter.trim().toLowerCase())),
    [tasks, filter],
  )

  return (
    <div className="ao-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务列表</h1>
          <p className="ao-page-description">全部任务及其状态、风险与版本。</p>
        </div>
      </header>
      {error !== '' && <p style={{ color: 'var(--state-error)', fontSize: 12 }} role="alert">{error}</p>}
      <input
        className="input-base"
        placeholder="按标题筛选"
        value={filter}
        onChange={(event) => { setFilter(event.target.value) }}
        style={{ maxWidth: 320, marginBottom: 12 }}
      />
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr><th>标题</th><th>状态</th><th>风险</th><th>版本</th><th>更新</th></tr>
        </thead>
        <tbody>
          {shown.map(task => (
            <tr key={task.taskId}>
              <td style={{ fontSize: 12 }}>{task.title}</td>
              <td className="font-mono" style={{ fontSize: 11 }}>{task.status}</td>
              <td className="font-mono" style={{ fontSize: 11 }}>{task.riskLevel}</td>
              <td className="font-mono" style={{ fontSize: 11 }}>v{task.version}</td>
              <td className="font-mono" style={{ fontSize: 11 }}>{task.updatedAt.slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>没有匹配的任务</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Render a simple Gantt chart derived from task timestamps.
 * @returns the Gantt panel.
 */
export function GanttPanel(): ReactElement {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void client.listTasks().then((result) => {
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setTasks((result.value as { tasks: TaskRecord[] }).tasks)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  const span = useMemo(() => {
    if (tasks.length === 0) return null
    const starts = tasks.map(task => Date.parse(task.createdAt))
    const ends = tasks.map(task => Date.parse(task.updatedAt))
    const min = Math.min(...starts)
    const max = Math.max(...ends)
    return { min, max: max === min ? min + 3_600_000 : max }
  }, [tasks])

  return (
    <div className="ao-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">任务甘特图</h1>
          <p className="ao-page-description">任务缺少计划日期，条形按创建到最近更新的时间跨度绘制。</p>
        </div>
      </header>
      {error !== '' && <p style={{ color: 'var(--state-error)', fontSize: 12 }} role="alert">{error}</p>}
      {span === null ? <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>暂无任务</p> : null}
      {span !== null ? (
        <div className="card" style={{ padding: 16 }}>
          {tasks.map((task) => {
            const start = Date.parse(task.createdAt)
            const end = Date.parse(task.updatedAt)
            const left = ((start - span.min) / (span.max - span.min)) * 100
            const width = Math.max(1.5, ((end - start) / (span.max - span.min)) * 100)
            return (
              <div key={task.taskId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ width: 220, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.title}
                </span>
                <div style={{ position: 'relative', flex: 1, height: 14, background: 'var(--color-border-subtle)', borderRadius: 7 }}>
                  <div style={{
                    position: 'absolute', left: `${Math.min(99, left)}%`, width: `${Math.min(100 - left, width)}%`,
                    height: '100%', borderRadius: 7, background: task.riskLevel === 'high' ? '#c084fc' : 'var(--color-accent)',
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** @param props - icon size in pixels. @returns the dashboard glyph. */
export function DashboardIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="12" width="4" height="8" rx="1" /><rect x="10" y="6" width="4" height="14" rx="1" /><rect x="16" y="9" width="4" height="11" rx="1" />
    </svg>
  )
}

/** @param props - icon size in pixels. @returns the list glyph. */
export function TaskListIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
    </svg>
  )
}

/** @param props - icon size in pixels. @returns the Gantt glyph. */
export function GanttIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="10" height="3" rx="1.5" /><rect x="7" y="11" width="13" height="3" rx="1.5" /><rect x="5" y="17" width="8" height="3" rx="1.5" />
    </svg>
  )
}
