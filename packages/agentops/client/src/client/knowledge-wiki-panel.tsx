/**
 * LLM Wiki workbench: raw drafts, conflict checks, publication and log.
 *
 * @module @agentops/dsh-client/knowledge-wiki-panel
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import {
  archiveWikiDraft,
  checkWikiDraft,
  createWikiDraft,
  fetchWikiSnapshot,
  publishWikiDraft,
  reviewWikiCategory,
  type WikiCategory,
  type WikiConflict,
  type WikiDraft,
  type WikiDraftStatus,
  type WikiPageType,
  type WikiSnapshot,
} from './knowledge-wiki-api.ts'

const DRAFT_STATUS: Readonly<Record<WikiDraftStatus, string>> = {
  inbox: '待检查',
  ready: '可发布',
  conflicted: '有冲突',
  published: '已发布',
  archived: '已归档',
}

const PAGE_TYPE: Readonly<Record<WikiPageType | 'document', string>> = {
  source: '来源摘要',
  entity: '实体',
  concept: '概念',
  comparison: '对比',
  overview: '综述',
  document: '文档',
}

function timeText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function conflictTone(conflict: WikiConflict): string {
  return conflict.severity === 'block' ? 'is-block' : conflict.severity === 'warn' ? 'is-warn' : 'is-info'
}

function uploadText(fileName: string, raw: string): { title: string; content: string } {
  if (!/\.html?$/i.test(fileName)) {
    return { title: fileName.replace(/\.[^.]+$/, ''), content: raw }
  }
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  parsed.querySelectorAll('script, style, noscript').forEach((element) => { element.remove() })
  const heading = parsed.querySelector('h1')
  const title = parsed.title.trim() || heading?.textContent.trim() || fileName.replace(/\.[^.]+$/, '')
  const body = parsed.body.textContent.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { title, content: `# ${title}\n\n${body}` }
}

/** Render the LLM Wiki review and publication surface. */
export function WikiWorkbench(): ReactElement {
  const [snapshot, setSnapshot] = useState<WikiSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [targetSpace, setTargetSpace] = useState('')
  const [uploadSpace, setUploadSpace] = useState('')
  const [autoPublish, setAutoPublish] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const next = await fetchWikiSnapshot()
      setSnapshot(next)
      setUploadSpace(current => current !== '' ? current : next.spaces[0]?.id ?? '')
      setSelectedId(current => current === '' || !next.drafts.some(draft => draft.id === current)
        ? next.drafts.find(draft => draft.status !== 'archived')?.id ?? ''
        : current)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const selected = useMemo<WikiDraft | null>(() =>
    snapshot?.drafts.find(draft => draft.id === selectedId) ?? null, [selectedId, snapshot])

  useEffect(() => {
    if (selected === null || snapshot === null) return
    setTargetSpace(current => current !== '' ? current : selected.targetSpaceId ?? snapshot.spaces[0]?.id ?? '')
  }, [selected, snapshot])

  const act = async (kind: 'check' | 'publish' | 'archive'): Promise<void> => {
    if (selected === null) return
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      if (kind === 'check') {
        const checked = await checkWikiDraft(selected.id)
        setNotice(checked.status === 'conflicted' ? '检查完成：存在阻断项' : '检查完成：可进入 Wiki')
      } else if (kind === 'publish') {
        if (targetSpace === '') throw new Error('请选择目标知识空间')
        await publishWikiDraft(selected.id, targetSpace, selected.categoryPath)
        setNotice('Wiki 已发布，并已加入检索与记忆星云')
      } else {
        await archiveWikiDraft(selected.id)
        setNotice('草稿已归档，不进入检索')
      }
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const reviewCategory = async (category: WikiCategory): Promise<void> => {
    setBusy(`category:${category.spaceId}:${category.path}`)
    setError('')
    setNotice('')
    try {
      await reviewWikiCategory(category.spaceId, category.path)
      setNotice(`分类已确认：${category.path}`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const upload = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setUploading(true)
    setError('')
    setNotice('')
    let imported = 0
    let published = 0
    let conflicted = 0
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const extracted = uploadText(file.name, await file.text())
        const draft: WikiDraft = await createWikiDraft({
          title: extracted.title,
          content: extracted.content,
          sourceKind: 'archive',
          sourceRef: `upload:${file.name}`,
          targetSpaceId: uploadSpace,
        })
        imported += 1
        setSelectedId(draft.id)
        setTargetSpace(uploadSpace)
        if (draft.status === 'conflicted') conflicted += 1
        if (autoPublish && draft.status === 'ready' && uploadSpace !== '') {
          await publishWikiDraft(draft.id, uploadSpace, draft.categoryPath)
          published += 1
        }
      } catch (reason) {
        failures.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    setNotice(`已导入 ${imported} 个文档，自动发布 ${published} 个 Wiki${conflicted === 0 ? '' : `，${conflicted} 个需处理冲突`}${failures.length === 0 ? '' : `；失败 ${failures.length} 个`}`)
    if (failures.length > 0) setError(failures.join('\n'))
    setUploading(false)
    await load()
  }

  if (loading) return <div className="kh-empty">正在加载 Wiki 工作台…</div>
  if (snapshot === null) return (
    <div className="kh-wiki-load-error">
      <div className="kh-error" role="alert">{error || '无法加载 Wiki 工作台'}</div>
      <button type="button" className="btn-secondary btn-sm" onClick={() => { void load() }}>重新加载</button>
    </div>
  )

  const visibleDrafts = snapshot.drafts.filter(draft => draft.status !== 'published' || draft.id === selectedId)

  return (
    <div className="kh-wiki">
      <div className="kh-wiki-stats">
        <div><strong>{snapshot.stats.drafts}</strong><span>草稿箱</span></div>
        <div><strong>{snapshot.stats.ready}</strong><span>可发布</span></div>
        <div><strong>{snapshot.stats.conflicted}</strong><span>待处理冲突</span></div>
        <div><strong>{snapshot.stats.published}</strong><span>Wiki 页面</span></div>
      </div>

      <div className="kh-wiki-flow" aria-label="LLM Wiki 三层架构">
        <div><b>01 · Schema</b><span>页面类型、晋升规则、交叉引用和操作日志</span></div>
        <div><b>02 · Raw</b><span>任务报告与原始资料只读入箱，保留来源</span></div>
        <div><b>03 · Wiki</b><span>检查通过后发布为可检索页面并进入记忆星云</span></div>
      </div>

      <section className="kh-wiki-upload-card">
        <div className="kh-wiki-upload-copy">
          <h3>上传技术文档</h3>
          <p>支持 Markdown / TXT / JSON / YAML / CSV / HTML。上传后自动分类、检查冲突并进入 Raw 草稿箱。</p>
        </div>
        <div className="kh-wiki-upload-actions">
          <label className="kh-wiki-file-picker">
            <span>{uploading ? '处理中…' : '选择文件'}</span>
            <input type="file" multiple accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.html,.htm" disabled={uploading} onChange={(event) => { void upload(event.target.files); event.target.value = '' }} />
          </label>
          <select value={uploadSpace} onChange={(event) => { setUploadSpace(event.target.value) }} aria-label="上传目标知识空间">
            {snapshot.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
          <label className="kh-wiki-auto-publish"><input type="checkbox" checked={autoPublish} onChange={(event) => { setAutoPublish(event.target.checked) }} />检查通过后自动发布</label>
        </div>
      </section>

      {error === '' ? null : <div className="kh-error" role="alert">{error}</div>}
      {notice === '' ? null : <div className="kh-stats kh-wiki-notice">{notice}</div>}

      <div className="kh-wiki-grid">
        <section className="kh-wiki-inbox">
          <div className="kh-wiki-section-head">
            <div><h3>Raw 草稿箱</h3><p>任务报告与技术资料先进入这里</p></div>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void load() }}>刷新</button>
          </div>
          {visibleDrafts.length === 0 ? <div className="kh-empty">暂无待处理草稿</div> : (
            <div className="kh-wiki-draft-list">
              {visibleDrafts.map(draft => (
                <button
                  key={draft.id}
                  type="button"
                  className={`kh-wiki-draft${draft.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => { setSelectedId(draft.id); setTargetSpace(draft.targetSpaceId ?? snapshot.spaces[0]?.id ?? '') }}
                >
                  <span><b>{draft.title}</b><small>{PAGE_TYPE[draft.pageType]} · {draft.categoryPath} · {draft.sourceKind}</small></span>
                  <em className={`kh-wiki-status is-${draft.status}`}>{DRAFT_STATUS[draft.status]}</em>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="kh-wiki-detail">
          {selected === null ? <div className="kh-empty">选择一份草稿查看检查结果</div> : (
            <>
              <div className="kh-wiki-section-head">
                <div><h3>{selected.title}</h3><p>{selected.sourceRef ?? '无来源引用'} · {timeText(selected.updatedAt)}</p></div>
                <span className={`kh-wiki-status is-${selected.status}`}>{DRAFT_STATUS[selected.status]}</span>
              </div>
              <div className="kh-wiki-detail-meta">
                <span>类型 <b>{PAGE_TYPE[selected.pageType]}</b></span>
                <span>分类 <b>{selected.categoryPath}</b></span>
                <span>版本 <b>v{selected.contentHash.slice(0, 8)}</b></span>
                <span>发现 <b>{selected.conflicts.length}</b></span>
                <span>目标 <b>{snapshot.spaces.find(space => space.id === selected.targetSpaceId)?.name ?? '发布时选择'}</b></span>
              </div>
              <div className="kh-wiki-conflicts">
                {selected.conflicts.length === 0 ? <div className="kh-wiki-conflict is-ok">结构检查通过，未发现重复或敏感内容</div> : selected.conflicts.map((conflict, index) => (
                  <div key={`${conflict.code}-${index}`} className={`kh-wiki-conflict ${conflictTone(conflict)}`}>
                    <b>{conflict.severity === 'block' ? '阻断' : conflict.severity === 'warn' ? '警告' : '关联'}</b>
                    <span>{conflict.message}</span>
                  </div>
                ))}
              </div>
              <pre className="kh-wiki-preview">{selected.content}</pre>
              <div className="kh-wiki-actions">
                <select value={targetSpace} onChange={(event) => { setTargetSpace(event.target.value) }} aria-label="目标知识空间">
                  {snapshot.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                </select>
                <button type="button" className="btn-secondary btn-sm" disabled={busy !== ''} onClick={() => { void act('check') }}>{busy === 'check' ? '检查中…' : '重新检查'}</button>
                <button type="button" className="btn-primary btn-sm" disabled={busy !== '' || selected.status === 'published' || selected.status === 'archived'} onClick={() => { void act('publish') }}>{busy === 'publish' ? '发布中…' : '创建 Wiki'}</button>
                <button type="button" className="btn-secondary btn-sm" disabled={busy !== '' || selected.status === 'published' || selected.status === 'archived'} onClick={() => { void act('archive') }}>归档草稿</button>
              </div>
            </>
          )}
        </section>

        <aside className="kh-wiki-side">
          <section>
            <div className="kh-wiki-section-head"><div><h3>分类目录</h3><p>Agent 自动维护 · {snapshot.categories.filter(category => category.reviewStatus === 'auto').length} 个待确认</p></div></div>
            <div className="kh-wiki-category-list">
              {snapshot.categories.slice(0, 12).map(category => (
                <div key={`${category.spaceId}-${category.path}`}>
                  <b>{category.path}</b>
                  <span>
                    {snapshot.spaces.find(space => space.id === category.spaceId)?.name ?? category.spaceId}
                    {' · '}{category.documentCount} 文档 / {category.draftCount} 草稿
                  </span>
                  {category.reviewStatus === 'auto'
                    ? <button type="button" className="btn-secondary btn-sm" disabled={busy !== ''} onClick={() => { void reviewCategory(category) }}>{busy === `category:${category.spaceId}:${category.path}` ? '确认中…' : '确认分类'}</button>
                    : <em>已确认</em>}
                </div>
              ))}
              {snapshot.categories.length === 0 ? <div className="kh-empty">尚无分类目录</div> : null}
            </div>
          </section>
          <section>
            <div className="kh-wiki-section-head"><div><h3>Wiki 索引</h3><p>{snapshot.pages.length} 个可检索页面</p></div></div>
            <div className="kh-wiki-page-list">
              {snapshot.pages.slice(0, 8).map(page => (
                <div key={page.id}>
                  <b>{page.title}</b>
                  <span>{PAGE_TYPE[page.pageType]} · {page.spaceId} · {page.categoryPath} · v{page.version}</span>
                </div>
              ))}
              {snapshot.pages.length === 0 ? <div className="kh-empty">尚未发布 Wiki</div> : null}
            </div>
          </section>
          <section>
            <div className="kh-wiki-section-head"><div><h3>操作日志</h3><p>只追加时间线</p></div></div>
            <div className="kh-wiki-log">
              {snapshot.operations.slice(0, 10).map(operation => (
                <div key={operation.id}><b>{operation.action}</b><span>{timeText(operation.createdAt)}</span></div>
              ))}
              {snapshot.operations.length === 0 ? <div className="kh-empty">暂无操作</div> : null}
            </div>
          </section>
        </aside>
      </div>

      <details className="kh-wiki-schema">
        <summary>查看 LLM Wiki Schema</summary>
        <pre>{snapshot.schema}</pre>
      </details>
    </div>
  )
}
