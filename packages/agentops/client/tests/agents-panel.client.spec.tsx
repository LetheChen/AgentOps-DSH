// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import type {
  AgentCatalogEntry,
  AgentRecord,
} from '../src/client/agent-catalogue-api.js'
import { AgentsPanel } from '../src/client/agents-panel.js'
import { zh } from '../src/client/agent-locales/index.js'

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

function pathOf(url: string): string {
  return new URL(url, 'http://localhost').pathname
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  const parsed: unknown = JSON.parse(init.body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object body')
  }
  return Object.fromEntries(Object.entries(parsed))
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

function findCall(calls: readonly ApiCall[], pathname: string): ApiCall {
  const call = calls.find(item => pathOf(item.url) === pathname)
  if (call === undefined) throw new Error(`missing API call ${pathname}`)
  return call
}

function entry(
  id: string,
  name: string,
  domain: string,
  harness: string,
  description: string,
  overrides: Partial<AgentCatalogEntry> = {},
): AgentCatalogEntry {
  return {
    id,
    name,
    domain,
    description,
    harness,
    model: 'deepseek/deepseek-chat',
    source: 'yaml',
    allowed_tools: [],
    denied_tools: [],
    knowledge_bases: [],
    timeout_seconds: 0,
    max_concurrent_runs: 0,
    cost_limit_per_run: null,
    executionBackend: 'auto',
    file_name: `${id}.yaml`,
    valid: true,
    issues: [],
    ...overrides,
  }
}

const LOG_PULLER_ENTRY = entry(
  'log_puller',
  'Log puller',
  'observability',
  'local_llm',
  'Pulls production logs',
  { allowed_tools: ['read_file'], knowledge_bases: ['runbooks'], timeout_seconds: 300, cost_limit_per_run: 1 },
)

const CATALOG = {
  dir: '/srv/agents',
  missing: false,
  entries: [
    LOG_PULLER_ENTRY,
    entry('report_maker', 'Report maker', 'reporting', 'codex', 'Builds reports'),
    entry('log_writer', 'Audit log writer', 'reporting', 'local_llm', 'Writes audit logs'),
    entry('broken_agent', 'Broken agent', 'observability', 'codex', 'Cannot be edited', {
      valid: false,
      issues: ['missing tier'],
    }),
  ],
}

const MODEL_CATALOG = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General chat model' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    },
    { id: 'empty-provider', name: 'Empty provider', models: [] },
  ],
  failures: [],
}

const LOG_PULLER_RECORD: AgentRecord = {
  agentId: 'log_puller',
  displayName: 'Log puller',
  domain: 'observability',
  description: 'Pulls production logs',
  harness: 'local_llm',
  executionBackend: 'auto',
  model: 'auto',
  systemPrompt: 'Find the first failure.',
  tier: 'T1',
  execution: 'skill',
  permissions: {
    allowedTools: ['read_file'],
    deniedTools: [],
  },
  knowledgeBases: ['runbooks'],
  timeoutSeconds: 300,
  maxConcurrentRuns: 2,
  costLimitPerRun: null,
  outputFiles: { report: 'reports/analysis.md' },
}

const TOOL_CATALOG = {
  file: '/srv/mappings/tool-map.yaml',
  missing: false,
  tools: [
    {
      id: 'read_file',
      displayName: '读取文件',
      description: '读取工作区文件',
      allowedDomains: ['observability'],
      requiresHumanApproval: false,
      migrated: true,
      mappedPlugin: '@deepseek-ai/dsh-tool-fs',
      mappedTool: 'read_file',
    },
    {
      id: 'sql_query',
      displayName: 'SQL 查询',
      description: '查询审计库',
      allowedDomains: [],
      requiresHumanApproval: true,
      migrated: false,
      note: '无（DSH 侧走 sql_query）',
    },
  ],
}

