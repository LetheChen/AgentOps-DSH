// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AskCenter } from '../src/client/knowledge-panel.tsx'
import { WikiWorkbench } from '../src/client/knowledge-wiki-panel.tsx'
import type { WikiSnapshot } from '../src/client/knowledge-wiki-api.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const snapshot: WikiSnapshot = {
  drafts: [{
    id: 'draft-1',
    title: 'Markdown 草稿',
    content: '# 文章预览\n\n**核心结论**：支持 Markdown。\n\n| 阶段 | 结果 |\n| --- | --- |\n| 预览 | 已渲染 |',
    sourceKind: 'manual',
    sourceRef: 'upload:markdown.md',
    sourceTaskId: null,
    sourceReportId: null,
    pageType: 'source',
    status: 'ready',
    targetSpaceId: 'technical_docs',
    categoryPath: '技术文档',
    conflicts: [],
    contentHash: 'abcdef1234567890',
    publishedDocumentId: null,
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
  }],
  pages: [],
  operations: [],
  spaces: [{ id: 'technical_docs', name: '技术文档', visibility: 'shared' }],
  categories: [],
  schema: '# schema',
  stats: { drafts: 1, ready: 1, conflicted: 0, published: 0 },
}

describe('knowledge Markdown rendering', () => {
  it('renders Wiki article preview Markdown as semantic content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(snapshot)))
    const { container } = render(<WikiWorkbench />)

    expect(await screen.findByRole('heading', { name: '文章预览' })).toBeTruthy()
    expect(screen.getByText('核心结论').tagName).toBe('STRONG')
    expect(container.querySelector('.kh-wiki-preview table')).not.toBeNull()
    expect(screen.queryByText('# 文章预览')).toBeNull()
  })

  it('renders retrieval results and citation excerpts as Markdown', async () => {
    const text = '## 检索结论\n\n**核心结论**：检索片段支持 Markdown。\n\n| 阶段 | 结果 |\n| --- | --- |\n| 检索 | 已渲染 |'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      citations: [{
        marker: 1,
        score: 0.98,
        text,
        citation: {
          chunkId: 'chunk-1',
          documentId: 'document-1',
          spaceId: 'technical_docs',
          version: 3,
          title: 'Harness 分析',
          section: '检索结论',
        },
      }],
    })))
    const { container } = render(<AskCenter />)

    fireEvent.change(screen.getByPlaceholderText(/输入问题/), { target: { value: 'harness' } })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => { expect(container.querySelectorAll('.kh-ask-results').length).toBe(1) })
    expect(container.querySelector('.kh-ask-answer-section h2')?.textContent).toBe('检索结论')
    expect(container.querySelector('.kh-ask-citation-snippet h2')?.textContent).toBe('检索结论')
    expect(container.querySelectorAll('.kh-ask-result strong').length).toBe(1)
    expect(container.querySelectorAll('.kh-ask-citation-snippet strong').length).toBe(1)
    expect(container.querySelectorAll('.kh-ask-answer-section table').length).toBe(1)
    expect(container.querySelectorAll('.kh-ask-citation-snippet table').length).toBe(1)
  })
})
