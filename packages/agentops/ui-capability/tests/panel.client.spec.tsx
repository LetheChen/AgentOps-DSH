// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CapabilityPanel, configFormValues, configFromForm, policyTables, policyWithTables } from '../src/client/panel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const definition = {
  capabilityId: 'database',
  name: '数据库',
  category: 'infrastructure',
  provider: 'database',
  description: '数据库查询与受控写操作',
  transports: ['cli', 'rest'],
  configSchema: [
    { key: 'engine', type: 'select', label: '引擎', required: true, options: ['mysql', 'sqlite'] },
    { key: 'database', type: 'string', label: '数据库', required: true },
    { key: 'port', type: 'number', label: '端口', required: false },
    { key: 'headless', type: 'boolean', label: '无头', required: false, default: true },
    { key: 'allowed_hosts', type: 'array', label: '主机', required: false },
  ],
  riskLevel: 'high',
  authorizationCapabilityId: 'database',
  supportsInstances: true,
  credentialRequired: true,
}

const tool = {
  toolId: 'sql_query',
  displayName: 'SQL 查询',
  description: '对已授权数据源执行单条只读 SELECT。',
  capabilityId: 'database',
  capabilityTransport: 'cli',
  authorizationCapabilityId: 'database',
  requiresCapabilityInstance: true,
  handlerModule: '@agentops/dsh-db',
  handlerFunction: 'sql_query',
  allowedDomains: ['smart_ops'],
  allowedAgents: [],
  deniedAgents: [],
  runtimeAvailable: true,
  runtimeNote: '',
  declarationKind: 'runtime_tool',
}

const declaredInterface = {
  toolId: 'oa_rest',
  displayName: '致远 OA REST',
  description: '致远 OA 接口声明。',
  capabilityId: 'oa',
  capabilityTransport: 'rest',
  authorizationCapabilityId: 'oa',
  requiresCapabilityInstance: true,
  handlerModule: 'metadata',
  handlerFunction: 'rest',
  allowedDomains: ['smart_ops'],
  allowedAgents: [],
  deniedAgents: [],
  runtimeAvailable: false,
  runtimeNote: '仅登记接口元数据；完成 MCP / CLI / REST / Webhook 桥接后才能运行',
  declarationKind: 'interface',
}

const instance = {
  instanceId: 'audit_reader',
  capabilityId: 'database',
  name: '审计库',
  config: { engine: 'mysql', database: 'audit_example' },
  accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
  credentialConfigured: true,
  status: 'enabled',
  lastTestStatus: 'succeeded',
  lastTestAt: '2026-11-12T00:00:00.000Z',
  lastTestError: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
}

function reply(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
}

type Envelope = { endpoint: string; method: string; body?: Record<string, unknown> }

function envelopeOf(init: RequestInit | undefined): Envelope {
  const body = init?.body
  if (typeof body !== 'string') throw new Error('request body must be serialized JSON')
  return JSON.parse(body) as Envelope
}

function install(): { readonly calls: { endpoint: string; method: string }[]; readonly bodies: Envelope[] } {
  const calls: { endpoint: string; method: string }[] = []
  const bodies: Envelope[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = envelopeOf(init)
    bodies.push(body)
    calls.push({ endpoint: body.endpoint, method: body.method })
    if (body.endpoint.endsWith('/catalog')) return reply({ capabilities: [definition], integrations: [instance] })
    if (body.endpoint.endsWith('/integrations')) return reply({ integrations: [instance] })
    if (body.endpoint.endsWith('/tools')) return reply({ tools: [tool, declaredInterface] })
    if (body.endpoint.endsWith('/bindings')) return reply({ bindings: [] })
    return reply({})
  }))
  return { calls, bodies }
}