const WORKFLOW_CATALOG = {
  dir: '/srv/workflows',
  missing: false,
  entries: [
    {
      id: 'log-flow',
      file: 'log-flow.yaml',
      name: 'Log flow',
      status: 'verified',
      ok: true,
      errors: [],
      nodeCount: 2,
      levelCount: 2,
      inputs: [],
      edges: [{ from: 'scan', to: 'notify' }],
      nodes: [
        {
          id: 'scan',
          level: 0,
          type: 'agent',
          agentRef: 'log_puller',
          displayName: 'Scan logs',
          businessRole: 'Observability',
        },
        {
          id: 'notify',
          level: 1,
          type: 'agent',
          agentRef: 'report_maker',
          displayName: 'Notify reporters',
          businessRole: 'Reporting',
        },
      ],
    },
    {
      id: 'broken-flow',
      file: 'broken-flow.yaml',
      name: 'Broken flow',
      status: 'invalid',
      ok: false,
      errors: ['missing command'],
      nodeCount: 1,
      levelCount: 1,
      inputs: [],
      edges: [],
      nodes: [{
        id: 'broken-scan',
        level: 0,
        type: 'agent',
        agentRef: 'log_puller',
        displayName: 'Broken scan',
        businessRole: 'Observability',
      }],
    },
  ],
} as const

