/**
 * Skill center: live skill catalog, installation, enablement and removal.
 *
 * @module @agentops/dsh-client/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

interface ManagedSkill {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
  readonly path: string | null
  readonly installed: boolean
  readonly disabled: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

interface SkillPayload {
  readonly skills: ManagedSkill[]
  readonly managedDir: string
  readonly disabledFile: string
}

interface InstallDraft {
  readonly source: string
  readonly ref: string
  readonly skillName: string
  readonly subdir: string
}

const EMPTY: SkillPayload = { skills: [], managedDir: '', disabledFile: '' }

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

function sourceLabel(source: string): string {
  if (source === 'custom') return '自定义目录'
  if (source === 'user-dsh' || source === 'user-agents') return '用户安装'
  if (source === 'project-dsh' || source === 'project-agents') return '项目内置'
  if (source === 'bundled') return '系统内置'
  if (source === 'runtime') return '运行时'
  return source
}

/** Render the skill management page. */
export function SkillsPanel(): ReactElement {
  const [data, setData] = useState<SkillPayload>(EMPTY)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<InstallDraft>({ source: '', ref: '', skillName: '', subdir: '' })

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setData(await request('/api/agentops/skills') as SkillPayload)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const sources = useMemo(() => [...new Set(data.skills.map(item => item.source))].sort(), [data.skills])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.skills.filter(item =>
      (source === 'all' || item.source === source)
      && (q === '' || item.name.includes(q) || item.description.toLowerCase().includes(q)))
  }, [data.skills, query, source])

  const toggle = async (item: ManagedSkill): Promise<void> => {
    setBusy(item.name)
    setError('')
    try {
      await request('/api/agentops/skills/toggle', { name: item.name, disabled: !item.disabled })
      setNotice(`${item.name} 已${item.disabled ? '启用' : '停用'}`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const remove = async (item: ManagedSkill): Promise<void> => {
    if (!window.confirm(`删除自定义 skill「${item.name}」？该操作会移除安装目录。`)) return
    setBusy(item.name)
    setError('')
    try {
      await request('/api/agentops/skills/delete', { name: item.name })
      setNotice(`${item.name} 已删除`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const install = async (): Promise<void> => {
    if (draft.source.trim() === '') {
      setError('请输入 GitHub 仓库或 HTTPS zip 地址')
      return
    }
    setBusy('install')
    setError('')
    setNotice('')
    try {
      await request('/api/agentops/skills/install', {
        source: draft.source.trim(),
        ...(draft.ref.trim() === '' ? {} : { ref: draft.ref.trim() }),
        ...(draft.skillName.trim() === '' ? {} : { skill_name: draft.skillName.trim() }),
        ...(draft.subdir.trim() === '' ? {} : { subdir: draft.subdir.trim() }),
      })
      setNotice('Skill 安装完成')
      setDraft({ source: '', ref: '', skillName: '', subdir: '' })
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
          <h1 className="ao-page-title">Skill 管理</h1>
          <p className="ao-page-description">内置 skill 可停用；自定义安装的 skill 可停用或删除。停用后不会出现在 Agent 的 skill 目录中。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { void load() }}>刷新</button>
        </div>
      </header>

      {error !== '' && <div className="card" style={{ padding: 16, color: 'var(--state-error)' }}>{error}</div>}
      {notice !== '' && <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>{notice}</div>}

      <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input-base" style={{ minWidth: 320, flex: 1 }} placeholder="GitHub 仓库 URL 或 HTTPS zip 地址" value={draft.source} onChange={(event) => { setDraft({ ...draft, source: event.target.value }) }} />
          <input className="input-base" style={{ width: 140 }} placeholder="ref（默认 main）" value={draft.ref} onChange={(event) => { setDraft({ ...draft, ref: event.target.value }) }} />
          <input className="input-base" style={{ width: 180 }} placeholder="skill 名称（可选）" value={draft.skillName} onChange={(event) => { setDraft({ ...draft, skillName: event.target.value }) }} />
          <input className="input-base" style={{ width: 180 }} placeholder="子目录（可选）" value={draft.subdir} onChange={(event) => { setDraft({ ...draft, subdir: event.target.value }) }} />
          <button type="button" className="btn-primary btn-sm" disabled={busy === 'install'} onClick={() => { void install() }}>
            {busy === 'install' ? '安装中…' : '安装 skill'}
          </button>
        </div>
        <div style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>
          安装目录：<span className="font-mono">{data.managedDir}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input-base" style={{ width: 260 }} placeholder="搜索名称或描述…" value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <select className="input-base" value={source} onChange={(event) => { setSource(event.target.value) }}>
          <option value="all">全部来源</option>
          {sources.map(item => <option key={item} value={item}>{sourceLabel(item)}</option>)}
        </select>
        <span className="status-pill status-pill-neutral">{loading ? '加载中…' : `${shown.length} / ${data.skills.length}`}</span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>来源</th>
              <th>调用</th>
              <th>路径</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(item => (
              <tr key={item.name} style={{ opacity: item.disabled ? 0.58 : 1 }}>
                <td style={{ minWidth: 260 }}>
                  <div className="font-mono" style={{ color: 'var(--color-text-primary)', fontSize: 13 }}>{item.name}</div>
                  <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12, marginTop: 3 }}>{item.description}</div>
                </td>
                <td><span className="status-pill status-pill-neutral">{sourceLabel(item.source)}</span></td>
                <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {item.modelInvocable ? '模型' : ''}{item.modelInvocable && item.userInvocable ? ' / ' : ''}{item.userInvocable ? '用户' : ''}
                </td>
                <td className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-tertiary)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.path ?? ''}>{item.path ?? '—'}</td>
                <td><span className={`status-pill ${item.disabled ? 'status-pill-neutral' : 'status-pill-success'}`}>{item.disabled ? '已停用' : '可用'}</span></td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn-secondary btn-sm" disabled={busy === item.name} onClick={() => { void toggle(item) }}>{item.disabled ? '启用' : '停用'}</button>
                    {item.installed && <button type="button" className="btn-secondary btn-sm" disabled={busy === item.name} onClick={() => { void remove(item) }}>删除</button>}
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>暂无匹配 skill</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Sidebar glyph for the skill center. */
export function SkillsIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" strokeLinejoin="round" />
      <path d="M8 7h8M8 11h6" strokeLinecap="round" />
    </svg>
  )
}
