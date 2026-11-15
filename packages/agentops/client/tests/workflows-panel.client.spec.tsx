// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/locales.js'
import { WorkflowsPanel, type WorkflowsPanelProps } from '../src/client/workflows-panel.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh)
const workflowsCss = readFileSync(
  resolve(import.meta.dirname, '../src/client/styles/workflows.css'),
  'utf8',
)
const pageShellCss = readFileSync(
  resolve(import.meta.dirname, '../src/client/styles/page-shell.css'),
  'utf8',
)

function renderPanel(overrides: Partial<WorkflowsPanelProps> = {}) {
  const publishSuccess = vi.fn()
  const publishFailure = vi.fn()
  render(
    <WorkflowsPanel
      t={t}
      publishSuccess={publishSuccess}
      publishFailure={publishFailure}
      {...overrides}
    />,
  )
  return { publishSuccess, publishFailure }
}

const SOURCE = 'id: demo\nnodes:\n  - id: scan\n    type: agent\n'
const AGENT = {
  id: 'scanner',
  name: 'Scanner',
  domain: 'ops',
  description: 'reads logs',
  harness: 'deepseek',
  model: 'deepseek-chat',
  source: 'yaml',
  allowed_tools: [],
  denied_tools: [],
  knowledge_bases: [],
  timeout_seconds: 900,
  max_concurrent_runs: 2,
  cost_limit_per_run: null,
  file_name: 'scanner.yaml',
  valid: true,
  issues: [],
} as const
const AGENT_CATALOG = {
  dir: '/srv/agents',
  missing: false,
  entries: [AGENT],
}
const COMPILED = {
  source: '// compiled scan\n(async () => {})()',
  layers: [['scan']],
  digest: 'compiled-digest-1',
}
const UPDATED_COMPILED = {
  source: '// compiled scan and analyze\n(async () => {})()',
  layers: [['scan'], ['analyze']],
  digest: 'compiled-digest-2',
}
const OLD_COMPILED = {
  source: '// old compiled scan\n(async () => {})()',
  layers: [['scan']],
  digest: 'compiled-digest-old',
}
const VALID_GRAPH = {
  ok: true,
  issues: [],
  nodes: [{
    id: 'scan',
    level: 0,
    agentRef: 'scanner',
    rolePrompt: 'scan logs',
    after: [],
    inputs: [],
    outputs: {},
    timeoutMs: 1000,
  }],
  edges: [],
  dataEdges: [],
  compiled: COMPILED,
}

const SCAN_NODE = {
  id: 'scan',
  level: 0,
  agentRef: 'scanner',
  rolePrompt: 'scan logs',
  after: [],
  inputs: [],
  outputs: { records: ['analyze'] },
  timeoutMs: 1000,
} as const
const ANALYZE_NODE = {
  id: 'analyze',
  level: 1,
  agentRef: 'scanner',
  rolePrompt: 'analyze logs',
  after: ['scan'],
  inputs: ['records'],
  outputs: {},
} as const
const NO_EDGE_GRAPH = {
  nodes: [SCAN_NODE, ANALYZE_NODE],
  edges: [],
  dataEdges: [],
  compiled: UPDATED_COMPILED,
} as const
const SCHEDULE_AND_DATA_GRAPH = {
  nodes: [SCAN_NODE, ANALYZE_NODE],
  edges: [{ from: 'scan', to: 'analyze' }],
  dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
  compiled: UPDATED_COMPILED,
} as const
const AWAIT_NODE = {
  id: 'wait',
  level: 0,
  type: 'await_command',
  rolePrompt: '',
  after: [],
  inputs: [],
  outputs: {},
  awaitCommandConfig: {
    targetActors: ['manager', 'worker'],
    commandPort: 'events',
    expirySeconds: 3600,
    maxCommands: 5,
  },
} as const
const AWAIT_GRAPH = {
  ok: true,
  issues: [],
  nodes: [AWAIT_NODE],
  edges: [],
  dataEdges: [],
  compiled: COMPILED,
} as const

interface CatalogEntry {
  readonly id: string
  readonly file: string
  readonly name: string
  readonly nodeCount: number
  readonly levelCount: number
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly status: 'verified' | 'invalid'
  readonly inputs: readonly {
    readonly name: string
    readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
    readonly required: boolean
    readonly description?: string
    readonly defaultValue?: unknown
  }[]
  readonly nodes: readonly {
    readonly id: string
    readonly level: number
    readonly type: 'agent' | 'command' | 'await_command' | 'gateway' | 'parallel_branch' | 'while'
  }[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly updatedAt?: string
}

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

const WORKFLOW_NODE_DRAG_MIME = 'application/agentops-workflow-node'

function workflowNodeTransfer(type: string, mime = WORKFLOW_NODE_DRAG_MIME): DataTransfer {
  const data = new Map<string, string>([[mime, type]])
  return Object.assign({} as DataTransfer, {
    types: [mime],
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (format: string, value: string): void => { data.set(format, value) },
    getData: (format: string): string => data.get(format) ?? '',
  })
}

const EMPTY_RUN_PAGE = { runs: [], total: 0 }

function installApi(
  handler: ApiHandler,
  runsHandler: ApiHandler = () => jsonResponse(EMPTY_RUN_PAGE),
): ApiCall[] {
  const calls: ApiCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    calls.push({ url, init })
    if (pathOf(url) === '/api/agentops/agents') return jsonResponse(AGENT_CATALOG)
    if (pathOf(url) === '/api/agentops/runs') return runsHandler(url, init)
    return handler(url, init)
  }))
  return calls
}

function entry(
  id: string,
  name: string,
  inputs: CatalogEntry['inputs'] = [],
): CatalogEntry {
  return {
    id,
    file: `${id}.yaml`,
    name,
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

const CATALOG = {
  dir: '/srv/workflows',
  missing: false,
  entries: [entry('demo', 'Demo workflow'), entry('other', 'Other workflow')],
}

function catalogResponse(entries: readonly CatalogEntry[] = CATALOG.entries): Response {
  return jsonResponse({ ...CATALOG, entries })
}

function sourceResponse(text = SOURCE, digest = 'digest-1'): Response {
  return jsonResponse({ text, digest })
}

function validationRequestText(init: RequestInit | undefined): string {
  return (JSON.parse(requestBody(init)) as { text: string }).text
}

interface WorkflowEditRequest {
  readonly text: string
  readonly operation: unknown
}

function editRequest(init: RequestInit | undefined): WorkflowEditRequest {
  return JSON.parse(requestBody(init)) as WorkflowEditRequest
}

function editResponse(
  text: string,
  graph: {
    readonly nodes: readonly unknown[]
    readonly edges: readonly unknown[]
    readonly dataEdges: readonly unknown[]
    readonly compiled?: unknown
  },
): Response {
  return jsonResponse({ ok: true, text, issues: [], compiled: COMPILED, ...graph })
}

function graphName(id: string, nodes: number, edges: number): string {
  return t('page.graphAria', { id, nodes: String(nodes), edges: String(edges) })
}

async function openEditor(): Promise<HTMLElement> {
  await screen.findByText('Demo workflow')
  fireEvent.click(screen.getAllByRole('button', { name: t('page.editWorkflow') })[0]!)
  return screen.findByRole('region', { name: t('page.editorAria', { id: 'demo' }) })
}

function yamlTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: t('yaml.label') }) as HTMLTextAreaElement
}

function compiledPreview(): HTMLElement {
  return screen.getByRole('region', { name: t('compiled.title') })
}