function catalogFactory(catalog = CATALOG): ApiHandler {
  return (url) => {
    if (pathOf(url) === '/api/agentops/agents') return jsonResponse(catalog)
    if (pathOf(url) === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
    if (pathOf(url) === '/api/agentops/workflows') return jsonResponse(WORKFLOW_CATALOG)
    if (pathOf(url) === '/api/agentops/runs') return jsonResponse({ runs: [], total: 0 })
    throw new Error(`unexpected request ${url}`)
  }
}

function renderPanel() {
  const publishSuccess = vi.fn()
  const publishFailure = vi.fn()
  render(
    <AgentsPanel
      t={t}
      publishSuccess={publishSuccess}
      publishFailure={publishFailure}
    />,
  )
  return { publishSuccess, publishFailure }
}

function fillRequiredIdentity(domain = 'observability'): void {
  fireEvent.change(screen.getByRole('textbox', { name: t('field.agentId') }), {
    target: { value: 'log_puller' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: t('field.displayName') }), {
    target: { value: 'Log puller' },
  })
  fireEvent.change(screen.getByRole('combobox', { name: t('field.domain') }), {
    target: { value: domain },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

interface RunTotals {
  readonly all: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

function totalForStatus(status: string | null, totals: RunTotals): number {
  switch (status) {
    case null: return totals.all
    case 'running': return totals.running
    case 'completed': return totals.completed
    case 'failed': return totals.failed
    case 'cancelled': return totals.cancelled
    default: throw new Error(`unexpected run status ${status}`)
  }
}

function runHistoryHandler(
  totalsFor: (workflowId: string) => RunTotals,
  latestFor: (workflowId: string) => {
    readonly runId: string
    readonly workflowId: string
    readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
    readonly startedAt: string
  } | undefined = () => undefined,
): ApiHandler {
  return (url) => {
    if (pathOf(url) !== '/api/agentops/runs') throw new Error(`unexpected request ${url}`)
    const parsed = new URL(url, 'http://localhost')
    const workflowId = parsed.searchParams.get('workflowId')
    if (workflowId === null) throw new Error('run history request omitted workflowId')
    const status = parsed.searchParams.get('status')
    const latest = status === null ? latestFor(workflowId) : undefined
    return jsonResponse({
      total: totalForStatus(status, totalsFor(workflowId)),
      runs: latest === undefined ? [] : [latest],
    })
  }
}

async function openLogPullerEditor(): Promise<HTMLElement> {
  await screen.findByText('Log puller')
  fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
  return screen.findByRole('dialog', { name: t('editor.editTitle') })
}

function runStatValue(label: string): string | null {
  const term = screen.getByText(label, { selector: '.agx-run-stat dt' })
  return term.closest('.agx-run-stat')?.querySelector('dd')?.textContent ?? null
}

describe('Agent catalogue panel', () => {
  it('combines free-text search with Domain and Harness filters', async () => {
    installApi(catalogFactory())
    renderPanel()

    await screen.findByText('Log puller')
    expect(screen.getByText('Report maker')).toBeTruthy()
    expect(screen.getByText('Audit log writer')).toBeTruthy()
    expect(screen.getByText('$1.00')).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: t('page.openAria', { name: 'Log puller' }),
      }).textContent,
    ).toContain(t('card.manage'))

    fireEvent.change(screen.getByRole('textbox', { name: t('page.searchLabel') }), {
      target: { value: 'audit' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('page.domainFilter') }), {
      target: { value: 'reporting' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('page.harnessFilter') }), {
      target: { value: 'auto' },
    })

    expect(screen.queryByText('Log puller')).toBeNull()
    expect(screen.queryByText('Report maker')).toBeNull()
    expect(screen.getByText('Audit log writer')).toBeTruthy()
    expect(screen.getByText(t('page.count', { shown: '1', total: '4' }))).toBeTruthy()
  })

  it('offers catalogue Domains and preserves an unlisted Domain on create', async () => {
    const calls = installApi((url, init) => {
      if (pathOf(url) === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (pathOf(url) === '/api/agentops/agents/create') {
        return jsonResponse({ ok: true, value: requestBody(init), issues: [] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.create') }))

    const domainInput = screen.getByRole('combobox', { name: t('field.domain') })
    expect(domainInput.getAttribute('list')).toBe('agent-editor-domain-options')
    const suggestions = Array.from(
      document.querySelectorAll<HTMLOptionElement>('#agent-editor-domain-options option'),
      option => option.value,
    )
    expect(suggestions).toEqual(expect.arrayContaining(['observability', 'reporting']))

    fillRequiredIdentity('incident-response')
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await waitFor(() => {
      expect(findCall(calls, '/api/agentops/agents/create')).toBeTruthy()
    })
    expect(requestBody(findCall(calls, '/api/agentops/agents/create').init)).toMatchObject({
      agentId: 'log_puller',
      domain: 'incident-response',
    })
  })

  it('marks tools missing from the catalogue instead of inventing metadata', async () => {
    installApi((url) => {
      if (pathOf(url) === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (pathOf(url) === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    const dialog = await openLogPullerEditor()
    expect(dialog.classList.contains('agx-editor-dialog')).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.permissions') }))

    expect(screen.getByText(t('permissions.policyTitle'))).toBeTruthy()
    expect(screen.getByText(t('permissions.policyHelper'))).toBeTruthy()
    expect(screen.getByText(new RegExp(t('permissions.currentPolicy')))).toBeTruthy()
    expect(screen.getAllByText('read_file').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(t('permissions.unknownTool'))).toBeTruthy()
    expect(await screen.findByText(t('permissions.catalogueFailed'))).toBeTruthy()
  })

  it('lists the migrated tool catalogue and filters it by the search field', async () => {
    installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/tools') return jsonResponse(TOOL_CATALOG)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await openLogPullerEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.permissions') }))

    expect(screen.getByText(t('permissions.catalogueTitle'))).toBeTruthy()
    expect(screen.getByText(t('permissions.catalogueHelper'))).toBeTruthy()
    await screen.findByText('查询审计库')
    expect(screen.getAllByText('读取工作区文件').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(t('permissions.migratedTo', {
      plugin: '@deepseek-ai/dsh-tool-fs',
      tool: 'read_file',
    })).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(t('permissions.notMigrated', { note: '无（DSH 侧走 sql_query）' }))).toBeTruthy()
    expect(screen.getAllByText(new RegExp(
      `${t('permissions.approvalLabel')}: ${t('permissions.approvalRequired')}$`,
    )).length).toBeGreaterThanOrEqual(1)

    fireEvent.change(screen.getByRole('textbox', { name: t('permissions.catalogueSearch') }), {
      target: { value: 'sql' },
    })
    const catalogue = document.querySelector('.agx-catalogue-list')
    expect(catalogue?.textContent).not.toContain('读取工作区文件')
    expect(catalogue?.textContent).toContain('查询审计库')
  })

  it('shows verified workflow nodes that reference the edited Agent', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/workflows') return jsonResponse(WORKFLOW_CATALOG)
      if (path === '/api/agentops/runs') return jsonResponse({ runs: [], total: 0 })
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
    await screen.findByRole('dialog', { name: t('editor.editTitle') })
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))

    expect(await screen.findByText('Log flow')).toBeTruthy()
    expect(screen.getByText('scan')).toBeTruthy()
    expect(screen.getByText('Scan logs')).toBeTruthy()
    expect(screen.getByText('Observability')).toBeTruthy()
    expect(screen.queryByText('Notify reporters')).toBeNull()
    expect(screen.queryByText('Broken flow')).toBeNull()
    expect(findCall(calls, '/api/agentops/workflows')).toBeTruthy()
    expect(await screen.findByText(t('runStats.empty'))).toBeTruthy()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/runs')).toHaveLength(5)
  })

  it('aggregates repeated workflow bindings once and uses server run totals', async () => {
    const workflow = {
      ...WORKFLOW_CATALOG.entries[0],
      nodeCount: 3,
      nodes: [
        ...WORKFLOW_CATALOG.entries[0].nodes,
        {
          id: 'scan-again',
          level: 1,
          type: 'agent',
          agentRef: 'log_puller',
          displayName: 'Scan logs again',
          businessRole: 'Observability',
        },
      ],
    }
    const runHistory = runHistoryHandler(
      () => ({ all: 12, running: 3, completed: 6, failed: 2, cancelled: 1 }),
      () => ({
        runId: 'run-latest',
        workflowId: 'log-flow',
        status: 'completed',
        startedAt: '2026-11-02T08:00:00.000Z',
      }),
    )
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/workflows') {
        return jsonResponse({ dir: '/srv/workflows', missing: false, entries: [workflow] })
      }
      if (path === '/api/agentops/runs') return runHistory(url, undefined)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await openLogPullerEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))

    await waitFor(() => {
      expect(runStatValue(t('runStats.workflows'))).toBe('1')
    })
    expect(runStatValue(t('runStats.total'))).toBe('12')
    expect(runStatValue(t('runStats.running'))).toBe('3')
    expect(runStatValue(t('runStats.completed'))).toBe('6')
    expect(runStatValue(t('runStats.failed'))).toBe('2')
    expect(runStatValue(t('runStats.cancelled'))).toBe('1')
    expect(screen.getAllByText('Log flow')).toHaveLength(2)
    expect(screen.getByText('scan-again')).toBeTruthy()
    expect(screen.getByText('run-latest')).toBeTruthy()
    expect(document.querySelector('.agx-run-status')?.textContent).toBe(t('runStats.completed'))

    const runCalls = calls.filter(call => pathOf(call.url) === '/api/agentops/runs')
    expect(runCalls).toHaveLength(5)
    expect(runCalls.every((call) => {
      return new URL(call.url, 'http://localhost').searchParams.get('workflowId') === 'log-flow'
    })).toBe(true)
  })

  it('retries run statistics without reloading workflow bindings', async () => {
    let runsUnavailable = true
    const runHistory = runHistoryHandler(
      () => ({ all: 4, running: 1, completed: 2, failed: 1, cancelled: 0 }),
    )
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/workflows') return jsonResponse(WORKFLOW_CATALOG)
      if (path === '/api/agentops/runs') {
        return runsUnavailable ? jsonResponse({ message: 'unavailable' }, 503) : runHistory(url, undefined)
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await openLogPullerEditor()
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))

    expect(await screen.findByText(t('runStats.loadFailed'))).toBeTruthy()
    expect(screen.getByText('Log flow')).toBeTruthy()
    expect(screen.getByText('scan')).toBeTruthy()
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflows')).toHaveLength(1)
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/runs')).toHaveLength(5)

    runsUnavailable = false
    fireEvent.click(screen.getByRole('button', { name: t('runStats.retry') }))

    await waitFor(() => {
      expect(runStatValue(t('runStats.workflows'))).toBe('1')
    })
    expect(runStatValue(t('runStats.total'))).toBe('4')
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/workflows')).toHaveLength(1)
    expect(calls.filter(call => pathOf(call.url) === '/api/agentops/runs')).toHaveLength(10)
  })
  it('reports workflow binding load failures with a retry action', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/workflows') return jsonResponse({}, 500)
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
    await screen.findByRole('dialog', { name: t('editor.editTitle') })
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))

    expect(await screen.findByText(t('workflowBindings.loadFailed'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('workflowBindings.retry') })).toBeTruthy()
    expect(screen.queryByText(t('workflowBindings.empty'))).toBeNull()
    expect(calls.some(call => pathOf(call.url) === '/api/agentops/runs')).toBe(false)
  })

  it('reports an empty verified workflow catalogue separately from a load failure', async () => {
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/workflows') {
        return jsonResponse({ dir: '/srv/workflows', missing: false, entries: [] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
    await screen.findByRole('dialog', { name: t('editor.editTitle') })
    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))

    expect(await screen.findByText(t('workflowBindings.empty'))).toBeTruthy()
    expect(screen.queryByText(t('workflowBindings.loadFailed'))).toBeNull()
    expect(calls.some(call => pathOf(call.url) === '/api/agentops/runs')).toBe(false)
  })

  it('keeps invalid agents visible but disables their editing entry point', async () => {
    installApi(catalogFactory())
    renderPanel()

    const invalid = await screen.findByRole('button', { name: t('page.invalid') })
    expect(invalid.hasAttribute('disabled')).toBe(true)
    expect(invalid.textContent).toContain('Broken agent')
    expect(invalid.textContent).toContain(t('page.invalidDescription'))
    expect(invalid.textContent).not.toContain(t('card.manage'))
  })

  it('keeps the previous catalogue and reports a failure when refresh fails', async () => {
    let catalogueRequests = 0
    installApi((url) => {
      if (pathOf(url) !== '/api/agentops/agents') throw new Error(`unexpected request ${url}`)
      catalogueRequests += 1
      if (catalogueRequests === 1) return jsonResponse(CATALOG)
      return jsonResponse({ message: 'internal path /srv/private' }, 500)
    })
    const { publishFailure } = renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.refresh') }))

    await waitFor(() => {
      expect(publishFailure).toHaveBeenCalledWith(t('page.refreshFailed'))
    })
    expect(screen.getByText('Log puller')).toBeTruthy()
    expect(catalogueRequests).toBe(2)
  })

  it('moves to the first host-rejected field tab without exposing host diagnostics', async () => {
    const hostMessage = 'host secret: /srv/private/agents.yaml'
    installApi((url, init) => {
      if (pathOf(url) === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (pathOf(url) === '/api/agentops/agents/create') {
        expect(requestBody(init)).toMatchObject({ agentId: 'log_puller' })
        return jsonResponse({
          ok: false,
          message: hostMessage,
          issues: [{ path: 'systemPrompt', message: hostMessage }],
        }, 422)
      }
      throw new Error(`unexpected request ${url}`)
    })
    const { publishFailure } = renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.create') }))
    fillRequiredIdentity()
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await waitFor(() => {
      expect(publishFailure).toHaveBeenCalledWith(t('error.save'))
    })
    const responsibilityTab = screen.getByRole('tab', { name: new RegExp(t('tabs.responsibility')) })
    expect(responsibilityTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(t('validation.hostRejected'))).toBeTruthy()
    expect(screen.queryByText(hostMessage)).toBeNull()
  })

  it('sends the complete create record and preserves an explicit T1 selection', async () => {
    const expected: AgentRecord = {
      agentId: 'log_puller',
      displayName: 'Log puller',
      domain: 'observability',
      description: 'Pulls recent production failures.',
      harness: 'local_llm',
      executionBackend: 'codex',
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      systemPrompt: 'Find the first causal failure.',
      tier: 'T1',
      execution: 'skill',
      permissions: { allowedTools: ['read_file'], deniedTools: [] },
      knowledgeBases: ['runbooks'],
      timeoutSeconds: 300,
      maxConcurrentRuns: 2,
      costLimitPerRun: 1.5,
      outputFiles: { report: 'reports/analysis.md' },
    }
    const calls = installApi((url, init) => {
      if (pathOf(url) === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (pathOf(url) === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (pathOf(url) === '/api/agentops/workflows') return jsonResponse(WORKFLOW_CATALOG)
      if (pathOf(url) === '/api/agentops/runs') return jsonResponse({ runs: [], total: 0 })
      if (pathOf(url) === '/api/agentops/agents/create') {
        expect(requestBody(init)).toEqual(expected)
        return jsonResponse({ ok: true, value: expected, issues: [] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.create') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.agentId') }), {
      target: { value: expected.agentId },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('field.displayName') }), {
      target: { value: expected.displayName },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('field.domain') }), {
      target: { value: expected.domain },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '执行后端' }), {
      target: { value: 'codex' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('field.tier') }), {
      target: { value: 'T1' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('field.modelMode') }), {
      target: { value: 'explicit' },
    })
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: t('field.modelProvider') }).textContent)
        .toContain('DeepSeek (deepseek)')
    })
    fireEvent.change(screen.getByRole('combobox', { name: t('field.modelProvider') }), {
      target: { value: 'deepseek' },
    })
    expect(screen.getByRole('combobox', { name: t('field.modelId') })).toHaveProperty('value', 'deepseek-chat')

    fireEvent.click(screen.getByRole('tab', { name: t('tabs.responsibility') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.description') }), {
      target: { value: expected.description },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('field.systemPrompt') }), {
      target: { value: expected.systemPrompt },
    })

    fireEvent.click(screen.getByRole('tab', { name: t('tabs.permissions') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.tools') }), {
      target: { value: 'read_file' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('tool.add') }))

    fireEvent.click(screen.getByRole('tab', { name: t('tabs.knowledge') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.knowledgeBases') }), {
      target: { value: 'runbooks' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.add') }))

    fireEvent.click(screen.getByRole('tab', { name: t('tabs.runtime') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.timeoutSeconds') }), {
      target: { value: '300' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('field.maxConcurrentRuns') }), {
      target: { value: '2' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('field.costLimitPerRun') }), {
      target: { value: '1.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('output.add') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('field.port') }), {
      target: { value: 'report' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: t('field.path') }), {
      target: { value: 'reports/analysis.md' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await waitFor(() => {
      expect(findCall(calls, '/api/agentops/agents/create')).toBeTruthy()
      expect(publishSuccess).toHaveBeenCalledWith(t('notice.created'))
    })
    expect(requestBody(findCall(calls, '/api/agentops/agents/create').init)).toEqual(expected)
  })

  it('preserves saved provider and model values that are absent from the live catalog', async () => {
    const legacyRecord: AgentRecord = {
      ...LOG_PULLER_RECORD,
      model: { provider: 'legacy-provider', id: 'legacy-model' },
    }
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: legacyRecord, issues: [] })
      }
      if (path === '/api/agentops/models') return jsonResponse(MODEL_CATALOG)
      if (path === '/api/agentops/agents/update') {
        return jsonResponse({ ok: true, value: legacyRecord, issues: [] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
    await screen.findByRole('dialog', { name: t('editor.editTitle') })
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: t('field.modelProvider') })).toHaveProperty('value', 'legacy-provider')
    })
    expect(screen.getByRole('combobox', { name: t('field.modelId') })).toHaveProperty('value', 'legacy-model')
    expect(screen.getByRole('option', {
      name: t('model.unavailableProvider', { value: 'legacy-provider' }),
    })).toBeTruthy()
    expect(screen.getByRole('option', {
      name: t('model.unavailableModel', { value: 'legacy-model' }),
    })).toBeTruthy()
    expect(screen.getByText(t('model.unavailableHint'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))
    await waitFor(() => {
      expect(findCall(calls, '/api/agentops/agents/update')).toBeTruthy()
    })
    expect(requestBody(findCall(calls, '/api/agentops/agents/update').init).model).toEqual({
      provider: 'legacy-provider',
      id: 'legacy-model',
    })
  })

  it('locks close, cancel, tabs, and save while a create request is pending', async () => {
    const createResponse = deferred<Response>()
    installApi((url) => {
      if (pathOf(url) === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (pathOf(url) === '/api/agentops/agents/create') return createResponse.promise
      throw new Error(`unexpected request ${url}`)
    })
    renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.create') }))
    fillRequiredIdentity()
    fireEvent.click(screen.getByRole('button', { name: t('editor.save') }))

    await screen.findByRole('button', { name: t('editor.saving') })
    expect(screen.getByRole('button', { name: t('editor.cancel') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('tab', { name: t('tabs.responsibility') }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('editor.close') }))
    expect(screen.getByRole('dialog', { name: t('editor.createTitle') })).toBeTruthy()

    await act(async () => {
      createResponse.resolve(jsonResponse({
        ok: true,
        value: {
          agentId: 'log_puller',
          displayName: 'Log puller',
          domain: 'observability',
          harness: 'local_llm',
          executionBackend: 'auto',
          model: 'auto',
          tier: 'T2',
          permissions: { allowedTools: [], deniedTools: [] },
          outputFiles: {},
        },
        issues: [],
      }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('editor.createTitle') })).toBeNull()
    })
  })

  it('requires delete confirmation and locks both dialogs while deletion is pending', async () => {
    const deleteResponse = deferred<Response>()
    const calls = installApi((url) => {
      const path = pathOf(url)
      if (path === '/api/agentops/agents') return jsonResponse(CATALOG)
      if (path === '/api/agentops/agents/detail') {
        return jsonResponse({ ok: true, value: LOG_PULLER_RECORD, issues: [] })
      }
      if (path === '/api/agentops/agents/delete') return deleteResponse.promise
      throw new Error(`unexpected request ${url}`)
    })
    const { publishSuccess } = renderPanel()

    await screen.findByText('Log puller')
    fireEvent.click(screen.getByRole('button', { name: t('page.openAria', { name: 'Log puller' }) }))
    await screen.findByRole('dialog', { name: t('editor.editTitle') })
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: t('field.agentId') })).toHaveProperty('value', 'log_puller')
    })

    fireEvent.click(screen.getByRole('button', { name: t('editor.delete') }))
    expect(screen.getByRole('dialog', { name: t('editor.deleteTitle') })).toBeTruthy()
    expect(calls.some(call => pathOf(call.url) === '/api/agentops/agents/delete')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: t('editor.deleteConfirm') }))
    await waitFor(() => {
      expect(calls.filter(call => pathOf(call.url) === '/api/agentops/agents/delete')).toHaveLength(1)
    })
    const deletingButtons = screen.getAllByRole('button', { name: t('editor.deleting') })
    expect(deletingButtons.length).toBeGreaterThan(0)
    expect(deletingButtons.every(button => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: t('editor.save') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('tab', { name: t('tabs.identity') }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }))
    expect(screen.getByRole('dialog', { name: t('editor.deleteTitle') })).toBeTruthy()

    await act(async () => {
      deleteResponse.resolve(jsonResponse({ ok: true, value: { agentId: 'log_puller' } }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('editor.editTitle') })).toBeNull()
      expect(publishSuccess).toHaveBeenCalledWith(t('notice.deleted'))
    })
  })
})
