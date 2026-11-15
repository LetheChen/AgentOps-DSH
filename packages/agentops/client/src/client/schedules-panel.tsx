/**
 * Schedules page: editable workflow schedules over `schedules.yaml`.
 *
 * @module @agentops/dsh-client/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

interface Schedule {
  readonly id: string
  readonly name: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone: string
  readonly inputs: Record<string, unknown>
  readonly enabled: boolean
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly lastRunAt: string | null
  readonly lastStatus: 'starting' | 'started' | 'failed' | null
  readonly lastError: string | null
  readonly lastSessionId: string | null
}

interface SchedulesPayload {
  readonly file: string
  readonly entries: Schedule[]
  readonly missing: boolean
}

interface Draft {
  readonly editing: boolean
  readonly id: string
  readonly name: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone: string
  readonly inputsText: string
  readonly enabled: boolean
}

function newDraft(): Draft {
  return {
    editing: false,
    id: '',
    name: '',
    workflowId: 'log-patrol',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    inputsText: '{}',
    enabled: true,
  }
}

function errorMessage(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') return error.message
  }
  return String(value)
}

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    credentials: 'include',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(errorMessage(value))
  return value
}

/** Render the editable schedules page. */
export function SchedulesPanel(): ReactElement {
  const [entries, setEntries] = useState<readonly Schedule[]>([])
  const [file, setFile] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const data = await request('/api/agentops/schedules') as SchedulesPayload
      setEntries(data.entries)
      setFile(data.file)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(entry =>
      (!onlyEnabled || entry.enabled)
      && (q.length === 0
        || entry.id.toLowerCase().includes(q)
        || entry.name.toLowerCase().includes(q)
        || entry.workflowId.toLowerCase().includes(q)))
  }, [entries, onlyEnabled, query])

  const save = async (): Promise<void> => {
    if (draft === null) return
    let inputs: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(draft.inputsText)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('inputs 必须是 JSON 对象')
      inputs = parsed as Record<string, unknown>
    } catch (reason) {
      setError(`inputs 解析失败：${reason instanceof Error ? reason.message : String(reason)}`)
      return
    }
    setBusy('save')
    setError('')
    try {
      await request('/api/agentops/schedules', {
        action: draft.editing ? 'update' : 'create',
        id: draft.id.trim(),
        name: draft.name.trim(),
        workflow_id: draft.workflowId.trim(),
        cron: draft.cron.trim(),
        timezone: draft.timezone.trim(),
        inputs,
        enabled: draft.enabled,
      })
      setNotice(draft.editing ? '定时计划已更新' : '定时计划已创建')
      setDraft(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const toggle = async (entry: Schedule): Promise<void> => {
    setBusy(entry.id)
    try {
      await request('/api/agentops/schedules', {
        action: 'update', id: entry.id, name: entry.name, workflow_id: entry.workflowId,
        cron: entry.cron, timezone: entry.timezone, inputs: entry.inputs, enabled: !entry.enabled,
      })
      setNotice(`${entry.id} 已${entry.enabled ? '停用' : '启用'}`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const run = async (entry: Schedule): Promise<void> => {
    setBusy(entry.id)
    setError('')
    try {
      const result = await request('/api/agentops/schedules/run', { id: entry.id }) as { sessionId?: string }
      setNotice(`${entry.id} 已触发${result.sessionId === undefined ? '' : `，会话 ${result.sessionId}`}`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await load()
    } finally {
      setBusy('')
    }
  }

  const remove = async (entry: Schedule): Promise<void> => {
    if (!window.confirm(`删除定时计划「${entry.name}」？`)) return
    setBusy(entry.id)
    try {
      await request('/api/agentops/schedules/delete', { id: entry.id })
      setNotice(`${entry.id} 已删除`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="ao-page sc-page agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">定时计划</h1>
          <p className="ao-page-description">到点后创建 AgentOps 会话并调用对应 workflow；配置写入 <span className="font-mono">{file || 'schedules.yaml'}</span>。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-primary btn-sm" onClick={() => { setDraft(newDraft()) }}>新建计划</button>
        </div>
      </header>

      {error !== '' && <div className="card" style={{ padding: 16, color: 'var(--state-error)' }}>{error}</div>}
      {notice !== '' && <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input-base" style={{ width: 260 }} placeholder="搜索名称 / ID / 工作流…" value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <button type="button" className="btn-secondary btn-sm" onClick={() => { setOnlyEnabled(value => !value) }}>{onlyEnabled ? '显示全部' : '只看已启用'}</button>
        <span className="status-pill status-pill-neutral">{loading ? '加载中…' : `已启用 ${entries.filter(item => item.enabled).length} / 共 ${entries.length}`}</span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="data-table">
          <thead><tr><th>名称</th><th>工作流</th><th>Cron / 时区</th><th>最近触发</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {shown.map(entry => (
              <tr key={entry.id}>
                <td><div style={{ color: 'var(--color-text-primary)' }}>{entry.name}</div><div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{entry.id}</div></td>
                <td className="font-mono" style={{ fontSize: 12 }}>{entry.workflowId}<div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(entry.inputs)}>{JSON.stringify(entry.inputs)}</div></td>
                <td className="font-mono" style={{ fontSize: 12 }}>{entry.cron}<div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{entry.timezone}</div></td>
                <td style={{ fontSize: 12 }}>{entry.lastRunAt ?? '—'}{entry.lastError === null ? null : <div style={{ color: 'var(--state-error)', maxWidth: 220 }}>{entry.lastError}</div>}</td>
                <td><span className={`status-pill ${entry.enabled ? 'status-pill-success' : 'status-pill-neutral'}`}>{entry.enabled ? '已启用' : '已停用'}</span>{entry.lastStatus === null ? null : <div style={{ fontSize: 11, marginTop: 4 }}>{entry.lastStatus}</div>}</td>
                <td><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button type="button" className="btn-secondary btn-sm" disabled={busy === entry.id} onClick={() => { setDraft({ editing: true, id: entry.id, name: entry.name, workflowId: entry.workflowId, cron: entry.cron, timezone: entry.timezone, inputsText: JSON.stringify(entry.inputs, null, 2), enabled: entry.enabled }) }}>编辑</button><button type="button" className="btn-secondary btn-sm" disabled={busy === entry.id} onClick={() => { void toggle(entry) }}>{entry.enabled ? '停用' : '启用'}</button><button type="button" className="btn-secondary btn-sm" disabled={busy === entry.id} onClick={() => { void run(entry) }}>立即运行</button><button type="button" className="btn-secondary btn-sm" disabled={busy === entry.id} onClick={() => { void remove(entry) }}>删除</button></div></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>暂无匹配的计划</td></tr>}
          </tbody>
        </table>
      </div>

      {draft === null ? null : (
        <div className="ao-capability-modal" onMouseDown={() => { setDraft(null) }}>
          <form className="ao-capability-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => { event.stopPropagation() }} onSubmit={(event) => { event.preventDefault(); void save() }}>
            <h2>{draft.editing ? '编辑定时计划' : '新建定时计划'}</h2>
            <section className="ao-capability-form-section">
              <label className="ao-capability-field"><span className="ao-capability-field-label">计划 ID</span><input className="input-base" value={draft.id} disabled={draft.editing} placeholder="log-patrol-daily" onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }} /></label>
              <label className="ao-capability-field"><span className="ao-capability-field-label">名称</span><input className="input-base" value={draft.name} placeholder="日志巡检（每日）" onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></label>
              <label className="ao-capability-field"><span className="ao-capability-field-label">工作流 ID</span><input className="input-base" value={draft.workflowId} placeholder="log-patrol" onChange={(event) => { setDraft({ ...draft, workflowId: event.target.value }) }} /></label>
              <label className="ao-capability-field"><span className="ao-capability-field-label">Cron</span><input className="input-base font-mono" value={draft.cron} placeholder="0 9 * * *" onChange={(event) => { setDraft({ ...draft, cron: event.target.value }) }} /><small>5 段 Vixie cron：分 时 日 月 周</small></label>
              <label className="ao-capability-field"><span className="ao-capability-field-label">时区</span><input className="input-base font-mono" value={draft.timezone} placeholder="Asia/Shanghai" onChange={(event) => { setDraft({ ...draft, timezone: event.target.value }) }} /></label>
              <label className="ao-capability-field"><span className="ao-capability-field-label">运行输入 JSON</span><textarea className="ao-capability-json-editor" rows={7} value={draft.inputsText} onChange={(event) => { setDraft({ ...draft, inputsText: event.target.value }) }} /></label>
              <label className="ao-capability-field"><span className="ao-capability-checkbox-row"><input type="checkbox" checked={draft.enabled} onChange={(event) => { setDraft({ ...draft, enabled: event.target.checked }) }} /><span>启用计划</span></span></label>
            </section>
            <footer className="ao-capability-dialog-footer"><span /><div className="ao-capability-actions"><button type="button" className="btn-secondary btn-sm" onClick={() => { setDraft(null) }}>取消</button><button type="submit" className="btn-primary btn-sm" disabled={busy === 'save'}>{busy === 'save' ? '保存中…' : '保存'}</button></div></footer>
          </form>
        </div>
      )}
    </div>
  )
}

/** Sidebar glyph for schedules. */
export function SchedulesIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" strokeLinecap="round" />
    </svg>
  )
}
