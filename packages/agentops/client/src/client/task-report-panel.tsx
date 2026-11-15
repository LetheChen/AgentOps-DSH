/**
 * Task report page: an aggregate view over one task's stages and events.
 *
 * Deliberately labelled `generated: false` — this is computed from the task
 * store, not written by a model. Calling it a "report" without that caveat
 * would overstate what the page does.
 */

import { useEffect, useState, type ReactElement } from 'react'

import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()


interface TaskRecord {
  id: string
  title: string
  status: string
  riskLevel: string
  version: number
  createdAt: string
  updatedAt: string
}

interface Stage {
  seq: number
  name: string
  status: string
  note?: string
  enteredAt: string
}

interface Event {
  seq: number
  kind: string
  fromStatus?: string
  toStatus?: string
  actor: string
  reason?: string
  at: string
}

interface Report {
  task: TaskRecord
  stages: Stage[]
  events: Event[]
  summary: {
    durationMs: number
    stageCount: number
    eventCount: number
    transitions: { from: string; to: string; at: string; actor: string }[]
    actors: string[]
    reachedStatuses: string[]
  }
  generated: boolean
}

/** Task detail as the v1 surface returns it. */
interface TaskDetailPayload {
  task: TaskRecord & { createdAt: string; updatedAt: string }
  stages: Stage[]
  events: Event[]
}

/**
 * Fold one task detail into the aggregate view.
 * @param detail - task, stages and events.
 * @returns the computed report; `generated` stays false because no model wrote it.
 */
function toReport(detail: TaskDetailPayload): Report {
  const events = detail.events
  const transitions = events
    .filter(event => event.kind === 'advanced')
    .map(event => ({ from: event.fromStatus ?? '?', to: event.toStatus ?? '?', actor: event.actor, at: event.at }))
  const first = events[0]?.at ?? detail.task.createdAt
  const last = events[events.length - 1]?.at ?? detail.task.updatedAt
  return {
    task: detail.task,
    stages: detail.stages,
    events,
    summary: {
      durationMs: Math.max(0, Date.parse(last) - Date.parse(first)),
      stageCount: detail.stages.length,
      eventCount: events.length,
      transitions,
      actors: [...new Set(events.map(event => event.actor))].sort(),
      reachedStatuses: [...new Set(transitions.map(row => row.to))],
    },
    generated: false,
  }
}

export function TaskReportPanel(): ReactElement {
  const [tasks, setTasks] = useState<{ taskId: string; title: string; status: string }[]>([])
  const [selected, setSelected] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')


  useEffect(() => {
    let cancelled = false
    void client.listTasks().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        setLoading(false)
        return
      }
      const value = result.value as { tasks: { taskId: string; title: string; status: string }[] }
      setTasks(value.tasks)
      setSelected(value.tasks[0]?.taskId ?? '')
      setLoading(false)
    }).catch((reason: unknown) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (selected === '') return
    let cancelled = false
    void client.getTask(selected).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setReport(toReport(result.value as TaskDetailPayload))
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [selected])

  if (loading) return <div className="card" style={{ padding: 40, textAlign: 'center' }}>加载中…</div>
  if (error !== '') return <div className="card" style={{ padding: 40, color: 'var(--state-error)' }}>加载失败：{error}</div>
  if (tasks.length === 0) return <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>暂无任务</div>

  return (
    <div className="ao-page agentops-surface">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <select
          className="input-base"
          style={{ maxWidth: 420 }}
          value={selected}
          onChange={(event) => { setSelected(event.target.value) }}
        >
          {tasks.map(task => (
            <option key={task.taskId} value={task.taskId}>{task.title}（{task.status}）</option>
          ))}
        </select>
        <span className="status-pill status-pill-neutral">
          {report === null ? '—' : `${report.summary.eventCount} 事件 / ${report.summary.stageCount} 阶段`}
        </span>
      </div>

      {report !== null && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="状态" value={report.task.status} />
            <Stat label="风险" value={report.task.riskLevel} />
            <Stat label="版本" value={`v${report.task.version}`} />
            <Stat label="持续" value={formatDuration(report.summary.durationMs)} />
            <Stat label="参与方" value={report.summary.actors.join(', ') || '—'} />
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>状态流转</div>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr><th>从</th><th>到</th><th>操作者</th><th>时间</th></tr></thead>
              <tbody>
                {report.summary.transitions.map((row, index) => (
                  <tr key={`${row.at}-${index}`}>
                    <td className="font-mono" style={{ fontSize: 11 }}>{row.from}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>{row.to}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>{row.actor}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>{row.at.slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
                {report.summary.transitions.length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>尚无状态流转</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>阶段</div>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr><th>#</th><th>阶段</th><th>状态</th><th>备注</th><th>进入时间</th></tr></thead>
              <tbody>
                {report.stages.map(stage => (
                  <tr key={stage.seq}>
                    <td className="font-mono" style={{ fontSize: 11 }}>{stage.seq}</td>
                    <td style={{ fontSize: 12 }}>{stage.name}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>{stage.status}</td>
                    <td className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{stage.note ?? '—'}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>{stage.enteredAt.slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
                {report.stages.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>尚无阶段记录</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            本页为聚合视图（generated: false）：数据来自任务库的阶段与事件，不是模型撰写的报告。
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }): ReactElement {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 14 }}>{value}</div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

export function TaskReportIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3h9l5 5v13H6z" strokeLinejoin="round" />
      <path d="M9 13h6M9 17h4" strokeLinecap="round" />
    </svg>
  )
}
