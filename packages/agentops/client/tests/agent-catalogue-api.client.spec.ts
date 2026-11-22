import { describe, expect, it } from 'vitest'

import {
  AgentBadRequestError,
  AgentConflictError,
  AgentNotFoundError,
  AgentResponseError,
  AgentServerError,
  AgentValidationError,
  createAgent,
  loadAgent,
  loadAgentCatalog,
  loadAgentModelCatalog,
  loadAgentToolCatalog,
  removeAgent,
  updateAgent,
  type AgentRecord,
} from '../src/client/agent-catalogue-api.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function operation(overrides: Partial<AgentRecord> = {}, issues: unknown[] = []) {
  return { value: { ...RECORD, ...overrides }, issues }
}

const AGENT = {
  id: 'log_analyst',
  name: 'Log analyst',
  domain: 'observability',
  description: 'Reads logs',
  harness: 'local_llm',
  executionBackend: 'auto',
  model: 'deepseek/deepseek-chat',
  source: 'yaml',
  allowed_tools: ['read_file'],
  denied_tools: [],
  knowledge_bases: ['runbooks'],
  timeout_seconds: 300,
  max_concurrent_runs: 2,
  cost_limit_per_run: 1.5,
  file_name: 'log_analyst.yaml',
  valid: true,
  issues: [],
} as const

const RECORD: AgentRecord = {
  agentId: 'log_analyst',
  displayName: 'Log analyst',
  domain: 'observability',
  description: 'Reads logs',
  harness: 'local_llm',
  executionBackend: 'auto',
  model: { provider: 'deepseek', id: 'deepseek-chat' },
  systemPrompt: 'Find the operational cause.',
  tier: 'T1',
  execution: 'skill',
  permissions: { allowedTools: ['read_file'], deniedTools: ['shell'] },
  knowledgeBases: ['runbooks'],
  timeoutSeconds: 300,
  maxConcurrentRuns: 2,
  costLimitPerRun: 1.5,
  outputFiles: { report: 'reports/analysis.md' },
}

function operationPayload(overrides: Partial<AgentRecord> = {}, issues: unknown[] = []) {
  return { ok: true, value: { ...RECORD, ...overrides }, issues }
}

