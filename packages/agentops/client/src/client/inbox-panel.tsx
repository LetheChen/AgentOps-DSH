/**
 * Inbox panel: capture records, triage them through the v1 inbox model.
 *
 * Every action goes through {@link createTaskRpcClient}: capture writes a
 * `captured` record, triage advances it to `triaged`/`ready` or closes it. The
 * server enforces the gates, so the panel only offers the actions the current
 * record and channel allow.
 *
 * @module @agentops/dsh-client/inbox-panel
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()

/** One inbox record. */
interface IdeaRecord {
  ideaId: string
  channel: string
  sourceSystem: string | null
  kind: string
  title: string | null
  content: string
  status: string
  convertedTaskId: string | null
  convertedIdeaId: string | null
  projectId: string | null
  sourceRef: string | null
  createdAt: string
  version: number
}

const STATUS_TABS = ['captured', 'triaged', 'ready', 'converted'] as const

const KIND_LABEL: Record<string, string> = {
  requirement: '需求',
  bug: '缺陷',
  doc: '文档',
  question: '咨询',
  idea: '灵感',
}

const STATUS_LABEL: Record<string, string> = {
  captured: '待分诊',
  triaged: '已分类',
  ready: '可建任务',
  converted: '已转任务',
  ignored: '已忽略',
  archived: '已归档',
}

/**
 * Render the inbox with capture and triage controls.
 * @returns the inbox panel.
 */
