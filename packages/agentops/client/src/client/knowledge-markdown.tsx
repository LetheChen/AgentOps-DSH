/**
 * Shared safe Markdown rendering for knowledge previews and retrieval results.
 * @module @agentops/dsh-client/knowledge-markdown
 */

import type { ReactElement } from 'react'

import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

const LABELS = {
  code: {
    copyLabel: '复制代码',
    copiedLabel: '已复制',
    toolbarLabels: {
      codeLabel: '代码',
      wrapLabel: '自动换行',
      unwrapLabel: '取消自动换行',
    },
  },
  footnotes: '脚注',
} satisfies MarkdownLabels

/**
 * Render knowledge text with the same safe GFM renderer used by chat.
 * @param props - Markdown source and an optional wrapper class.
 * @returns the rendered Markdown wrapper.
 */
export function KnowledgeMarkdown({ text, className }: {
  readonly text: string
  readonly className?: string | undefined
}): ReactElement {
  return (
    <div className={className}>
      <MarkdownText text={text} labels={LABELS} variant="compact" />
    </div>
  )
}
