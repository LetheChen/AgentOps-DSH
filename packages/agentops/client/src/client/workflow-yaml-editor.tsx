/**
 * Controlled YAML source editor with line numbers and validation issue links.
 *
 * @module @agentops/dsh-client/workflow-yaml-editor
 */

import { useEffect, useMemo, useRef, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { WorkflowIssue } from './workflow-editor-api.js'
import { insertSpaces, isSaveShortcut, sourceRangeForIssue } from './workflow-editor-logic.js'
import type { NS } from './locales.js'

/** Props for the controlled workflow YAML editor. */
export interface WorkflowYamlEditorProps {
  readonly text: string
  readonly onChange: (text: string) => void
  readonly onSave: () => void
  readonly issues: readonly WorkflowIssue[]
  readonly activeIssue: number | null
  readonly onIssueSelect: (index: number) => void
  /** Increment to focus and select the active issue from outside the editor. */
  readonly focusRequest: number
  readonly disabled: boolean
  readonly t: PropsLocale<typeof NS>['t']
}

function lineCountOf(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

function focusIssue(
  textarea: HTMLTextAreaElement | null,
  text: string,
  issue: WorkflowIssue,
): void {
  if (textarea === null) return
  textarea.focus()
  // A cycle issue points at the dependency that closes the loop; select the
  // whole declaration so the indentation and relationship remain visible.
  const range = sourceRangeForIssue(
    text,
    issue.kind === 'cycle' && issue.column !== undefined
      ? { ...issue, column: 1 }
      : issue,
  )
  if (range === null) {
    textarea.setSelectionRange(text.length, text.length)
    return
  }
  textarea.setSelectionRange(range.start, range.end)
}

/**
 * Render the workflow YAML editor.
 * @param props - draft text, callbacks, validation issues, and localized copy.
 * @returns the source textarea, synchronized line-number gutter, and issue list.
 */
export function WorkflowYamlEditor({
  text,
  onChange,
  onSave,
  issues,
  activeIssue,
  onIssueSelect,
  focusRequest,
  disabled,
  t,
}: WorkflowYamlEditorProps): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)
  const handledFocusRequest = useRef(0)
  const lines = useMemo(() => Array.from({ length: lineCountOf(text) }, (_, index) => index + 1), [text])

  useEffect(() => {
    const selection = pendingSelection.current
    if (selection === null || textareaRef.current === null) return
    pendingSelection.current = null
    textareaRef.current.setSelectionRange(selection.start, selection.end)
  }, [text])

  useEffect(() => {
    if (focusRequest <= handledFocusRequest.current || activeIssue === null) return
    const issue = issues[activeIssue]
    if (issue === undefined) return
    handledFocusRequest.current = focusRequest
    focusIssue(textareaRef.current, text, issue)
  }, [activeIssue, focusRequest, issues, text])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (disabled) return
    if (event.key === 'Tab') {
      event.preventDefault()
      const textarea = event.currentTarget
      const edit = insertSpaces(text, textarea.selectionStart, textarea.selectionEnd)
      pendingSelection.current = edit.selection
      onChange(edit.text)
      textarea.setSelectionRange(edit.selection.start, edit.selection.end)
      return
    }
    if (isSaveShortcut(event)) {
      event.preventDefault()
      onSave()
    }
  }

  const selectIssue = (index: number, issue: WorkflowIssue): void => {
    onIssueSelect(index)
    focusIssue(textareaRef.current, text, issue)
  }

  return (
    <div className="workflow-yaml-editor" data-disabled={disabled || undefined}>
      <div className="workflow-yaml-source">
        <div ref={gutterRef} className="workflow-yaml-gutter" aria-hidden="true">
          {lines.map(line => <span key={line}>{line}</span>)}
        </div>
        <textarea
          ref={textareaRef}
          className="workflow-yaml-textarea"
          aria-label={t('yaml.label')}
          placeholder={t('yaml.placeholder')}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={(event) => {
            if (gutterRef.current !== null) gutterRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          disabled={disabled}
          wrap="off"
          spellCheck={false}
          style={{ tabSize: 2 }}
        />
      </div>

      <section className="workflow-yaml-issues" aria-labelledby="workflow-yaml-issues-title">
        <h3 id="workflow-yaml-issues-title">{t('yaml.issues.title')}</h3>
        {issues.length === 0 ? (
          <p className="workflow-yaml-issues-empty">{t('yaml.issues.empty')}</p>
        ) : (
          <ol className="workflow-yaml-issue-list">
            {issues.map((issue, index) => (
              <li key={`${issue.path}:${issue.line ?? ''}:${issue.column ?? ''}:${index}`}>
                <button
                  type="button"
                  className={`workflow-yaml-issue${activeIssue === index ? ' is-active' : ''}`}
                  aria-pressed={activeIssue === index}
                  onClick={() => { selectIssue(index, issue) }}
                >
                  <span className="workflow-yaml-issue-location">
                    {issue.line === undefined
                      ? issue.path
                      : t('yaml.issue.position', { line: String(issue.line), message: '' })}
                  </span>
                  <span className="workflow-yaml-issue-message">{issue.message}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
