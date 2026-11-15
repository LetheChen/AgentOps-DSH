// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { WorkflowYamlEditor } from '../src/client/workflow-yaml-editor.js'

afterEach(cleanup)

const t = makeTranslate({
  'yaml.label': 'YAML source',
  'yaml.placeholder': 'Edit workflow YAML',
  'yaml.issues.title': 'Validation issues',
  'yaml.issues.empty': 'No validation issues',
  'yaml.issue.position': 'Line {line}: {message}',
  'yaml.issue.path': '{path}: {message}',
})

describe('workflow YAML editor', () => {
  it('inserts two spaces for Tab and moves the caret after them', () => {
    const onChange = vi.fn()
    render(
      <WorkflowYamlEditor
        text="abc"
        onChange={onChange}
        onSave={vi.fn()}
        issues={[]}
        activeIssue={null}
        onIssueSelect={vi.fn()}
        focusRequest={0}
        disabled={false}
        t={t}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'YAML source' }) as HTMLTextAreaElement
    textarea.setSelectionRange(1, 1)

    fireEvent.keyDown(textarea, { key: 'Tab' })

    expect(onChange).toHaveBeenCalledWith('a  bc')
  })

  it('saves on Ctrl+S and Cmd+S while preventing the browser default', () => {
    const onSave = vi.fn()
    render(
      <WorkflowYamlEditor
        text="workflow: {}"
        onChange={vi.fn()}
        onSave={onSave}
        issues={[]}
        activeIssue={null}
        onIssueSelect={vi.fn()}
        focusRequest={0}
        disabled={false}
        t={t}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'YAML source' })

    const ctrlSave = new KeyboardEvent('keydown', {
      key: 's', ctrlKey: true, bubbles: true, cancelable: true,
    })
    textarea.dispatchEvent(ctrlSave)
    const metaSave = new KeyboardEvent('keydown', {
      key: 'S', metaKey: true, bubbles: true, cancelable: true,
    })
    textarea.dispatchEvent(metaSave)

    expect(onSave).toHaveBeenCalledTimes(2)
    expect(ctrlSave.defaultPrevented).toBe(true)
    expect(metaSave.defaultPrevented).toBe(true)
  })

  it('focuses the textarea and selects the reported source line when an issue is chosen', async () => {
    function Harness() {
      const [activeIssue, setActiveIssue] = useState<number | null>(null)
      return (
        <WorkflowYamlEditor
          text={'id: demo\nnodes:\n  - bad\n'}
          onChange={vi.fn()}
          onSave={vi.fn()}
          issues={[{ path: 'nodes[0]', message: 'bad node', line: 3, column: 3 }]}
          activeIssue={activeIssue}
          onIssueSelect={setActiveIssue}
          focusRequest={0}
          disabled={false}
          t={t}
        />
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /bad node/ }))
    const textarea = screen.getByRole('textbox', { name: 'YAML source' }) as HTMLTextAreaElement

    await waitFor(() => { expect(document.activeElement).toBe(textarea) })
    expect(textarea.selectionStart).toBe(18)
    expect(textarea.selectionEnd).toBe(23)
  })

  it('keeps the line-number gutter aligned with textarea scrolling', () => {
    const { container } = render(
      <WorkflowYamlEditor
        text={'a: 1\nb: 2\nc: 3\n'}
        onChange={vi.fn()}
        onSave={vi.fn()}
        issues={[]}
        activeIssue={null}
        onIssueSelect={vi.fn()}
        focusRequest={0}
        disabled={false}
        t={t}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'YAML source' }) as HTMLTextAreaElement
    const gutter = container.querySelector<HTMLElement>('.workflow-yaml-gutter')

    textarea.scrollTop = 48
    fireEvent.scroll(textarea)

    expect(gutter?.scrollTop).toBe(48)
    expect(gutter?.textContent).toContain('4')
  })

  it('disables wrapping and displays validation messages without translating them again', () => {
    render(
      <WorkflowYamlEditor
        text="workflow: {}"
        onChange={vi.fn()}
        onSave={vi.fn()}
        issues={[{ path: 'workflow', message: 'yaml.label', line: 1 }]}
        activeIssue={null}
        onIssueSelect={vi.fn()}
        focusRequest={0}
        disabled={false}
        t={t}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'YAML source' })

    expect(textarea.getAttribute('wrap')).toBe('off')
    expect(screen.getByText('yaml.label')).toBeDefined()
  })
})