describe('capability config schema codec', () => {
  const fields = [
    { key: 'engine', type: 'select' as const, label: '引擎', required: true, options: ['mysql', 'sqlite'] },
    { key: 'port', type: 'number' as const, label: '端口', required: true },
    { key: 'headless', type: 'boolean' as const, label: '无头', required: false, default: true },
    { key: 'allowed_hosts', type: 'array' as const, label: '主机', required: true },
    { key: 'secret', type: 'string' as const, label: '密码', required: false },
  ]

  it('round-trips typed defaults, arrays and booleans', () => {
    const values = configFormValues(fields, { engine: 'mysql', port: 3306, allowed_hosts: ['a.example', 'b.example'] })
    expect(values).toEqual({
      engine: 'mysql', port: '3306', headless: true, allowed_hosts: 'a.example, b.example', secret: '',
    })
    expect(configFromForm(fields, values)).toEqual({
      engine: 'mysql', port: 3306, headless: true, allowed_hosts: ['a.example', 'b.example'],
    })
  })
})

describe('capability panel', () => {
  it('renders capability, instance, credential, and test state from the RPC source', async () => {
    const { calls } = install()
    render(<CapabilityPanel />)
    expect(await screen.findByText('审计库')).toBeTruthy()
    expect(screen.getAllByText('数据库').length).toBeGreaterThan(0)
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: '控制面审计' })).toBeNull()
    expect(calls.some(call => call.endpoint.endsWith('/catalog'))).toBe(true)
    expect(calls.some(call => call.endpoint.endsWith('/integrations') && call.method === 'GET')).toBe(true)
    expect(calls.some(call => call.endpoint.endsWith('/audit'))).toBe(false)
  })

  it('renders tool runtime availability and filters the table by capability', async () => {
    install()
    render(<CapabilityPanel />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: '工具与接口' }))
    expect(await screen.findByText('SQL 查询')).toBeTruthy()
    expect(screen.getByText('可运行')).toBeTruthy()
    expect(screen.getByText('致远 OA REST')).toBeTruthy()
    expect(screen.getAllByText('仅登记接口')).toHaveLength(2)
    expect(screen.getByText('@agentops/dsh-db')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '按能力筛选' }), { target: { value: 'database' } })
    await waitFor(() => {
      expect(screen.queryByText('致远 OA REST')).toBeNull()
    })
    expect(screen.getByText('SQL 查询')).toBeTruthy()
  })

  it('submits schema-driven config with typed values and required-field validation', async () => {
    const { bodies, calls } = install()
    render(<CapabilityPanel />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getAllByRole('button', { name: '新增实例' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('select')?.value).toBe('database')
    expect(dialog.querySelectorAll('select')[1]?.value).toBe('mysql')

    fireEvent.change(screen.getByLabelText(/数据库/), { target: { value: 'audit_example' } })
    fireEvent.change(screen.getByLabelText(/端口/), { target: { value: '3306' } })
    fireEvent.change(screen.getByLabelText(/主机/), { target: { value: 'a.example, b.example' } })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'New audit' } })
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }))
    await waitFor(() => {
      expect(calls.some(call => call.endpoint.endsWith('/integrations') && call.method === 'POST')).toBe(true)
    })
    const sent = bodies.find(body => body.endpoint.endsWith('/integrations') && body.method === 'POST')
    if (sent === undefined) throw new Error('POST request missing')
    expect(sent.body?.config).toEqual({
      engine: 'mysql',
      database: 'audit_example',
      port: 3306,
      headless: true,
      allowed_hosts: ['a.example', 'b.example'],
    })
  })

  it('blocks submission when a required schema field is empty', async () => {
    const { calls } = install()
    render(<CapabilityPanel />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getAllByRole('button', { name: '新增实例' })[0]!)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Incomplete' } })
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }))
    expect(await screen.findByText('请填写数据库')).toBeTruthy()
    expect(calls.some(call => call.endpoint.endsWith('/integrations') && call.method === 'POST')).toBe(false)
  })

  it('syncs visual fields into advanced JSON and back without dropping values', async () => {
    const { bodies, calls } = install()
    render(<CapabilityPanel />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(/数据库/), { target: { value: 'updated_db' } })
    fireEvent.click(screen.getByRole('button', { name: '高级 JSON' }))
    const advanced = screen.getByRole('dialog').querySelector('textarea') as HTMLTextAreaElement
    expect(advanced.value).toContain('"database": "updated_db"')
    fireEvent.click(screen.getByRole('button', { name: '返回表单' }))
    expect(screen.getByLabelText(/数据库/)).toHaveProperty('value', 'updated_db')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => {
      expect(calls.some(call => call.endpoint.endsWith('/audit_reader') && call.method === 'PATCH')).toBe(true)
    })
    const sent = bodies.find(body => body.endpoint.endsWith('/audit_reader'))
    if (sent === undefined) throw new Error('PATCH request missing')
    expect((sent.body?.config as Record<string, unknown>).database).toBe('updated_db')
  })

  it('uses the live preset roster and groups bindings by capability', async () => {
    install()
    const readPresets = async () => [
      { id: 'manager', name: 'Manager', description: 'Entry', isDefault: true },
      { id: 'oa', name: 'OA assistant', isDefault: false },
    ]
    render(<CapabilityPanel readPresets={readPresets} />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: 'Agent 授权' }))
    const select = await screen.findByRole('combobox', { name: 'Agent preset' })
    expect((select as HTMLSelectElement).value).toBe('manager')
    expect(screen.getByRole('option', { name: 'Manager · 默认' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'OA assistant' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '数据库' })).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()
  })

  it('refuses to bind a database instance without an allowed table', async () => {
    const unsafe = { ...instance, accessPolicy: {} }
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = envelopeOf(init)
      if (body.endpoint.endsWith('/catalog')) return reply({ capabilities: [definition], integrations: [unsafe] })
      if (body.endpoint.endsWith('/integrations')) return reply({ integrations: [unsafe] })
      if (body.endpoint.endsWith('/tools')) return reply({ tools: [tool] })
      if (body.endpoint.endsWith('/audit')) return reply({ events: [] })
      if (body.endpoint.endsWith('/bindings')) return reply({ bindings: [] })
      return reply({})
    }))
    render(<CapabilityPanel readPresets={async () => [{ id: 'manager', name: 'Manager', isDefault: true }]} />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: 'Agent 授权' }))
    await screen.findByRole('combobox', { name: 'Agent preset' })
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByText('数据库实例需先选择可访问表')).toBeTruthy()
  })

  it('sends the binding contract in snake_case after the user checks an instance', async () => {
    const { bodies } = install()
    render(<CapabilityPanel readPresets={async () => [{ id: 'manager', name: 'Manager', isDefault: true }]} />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: 'Agent 授权' }))
    await screen.findByRole('combobox', { name: 'Agent preset' })
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(bodies.some(body => body.endpoint.endsWith('/bindings') && body.method === 'PUT')).toBe(true)
    })
    const sent = bodies.find(body => body.endpoint.endsWith('/bindings') && body.method === 'PUT')
    if (sent === undefined) throw new Error('PUT binding request missing')
    expect(sent.body?.bindings).toEqual([{
      capability_id: 'database',
      instance_id: 'audit_reader',
      enabled: true,
    }])
  })

  it('opens an edit dialog with an empty secret and preserves it when left blank', async () => {
    const { bodies, calls } = install()
    render(<CapabilityPanel />)
    await screen.findByText('审计库')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    const secret = dialog.querySelector('input[type="password"]') as HTMLInputElement
    expect(secret.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => {
      expect(calls.some(call => call.endpoint.endsWith('/audit_reader') && call.method === 'PATCH')).toBe(true)
    })
    const sent = bodies.find(body => body.endpoint.endsWith('/audit_reader'))
    if (sent === undefined) throw new Error('PATCH request missing')
    expect(Object.prototype.hasOwnProperty.call(sent.body ?? {}, 'secret')).toBe(false)
  })
})

describe('table policy helpers', () => {
  it('reads and writes both allowed_tables shapes', () => {
    expect(policyTables('{"allowed_tables":{"audit_example":["users","audit_records"]}}'))
      .toEqual(['users', 'audit_records'])
    expect(policyTables('{"allowed_tables":["users"]}')).toEqual(['users'])
    expect(JSON.parse(policyWithTables('{}', 'audit_example', ['users'])))
      .toEqual({ allowed_tables: { audit_example: ['users'] } })
  })
})
