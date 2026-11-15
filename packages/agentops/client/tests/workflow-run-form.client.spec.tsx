// @vitest-environment jsdom
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/locales.js'
import type {
  WorkflowRunInputDefinition,
  WorkflowSummary,
} from '../src/client/workflow-editor-api.js'
import { WorkflowRunForm } from '../src/client/workflow-run-form.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh)

interface ApiCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

type ApiHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  return init.body
}

function pathOf(url: string): string {
  return new URL(url, 'http://localhost').pathname
}
function fieldValue(name: RegExp): string {
  const element = screen.getByRole('textbox', { name })
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
  throw new Error('expected an input or textarea')
}


function installApi(handler: ApiHandler): ApiCall[] {
  const calls: ApiCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    calls.push({ url, init })
    return handler(url, init)
  }))
  return calls
}

function wireInput(input: WorkflowRunInputDefinition): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    name: input.name,
    type: input.type,
    required: input.required,
  }
  if (input.description !== undefined) wire.description = input.description
  if (input.defaultValue !== undefined) wire.default = input.defaultValue
  return wire
}

function hintResponse(
  workflowId: string,
  inputs: readonly WorkflowRunInputDefinition[],
): Response {
  return jsonResponse({
    workflowId,
    prompt: `run ${workflowId}`,
    reason: 'needs an Agent session',
    inputs: inputs.map(wireInput),
  })
}

function entry(
  id: string,
  inputs: readonly WorkflowRunInputDefinition[] = [],
): WorkflowSummary {
  return {
    id,
    file: `${id}.yaml`,
    name: id,
    nodeCount: 1,
    levelCount: 1,
    ok: true,
    errors: [],
    status: 'verified',
    inputs,
    nodes: [{ id: 'scan', level: 0, type: 'agent' }],
    edges: [],
  }
}

function renderForm(
  workflow: WorkflowSummary,
  onStarted = vi.fn(),
  onClose = vi.fn(),
): void {
  render(
    <WorkflowRunForm
      t={t}
      entry={workflow}
      onClose={onClose}
      onStarted={onStarted}
    />,
  )
}