export function InboxPanel(): ReactElement {
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>('captured')
  const [ideas, setIdeas] = useState<IdeaRecord[]>([])
  const [projects, setProjects] = useState<{ project_id: string; name: string }[]>([])
  const [projectId, setProjectId] = useState('')
  const [content, setContent] = useState('')
  const [kind, setKind] = useState('requirement')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [queryText, setQueryText] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const query = projectId === '' ? {} : { projectId }
    const [listed, projectList, allListed] = await Promise.all([
      client.listIdeas({ ...query, status: tab }),
      client.listProjects(),
      client.listIdeas(query),
    ])
    if (!listed.ok) {
      setError(`${listed.error.code}: ${listed.error.message}`)
      setLoading(false)
      return
    }
    setIdeas((listed.value as { ideas: IdeaRecord[] }).ideas)
    const allRows = allListed.ok ? (allListed.value as { ideas?: IdeaRecord[] }).ideas ?? [] : []
    setCounts(Object.fromEntries(STATUS_TABS.map(status => [status, allRows.filter(idea => idea.status === status).length])))
    if (projectList.ok) {
      const rows = (projectList.value as { projects: { project_id: string; name: string }[] }).projects
      setProjects(rows)
      setProjectId(current => (current === '' ? (rows[0]?.project_id ?? '') : current))
    }
    setLoading(false)
  }, [tab, projectId])

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }, [load])

  const capture = useCallback(async () => {
    if (content.trim() === '') return
    setBusy('capture')
    setError('')
    const result = await client.captureIdea({
      channel: 'manual',
      kind,
      content,
      ...(projectId === '' ? {} : { project_id: projectId }),
    })
    setBusy('')
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setContent('')
    setTab('captured')
    await load()
  }, [content, kind, projectId, load])

  const triage = useCallback(async (idea: IdeaRecord, action: string, targetProjectId?: string) => {
    setBusy(idea.ideaId)
    setError('')
    const result = await client.triageIdea(idea.ideaId, {
      action,
      kind: idea.kind,
      ...(targetProjectId === undefined ? {} : { project_id: targetProjectId }),
    })
    setBusy('')
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    await load()
  }, [load])

  const convert = useCallback(async (idea: IdeaRecord) => {
    setBusy(idea.ideaId)
    setError('')
    const result = await client.convertIdea(idea.ideaId)
    setBusy('')
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setTab('converted')
    await load()
  }, [load])

  const targetProject = projectId === '' ? undefined : projectId
  const normalizedQuery = queryText.trim().toLocaleLowerCase()
  const visible = ideas.filter(idea => normalizedQuery === ''
    || `${idea.title ?? ''} ${idea.content} ${idea.sourceSystem ?? ''} ${idea.sourceRef ?? ''}`
      .toLocaleLowerCase()
      .includes(normalizedQuery))

  return (
    <div className="ao-page agentops-surface tc-inbox-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">收件箱</h1>
          <p className="ao-page-description">草稿与外部线索统一进入这里。人工、机器人、连接器和 Agent 写入的记录都必须经分诊后才可进入任务准入。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { void load() }}>刷新</button>
        </div>
      </header>

      {error !== '' && <p className="tc-inline-error" role="alert">{error}</p>}

      <section className="tc-inbox-overview">
        <div className="tc-inbox-hero">
          <span>待处理总量</span>
          <strong>{(counts.captured ?? 0) + (counts.triaged ?? 0) + (counts.ready ?? 0)}</strong>
          <small>草稿、已分类与待建任务</small>
        </div>
        {STATUS_TABS.map(status => (
          <button
            key={status}
            type="button"
            className={`tc-inbox-stat${tab === status ? ' is-active' : ''}`}
            onClick={() => { setTab(status) }}
          >
            <span>{STATUS_LABEL[status]}</span>
            <b>{counts[status] ?? 0}</b>
          </button>
        ))}
      </section>

      <section className="tc-inbox-capture tc-panel-card">
        <div className="tc-inbox-section-head">
          <div><h3>快速收录</h3><p>先把线索放进收件箱，分类和立项稍后处理。</p></div>
          <span>MANUAL · 可追溯来源</span>
        </div>
        <div className="tc-inbox-form">
          <label>
            <span>归属项目</span>
            <select className="input-base" value={projectId} onChange={(event) => { setProjectId(event.target.value) }}>
              <option value="">未归属</option>
              {projects.map(project => (
                <option key={project.project_id} value={project.project_id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>记录类型</span>
            <select className="input-base" value={kind} onChange={(event) => { setKind(event.target.value) }}>
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="is-grow">
            <span>内容</span>
            <input
              className="input-base"
              placeholder="粘贴需求、缺陷、文档线索或一句想法…"
              value={content}
              onChange={(event) => { setContent(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') void capture() }}
            />
          </label>
          <button type="button" className="btn-primary" disabled={busy === 'capture' || content.trim() === ''} onClick={() => { void capture() }}>
            {busy === 'capture' ? '收录中…' : '收录到收件箱'}
          </button>
        </div>
      </section>

      <section className="tc-inbox-toolbar">
        <div className="tc-inbox-tabs">
          {STATUS_TABS.map(status => (
            <button key={status} type="button" className={tab === status ? 'is-active' : ''} onClick={() => { setTab(status) }}>
              {STATUS_LABEL[status]}<b>{counts[status] ?? 0}</b>
            </button>
          ))}
        </div>
        <label className="tc-inbox-search">
          <input value={queryText} onChange={(event) => { setQueryText(event.target.value) }} placeholder="搜索标题、正文、来源…" />
        </label>
      </section>

      <div className="tc-inbox-list">
        {loading ? <p className="tc-muted">正在加载收件箱…</p> : null}
        {!loading && visible.length === 0 ? (
          <div className="tc-inbox-empty">
            <strong>{normalizedQuery === '' ? '这个状态下没有记录' : '没有匹配的记录'}</strong>
            <p>{normalizedQuery === '' ? '把新线索收录进来，或切换到其他状态。' : '换个关键词，或清空搜索后重试。'}</p>
          </div>
        ) : null}
        {visible.map(idea => (
          <article key={idea.ideaId} className="tc-inbox-card">
            <div className="tc-inbox-card-head">
              <span className={`tc-inbox-kind is-${idea.kind}`}>{KIND_LABEL[idea.kind] ?? idea.kind}</span>
              <span className="tc-inbox-source">{idea.channel}{idea.sourceSystem === null ? '' : ` · ${idea.sourceSystem}`}</span>
              <span className={`tc-inbox-status is-${idea.status}`}>{STATUS_LABEL[idea.status] ?? idea.status}</span>
            </div>
            <h3>{idea.title ?? idea.content}</h3>
            {idea.title !== null ? <p>{idea.content}</p> : null}
            <div className="tc-inbox-card-meta">
              <span>{idea.sourceRef ?? '内部收录'}</span>
              <span>{idea.createdAt.slice(0, 16).replace('T', ' ')}</span>
              {idea.convertedTaskId !== null ? <span>Task · {idea.convertedTaskId.slice(-8)}</span> : null}
              {idea.convertedIdeaId !== null ? <span>Candidate · {idea.convertedIdeaId.slice(-8)}</span> : null}
            </div>
            <div className="tc-inbox-card-actions">
              {idea.status === 'captured' ? <button type="button" className="btn-secondary btn-sm" disabled={busy === idea.ideaId || targetProject === undefined} onClick={() => { void triage(idea, 'classify', targetProject) }}>分类并归属</button> : null}
              {idea.status === 'triaged' && targetProject !== undefined ? <button type="button" className="btn-primary btn-sm" disabled={busy === idea.ideaId} onClick={() => { void triage(idea, 'ready', targetProject) }}>标记可建任务</button> : null}
              {idea.status === 'ready' ? <button type="button" className="btn-primary btn-sm" disabled={busy === idea.ideaId} onClick={() => { void convert(idea) }}>转入任务准入</button> : null}
              {idea.status !== 'converted' ? <><button type="button" className="btn-secondary btn-sm" disabled={busy === idea.ideaId} onClick={() => { void triage(idea, 'ignore') }}>忽略</button><button type="button" className="btn-secondary btn-sm" disabled={busy === idea.ideaId} onClick={() => { void triage(idea, 'archive') }}>归档</button></> : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  )

}

/**
 * Render the inbox sidebar glyph.
 * @param props - icon size in pixels.
 * @returns the glyph.
 */
export function InboxIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 13h5l2 3h4l2-3h5" strokeLinejoin="round" />
      <path d="M5 5h14l2 8v6H3v-6z" strokeLinejoin="round" />
    </svg>
  )
}
