/**
 * Log collection tab: task registry, SSH binding, retention and run history.
 *
 * Mirrors the original AgentOps log-collection page. The local directory is
 * derived from the task id and never typed by the operator.
 *
 * @module @agentops/dsh-ui-capability/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import { createLogCollectionApi, type LogCollectionRpcResult } from './log-collection-api.ts'
import { zh as copy } from './locales.ts'

/** One SSH instance a task may reference. */
interface SshInstanceOption {
  readonly instance_id: string
  readonly name: string
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly host: string
  readonly port: number | null
  readonly username: string
  readonly credential_configured: boolean
  readonly host_key_pinned: boolean
}

/** One log collection task as the control plane projects it. */
interface LogTask {
  readonly task_id: string
  readonly name: string
  readonly owner_domain: string
  readonly ssh_instance_id: string
  readonly remote_paths: readonly string[]
  readonly storage_key: string
  readonly local_subdir: string
  /** Absolute directory resolved from the collection root and the subdirectory. */
  readonly local_dir: string
  readonly local_max_days: number
  readonly enabled: boolean
  readonly revision: number
  readonly created_at: string
  readonly updated_at: string
}

/** One recorded pull run. */
interface LogRun {
  readonly runId: string
  readonly taskId: string
  readonly status: 'succeeded' | 'failed'
  readonly origin: 'manual' | 'tool' | 'schedule'
  readonly finishedAt: string
  readonly elapsedMs: number
  readonly fileCount: number
  readonly byteCount: number
  readonly errorMessage: string | null
}

interface ScheduleSummary {
  readonly id: string
  readonly name: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone: string
  readonly enabled: boolean
}

interface Draft {
  readonly taskId?: string
  readonly revision?: number
  readonly id: string
  readonly name: string
  readonly sshInstanceId: string
  readonly remotePathsText: string
  readonly localSubdir: string
  readonly localMaxDays: string
  readonly enabled: boolean
}

