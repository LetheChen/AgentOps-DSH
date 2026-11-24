/**
 * Project list: the container every task belongs to.
 *
 * Creating a project and listing its task counts happen here; the inbox and the
 * board use the same records through {@link createTaskRpcClient}.
 *
 * @module @agentops/dsh-client/projects-panel
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { createTaskRpcClient } from './task-rpc-api.ts'

const client = createTaskRpcClient()

/** One project row. */
interface ProjectRecord {
  project_id: string
  name: string
  type: string | null
  local_path: string | null
  workspace_id: string | null
  workspace_path: string | null
  workspace_title: string | null
  ownership_state: 'active' | 'ownership_pending'
  version: number
  task_count: number
}

/**
 * Render the project table and its create form.
 * @returns the projects panel.
 */
export function ProjectsPanel(): ReactElement {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [tasks, setTasks] = useState<readonly { projectId: string; status: string; riskLevel: string; title: string }[]>([])
  const [workspaces, setWorkspaces] = useState<readonly { workspace_id: string; title: string; path: string }[]>([])
  const [name, setName] = useState('')
  const [type, setType] = useState<'code' | 'knowledge' | 'hybrid'>('code')
  const [workspaceId, setWorkspaceId] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
  const [feishuDocToken, setFeishuDocToken] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [rebindTarget, setRebindTarget] = useState<ProjectRecord | null>(null)
  const [rebindWorkspaceId, setRebindWorkspaceId] = useState('')
  const [rebindLocalPath, setRebindLocalPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const [projectResult, taskResult, workspaceResult] = await Promise.all([
      client.listProjects(),
      client.listTasks({ limit: '500' }),
      client.listWorkspaces(),
    ])
    if (!projectResult.ok) {
      setError(`${projectResult.error.code}: ${projectResult.error.message}`)
      return
    }
    setProjects((projectResult.value as { projects: ProjectRecord[] }).projects)
    if (taskResult.ok) {
      const rows = (taskResult.value as { tasks?: { projectId: string; status: string; riskLevel: string; title: string }[] }).tasks ?? []
      setTasks(rows)
    }
    if (workspaceResult.ok) {
      setWorkspaces((workspaceResult.value as { workspaces?: { workspace_id: string; title: string; path: string }[] }).workspaces ?? [])
    }
    setError('')
  }, [])

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [load])

  const create = useCallback(async () => {
    if (name.trim() === '') return
    const bound = type === 'knowledge' ? feishuDocToken.trim() !== '' : workspaceId.trim() !== '' || localPath.trim() !== ''
    if (!bound) {
      setError('项目必须绑定 DSH Workspace、已验证目录或知识项目文档。')
      return
    }
    setBusy(true); setError('')
    const result = await client.createProject({
      name: name.trim(),
      type,
      ...(workspaceId.trim() === '' ? {} : { workspace_id: workspaceId.trim() }),
      ...(workspaceId.trim() === '' && localPath.trim() === '' ? {} : workspaceId.trim() === '' ? { local_path: localPath.trim() } : {}),
      ...(githubUrl.trim() === '' ? {} : { github_url: githubUrl.trim() }),
      ...(feishuDocToken.trim() === '' ? {} : { feishu_doc_token: feishuDocToken.trim() }),
    })
    setBusy(false)
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setName(''); setWorkspaceId(''); setLocalPath(''); setGithubUrl(''); setFeishuDocToken(''); setShowCreate(false)
    await load()
  }, [name, type, workspaceId, localPath, githubUrl, feishuDocToken, load])

  const rebind = useCallback(async () => {
    if (rebindTarget === null) return
    if ((rebindWorkspaceId.trim() === '') === (rebindLocalPath.trim() === '')) {
      setError('重新绑定必须且只能选择 DSH Workspace 或已验证目录之一。')
      return
    }
    setBusy(true); setError('')
    const result = await client.rebindProject(rebindTarget.project_id, {
      if_version: rebindTarget.version,
      ...(rebindWorkspaceId.trim() === '' ? {} : { workspace_id: rebindWorkspaceId.trim() }),
      ...(rebindLocalPath.trim() === '' ? {} : { local_path: rebindLocalPath.trim() }),
    })
    setBusy(false)
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setRebindTarget(null); setRebindWorkspaceId(''); setRebindLocalPath('')
    await load()
  }, [rebindTarget, rebindWorkspaceId, rebindLocalPath, load])

  const normalized = query.trim().toLocaleLowerCase()
  const visibleProjects = projects.filter(project => normalized === ''
    || `${project.name} ${project.project_id} ${project.local_path ?? ''}`.toLocaleLowerCase().includes(normalized))
  const totalTasks = tasks.length
  const activeTasks = tasks.filter(task => ['in_progress', 'validating', 'closing'].includes(task.status)).length
  const highRisk = tasks.filter(task => task.riskLevel === 'high').length
  const activeProjects = projects.filter(project => project.ownership_state === 'active').length

  return (
    <div className="ao-page agentops-surface tc-projects-page">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">项目管理</h1>
          <p className="ao-page-description">项目是任务准入与执行的工作区边界。创建后绑定一次 DSH Workspace 或已验证目录，不再逐 Agent 授权。</p>
        </div>
        <div className="ao-page-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { void load() }}>刷新</button>
          <button type="button" className="btn-primary btn-sm" onClick={() => { setShowCreate(true) }}>新建项目</button>
        </div>
      </header>

      {error !== '' && <p className="tc-inline-error" role="alert">{error}</p>}

      <section className="tc-project-overview">
        <div className="tc-project-kpi"><span>项目</span><b>{projects.length}</b><small>{activeProjects} 个可执行</small></div>
        <div className="tc-project-kpi"><span>任务</span><b>{totalTasks}</b><small>{activeTasks} 个推进中</small></div>
        <div className="tc-project-kpi is-danger"><span>高风险</span><b>{highRisk}</b><small>需要优先关注</small></div>
        <div className="tc-project-kpi is-muted"><span>待绑定</span><b>{projects.length - activeProjects}</b><small>不能派发执行</small></div>
      </section>

      <section className="tc-projects-toolbar">
        <input className="input-base" value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder="搜索项目名称、ID、目录…" />
        <span>任务与工作区按项目隔离</span>
      </section>

      <section className="tc-project-grid">
        {visibleProjects.map((project) => {
          const projectTasks = tasks.filter(task => task.projectId === project.project_id)
          const done = projectTasks.filter(task => task.status === 'closed').length
          const blocked = projectTasks.filter(task => ['blocked', 'failed', 'paused'].includes(task.status)).length
          const risk = projectTasks.filter(task => task.riskLevel === 'high').length
          const progress = projectTasks.length === 0 ? 0 : Math.round(done / projectTasks.length * 100)
          const boundary = project.local_path ?? project.workspace_path ?? project.workspace_id ?? '未绑定'
          return (
            <article key={project.project_id} className={`tc-project-card${project.ownership_state === 'active' ? '' : ' is-pending'}`}>
              <header>
                <div className="tc-project-icon">{project.name.slice(0, 1).toLocaleUpperCase()}</div>
                <div><h3>{project.name}</h3><span>{project.project_id}</span></div>
                <span className={`tc-project-state is-${project.ownership_state}`}>{project.ownership_state === 'active' ? '可执行' : '待绑定'}</span>
              </header>
              <div className="tc-project-boundary"><span>执行边界</span><b title={boundary}>{boundary}</b></div>
              <div className="tc-project-progress"><div><i style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>
              <div className="tc-project-metrics">
                <span><b>{projectTasks.length}</b> 任务</span>
                <span><b>{done}</b> 已关闭</span>
                <span className={blocked > 0 ? 'is-danger' : ''}><b>{blocked}</b> 阻塞</span>
                <span className={risk > 0 ? 'is-danger' : ''}><b>{risk}</b> 高风险</span>
              </div>
              <footer><span>{project.type ?? 'code'}</span><span>{project.ownership_state === 'active' ? 'Workspace 已授权' : '禁止派发执行'}</span><button type="button" onClick={() => { setRebindTarget(project); setRebindWorkspaceId(project.workspace_id ?? ''); setRebindLocalPath(project.local_path ?? '') }}>重新绑定</button></footer>
            </article>
          )
        })}
        {visibleProjects.length === 0 ? <div className="tc-project-empty"><strong>没有匹配的项目</strong><p>创建项目并绑定 Workspace 后，任务才有可执行边界。</p></div> : null}
      </section>

      {rebindTarget !== null ? (
        <div className="tc-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRebindTarget(null) }}>
          <section className="tc-modal" role="dialog" aria-modal="true" aria-label="重新绑定项目工作区">
            <header><h2>重新绑定 · {rebindTarget.name}</h2><button type="button" aria-label="关闭" onClick={() => { setRebindTarget(null) }}>×</button></header>
            <form onSubmit={(event) => { event.preventDefault(); void rebind() }}>
              <label className="tc-form-field"><span>DSH Workspace</span><select value={rebindWorkspaceId} onChange={(event) => { setRebindWorkspaceId(event.target.value); setRebindLocalPath('') }}><option value="">不选择</option>{workspaces.map(workspace => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.title} · {workspace.path}</option>)}</select></label>
              <label className="tc-form-field"><span>或已验证目录</span><input value={rebindLocalPath} disabled={rebindWorkspaceId !== ''} onChange={(event) => { setRebindLocalPath(event.target.value) }} placeholder="绝对路径，服务端将校验 realpath" /></label>
              <p className="tc-form-hint">已有活跃任务的项目不能改工作区；否则任务执行范围会漂移。先把活跃任务关闭、取消或完成验收。</p>
              <div className="tc-modal-actions"><button type="button" className="btn-secondary" onClick={() => { setRebindTarget(null) }}>取消</button><button type="submit" className="btn-primary" disabled={busy}>{busy ? '绑定中…' : '保存绑定'}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {showCreate ? (
        <div className="tc-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false) }}>
          <section className="tc-modal" role="dialog" aria-modal="true" aria-label="新建项目">
            <header><h2>新建项目</h2><button type="button" aria-label="关闭" onClick={() => { setShowCreate(false) }}>×</button></header>
            <form onSubmit={(event) => { event.preventDefault(); void create() }}>
              <label className="tc-form-field"><span>项目名称</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value) }} placeholder="例如：订单后台" /></label>
              <label className="tc-form-field"><span>项目类型</span><select value={type} onChange={(event) => { setType(event.target.value as typeof type) }}><option value="code">代码</option><option value="knowledge">知识</option><option value="hybrid">混合</option></select></label>
              {type !== 'knowledge' ? (
                <>
                  <label className="tc-form-field"><span>DSH Workspace</span><select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setLocalPath('') }}><option value="">选择已注册 Workspace</option>{workspaces.map(workspace => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.title} · {workspace.path}</option>)}</select></label>
                  <label className="tc-form-field"><span>或已验证目录</span><input value={localPath} disabled={workspaceId !== ''} onChange={(event) => { setLocalPath(event.target.value) }} placeholder="绝对路径，服务端将校验 realpath" /></label>
                </>
              ) : null}
              {type !== 'code' ? <label className="tc-form-field"><span>飞书文档 Token</span><input value={feishuDocToken} onChange={(event) => { setFeishuDocToken(event.target.value) }} placeholder="知识项目必填" /></label> : null}
              <label className="tc-form-field"><span>仓库地址（可选）</span><input value={githubUrl} onChange={(event) => { setGithubUrl(event.target.value) }} /></label>
              <p className="tc-form-hint">项目只有绑定工作区后才会进入“可执行”；未绑定项目仍会保留，但 Agent 无法派发。</p>
              <div className="tc-modal-actions"><button type="button" className="btn-secondary" onClick={() => { setShowCreate(false) }}>取消</button><button type="submit" className="btn-primary" disabled={busy || name.trim() === ''}>{busy ? '创建中…' : '创建项目'}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  )
}

/** @param props - icon size in pixels. @returns the projects glyph. */
export function ProjectsIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" strokeLinejoin="round" />
    </svg>
  )
}