describe('agent catalogue API', () => {
  it('loads the catalogue without exposing malformed details as data', async () => {
    let capturedUrl = ''
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = input instanceof Request ? input.url : input.toString()
      return jsonResponse({ dir: '/srv/agents', missing: false, entries: [AGENT] })
    }

    await expect(loadAgentCatalog(fetchImpl)).resolves.toEqual({
      dir: '/srv/agents',
      missing: false,
      entries: [AGENT],
    })
    expect(capturedUrl).toBe('/api/agentops/agents')
  })

  it('rejects malformed catalogue entries instead of rendering partial agents', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      dir: '/srv/agents',
      missing: false,
      entries: [{ ...AGENT, source: 'database' }],
    })
    await expect(loadAgentCatalog(fetchImpl)).rejects.toBeInstanceOf(AgentResponseError)
  })

  it('loads the live model catalog with provider failures isolated', async () => {
    let captured: { readonly url: string; readonly init: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      captured = { url: input instanceof Request ? input.url : input.toString(), init }
      return jsonResponse({
        providers: [{
          id: 'deepseek',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General chat model' }],
        }],
        failures: [{ id: 'backup', name: 'Backup route', message: 'offline' }],
      })
    }

    await expect(loadAgentModelCatalog(fetchImpl)).resolves.toEqual({
      providers: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General chat model' }],
      }],
      failures: [{ id: 'backup', name: 'Backup route', message: 'offline' }],
    })
    expect(captured?.url).toBe('/api/agentops/models')
    expect(captured?.init.credentials).toBe('include')
  })

  it('rejects a malformed live model entry without exposing partial options', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat' }] }],
      failures: [],
    })
    await expect(loadAgentModelCatalog(fetchImpl)).rejects.toBeInstanceOf(AgentResponseError)
  })

  it('loads one Agent with its non-fatal issues', async () => {
    let captured: { readonly url: string; readonly init: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      captured = { url: input instanceof Request ? input.url : input.toString(), init }
      return jsonResponse(operationPayload({}, [{
        path: 'tier',
        message: 'tier missing; defaulted to T2',
        kind: 'coercion',
      }]))
    }

    await expect(loadAgent(fetchImpl, 'log_analyst')).resolves.toEqual(operation({}, [{
      path: 'tier',
      message: 'tier missing; defaulted to T2',
      kind: 'coercion',
    }]))
    expect(captured?.url).toBe('/api/agentops/agents/detail')
    expect(captured?.init.method).toBe('POST')
    expect(captured?.init.credentials).toBe('include')
    expect(captured?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(captured?.init.body).toBe(JSON.stringify({ agentId: 'log_analyst' }))
  })

  it.each([
    ['create', createAgent, '/api/agentops/agents/create'],
    ['update', updateAgent, '/api/agentops/agents/update'],
  ] as const)('%s sends the complete camelCase Agent record', async (_name, request, path) => {
    let captured: { readonly url: string; readonly init: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      captured = { url: input instanceof Request ? input.url : input.toString(), init }
      return jsonResponse(operationPayload())
    }

    await expect(request(fetchImpl, RECORD)).resolves.toEqual(operation())
    expect(captured?.url).toBe(path)
    expect(captured?.init.body).toBe(JSON.stringify(RECORD))
  })

  it('deletes by Agent id and returns the confirmed id', async () => {
    let captured: { readonly url: string; readonly init: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      captured = { url: input instanceof Request ? input.url : input.toString(), init }
      return jsonResponse({ ok: true, value: { agentId: 'log_analyst' } })
    }

    await expect(removeAgent(fetchImpl, 'log_analyst')).resolves.toEqual({ agentId: 'log_analyst' })
    expect(captured?.url).toBe('/api/agentops/agents/delete')
    expect(captured?.init.body).toBe(JSON.stringify({ agentId: 'log_analyst' }))
  })

  it.each([
    [400, AgentBadRequestError, []],
    [404, AgentNotFoundError, []],
    [409, AgentConflictError, []],
    [422, AgentValidationError, [{ path: 'tier', message: 'unsupported tier' }]],
    [500, AgentServerError, []],
  ] as const)('maps HTTP %i to a typed failure', async (status, ErrorType, issues) => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      ok: false,
      code: 'failure',
      message: `failure ${String(status)}`,
      issues,
    }, status)

    const failure = loadAgent(fetchImpl, 'log_analyst')
    await expect(failure).rejects.toBeInstanceOf(ErrorType)
    await expect(failure).rejects.toMatchObject({ status, message: `failure ${String(status)}`, issues })
  })

  it('rejects a successful mutation with a malformed Agent record', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      ok: true,
      value: { ...RECORD, tier: 'T9' },
      issues: [],
    })
    await expect(updateAgent(fetchImpl, RECORD)).rejects.toBeInstanceOf(AgentResponseError)
  })

  it('rejects a successful delete response with a missing id', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ ok: true, value: {} })
    await expect(removeAgent(fetchImpl, 'log_analyst')).rejects.toBeInstanceOf(AgentResponseError)
  })

  it('loads the tool catalogue with its migration targets', async () => {
    let capturedUrl = ''
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = input instanceof Request ? input.url : input.toString()
      return jsonResponse({
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
      })
    }

    await expect(loadAgentToolCatalog(fetchImpl)).resolves.toEqual({
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
    })
    expect(capturedUrl).toContain('/api/agentops/tools')
  })

  it('reports a missing catalogue file instead of an empty tool list', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      file: '/srv/mappings/tool-map.yaml',
      missing: true,
      tools: [],
    })
    await expect(loadAgentToolCatalog(fetchImpl)).resolves.toEqual({
      file: '/srv/mappings/tool-map.yaml',
      missing: true,
      tools: [],
    })
  })

  it('rejects a tool catalogue entry with a malformed migration flag', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      file: '/srv/mappings/tool-map.yaml',
      missing: false,
      tools: [
        {
          id: 'read_file',
          displayName: '读取文件',
          description: '读取工作区文件',
          allowedDomains: ['observability'],
          requiresHumanApproval: false,
          migrated: 'yes',
        },
      ],
    })
    await expect(loadAgentToolCatalog(fetchImpl)).rejects.toBeInstanceOf(AgentResponseError)
  })
})