describe('workflow run form', () => {
  it('starts a workflow without inputs only after the explicit start action', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflow-run-hint') return hintResponse('plain', [])
      if (path === '/api/agentops/workflow-run') {
        return jsonResponse({ ok: true, sessionId: 'session-1', workflowId: 'plain' })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const onStarted = vi.fn()
    renderForm(entry('plain'), onStarted)

    await screen.findByText(t('page.run.noInputs'))
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-run')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: t('page.run.start') }))

    await waitFor(() => { expect(onStarted).toHaveBeenCalledTimes(1) })
    const run = calls.find(call => pathOf(call.url) === '/api/agentops/workflow-run')
    expect(JSON.parse(requestBody(run?.init))).toEqual({ workflowId: 'plain', inputs: {} })
    expect(onStarted).toHaveBeenCalledWith({
      ok: true,
      sessionId: 'session-1',
      workflowId: 'plain',
    })
  })

  it('preserves false, zero, an empty array, and an explicit empty string', async () => {
    const inputs = [
      { name: 'enabled', type: 'boolean', required: false, defaultValue: false },
      { name: 'retries', type: 'integer', required: false, defaultValue: 0 },
      { name: 'tags', type: 'array', required: false, defaultValue: [] },
      { name: 'note', type: 'string', required: false, defaultValue: '' },
    ] as const
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflow-run-hint') return hintResponse('values', inputs)
      if (path === '/api/agentops/workflow-run') {
        return jsonResponse({ ok: true, sessionId: 'session-2', workflowId: 'values' })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderForm(entry('values', inputs))

    const enabled = await screen.findByRole('combobox', { name: /enabled/ })
    await waitFor(() => { expect((enabled as HTMLSelectElement).value).toBe('false') })
    expect(fieldValue(/retries/)).toBe('0')
    expect(fieldValue(/tags/)).toBe('[]')
    expect(fieldValue(/note/)).toBe('')

    fireEvent.click(screen.getByRole('button', { name: t('page.run.start') }))
    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-run')).toHaveLength(1)
    })
    const run = calls.find(call => pathOf(call.url) === '/api/agentops/workflow-run')
    expect(JSON.parse(requestBody(run?.init))).toEqual({
      workflowId: 'values',
      inputs: { enabled: false, retries: 0, tags: [], note: '' },
    })
  })

  it('reports required, integer, finite-number, and JSON-array problems beside fields', async () => {
    const inputs = [
      { name: 'level', type: 'string', required: true },
      { name: 'retries', type: 'integer', required: true },
      { name: 'ratio', type: 'number', required: false },
      { name: 'tags', type: 'array', required: true },
      { name: 'enabled', type: 'boolean', required: true },
    ] as const
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflow-run-hint') return hintResponse('validate', inputs)
      throw new Error(`unexpected request ${url}`)
    })
    renderForm(entry('validate', inputs))

    fireEvent.change(await screen.findByRole('textbox', { name: /level/ }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: /retries/ }), { target: { value: '1.5' } })
    fireEvent.change(screen.getByRole('textbox', { name: /ratio/ }), { target: { value: '1e999' } })
    fireEvent.change(screen.getByRole('textbox', { name: /tags/ }), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: t('page.run.start') }))

    expect(await screen.findByText(t('page.run.invalidRequired', { name: 'level' }))).toBeTruthy()
    expect(screen.getByText(t('page.run.invalidInteger', { name: 'retries' }))).toBeTruthy()
    expect(screen.getByText(t('page.run.invalidNumber', { name: 'ratio' }))).toBeTruthy()
    expect(screen.getByText(t('page.run.invalidArray', { name: 'tags' }))).toBeTruthy()
    expect(screen.getByText(t('page.run.invalidRequired', { name: 'enabled' }))).toBeTruthy()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-run')).toHaveLength(0)
  })

  it('keeps the dialog open while starting and ignores repeat, Escape, close, and mask attempts', async () => {
    let releaseRun!: () => void
    const runPromise = new Promise<Response>((resolve) => {
      releaseRun = () => { resolve(jsonResponse({ ok: true, sessionId: 'session-3', workflowId: 'slow' })) }
    })
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflow-run-hint') return hintResponse('slow', [])
      if (path === '/api/agentops/workflow-run') return runPromise
      throw new Error(`unexpected request ${url}`)
    })
    const onStarted = vi.fn()
    const onClose = vi.fn()
    renderForm(entry('slow'), onStarted, onClose)

    await screen.findByText(t('page.run.noInputs'))
    const start = screen.getByRole('button', { name: t('page.run.start') })
    fireEvent.click(start)
    fireEvent.click(start)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: t('page.run.closeLabel') }))
    const mask = document.querySelector('[role="presentation"] > [aria-hidden="true"]')
    if (mask === null) throw new Error('expected the modal mask')
    fireEvent.click(mask)

    expect(screen.getByRole('dialog', { name: t('page.run.formTitle') })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-run')).toHaveLength(1)

    await act(async () => { releaseRun() })
    await waitFor(() => { expect(onStarted).toHaveBeenCalledTimes(1) })
  })

  it('keeps entered values and shows the host reason when a run fails', async () => {
    const inputs = [{ name: 'level', type: 'string', required: true }] as const
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflow-run-hint') return hintResponse('failed', inputs)
      if (path === '/api/agentops/workflow-run') {
        return jsonResponse({ ok: false, reason: 'session unavailable' }, 503)
      }
      throw new Error(`unexpected request ${url}`)
    })
    const onStarted = vi.fn()
    renderForm(entry('failed', inputs), onStarted)

    const level = await screen.findByRole('textbox', { name: /level/ })
    fireEvent.change(level, { target: { value: 'ERROR' } })
    fireEvent.click(screen.getByRole('button', { name: t('page.run.start') }))

    await screen.findByText(t('page.run.failed', { message: 'session unavailable' }))
    expect((level as HTMLInputElement).value).toBe('ERROR')
    expect(screen.getByRole('dialog', { name: t('page.run.formTitle') })).toBeTruthy()
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('focuses the first field after the host hint loads', async () => {
    installApi((url) => {
      if (pathOf(url) === '/api/agentops/workflow-run-hint') {
        return hintResponse('focus', [{ name: 'level', type: 'string', required: true }])
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderForm(entry('focus', [{ name: 'level', type: 'string', required: true }]))

    const level = await screen.findByRole('textbox', { name: /level/ })
    expect(level.hasAttribute('data-modal-autofocus')).toBe(true)
    await waitFor(() => { expect(document.activeElement).toBe(level) })
  })

  it('drops a hint response after the form closes', async () => {
    let releaseHint!: () => void
    const hintPromise = new Promise<Response>((resolve) => {
      releaseHint = () => { resolve(hintResponse('late', [{ name: 'level', type: 'string', required: true }])) }
    })
    installApi((url) => {
      if (pathOf(url) === '/api/agentops/workflow-run-hint') return hintPromise
      throw new Error(`unexpected request ${url}`)
    })
    function Harness(): ReactElement {
      const [open, setOpen] = useState(true)
      return open
        ? (
          <WorkflowRunForm
            t={t}
            entry={entry('late', [{ name: 'level', type: 'string', required: true }])}
            onClose={() => { setOpen(false) }}
            onStarted={() => {}}
          />
        )
        : <p>closed</p>
    }
    render(<Harness />)

    await screen.findByText(t('page.run.loading'))
    fireEvent.click(screen.getByRole('button', { name: t('page.run.cancel') }))
    await screen.findByText('closed')

    await act(async () => { releaseHint() })
    expect(screen.getByText('closed')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