/** Shorten a byte count for the table. */
function bytesText(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function timeText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function originText(origin: LogRun['origin']): string {
  if (origin === 'schedule') return '定时计划'
  if (origin === 'tool') return 'Agent 工具'
  return '手动触发'
}

function errorOf(result: LogCollectionRpcResult): string | null {
  return result.ok ? null : `${result.error.code}: ${result.error.message}`
}

function newDraft(sshInstances: readonly SshInstanceOption[]): Draft {
  return {
    id: '',
    name: '',
    sshInstanceId: sshInstances[0]?.instance_id ?? '',
    remotePathsText: '',
    localSubdir: '',
    localMaxDays: '30',
    enabled: true,
  }
}

/** Render the log collection tab. */
export function LogCollectionTab(): ReactElement {
  // Memoized: a fresh client each render would re-create `load` and loop forever.
  const api = useMemo(() => createLogCollectionApi(), [])
  const [tasks, setTasks] = useState<readonly LogTask[]>([])
  const [sshInstances, setSshInstances] = useState<readonly SshInstanceOption[]>([])
  const [runs, setRuns] = useState<readonly LogRun[]>([])
  const [schedules, setSchedules] = useState<readonly ScheduleSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [copiedPath, setCopiedPath] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const [taskResult, runResult, scheduleResult] = await Promise.all([
      api.list(),
      api.listRuns(),
      fetch('/api/agentops/schedules', { credentials: 'include' })
        .then(async response => response.ok ? await response.json() as { entries?: ScheduleSummary[] } : { entries: [] })
        .catch(() => ({ entries: [] as ScheduleSummary[] })),
    ])
    setLoading(false)
    const firstError = errorOf(taskResult) ?? errorOf(runResult)
    if (firstError !== null) {
      setError(firstError)
      return
    }
    if (taskResult.ok) {
      const value = taskResult.value as { tasks?: LogTask[]; ssh_instances?: SshInstanceOption[] }
      setTasks(value.tasks ?? [])
      setSshInstances(value.ssh_instances ?? [])
    }
    if (runResult.ok) {
      setRuns((runResult.value as { runs?: LogRun[] }).runs ?? [])
    }
    setSchedules(scheduleResult.entries ?? [])
  }, [api])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => { void load() }, 15_000)
    return () => { window.clearInterval(timer) }
  }, [autoRefresh, load])

  const latestByTask = useMemo(() => {
    const latest = new Map<string, LogRun>()
    for (const run of runs) {
      if (!latest.has(run.taskId)) latest.set(run.taskId, run)
    }
    return latest
  }, [runs])

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tasks.filter((task) => {
      if (statusFilter === 'enabled' && !task.enabled) return false
      if (statusFilter === 'disabled' && task.enabled) return false
      if (needle === '') return true
      return [task.task_id, task.name, task.ssh_instance_id, task.local_dir, ...task.remote_paths]
        .some(value => value.toLowerCase().includes(needle))
    })
  }, [query, statusFilter, tasks])

  const summary = useMemo(() => ({
    tasks: tasks.length,
    enabled: tasks.filter(task => task.enabled).length,
    succeeded: runs.filter(run => run.status === 'succeeded').length,
    failed: runs.filter(run => run.status === 'failed').length,
    bytes: runs.reduce((sum, run) => sum + run.byteCount, 0),
    successRate: runs.length === 0 ? null : Math.round(runs.filter(run => run.status === 'succeeded').length / runs.length * 100),
    avgElapsed: runs.length === 0 ? null : Math.round(runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length),
    latestFailure: runs.find(run => run.status === 'failed') ?? null,
  }), [runs, tasks])

  const save = async (): Promise<void> => {
    if (draft === null) return
    const remotePaths = draft.remotePathsText.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (draft.name.trim() === '') { setDraftError(copy['logs.error.name']); return }
    if (draft.sshInstanceId === '') { setDraftError(copy['logs.error.ssh']); return }
    if (remotePaths.length === 0) { setDraftError(copy['logs.error.paths']); return }
    setBusy('save')
    const body = {
      ...(draft.taskId === undefined ? { task_id: draft.id.trim() } : {}),
      ...(draft.revision === undefined ? {} : { expected_revision: draft.revision }),
      name: draft.name.trim(),
      ssh_instance_id: draft.sshInstanceId,
      remote_paths: remotePaths,
      local_subdir: draft.localSubdir.trim(),
      local_max_days: Number.parseInt(draft.localMaxDays, 10) || 0,
      enabled: draft.enabled,
    }
    const result = draft.taskId === undefined ? await api.create(body) : await api.update(draft.taskId, body)
    setBusy('')
    if (!result.ok) { setDraftError(errorOf(result) ?? copy['logs.error.save']); return }
    setDraft(null)
    setNotice(copy['logs.saved'])
    await load()
  }

  const remove = async (task: LogTask): Promise<void> => {
    if (!window.confirm(copy['logs.confirm.delete'].replace('{name}', task.name))) return
    setBusy(task.task_id)
    const result = await api.remove(task.task_id)
    setBusy('')
    if (!result.ok) { setError(errorOf(result) ?? copy['logs.error.delete']); return }
    await load()
  }

  const runNow = async (task: LogTask): Promise<void> => {
    setBusy(task.task_id)
    setNotice(null)
    const result = await api.runNow(task.task_id)
    setBusy('')
    if (!result.ok) {
      setError(errorOf(result) ?? copy['logs.error.run'])
    } else {
      const value = result.value as { files?: { bytes: number }[] }
      const files = value.files ?? []
      setNotice(copy['logs.ran']
        .replace('{files}', String(files.length))
        .replace('{bytes}', bytesText(files.reduce((sum, file) => sum + file.bytes, 0))))
    }
    await load()
  }

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      window.setTimeout(() => { setCopiedPath(current => current === path ? '' : current) }, 1500)
    } catch {
      setError(copy['logs.error.clipboard'])
    }
  }

  return (
    <div className="ao-capability-logpanel">
      {error === null ? null : <div className="ao-capability-error">{error}</div>}
      {notice === null ? null : <div className="ao-capability-notice">{notice}</div>}

      <section className="ao-capability-section ao-log-hero">
        <div className="ao-capability-loghead">
          <div>
            <h2>{copy['logs.title']}</h2>
            <p className="ao-capability-muted">{copy['logs.description']}</p>
          </div>
          <div className="ao-log-head-actions">
            <label className="ao-capability-checkbox-row">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => { setAutoRefresh(event.target.checked) }} />
              <span>{copy['logs.autoRefresh']}</span>
            </label>
            <button type="button" className="ao-capability-btn secondary sm" onClick={() => { void load() }}>{copy['logs.refresh']}</button>
            <button type="button" className="ao-capability-btn primary" onClick={() => { setDraft(newDraft(sshInstances)); setDraftError(null) }}>{copy['logs.new']}</button>
          </div>
        </div>

        <div className="ao-log-summary">
          <div><span>{copy['logs.stat.tasks']}</span><strong>{summary.tasks}</strong></div>
          <div><span>{copy['logs.stat.enabled']}</span><strong>{summary.enabled}</strong></div>
          <div><span>{copy['logs.stat.success']}</span><strong>{summary.succeeded}</strong></div>
          <div><span>{copy['logs.stat.failed']}</span><strong className={summary.failed > 0 ? 'is-error' : ''}>{summary.failed}</strong></div>
          <div><span>{copy['logs.stat.bytes']}</span><strong>{bytesText(summary.bytes)}</strong></div>
        </div>

        <div className="ao-log-toolbar">
          <input className="input-base" value={query} placeholder={copy['logs.search']} onChange={(event) => { setQuery(event.target.value) }} />
          <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as 'all' | 'enabled' | 'disabled') }}>
            <option value="all">{copy['logs.filter.all']}</option>
            <option value="enabled">{copy['logs.filter.enabled']}</option>
            <option value="disabled">{copy['logs.filter.disabled']}</option>
          </select>
          <span className="ao-capability-muted">显示 {filteredTasks.length} / {tasks.length}</span>
        </div>

        {loading ? <div className="ao-capability-state">{copy['loading']}</div>
          : tasks.length === 0 ? <div className="ao-capability-state">{copy['logs.empty']}</div>
            : filteredTasks.length === 0 ? <div className="ao-capability-state">没有符合筛选条件的采集任务。</div>
              : (
                <div className="ao-capability-table-wrap ao-log-table-wrap">
                  <table className="ao-capability-table ao-log-table">
                    <thead>
                      <tr>
                        <th>{copy['logs.col.task']}</th>
                        <th>{copy['logs.col.ssh']}</th>
                        <th>{copy['logs.col.paths']}</th>
                        <th>{copy['logs.col.local']}</th>
                        <th>{copy['logs.lastRun']}</th>
                        <th>{copy['logs.col.retention']} / {copy['logs.col.status']}</th>
                        <th>{copy['logs.col.actions']}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTasks.map((task) => {
                        const instance = sshInstances.find(item => item.instance_id === task.ssh_instance_id)
                        const latest = latestByTask.get(task.task_id)
                        return (
                          <tr key={task.task_id}>
                            <td>
                              <strong>{task.name}</strong>
                              <div className="ao-capability-muted mono">{task.task_id}</div>
                              <div className="ao-capability-muted">{task.owner_domain}</div>
                            </td>
                            <td>
                              <div className="ao-log-primary">{instance?.name ?? task.ssh_instance_id}</div>
                              <div className="ao-capability-muted mono">{instance === undefined ? task.ssh_instance_id : `${instance.host}${instance.port === null ? '' : `:${instance.port}`}`}</div>
                              <div className="ao-capability-muted">用户 {instance?.username || '—'}</div>
                            </td>
                            <td className="ao-log-path-cell">
                              {task.remote_paths.map((path, index) => (
                                <div className={index === 0 ? 'ao-log-primary mono' : 'ao-capability-muted mono'} title={path} key={path}>{path}</div>
                              ))}
                            </td>
                            <td className="ao-log-path-cell">
                              <div className="ao-log-primary mono" title={task.local_dir}>{task.local_subdir === '' ? task.storage_key : task.local_subdir}</div>
                              <div className="ao-capability-muted mono" title={task.local_dir}>{task.local_dir}</div>
                              <button type="button" className="ao-log-copy" onClick={() => { void copyPath(task.local_dir) }}>
                                {copiedPath === task.local_dir ? copy['logs.copied'] : copy['logs.copyPath']}
                              </button>
                            </td>
                            <td>
                              {latest === undefined ? <span className="ao-capability-status muted">{copy['logs.never']}</span> : (
                                <div className="ao-log-lastrun">
                                  <span className={`ao-capability-status ${latest.status === 'succeeded' ? 'ok' : 'error'}`}>
                                    {latest.status === 'succeeded' ? copy['logs.runs.ok'] : copy['logs.runs.failed']}
                                  </span>
                                  <div className="ao-log-primary">{timeText(latest.finishedAt)}</div>
                                  <div className="ao-capability-muted">{latest.fileCount} 文件 / {bytesText(latest.byteCount)} / {latest.elapsedMs}ms</div>
                                  <div className="ao-capability-muted">{originText(latest.origin)}</div>
                                  {latest.errorMessage === null ? null : <div className="ao-log-run-error" title={latest.errorMessage}>{latest.errorMessage}</div>}
                                </div>
                              )}
                            </td>
                            <td>
                              <div className="ao-log-primary">{task.local_max_days === 0 ? copy['logs.keepForever'] : `${task.local_max_days} 天`}</div>
                              <span className={`ao-capability-status ${task.enabled ? 'ok' : 'muted'}`}>{task.enabled ? copy['instance.status.enabled'] : copy['instance.status.disabled']}</span>
                            </td>
                            <td>
                              <div className="ao-capability-actions ao-log-actions">
                                <button type="button" className="ao-capability-btn secondary sm" disabled={busy === task.task_id} onClick={() => { void runNow(task) }}>{busy === task.task_id ? copy['logs.running'] : copy['logs.run']}</button>
                                <button type="button" className="ao-capability-btn secondary sm" onClick={() => { setDraft({ taskId: task.task_id, revision: task.revision, id: task.task_id, name: task.name, sshInstanceId: task.ssh_instance_id, remotePathsText: task.remote_paths.join('\n'), localSubdir: task.local_subdir, localMaxDays: String(task.local_max_days), enabled: task.enabled }); setDraftError(null) }}>{copy['instance.edit']}</button>
                                <button type="button" className="ao-capability-btn danger sm" disabled={busy === task.task_id} onClick={() => { void remove(task) }}>{copy['instance.delete']}</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </section>

      <div className="ao-log-bottom">
        <section className="ao-capability-section ao-log-runs-section">
          <div className="ao-capability-section-head">
            <div><h2>{copy['logs.runs.title']}</h2><p>最近 10 次采集；失败记录会保留错误原文，便于定位连接、认证、路径或写入问题。</p></div>
            <span className="ao-capability-muted">{runs.length} 条</span>
          </div>
          {runs.length === 0 ? <div className="ao-capability-state">{copy['logs.runs.empty']}</div> : (
            <ul className="ao-capability-runs ao-log-runs">
              {runs.slice(0, 10).map(run => (
                <li key={run.runId}>
                  <div><strong>{run.taskId}</strong><div className="ao-capability-muted">{originText(run.origin)}</div></div>
                  <span className={`ao-capability-status ${run.status === 'succeeded' ? 'ok' : 'error'}`}>{run.status === 'succeeded' ? copy['logs.runs.ok'] : copy['logs.runs.failed']}</span>
                  <div className="ao-log-primary">{timeText(run.finishedAt)}</div>
                  <div>{run.fileCount} 文件 / {bytesText(run.byteCount)} / {run.elapsedMs}ms</div>
                  <div className={run.errorMessage === null ? 'ao-capability-muted' : 'ao-log-run-error'} title={run.errorMessage ?? ''}>{run.errorMessage ?? '—'}</div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="ao-log-side">
          <div className="ao-log-side-card">
            <div className="ao-log-side-title"><h3>计划联动</h3><span>{schedules.length}</span></div>
            {schedules.length === 0 ? <div className="ao-capability-muted">未读取到定时计划。</div> : (
              <div className="ao-log-plan-list">
                {schedules.map(plan => (
                  <div className="ao-log-plan-row" key={plan.id}>
                    <div><strong>{plan.name}</strong><div className="ao-capability-muted mono">{plan.id} · {plan.workflowId}</div></div>
                    <span className={`ao-capability-status ${plan.enabled ? 'ok' : 'muted'}`}>{plan.enabled ? '已启用' : '已停用'}</span>
                    <div className="ao-capability-muted mono">{plan.cron} · {plan.timezone}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ao-log-side-card">
            <div className="ao-log-side-title"><h3>运行态势</h3><span>最近 {runs.length} 次</span></div>
            <div className="ao-log-health-grid">
              <div><span>成功率</span><strong>{summary.successRate === null ? '—' : `${summary.successRate}%`}</strong></div>
              <div><span>平均耗时</span><strong>{summary.avgElapsed === null ? '—' : `${summary.avgElapsed}ms`}</strong></div>
              <div><span>近期采集量</span><strong>{bytesText(summary.bytes)}</strong></div>
            </div>
            {summary.latestFailure === null ? <div className="ao-capability-muted">最近没有失败记录。</div> : (
              <div className="ao-log-latest-error"><strong>最近失败</strong><span>{timeText(summary.latestFailure.finishedAt)}</span><p>{summary.latestFailure.errorMessage ?? '—'}</p></div>
            )}
          </div>

          <div className="ao-log-side-card">
            <div className="ao-log-side-title"><h3>采集链路</h3><span>增量</span></div>
            <ol className="ao-log-flow">
              <li><b>01</b><span>远程 active 日志文件</span></li>
              <li><b>02</b><span>SFTP 增量读取</span></li>
              <li><b>03</b><span>本地业务目录落地</span></li>
              <li><b>04</b><span>日志巡检增量分析</span></li>
            </ol>
          </div>
        </aside>
      </div>
      {draft === null ? null : (
        <div className="ao-capability-modal" onMouseDown={() => { setDraft(null) }}>
          <form
            className="ao-capability-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ao-log-dialog-title"
            aria-describedby="ao-log-dialog-description"
            onMouseDown={(event) => { event.stopPropagation() }}
            onSubmit={(event) => { event.preventDefault(); void save() }}
          >
            <header className="ao-capability-dialog-header">
              <div>
                <div className="ao-capability-kicker">{copy['logs.dialogKicker']}</div>
                <h2 id="ao-log-dialog-title">{draft.taskId === undefined ? copy['logs.new'] : copy['logs.edit']}</h2>
                <p id="ao-log-dialog-description">{copy['logs.dialogDescription']}</p>
              </div>
              <button type="button" className="ao-capability-dialog-close" aria-label={copy['logs.close']} onClick={() => { setDraft(null) }}>×</button>
            </header>

            <div className="ao-capability-dialog-body">
              <section className="ao-capability-form-section">
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.id']}</span>
                  <input
                    value={draft.id}
                    disabled={draft.taskId !== undefined}
                    placeholder="oa_approval"
                    onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
                  />
                  <small>{copy['logs.field.idHint']}</small>
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.name']}</span>
                  <input value={draft.name} placeholder="智能审批日志" onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} />
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.ssh']}</span>
                  <select value={draft.sshInstanceId} onChange={(event) => { setDraft({ ...draft, sshInstanceId: event.target.value }) }}>
                    <option value="">{copy['instance.config.select']}</option>
                    {sshInstances.map(instance => (
                      <option key={instance.instance_id} value={instance.instance_id}>
                        {instance.name}（{instance.host}{instance.port === null ? '' : `:${instance.port}`}）
                      </option>
                    ))}
                  </select>
                  <small>{copy['logs.field.sshHint']}</small>
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.paths']}</span>
                  <textarea
                    className="ao-capability-json-editor"
                    rows={5}
                    value={draft.remotePathsText}
                    placeholder="/opt/AI_Agent_Platform/logs/app/oa_audit.log"
                    onChange={(event) => { setDraft({ ...draft, remotePathsText: event.target.value }) }}
                  />
                  <small>{copy['logs.field.pathsHint']}</small>
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.localSubdir']}</span>
                  <input
                    value={draft.localSubdir}
                    placeholder="smart-approval/logs"
                    onChange={(event) => { setDraft({ ...draft, localSubdir: event.target.value }) }}
                  />
                  <small>{copy['logs.field.localSubdirHint']}</small>
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-field-label">{copy['logs.field.retention']}</span>
                  <input type="number" min={0} value={draft.localMaxDays} onChange={(event) => { setDraft({ ...draft, localMaxDays: event.target.value }) }} />
                  <small>{copy['logs.field.retentionHint']}</small>
                </label>
                <label className="ao-capability-field">
                  <span className="ao-capability-checkbox-row">
                    <input type="checkbox" checked={draft.enabled} onChange={(event) => { setDraft({ ...draft, enabled: event.target.checked }) }} />
                    <span>{copy['logs.field.enabled']}</span>
                  </span>
                </label>
              </section>

              {draftError === null ? null : <div className="ao-capability-dialog-error">{draftError}</div>}
            </div>

            <footer className="ao-capability-dialog-footer">
              <span>{copy['logs.localRootHint']}</span>
              <div className="ao-capability-actions">
                <button type="button" className="ao-capability-btn secondary" onClick={() => { setDraft(null) }}>{copy['instance.cancel']}</button>
                <button type="submit" className="ao-capability-btn primary" disabled={busy === 'save'}>
                  {draft.taskId === undefined ? copy['logs.create'] : copy['logs.save']}
                </button>
              </div>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}