describe('workflows panel recent runs', () => {
  it('shows the latest run or an explicit never-run state in cards and table rows', async () => {
    const calls = installApi(
      (url) => {
        const path = pathOf(url)
        if (path === '/api/agentops/workflows') return catalogResponse()
        throw new Error(`unexpected request ${url}`)
      },
      (url) => {
        const workflowId = new URL(url, 'http://localhost').searchParams.get('workflowId')
        if (workflowId === 'demo') {
          return jsonResponse({
            runs: [{
              runId: 'run-demo-latest',
              workflowId: 'demo',
              status: 'completed',
              startedAt: '2026-10-30T08:09:10.000Z',
            }],
            total: 1,
          })
        }
        return jsonResponse(EMPTY_RUN_PAGE)
      },
    )
    renderPanel()

    await screen.findByText('Demo workflow')
    expect(screen.getAllByRole('button', { name: t('page.editWorkflow') })[0]?.textContent)
      .toContain(t('page.editWorkflow'))
    await waitFor(() => {
      const demo = document.querySelector('[data-workflow-id="demo"] .wfx-last-run')
      const other = document.querySelector('[data-workflow-id="other"] .wfx-last-run')
      expect(demo?.textContent).toContain(t('page.history.status.completed'))
      expect(demo?.textContent).toContain(t('page.lastRunAt', { time: '2026-10-30 08:09:10' }))
      expect(other?.textContent).toContain(t('page.neverRun'))
    })
    const recentRequests = calls.filter((call) => {
      if (pathOf(call.url) !== '/api/agentops/runs') return false
      const params = new URL(call.url, 'http://localhost').searchParams
      return params.get('limit') === '1'
    })
    expect(recentRequests.map(call => new URL(call.url, 'http://localhost').searchParams.get('workflowId')))
      .toEqual(['demo', 'other'])

    fireEvent.click(screen.getByRole('button', { name: t('page.viewTable') }))
    expect(screen.getAllByRole('button', { name: t('page.editWorkflow') })[0]?.textContent)
      .toContain(t('page.editWorkflow'))
    const demoRow = screen.getByText('Demo workflow').closest('tr')
    const otherRow = screen.getByText('Other workflow').closest('tr')
    expect(demoRow?.textContent).toContain(t('page.history.status.completed'))
    expect(otherRow?.textContent).toContain(t('page.neverRun'))
  })

  it('isolates a failed recent-run request from other workflows and history loading', async () => {
    const calls = installApi(
      (url) => {
        const path = pathOf(url)
        if (path === '/api/agentops/workflows') return catalogResponse()
        throw new Error(`unexpected request ${url}`)
      },
      (url) => {
        const params = new URL(url, 'http://localhost').searchParams
        const workflowId = params.get('workflowId')
        if (workflowId === 'demo' && params.get('limit') === '1') throw new Error('history unavailable')
        if (workflowId === 'demo') {
          return jsonResponse({
            runs: [{
              runId: 'run-from-dialog',
              workflowId: 'demo',
              status: 'failed',
              startedAt: '2026-10-30T09:00:00.000Z',
            }],
            total: 1,
          })
        }
        return jsonResponse(EMPTY_RUN_PAGE)
      },
    )
    renderPanel()

    await screen.findByText('Demo workflow')
    await waitFor(() => {
      const demo = document.querySelector('[data-workflow-id="demo"] .wfx-last-run')
      expect(demo?.textContent).toContain(t('page.lastRunFailed'))
    })
    const other = document.querySelector('[data-workflow-id="other"] .wfx-last-run')
    expect(other?.textContent).toContain(t('page.neverRun'))

    fireEvent.click(screen.getAllByRole('button', { name: t('page.history') })[0]!)
    expect(await screen.findByText('run-from-dialog')).toBeTruthy()
    const dialogRequests = calls.filter((call) => {
      if (pathOf(call.url) !== '/api/agentops/runs') return false
      const params = new URL(call.url, 'http://localhost').searchParams
      return params.get('workflowId') === 'demo' && params.get('limit') === null
    })
    expect(dialogRequests).toHaveLength(1)
    expect(document.querySelector('[data-workflow-id="demo"] .wfx-last-run')?.textContent)
      .toContain(t('page.lastRunFailed'))
  })
})

describe('workflows panel YAML editor', () => {
  it('keeps the body-portaled editor inside the AgentOps theme scope', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    const editor = await openEditor()

    const dialog = editor.closest('[role="dialog"]')
    expect(dialog?.classList.contains('agentops-theme-scope')).toBe(true)
    expect(dialog?.classList.contains('agentops-surface')).toBe(false)
  })

  it('selects by catalog id and keeps the open editor mounted when search hides its card', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    const search = screen.getByRole('textbox', { name: t('page.search') })
    fireEvent.change(search, { target: { value: 'no matching workflow' } })

    expect(screen.getByRole('region', { name: t('page.editorAria', { id: 'demo' }) })).toBeDefined()
    expect(screen.getByText('Demo workflow')).toBeDefined()
  })

  it('loads exact source before validating it when the editor opens', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-source')).toHaveLength(1)
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-validate')).toHaveLength(1)
    })
    const editorCalls = calls
      .map(call => pathOf(call.url))
      .filter(path => path === '/api/agentops/workflow-source' || path === '/api/agentops/workflow-validate')
    expect(editorCalls).toEqual([
      '/api/agentops/workflow-source',
      '/api/agentops/workflow-validate',
    ])
  })

  it('shows generated source, layers, digest, and compiler limitations', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))

    const preview = await screen.findByRole('region', { name: t('compiled.title') })
    expect(preview.textContent).toContain(COMPILED.source)
    expect(preview.textContent).toContain(t('compiled.layer', { level: '0' }))
    expect(preview.textContent).toContain('scan')
    expect(preview.textContent).toContain(COMPILED.digest)
    expect(preview.textContent).toContain(t('compiled.limitation.dataPorts'))
    expect(preview.textContent).toContain(t('compiled.limitation.retryTimeout'))
    expect(preview.textContent).toContain(t('compiled.limitation.ptc'))
    expect(preview.textContent).toContain(t('compiled.limitation.yamlAuthority'))
  })

  it('refreshes the compiled preview after a draft validates successfully', async () => {
    installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        return jsonResponse(validationRequestText(init) === SOURCE
          ? VALID_GRAPH
          : { ...VALID_GRAPH, compiled: UPDATED_COMPILED })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    await waitFor(() => { expect(compiledPreview().textContent).toContain(COMPILED.digest) })

    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# refreshed\n` } })
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    expect(screen.getByText(t('compiled.stale'))).toBeDefined()

    await waitFor(() => {
      expect(compiledPreview().textContent).toContain(UPDATED_COMPILED.source)
      expect(compiledPreview().textContent).toContain(UPDATED_COMPILED.digest)
      expect(screen.queryByText(t('compiled.stale'))).toBeNull()
    }, { timeout: 800 })
  })

  it('keeps the newest compiled preview when an older validation response arrives later', async () => {
    let releaseOld!: () => void
    const oldResult = new Promise<Response>((resolve) => {
      releaseOld = () => { resolve(jsonResponse({ ...VALID_GRAPH, compiled: OLD_COMPILED })) }
    })
    const calls = installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        const text = validationRequestText(init)
        if (text === `${SOURCE}# old compiled\n`) return oldResult
        if (text === `${SOURCE}# new compiled\n`) {
          return jsonResponse({ ...VALID_GRAPH, compiled: UPDATED_COMPILED })
        }
        return jsonResponse(VALID_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))

    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# old compiled\n` } })
    await waitFor(() => {
      expect(calls.some(call =>
        pathOf(call.url) === '/api/agentops/workflow-validate'
        && validationRequestText(call.init) === `${SOURCE}# old compiled\n`,
      )).toBe(true)
    }, { timeout: 600 })
    await new Promise(resolve => setTimeout(resolve, 380))
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# new compiled\n` } })
    await waitFor(() => {
      expect(screen.getByText(UPDATED_COMPILED.digest)).toBeDefined()
    }, { timeout: 800 })

    await act(async () => { releaseOld() })
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    expect(compiledPreview().textContent).toContain(UPDATED_COMPILED.digest)
    expect(screen.queryByText(OLD_COMPILED.digest)).toBeNull()
  })

  it('waits 350 ms after a draft edit before validating it', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    await waitFor(() => { expect(screen.getByRole('textbox', { name: t('yaml.label') })).toBeDefined() })

    const before = calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-validate').length
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# edited\n` } })

    await new Promise(resolve => setTimeout(resolve, 300))
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-validate')).toHaveLength(before)
    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-validate')).toHaveLength(before + 1)
    }, { timeout: 600 })
  })

  it('ignores an older validation response after a newer draft has started validating', async () => {
    let releaseOld!: () => void
    const oldResult = new Promise<Response>((resolve) => {
      releaseOld = () => { resolve(jsonResponse({
        ok: false,
        issues: [{ path: 'nodes', message: 'old failure', line: 2 }],
      }, 422)) }
    })
    const calls = installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        const text = validationRequestText(init)
        if (text === `${SOURCE}# old\n`) return oldResult
        if (text === `${SOURCE}# new\n`) {
          return jsonResponse({
            ok: true,
            issues: [],
            nodes: [{
              id: 'new',
              level: 0,
              agentRef: 'scanner',
              rolePrompt: 'new node',
              after: [],
              inputs: [],
              outputs: {},
            }],
            edges: [],
            dataEdges: [],
            compiled: UPDATED_COMPILED,
          })
        }
        return jsonResponse(VALID_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))

    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# old\n` } })
    await waitFor(() => {
      expect(calls.some(call =>
        pathOf(call.url) === '/api/agentops/workflow-validate'
        && validationRequestText(call.init) === `${SOURCE}# old\n`,
      )).toBe(true)
    }, { timeout: 600 })
    await new Promise(resolve => setTimeout(resolve, 380))
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# new\n` } })
    await waitFor(() => { expect(screen.getByText(t('editor.valid'))).toBeDefined() }, { timeout: 800 })

    await act(async () => { releaseOld() })
    expect(screen.queryByText('old failure')).toBeNull()
    expect(screen.getByText(t('editor.valid'))).toBeDefined()
  })

  it('clears a validation request error after the next validation succeeds', async () => {
    installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        if (validationRequestText(init) === `${SOURCE}# broken\n`) throw new Error('network down')
        return jsonResponse(VALID_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))

    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# broken\n` } })
    const errorText = t('editor.loadFailed', { message: 'network down' })
    await screen.findByText(errorText, undefined, { timeout: 800 })
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# recovered\n` } })

    await waitFor(() => {
      expect(screen.queryByText(errorText)).toBeNull()
      expect(screen.getByText(t('editor.valid'))).toBeDefined()
    }, { timeout: 800 })
  })
  it('blocks saving after a 409 conflict until the latest source is reloaded', async () => {
    let sourceLoads = 0
    const diskSource = `${SOURCE}# disk change\n`
    const calls = installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') {
        sourceLoads += 1
        return sourceLoads === 1
          ? sourceResponse(SOURCE, 'digest-1')
          : sourceResponse(diskSource, 'disk-digest')
      }
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-save') {
        const expectedDigest = (JSON.parse(requestBody(init)) as { expectedDigest: string }).expectedDigest
        return expectedDigest === 'digest-1'
          ? jsonResponse({ actualDigest: 'disk-digest' }, 409)
          : jsonResponse({ digest: 'digest-2' })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    const draft = `${SOURCE}# conflict draft\n`
    fireEvent.change(yamlTextarea(), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await screen.findByText(t('editor.conflict'))
    expect(yamlTextarea().value).toBe(draft)
    expect(screen.getByText(t('editor.digest', { digest: 'digest-1' }))).toBeDefined()
    const saveButton = screen.getByRole('button', { name: t('editor.save') }) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    fireEvent.click(saveButton)
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-save')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '重新加载磁盘源码' }))
    await waitFor(() => { expect(yamlTextarea().value).toBe(diskSource) })
    expect(screen.getByText(t('editor.digest', { digest: 'disk-digest' }))).toBeDefined()
    const reloadedSaveButton = screen.getByRole('button', { name: t('editor.save') }) as HTMLButtonElement
    expect(reloadedSaveButton.disabled).toBe(false)
    fireEvent.click(reloadedSaveButton)
    await screen.findByText(t('editor.saved'))
    expect(publishSuccess).toHaveBeenCalledWith(t('page.saved', { id: 'demo' }))
    const saves = calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-save')
    expect(saves).toHaveLength(2)
    expect(JSON.parse(requestBody(saves[1]?.init))).toMatchObject({ expectedDigest: 'disk-digest' })
  })

  it('keeps the draft and displays issues when save returns 422', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-save') {
        return jsonResponse({
          ok: false,
          issues: [{ path: 'nodes[0].after', message: 'cycle detected', kind: 'cycle', line: 3, nodeIds: ['scan'] }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    const draft = `${SOURCE}# invalid save\n`
    fireEvent.change(yamlTextarea(), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await screen.findByText('cycle detected')
    expect(yamlTextarea().value).toBe(draft)
  })

  it('opens YAML and selects the first validation issue from the editor summary', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        return jsonResponse({
          ok: false,
          issues: [{ path: 'nodes[0]', message: 'missing agent', line: 3, column: 3 }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    await waitFor(() => { expect(screen.getByText(t('editor.invalid'))).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: t('editor.viewIssues', { count: '1' }) }))

    expect(screen.getByRole('tab', { name: t('editor.tab.yaml') }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(yamlTextarea()) })
    expect(yamlTextarea().selectionStart).toBeLessThan(yamlTextarea().selectionEnd)
  })

  it('keeps the last successful graph and marks it stale after validation fails', async () => {
    installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        if (validationRequestText(init) === SOURCE) return jsonResponse(VALID_GRAPH)
        return jsonResponse({
          ok: false,
          issues: [{ path: 'nodes', message: 'new validation failure', line: 2 }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# broken\n` } })
    await waitFor(() => { expect(screen.getByText('new validation failure')).toBeDefined() }, { timeout: 800 })
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.canvas') }))

    const graph = screen.getByRole('group', {
      name: t('page.graphAria', { id: 'demo', nodes: '1', edges: '0' }),
    })
    expect(graph.textContent).toContain('scan')
    expect(screen.getByText(t('editor.stale'))).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    expect(compiledPreview().textContent).toContain(COMPILED.digest)
    expect(screen.getByText(t('compiled.stale'))).toBeDefined()
  })

  it('treats non-blocking validation issues as valid and keeps canvas editing enabled', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        return jsonResponse({
          ...VALID_GRAPH,
          issues: [{ path: 'nodes[0].role_prompt', message: 'consider a shorter prompt', kind: 'hint' }],
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    await waitFor(() => {
      expect(screen.getByText(t('editor.validWithHints', { count: '1' }))).toBeDefined()
    })
    expect(screen.getByRole('button', { name: t('editor.viewHints', { count: '1' }) })).toBeDefined()
    expect(screen.queryByText(t('editor.stale'))).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.from') }), {
      target: { value: 'scan' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.to') }), {
      target: { value: 'scan' },
    })
    expect(screen.getByRole('button', { name: t('canvas.inspector.addEdge') }).hasAttribute('disabled')).toBe(false)
  })

  it('does not synthesize an empty graph when the initial source is invalid', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') {
        return jsonResponse({ ok: false, issues: [{ path: 'workflow', message: 'invalid root' }] }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    expect(screen.getByText(t('editor.graphUnavailable'))).toBeDefined()
    expect(screen.queryByRole('group', { name: t('page.graphAria', { id: 'demo', nodes: '0', edges: '0' }) })).toBeNull()
    expect(screen.queryByText(t('page.graphEmpty'))).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    expect(screen.getByText(t('compiled.empty'))).toBeDefined()
    expect(screen.queryByText(COMPILED.source)).toBeNull()
  })

  it('refreshes the workflow catalog after a successful save', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-save') return jsonResponse({ digest: 'digest-2' })
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    fireEvent.change(yamlTextarea(), { target: { value: `${SOURCE}# saved\n` } })
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await screen.findByText(t('editor.saved'))
    expect(publishSuccess).toHaveBeenCalledWith(t('page.saved', { id: 'demo' }))
    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflows')).toHaveLength(2)
    })
  })

  it('highlights cycle nodes and selects the reported source line when its issue is chosen', async () => {
    const initialSource = 'id: demo\nnodes:\n  - id: scan\n  - id: analyze\n    after: [scan]\n'
    const cycleSource = 'id: demo\nnodes:\n  - id: scan\n    after: [analyze]\n  - id: analyze\n    after: [scan]\n'
    installApi((url, init) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse(initialSource)
      if (path === '/api/agentops/workflow-validate') {
        if (validationRequestText(init) === initialSource) {
          return jsonResponse({
            ok: true,
            issues: [],
            compiled: COMPILED,
            nodes: [
              {
                id: 'scan',
                level: 0,
                agentRef: 'scanner',
                rolePrompt: 'scan logs',
                after: [],
                inputs: [],
                outputs: {},
              },
              {
                id: 'analyze',
                level: 1,
                agentRef: 'scanner',
                rolePrompt: 'analyze logs',
                after: ['scan'],
                inputs: [],
                outputs: {},
              },
            ],
            edges: [{ from: 'scan', to: 'analyze' }],
            dataEdges: [],
          })
        }
        return jsonResponse({
          ok: false,
          issues: [{
            path: 'nodes[0].after',
            message: 'cycle detected',
            kind: 'cycle',
            line: 4,
            column: 5,
            nodeIds: ['scan', 'analyze'],
            cycle: ['scan', 'analyze', 'scan'],
          }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    fireEvent.change(yamlTextarea(), { target: { value: cycleSource } })
    await screen.findByText('cycle detected', undefined, { timeout: 800 })
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.canvas') }))

    await waitFor(() => {
      const highlighted = screen.getByRole('group', {
        name: t('page.graphAria', { id: 'demo', nodes: '2', edges: '1' }),
      }).querySelectorAll('.dag-canvas-node-highlighted')
      expect(highlighted).toHaveLength(2)
    })
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    fireEvent.click(screen.getByRole('button', { name: /cycle detected/ }))

    await waitFor(() => { expect(document.activeElement).toBe(yamlTextarea()) })
    expect(yamlTextarea().selectionStart).toBe(cycleSource.indexOf('    after'))
  })

  it('opens the run form immediately and starts with the submitted inputs', async () => {
    let releaseHint!: () => void
    const hintPromise = new Promise<Response>((resolve) => {
      releaseHint = () => {
        resolve(jsonResponse({
          workflowId: 'demo',
          prompt: 'run demo',
          reason: 'needs an Agent session',
          inputs: [],
        }))
      }
    })
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-run-hint') return hintPromise
      if (path === '/api/agentops/workflow-run') {
        return jsonResponse({ ok: true, sessionId: 'session-1', workflowId: 'demo' })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()
    await screen.findByText('Demo workflow')

    fireEvent.click(screen.getAllByRole('button', { name: t('page.run') })[0]!)
    expect(screen.getByRole('dialog', { name: t('page.run.formTitle') })).toBeTruthy()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-run')).toHaveLength(0)

    await act(async () => { releaseHint() })
    await screen.findByText(t('page.run.noInputs'))
    fireEvent.click(screen.getByRole('button', { name: t('page.run.start') }))
    await waitFor(() => {
      expect(publishSuccess).toHaveBeenCalledWith(t('page.run.started', { id: 'session-1' }))
    })
    const run = calls.find(call => pathOf(call.url) === '/api/agentops/workflow-run')
    expect(JSON.parse(requestBody(run?.init))).toEqual({ workflowId: 'demo', inputs: {} })
  })

  it('keeps Copy instruction working', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-run-hint') {
        return jsonResponse({
          workflowId: 'demo',
          prompt: 'run demo',
          reason: 'needs an Agent session',
          inputs: [],
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()
    await screen.findByText('Demo workflow')

    fireEvent.click(screen.getAllByRole('button', { name: t('page.copyInstruction') })[0]!)
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('run demo') })
    await waitFor(() => { expect(publishSuccess).toHaveBeenCalledWith(t('page.copy.done', { id: 'demo' })) })
  })

  it('ignores a source response that arrives after the editor closes', async () => {
    let releaseSource!: () => void
    const sourcePromise = new Promise<Response>((resolve) => {
      releaseSource = () => { resolve(sourceResponse()) }
    })
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourcePromise
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await screen.findByText('Demo workflow')
    fireEvent.click(screen.getAllByRole('button', { name: t('page.editWorkflow') })[0]!)
    await waitFor(() => { expect(calls.some(call => pathOf(call.url) === '/api/agentops/workflow-source')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: t('page.closeEditor') }))

    await act(async () => { releaseSource() })
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-validate')).toHaveLength(0)
    expect(screen.queryByRole('region', { name: t('page.editorAria', { id: 'demo' }) })).toBeNull()
  })
})

describe('workflows panel canvas editor', () => {
  it('shows all six node templates and switches the add form', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const templates = [
      t('canvas.nodeType.agent'),
      t('canvas.nodeType.command'),
      t('canvas.nodeType.awaitCommand'),
      t('canvas.nodeType.gateway'),
      t('canvas.nodeType.parallelBranch'),
      t('canvas.nodeType.while'),
    ]
    for (const label of templates) {
      expect(within(library).getByRole('button', {
        name: t('canvas.library.selectTemplate', { type: label }),
      })).toBeDefined()
    }

    expect(within(library).getByRole('button', { name: /Scanner/ })).toBeDefined()
    expect(within(library).getByRole('textbox', { name: t('canvas.library.rolePrompt') })).toBeDefined()

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.command') }),
    }))
    expect(within(library).getByRole('textbox', { name: t('canvas.library.cliTemplate') })).toBeDefined()
    expect(within(library).queryByRole('textbox', { name: t('canvas.library.rolePrompt') })).toBeNull()
    expect(within(library).queryByRole('button', { name: /Scanner/ })).toBeNull()

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.awaitCommand') }),
    }))
    expect(within(library).getByText(t('canvas.library.agentOnlyNotice'))).toBeDefined()
    expect(within(library).queryByRole('textbox', { name: t('canvas.library.cliTemplate') })).toBeNull()
    const awaitTargets = within(library).getByRole('textbox', {
      name: t('canvas.library.awaitTargets'),
    }) as HTMLTextAreaElement
    const awaitCommandPort = within(library).getByRole('textbox', {
      name: t('canvas.library.awaitCommandPort'),
    }) as HTMLInputElement
    const awaitExpiry = within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitExpirySeconds'),
    }) as HTMLInputElement
    const awaitMaxCommands = within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitMaxCommands'),
    }) as HTMLInputElement
    expect(awaitTargets.value).toBe('')
    expect(awaitCommandPort.value).toBe('command')
    expect(awaitExpiry.value).toBe('86400')
    expect(awaitMaxCommands.value).toBe('10')

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.gateway') }),
    }))
    expect(within(library).getByRole('textbox', { name: t('canvas.library.condition') })).toBeDefined()

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.parallelBranch') }),
    }))
    expect(within(library).getByRole('textbox', { name: t('canvas.library.branches') })).toBeDefined()

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.while') }),
    }))
    expect(within(library).getByRole('textbox', { name: t('canvas.library.body') })).toBeDefined()
    expect(within(library).getByRole('textbox', { name: t('canvas.library.continueIf') })).toBeDefined()
    expect(within(library).getByRole('spinbutton', { name: t('canvas.library.maxIterations') })).toBeDefined()
  })

  it('orders control flow templates from loop to gateway', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const controlHeading = within(library).getByRole('heading', {
      level: 4,
      name: t('canvas.library.group.control'),
    })
    const controlGroup = controlHeading.closest('section')
    expect(controlGroup).not.toBeNull()
    if (controlGroup === null) throw new Error('expected control flow group')

    expect(within(controlGroup).getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual([
        t('canvas.library.selectTemplate', { type: t('canvas.nodeType.while') }),
        t('canvas.library.selectTemplate', { type: t('canvas.nodeType.parallelBranch') }),
        t('canvas.library.selectTemplate', { type: t('canvas.nodeType.gateway') }),
      ])
  })

  it('writes the workflow node drag payload as a copy operation', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const template = within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.command') }),
    })
    const transfer = workflowNodeTransfer('')

    fireEvent.dragStart(template, { dataTransfer: transfer })

    expect(transfer.getData(WORKFLOW_NODE_DRAG_MIME)).toBe('command')
    expect(transfer.effectAllowed).toBe('copy')
  })

  it('selects a dragged template without submitting a canvas edit', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 1, 0) })
    const stage = document.querySelector<HTMLElement>('.workflow-canvas-stage')
    expect(stage).not.toBeNull()
    if (stage === null) throw new Error('expected canvas stage')
    const transfer = workflowNodeTransfer('command')

    fireEvent.dragOver(stage, { dataTransfer: transfer })
    expect(stage.classList.contains('is-drop-target')).toBe(true)
    expect(screen.getByText('松开以选择该节点模板')).toBeDefined()
    expect(transfer.dropEffect).toBe('copy')

    fireEvent.drop(stage, { dataTransfer: transfer })

    await waitFor(() => {
      expect(document.querySelector('.workflow-canvas-stage')?.classList.contains('is-drop-target')).toBe(false)
      expect(screen.getByText('已选择命令模板，填写配置后添加')).toBeDefined()
    })
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const commandTemplate = within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.command') }),
    })
    const nodeIdInput = within(library).getByRole('textbox', { name: t('canvas.library.nodeId') })
    expect(commandTemplate.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(nodeIdInput) })
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')).toHaveLength(0)
  })

  it('rejects invalid drag data and clears the drop highlight on leave', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 1, 0) })
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const gatewayTemplate = within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.gateway') }),
    })
    fireEvent.click(gatewayTemplate)
    const stage = document.querySelector<HTMLElement>('.workflow-canvas-stage')
    expect(stage).not.toBeNull()
    if (stage === null) throw new Error('expected canvas stage')

    fireEvent.dragOver(stage, { dataTransfer: workflowNodeTransfer('command', 'text/plain') })
    expect(stage.classList.contains('is-drop-target')).toBe(false)

    const validMime = workflowNodeTransfer('command')
    fireEvent.dragOver(stage, { dataTransfer: validMime })
    expect(stage.classList.contains('is-drop-target')).toBe(true)
    fireEvent.dragLeave(stage)
    expect(stage.classList.contains('is-drop-target')).toBe(false)
    expect(screen.queryByText('松开以选择该节点模板')).toBeNull()

    fireEvent.dragOver(stage, { dataTransfer: validMime })
    fireEvent.drop(stage, { dataTransfer: workflowNodeTransfer('unknown') })

    expect(gatewayTemplate.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/已选择.*模板，填写配置后添加/)).toBeNull()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')).toHaveLength(0)
  })

  it('submits all six node types with normalized list fields', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-edit') return editResponse(SOURCE, VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const editCalls = (): readonly ApiCall[] => calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')
    const choose = (typeLabel: string): void => {
      fireEvent.click(within(library).getByRole('button', {
        name: t('canvas.library.selectTemplate', { type: typeLabel }),
      }))
    }
    const setNodeId = (id: string): void => {
      fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.nodeId') }), {
        target: { value: id },
      })
    }
    const submit = (): void => {
      fireEvent.click(within(library).getByRole('button', { name: t('canvas.library.addNode') }))
    }

    setNodeId('agent-node')
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.rolePrompt') }), {
      target: { value: 'Run the agent' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(1) })

    choose(t('canvas.nodeType.command'))
    setNodeId('command-node')
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.cliTemplate') }), {
      target: { value: 'git status' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(2) })

    choose(t('canvas.nodeType.awaitCommand'))
    setNodeId('await-node')
    fireEvent.change(within(library).getByRole('textbox', {
      name: t('canvas.library.awaitTargets'),
    }), {
      target: { value: 'manager, worker\n manager' },
    })
    fireEvent.change(within(library).getByRole('textbox', {
      name: t('canvas.library.awaitCommandPort'),
    }), {
      target: { value: 'events' },
    })
    fireEvent.change(within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitExpirySeconds'),
    }), {
      target: { value: '3600' },
    })
    fireEvent.change(within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitMaxCommands'),
    }), {
      target: { value: '5' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(3) })

    choose(t('canvas.nodeType.gateway'))
    setNodeId('gateway-node')
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.condition') }), {
      target: { value: 'status === "failed"' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(4) })

    choose(t('canvas.nodeType.parallelBranch'))
    setNodeId('parallel-node')
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.branches') }), {
      target: { value: 'lint, test\n test build' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(5) })

    choose(t('canvas.nodeType.while'))
    setNodeId('while-node')
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.body') }), {
      target: { value: 'analyze  revise\nanalyze' },
    })
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.continueIf') }), {
      target: { value: 'attempt < 3' },
    })
    fireEvent.change(within(library).getByRole('spinbutton', { name: t('canvas.library.maxIterations') }), {
      target: { value: '4' },
    })
    submit()
    await waitFor(() => { expect(editCalls()).toHaveLength(6) })

    expect(editCalls().map(call => editRequest(call.init).operation)).toEqual([
      { kind: 'add-node', id: 'agent-node', agent: 'scanner', rolePrompt: 'Run the agent' },
      { kind: 'add-node', id: 'command-node', type: 'command', cliTemplate: 'git status' },
      {
        kind: 'add-node',
        id: 'await-node',
        type: 'await_command',
        targetActors: ['manager', 'worker'],
        commandPort: 'events',
        expirySeconds: 3600,
        maxCommands: 5,
      },
      { kind: 'add-node', id: 'gateway-node', type: 'gateway', condition: 'status === "failed"' },
      { kind: 'add-node', id: 'parallel-node', type: 'parallel_branch', branches: ['lint', 'test', 'build'] },
      {
        kind: 'add-node',
        id: 'while-node',
        type: 'while',
        body: ['analyze', 'revise'],
        continueIf: 'attempt < 3',
        maxIterations: 4,
      },
    ])
  })

  it('filters node templates by label, description, and type', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const search = within(library).getByRole('searchbox', { name: t('canvas.library.searchLabel') })
    const awaitTemplate = (): HTMLElement | null => within(library).queryByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.awaitCommand') }),
    })

    fireEvent.change(search, { target: { value: t('canvas.nodeType.awaitCommand') } })
    expect(awaitTemplate()).not.toBeNull()
    expect(within(library).queryByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.agent') }),
    })).toBeNull()

    fireEvent.change(search, {
      target: { value: t('canvas.library.template.awaitCommand.description') },
    })
    expect(awaitTemplate()).not.toBeNull()

    fireEvent.change(search, { target: { value: 'await_command' } })
    expect(awaitTemplate()).not.toBeNull()

    fireEvent.change(search, { target: { value: 'no-such-template' } })
    expect(awaitTemplate()).toBeNull()
    expect(within(library).getByText(t('canvas.library.searchEmpty'))).toBeDefined()
    expect(within(library).queryByRole('form', { name: t('canvas.library.addNode') })).toBeNull()

    fireEvent.click(within(library).getByRole('button', { name: t('canvas.library.clearSearch') }))
    expect((search as HTMLInputElement).value).toBe('')
    expect(within(library).getByRole('form', { name: t('canvas.library.addNode') })).toBeDefined()
    for (const label of [
      t('canvas.nodeType.agent'),
      t('canvas.nodeType.command'),
      t('canvas.nodeType.awaitCommand'),
      t('canvas.nodeType.gateway'),
      t('canvas.nodeType.parallelBranch'),
      t('canvas.nodeType.while'),
    ]) {
      expect(within(library).getByRole('button', {
        name: t('canvas.library.selectTemplate', { type: label }),
      })).toBeDefined()
    }
  })

  it('submits the default await command settings', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-edit') return editResponse(SOURCE, VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.awaitCommand') }),
    }))
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.nodeId') }), {
      target: { value: 'await-node' },
    })
    fireEvent.click(within(library).getByRole('button', { name: t('canvas.library.addNode') }))

    const editCalls = calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')
    await waitFor(() => { expect(editCalls).toHaveLength(1) })
    expect(editRequest(editCalls[0]?.init).operation).toEqual({
      kind: 'add-node',
      id: 'await-node',
      type: 'await_command',
      targetActors: [],
      commandPort: 'command',
      expirySeconds: 86400,
      maxCommands: 10,
    })
  })

  it('rejects invalid await command limits before sending an edit', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-edit') return editResponse(SOURCE, VALID_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })
    const editCalls = (): readonly ApiCall[] => calls.filter(
      call => pathOf(call.url) === '/api/agentops/workflow-edit',
    )

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.awaitCommand') }),
    }))
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.nodeId') }), {
      target: { value: 'await-node' },
    })
    const expiry = within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitExpirySeconds'),
    })
    const maxCommands = within(library).getByRole('spinbutton', {
      name: t('canvas.library.awaitMaxCommands'),
    })
    const submit = (): void => {
      fireEvent.click(within(library).getByRole('button', { name: t('canvas.library.addNode') }))
    }

    fireEvent.change(expiry, { target: { value: '0' } })
    submit()
    expect(within(library).getByText(t('canvas.library.invalidAwaitNumber'))).toBeDefined()
    expect(editCalls()).toHaveLength(0)

    fireEvent.change(expiry, { target: { value: '86400' } })
    fireEvent.change(maxCommands, { target: { value: '0' } })
    submit()
    expect(within(library).getByText(t('canvas.library.invalidAwaitNumber'))).toBeDefined()
    expect(editCalls()).toHaveLength(0)
  })

  it('rejects a second await command node without sending an edit', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(AWAIT_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    const library = screen.getByRole('complementary', { name: t('canvas.library.title') })

    fireEvent.click(within(library).getByRole('button', {
      name: t('canvas.library.selectTemplate', { type: t('canvas.nodeType.awaitCommand') }),
    }))
    fireEvent.change(within(library).getByRole('textbox', { name: t('canvas.library.nodeId') }), {
      target: { value: 'second-wait' },
    })
    fireEvent.click(within(library).getByRole('button', { name: t('canvas.library.addNode') }))

    expect(within(library).getByText(t('canvas.library.duplicateAwait'))).toBeDefined()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')).toHaveLength(0)
  })

  it('shows await command settings as inspector fields instead of JSON', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(AWAIT_GRAPH)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 1, 0) })
    fireEvent.click(screen.getByRole('button', {
      name: t('canvas.nodeAria', { id: 'wait', level: '0' }),
    }))

    const inspector = screen.getByRole('region', { name: t('canvas.inspector.node') })
    expect(inspector.textContent).toContain(t('canvas.inspector.targetActors'))
    expect(inspector.textContent).toContain('manager, worker')
    expect(inspector.textContent).toContain(t('canvas.inspector.commandPort'))
    expect(inspector.textContent).toContain('events')
    expect(inspector.textContent).toContain(t('canvas.inspector.expirySeconds'))
    expect(inspector.textContent).toContain('3600')
    expect(inspector.textContent).toContain(t('canvas.inspector.maxCommands'))
    expect(inspector.textContent).toContain('5')
    const configBlock = within(inspector)
      .getByText(t('canvas.inspector.awaitCommandConfig'))
      .closest('.workflow-inspector-block')
    expect(configBlock).not.toBeNull()
    expect(configBlock?.querySelector('pre')).toBeNull()
  })
  it('shows the three-pane editor, Agent library, and applies an add-node edit', async () => {
    const edited = `${SOURCE}  - id: analyze\n    type: agent\n    agent: scanner\n    rolePrompt: analyze logs\n`
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse(VALID_GRAPH)
      if (path === '/api/agentops/workflow-edit') {
        return editResponse(edited, NO_EDGE_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()

    await screen.findByRole('group', { name: graphName('demo', 1, 0) })
    const inspector = screen.getByRole('complementary', { name: t('canvas.inspector.title') })
    const agentButton = screen.getByRole('button', { name: /Scanner/ })
    expect(agentButton.textContent).toContain('Scanner')
    expect(agentButton.getAttribute('aria-pressed')).toBe('true')
    expect(agentButton.getAttribute('role')).toBeNull()
    expect(document.querySelector('.workflow-canvas-stage')).not.toBeNull()
    expect(inspector.textContent).toContain(t('canvas.inspector.empty'))

    fireEvent.change(screen.getByRole('textbox', { name: t('canvas.library.nodeId') }), {
      target: { value: 'analyze' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('canvas.library.rolePrompt') }), {
      target: { value: 'analyze logs' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('canvas.library.addNode') }))

    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')).toHaveLength(1)
    })
    const request = editRequest(calls.find(call => pathOf(call.url) === '/api/agentops/workflow-edit')?.init)
    expect(request.text).toBe(SOURCE)
    expect(request.operation).toEqual({
      kind: 'add-node',
      id: 'analyze',
      agent: 'scanner',
      rolePrompt: 'analyze logs',
    })
    await screen.findByRole('group', { name: graphName('demo', 2, 0) })
    expect(screen.getByRole('region', { name: t('canvas.inspector.node') }).textContent).toContain('analyze logs')

    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.compiled') }))
    await waitFor(() => { expect(compiledPreview().textContent).toContain(UPDATED_COMPILED.digest) })

    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    expect(yamlTextarea().value).toBe(edited)
  })

  it('selects a node, shows its fields, removes it, and clears the selection', async () => {
    const edited = `${SOURCE}# analyze removed\n`
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse({
        ok: true,
        issues: [],
        ...SCHEDULE_AND_DATA_GRAPH,
      })
      if (path === '/api/agentops/workflow-edit') {
        return editResponse(edited, {
          nodes: [SCAN_NODE],
          edges: [],
          dataEdges: [],
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 2, 2) })

    fireEvent.click(screen.getByRole('button', {
      name: t('canvas.nodeAria', { id: 'analyze', level: '1' }),
    }))
    const nodeInspector = screen.getByRole('region', { name: t('canvas.inspector.node') })
    expect(nodeInspector.textContent).toContain('analyze logs')
    expect(nodeInspector.textContent).toContain('records')

    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.removeNode') }))
    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')).toHaveLength(1)
    })
    expect(editRequest(calls.find(call => pathOf(call.url) === '/api/agentops/workflow-edit')?.init).operation)
      .toEqual({ kind: 'remove-node', id: 'analyze' })
    await screen.findByRole('group', { name: graphName('demo', 1, 0) })
    expect(screen.queryByRole('region', { name: t('canvas.inspector.node') })).toBeNull()
    expect(screen.getByText(t('canvas.inspector.empty'))).toBeDefined()
  })

  it('adds and removes a schedule edge through source-only edits', async () => {
    const scheduled = `${SOURCE}# schedule\n`
    const unscheduled = `${SOURCE}# unscheduled\n`
    let editCount = 0
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse({ ok: true, issues: [], ...NO_EDGE_GRAPH })
      if (path === '/api/agentops/workflow-edit') {
        editCount += 1
        return editCount === 1
          ? editResponse(scheduled, { ...NO_EDGE_GRAPH, edges: [{ from: 'scan', to: 'analyze' }] })
          : editResponse(unscheduled, NO_EDGE_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 2, 0) })

    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.from') }), {
      target: { value: 'scan' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.to') }), {
      target: { value: 'analyze' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.addEdge') }))
    await screen.findByRole('group', { name: graphName('demo', 2, 1) })

    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.removeEdge') }))
    await waitFor(() => { expect(editCount).toBe(2) })
    await screen.findByRole('group', { name: graphName('demo', 2, 0) })

    const edits = calls
      .filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')
      .map(call => editRequest(call.init))
    expect(edits.map(edit => edit.text)).toEqual([SOURCE, scheduled])
    expect(edits.map(edit => edit.operation)).toEqual([
      { kind: 'add-schedule-edge', from: 'scan', to: 'analyze' },
      { kind: 'remove-schedule-edge', from: 'scan', to: 'analyze' },
    ])
    expect(screen.getByText(t('canvas.inspector.empty'))).toBeDefined()
  })

  it('keeps the data port through keyboard selection, rendering, and removal', async () => {
    const dataAdded = `${SOURCE}# data\n`
    const dataRemoved = `${SOURCE}# data removed\n`
    let editCount = 0
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse({ ok: true, issues: [], ...NO_EDGE_GRAPH })
      if (path === '/api/agentops/workflow-edit') {
        editCount += 1
        return editCount === 1
          ? editResponse(dataAdded, {
            ...NO_EDGE_GRAPH,
            dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
          })
          : editResponse(dataRemoved, NO_EDGE_GRAPH)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 2, 0) })

    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.edgeKind') }), {
      target: { value: 'data' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.from') }), {
      target: { value: 'scan' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('canvas.inspector.to') }), {
      target: { value: 'analyze' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('canvas.inspector.port') }), {
      target: { value: 'records' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.addEdge') }))
    const dataGraph = await screen.findByRole('group', { name: graphName('demo', 2, 1) })
    expect(dataGraph.textContent).toContain('records')

    const dataEdge = screen.getByRole('button', {
      name: t('canvas.dataEdgeAria', { from: 'scan', to: 'analyze', port: 'records' }),
    })
    fireEvent.keyDown(dataEdge, { key: 'Enter' })
    expect(dataEdge.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: t('canvas.inspector.edge') }).textContent).toContain('records')

    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.removeEdge') }))
    await waitFor(() => { expect(editCount).toBe(2) })

    const edits = calls
      .filter(call => pathOf(call.url) === '/api/agentops/workflow-edit')
      .map(call => editRequest(call.init))
    expect(edits.map(edit => edit.operation)).toEqual([
      { kind: 'add-data-edge', from: 'scan', to: 'analyze', port: 'records' },
      { kind: 'remove-data-edge', from: 'scan', to: 'analyze', port: 'records' },
    ])
  })

  it('keeps the source, graph, and selection when a canvas edit is rejected', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/workflows') return catalogResponse()
      if (path === '/api/agentops/workflow-source') return sourceResponse()
      if (path === '/api/agentops/workflow-validate') return jsonResponse({
        ok: true,
        issues: [],
        ...SCHEDULE_AND_DATA_GRAPH,
      })
      if (path === '/api/agentops/workflow-edit') {
        return jsonResponse({
          ok: false,
          issues: [{ path: 'nodes.analyze', message: 'node is required', kind: 'operation' }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()
    await openEditor()
    await screen.findByRole('group', { name: graphName('demo', 2, 2) })

    fireEvent.click(screen.getByRole('button', {
      name: t('canvas.nodeAria', { id: 'analyze', level: '1' }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('canvas.inspector.removeNode') }))

    await screen.findByText(t('canvas.editRejected'))
    expect(screen.getByText(t('yaml.issue.path', {
      path: 'nodes.analyze',
      message: 'node is required',
    }))).toBeDefined()
    expect(screen.getByRole('group', { name: graphName('demo', 2, 2) })).toBeDefined()
    expect(screen.getByRole('region', { name: t('canvas.inspector.node') }).textContent).toContain('analyze logs')

    fireEvent.click(screen.getByRole('tab', { name: t('editor.tab.yaml') }))
    expect(yamlTextarea().value).toBe(SOURCE)
    const editCall = calls.find(call => pathOf(call.url) === '/api/agentops/workflow-edit')
    expect(editRequest(editCall?.init)).toEqual({
      text: SOURCE,
      operation: { kind: 'remove-node', id: 'analyze' },
    })
  })
})
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return workflowsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

function cssBlocks(header: string, source: string = workflowsCss): readonly string[] {
  const blocks: string[] = []
  let from = 0
  while (true) {
    const start = source.indexOf(header, from)
    if (start < 0) return blocks
    const open = source.indexOf('{', start + header.length)
    if (open < 0) return blocks
    let depth = 1
    let index = open + 1
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') depth -= 1
      index += 1
    }
    if (depth !== 0) return blocks
    blocks.push(source.slice(open + 1, index - 1))
    from = index
  }
}

describe('workflow editor responsive styles', () => {
  it('uses a full-size workbench instead of the primitive dialog column', () => {
    const dialogRule = cssRule('.wfx-editor-dialog')
    const editorRule = cssRule('.workflow-editor')
    const panesRule = cssRule('.workflow-editor-panes')
    const canvasPaneRule = cssRule('.workflow-editor-pane.workflow-editor-canvas-pane')
    const workbenchRule = cssRule('.workflow-canvas-workbench')
    const sideSurfaceRule = workflowsCss.match(
      /\.workflow-canvas-library,\s*\.workflow-canvas-inspector\s*\{([^}]*)\}/,
    )?.[1] ?? ''
    const stageSurfaceRule = [...workflowsCss.matchAll(/\.workflow-canvas-stage\s*\{([^}]*)\}/g)]
      .map(match => match[1] ?? '')
      .find(rule => rule.includes('border:')) ?? ''

    expect(dialogRule).toMatch(/width:\s*100%/)
    expect(dialogRule).toMatch(/max-width:\s*100%/)
    expect(dialogRule).toMatch(/height:\s*100%/)
    expect(dialogRule).toMatch(/max-height:\s*100%/)
    expect(dialogRule).toMatch(/gap:\s*0/)
    expect(dialogRule).toMatch(/padding:\s*0/)
    expect(dialogRule).toMatch(/overflow:\s*hidden/)
    expect(editorRule).toMatch(/height:\s*100%/)
    expect(editorRule).toMatch(/display:\s*flex/)
    expect(editorRule).toMatch(/background:\s*var\(--color-bg-base\)/)
    expect(panesRule).toMatch(/flex:\s*1/)
    expect(panesRule).toMatch(/min-height:\s*0/)
    expect(panesRule).toMatch(/overflow:\s*hidden/)
    expect(canvasPaneRule).toMatch(/padding:\s*0/)
    expect(canvasPaneRule).toMatch(/overflow:\s*hidden/)
    expect(workbenchRule).toMatch(/grid-template-columns:\s*minmax\(180px,\s*220px\)/)
    expect(workbenchRule).toMatch(/height:\s*100%/)
    expect(workbenchRule).toMatch(/padding:\s*12px/)
    expect(workbenchRule).toMatch(/background:\s*var\(--color-bg-base\)/)
    expect(sideSurfaceRule).toMatch(
      /border:\s*0\.5px solid var\(--color-border-subtle\)/,
    )
    expect(sideSurfaceRule).toMatch(
      /background:\s*var\(--color-bg-surface\)/,
    )
    expect(stageSurfaceRule).toMatch(
      /border:\s*0\.5px solid var\(--color-border-subtle\)/,
    )
    expect(stageSurfaceRule).toMatch(
      /background:\s*var\(--color-bg-surface\)/,
    )
  })

  it('turns the library and inspector into drawers below 900px', () => {
    const drawerRules = cssBlocks('@media (max-width: 900px)').find(block =>
      block.includes('.workflow-canvas-mobile-bar'),
    ) ?? ''

    expect(drawerRules).toMatch(/\.workflow-canvas-workbench[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(drawerRules).toMatch(/\.workflow-canvas-mobile-bar[\s\S]*display:\s*flex/)
    expect(drawerRules).toMatch(/\.workflow-canvas-scrim[\s\S]*position:\s*absolute/)
    expect(drawerRules).toMatch(/\.workflow-canvas-library,[\s\S]*position:\s*absolute/)
    expect(drawerRules).toMatch(/data-workbench-panel="library"[\s\S]*display:\s*block/)
    expect(drawerRules).toMatch(/data-workbench-panel="inspector"[\s\S]*display:\s*block/)
  })

  it('keeps the shared page header compact on narrow screens', () => {
    const compactRules = cssBlocks('@media (max-width: 640px)', pageShellCss).join('')
    const headingRule = compactRules.match(/\.ao-page-heading\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(compactRules).toMatch(/\.ao-page-header[\s\S]*flex-direction:\s*column/)
    expect(headingRule).toMatch(/flex:\s*0 0 auto/)
  })
  it('keeps the node search bounded and touch friendly', () => {
    const searchRule = cssRule('.workflow-node-template-search')
    const inputRule = cssRule('.workflow-node-template-search input')
    const clearRule = cssRule('.workflow-node-template-search button')
    const emptyRule = cssRule('.workflow-node-template-search-empty')
    const coarseRules = cssBlocks('@media (pointer: coarse)').join('')

    expect(searchRule).toMatch(/min-width:\s*0/)
    expect(inputRule).toMatch(/box-sizing:\s*border-box/)
    expect(inputRule).toMatch(/width:\s*100%/)
    expect(inputRule).toMatch(/min-width:\s*0/)
    expect(clearRule).toMatch(/width:\s*28px/)
    expect(clearRule).toMatch(/height:\s*28px/)
    expect(emptyRule).toMatch(/border:\s*1px dashed/)
    expect(coarseRules).toMatch(/\.workflow-node-template-search input,[\s\S]*font-size:\s*16px/)
    expect(coarseRules).toMatch(/\.workflow-node-template-search input\s*\{[^}]*height:\s*44px;[^}]*padding-right:\s*46px;/)
    expect(coarseRules).toMatch(/\.workflow-node-template-search button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/)
  })
  it('keeps selected editor cards opaque against the AgentOps palette', () => {
    const templateRule = cssRule('.workflow-node-template.is-active')
    const agentRule = cssRule('.workflow-agent-card.is-active')
    const opaqueSelection = /background:\s*color-mix\(in srgb, var\(--color-primary\) 16%, var\(--color-bg-elevated\)\)/

    expect(templateRule).toMatch(opaqueSelection)
    expect(agentRule).toMatch(opaqueSelection)
  })
  it('styles drag targets and hides pointer-only hints on touch devices', () => {
    const stageRule = [...workflowsCss.matchAll(/\.workflow-canvas-stage\s*\{([^}]*)\}/g)]
      .map(match => match[1] ?? '')
      .find(rule => rule.includes('border:')) ?? ''
    const targetRule = cssRule('.workflow-canvas-stage.is-drop-target')
    const feedbackRule = cssRule('.workflow-canvas-drop-feedback')
    const hintRule = cssRule('.workflow-node-template-drag-hint')
    const coarseRules = cssBlocks('@media (pointer: coarse)').join('')

    expect(stageRule).toMatch(/position:\s*relative/)
    expect(targetRule).toMatch(/border-color:\s*var\(--color-primary\)/)
    expect(targetRule).toMatch(/background:\s*color-mix\(/)
    expect(feedbackRule).toMatch(/pointer-events:\s*none/)
    expect(feedbackRule).toMatch(/border:\s*1px dashed var\(--color-primary\)/)
    expect(hintRule).toMatch(/font-size:\s*11px/)
    expect(coarseRules).toMatch(/\.workflow-node-template-drag-hint\s*\{\s*display:\s*none/)
    expect(workflowsCss).not.toMatch(/font-weight:\s*(600|700|800|900)/)
  })

  it('fits the workbench and its primary actions at 390px', () => {
    const mobileRules = cssBlocks('@media (max-width: 390px)')
    const actionRules = mobileRules.find(block => block.includes('.workflow-editor-actions')) ?? ''
    const drawerRules = mobileRules.find(block => block.includes('.workflow-canvas-library')) ?? ''
    const footerRules = mobileRules.find(block => block.includes('flex: 0 0 auto')) ?? ''

    expect(actionRules).toMatch(/\.workflow-editor-actions[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(drawerRules).toMatch(/\.workflow-canvas-library,[\s\S]*width:\s*calc\(100% - 16px\)/)
    expect(footerRules).toMatch(/\.workflow-editor-footer[\s\S]*flex:\s*0 0 auto/)
    expect(workflowsCss).not.toMatch(/font-weight:\s*(600|700|800|900)/)
  })
})
