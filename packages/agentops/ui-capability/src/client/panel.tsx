/**
 * Capability-center main panel and sidebar glyph.
 *
 * The page is a structural reproduction of AgentOps: capability summary,
 * instance table, credential presence, test/edit/delete actions, and
 * authorization. Every mutation refreshes the same RPC snapshot.
 *
 * @module @agentops/dsh-ui-capability/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { IconRefreshOutlineRegular, IconCordisPluginOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createCapabilityApi, type CapabilityRpcResult } from './api.ts'
import { zh as copy } from './locales.ts'
import type { CapabilityAgentPresetReader } from './index.ts'

interface CapabilityConfigField {
  readonly key: string
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'select'
  readonly label: string
  readonly required: boolean
  readonly placeholder?: string
  readonly description?: string
  readonly options?: readonly string[]
  readonly default?: unknown
}

interface CapabilityDefinition {
  readonly capabilityId: string
  readonly name: string
  readonly category: string
  readonly provider: string
  readonly description: string
  readonly transports: readonly string[]
  readonly configSchema: readonly CapabilityConfigField[]
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly authorizationCapabilityId: string
  readonly supportsInstances: boolean
  readonly credentialRequired: boolean
}

/** Model-facing roster row used by the binding selector. */
interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly isDefault: boolean
  readonly broken?: string
}

interface CapabilityTool {
  readonly toolId: string
  readonly displayName: string
  readonly description: string
  readonly capabilityId: string
  readonly capabilityTransport: string
  readonly authorizationCapabilityId: string
  readonly requiresCapabilityInstance: boolean
  readonly handlerModule: string
  readonly handlerFunction: string
  readonly allowedDomains: readonly string[]
  readonly allowedAgents: readonly string[]
  readonly deniedAgents: readonly string[]
  readonly runtimeAvailable: boolean
  readonly runtimeNote: string
  readonly declarationKind: 'runtime_tool' | 'interface'
}

interface IntegrationInstance {
  readonly instanceId: string
  readonly capabilityId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly accessPolicy: Readonly<Record<string, unknown>>
  readonly credentialConfigured: boolean
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly lastTestStatus: 'succeeded' | 'failed' | null
  readonly lastTestAt: string | null
  readonly lastTestError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface CapabilityBinding {
  readonly agentPreset: string
  readonly capabilityId: string
  readonly instanceId: string
  readonly enabled: boolean
}

interface Draft {
  readonly instanceId?: string
  readonly capabilityId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly configJson: string
  readonly configValues: Readonly<Record<string, string | boolean>>
  readonly configMode: 'fields' | 'json'
  readonly accessPolicy: string
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly secret: string
}

const EMPTY_CATALOG: readonly CapabilityDefinition[] = []
const EMPTY_INSTANCES: readonly IntegrationInstance[] = []
const EMPTY_TOOLS: readonly CapabilityTool[] = []
const EMPTY_BINDINGS: readonly CapabilityBinding[] = []
const EMPTY_PRESETS: readonly AgentPreset[] = []


const CATEGORY_LABELS: Record<string, string> = {
  business: '业务系统',
  collaboration: '协作办公',
  message: '消息通知',
  data: '数据服务',
  developer: '研发工具',
  tool: '浏览器自动化',
  infrastructure: '基础设施',
  observability: '可观测',
}

const TRANSPORT_LABELS: Record<string, string> = {
  rest: 'REST API',
  mcp: 'MCP',
  cli: 'CLI',
  webhook: 'Webhook',
  oauth: 'OAuth',
  skill: 'Skill',
}

const RISK_META: Record<string, { readonly label: string; readonly tone: string }> = {
  low: { label: '低风险', tone: 'ok' },
  medium: { label: '中风险', tone: 'warn' },
  high: { label: '高风险', tone: 'err' },
}

const STATUS_META: Record<string, { readonly label: string; readonly tone: string }> = {
  enabled: { label: '已启用', tone: 'ok' },
  disabled: { label: '已停用', tone: 'muted' },
  error: { label: '异常', tone: 'err' },
  succeeded: { label: '通过', tone: 'ok' },
  failed: { label: '失败', tone: 'err' },
  untested: { label: '未测试', tone: 'muted' },
}

function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value] ?? value
}

function transportLabel(value: string): string {
  return TRANSPORT_LABELS[value] ?? value
}

function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function CapabilityPill({ tone, children }: { readonly tone: string; readonly children: ReactNode }): ReactElement {
  return <span className={`ao-capability-pill ao-capability-pill-${tone}`}>{children}</span>
}

function RiskPill({ level }: { readonly level: string }): ReactElement {
  const meta = RISK_META[level] ?? { label: level, tone: 'muted' }
  return <CapabilityPill tone={meta.tone}>{meta.label}</CapabilityPill>
}

function StatusPill({ status }: { readonly status: string | null | undefined }): ReactElement {
  const meta = STATUS_META[status ?? ''] ?? { label: status ?? '—', tone: 'muted' }
  return <CapabilityPill tone={meta.tone}>{meta.label}</CapabilityPill>
}

function SectionTitle({ title, description, action }: {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
}): ReactElement {
  return (
    <div className="ao-capability-section-head">
      <div>
        <h2>{title}</h2>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

function valueOf(result: CapabilityRpcResult, key: string): unknown {
  if (!result.ok) return undefined
  const value = result.value
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/** Convert one schema field into the primitive shape accepted by the instance API. */
export function parseConfigFieldValue(field: CapabilityConfigField, raw: string | boolean): unknown {
  if (field.type === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === 'on'
  const text = String(raw).trim()
  if (field.type === 'array') {
    return text.split(',').map(item => item.trim()).filter(item => item.length > 0)
  }
  if (field.type === 'number') {
    if (text === '') return undefined
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : text
  }
  return text === '' ? undefined : text
}

/** Build an editable form state from schema defaults and persisted values. */
export function configFormValues(
  fields: readonly CapabilityConfigField[],
  config: Readonly<Record<string, unknown>> = {},
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const field of fields) {
    const value = config[field.key] ?? field.default
    if (field.type === 'boolean') values[field.key] = value === true
    else if (Array.isArray(value)) values[field.key] = value.join(', ')
    else if (value === undefined || value === null) {
      values[field.key] = field.type === 'select' && field.options !== undefined ? field.options[0] ?? '' : ''
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[field.key] = String(value)
  }
  return values
}

/** Convert schema form state into the API config object. */
export function configFromForm(
  fields: readonly CapabilityConfigField[],
  values: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    const parsed = parseConfigFieldValue(field, values[field.key] ?? '')
    if (parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)) continue
    config[field.key] = parsed
  }
  return config
}

function objectOf(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Table names authorized by one access-policy JSON document. */
export function policyTables(policyJson: string): string[] {
  const policy = objectOf(policyJson)
  const allowed = policy?.allowed_tables
  if (Array.isArray(allowed)) return allowed.filter((item): item is string => typeof item === 'string')
  if (typeof allowed === 'object' && allowed !== null) {
    return Object.values(allowed).flatMap(value =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    )
  }
  return []
}

/** Serialize one access policy with the selected table whitelist. */
export function policyWithTables(policyJson: string, schema: string, tables: readonly string[]): string {
  const policy = objectOf(policyJson) ?? {}
  return JSON.stringify({ ...policy, allowed_tables: { [schema]: [...tables] } }, null, 2)
}

function errorOf(result: CapabilityRpcResult): string | null {
  return result.ok ? null : `${result.error.code}: ${result.error.message}`
}

function statusKey(status: string): 'instance.status.enabled' | 'instance.status.disabled' | 'instance.status.error' {
  if (status === 'enabled') return 'instance.status.enabled'
  if (status === 'disabled') return 'instance.status.disabled'
  return 'instance.status.error'
}

function emptyDraft(capability: CapabilityDefinition): Draft {
  return {
    capabilityId: capability.capabilityId,
    name: '',
    config: {},
    configJson: '{\n  \n}',
    configValues: configFormValues(capability.configSchema),
    configMode: 'fields',
    accessPolicy: '{}',
    status: 'enabled',
    secret: '',
  }
}

/** Human-readable label for a schema field. */
function fieldLabel(field: CapabilityConfigField): string {
  return field.label || field.key
}

/** Whether an enabled database instance has at least one authorized table. */
function databaseBindingReady(item: IntegrationInstance): boolean {
  if (item.capabilityId !== 'database') return true
  const policy = item.accessPolicy as { readonly allowed_tables?: unknown }
  const allowed = policy.allowed_tables
  if (Array.isArray(allowed)) return allowed.length > 0
  return typeof allowed === 'object' && allowed !== null
    && Object.values(allowed as Record<string, unknown>).some(value => Array.isArray(value) && value.length > 0)
}

/** Human-readable capability name with an id fallback. */
function capabilityName(capabilityId: string, catalog: readonly CapabilityDefinition[]): string {
  return catalog.find(item => item.capabilityId === capabilityId)?.name ?? capabilityId
}

/** One capability row with an instance count. */
/** Render the capability-center page. */
export function CapabilityPanel({ readPresets }: { readonly readPresets?: CapabilityAgentPresetReader }): ReactElement {
  const t = useCallback((key: keyof typeof copy): string => copy[key], [])
  const api = useMemo(() => createCapabilityApi(), [])
  const [catalog, setCatalog] = useState(EMPTY_CATALOG)
  const [instances, setInstances] = useState(EMPTY_INSTANCES)
  const [tools, setTools] = useState(EMPTY_TOOLS)
  const [bindings, setBindings] = useState(EMPTY_BINDINGS)
  const [agentPresets, setAgentPresets] = useState(EMPTY_PRESETS)
  const [agentPreset, setAgentPreset] = useState('')
  const [presetError, setPresetError] = useState<string | null>(null)
  const [tab, setTab] = useState<'instances' | 'tools' | 'bindings'>('instances')
  const [search, setSearch] = useState('')
  const [instanceCategory, setInstanceCategory] = useState('all')
  const [instanceCapabilityId, setInstanceCapabilityId] = useState('all')
  const [toolSearch, setToolSearch] = useState('')
  const [toolCategory, setToolCategory] = useState('all')
  const [toolCapabilityId, setToolCapabilityId] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [hostKeyBusy, setHostKeyBusy] = useState(false)
  const [tableList, setTableList] = useState<readonly string[]>([])
  const [tableSearch, setTableSearch] = useState('')
  const [tablesBusy, setTablesBusy] = useState(false)
  const [tablesNote, setTablesNote] = useState<string | null>(null)
  const [hostKeyNote, setHostKeyNote] = useState<string | null>(null)
  const requestId = useRef(0)
  const agentPresetRef = useRef('')
  const hostKeyAttempt = useRef('')

  useEffect(() => { agentPresetRef.current = agentPreset }, [agentPreset])

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const [catalogResult, instanceResult, toolsResult, bindingResult] = await Promise.all([
        api.listCatalog(), api.listIntegrations(), api.listTools(), api.listBindings(agentPreset),
      ])
      if (id !== requestId.current) return
      const firstError = errorOf(catalogResult) ?? errorOf(instanceResult) ?? errorOf(toolsResult)
        ?? errorOf(bindingResult)
      if (firstError !== null) {
        setError(firstError)
        return
      }
      const nextCatalog = valueOf(catalogResult, 'capabilities')
      const nextInstances = valueOf(instanceResult, 'integrations')
      const nextTools = valueOf(toolsResult, 'tools')
      const nextBindings = valueOf(bindingResult, 'bindings')
      if (!Array.isArray(nextCatalog) || !Array.isArray(nextInstances) || !Array.isArray(nextTools)
        || !Array.isArray(nextBindings)) {
        setError(t('error.load'))
        return
      }
      setCatalog(nextCatalog as CapabilityDefinition[])
      setInstances(nextInstances as IntegrationInstance[])
      setTools(nextTools as CapabilityTool[])
      setBindings(nextBindings as CapabilityBinding[])
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [agentPreset, api, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (readPresets === undefined) return
    let current = true
    void readPresets().then((rows) => {
      if (!current) return
      setAgentPresets(rows)
      setPresetError(null)
      const currentPreset = agentPresetRef.current
      const stillValid = rows.some(row => row.id === currentPreset && row.broken === undefined)
      if (!stillValid) {
        setAgentPreset(rows.find(row => row.isDefault && row.broken === undefined)?.id
          ?? rows.find(row => row.broken === undefined)?.id ?? '')
      }
    }).catch((reason: unknown) => {
      if (current) setPresetError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [readPresets])


  const openCreate = (capabilityId: string): void => {
    const capability = catalog.find(item => item.capabilityId === capabilityId)
    if (capability === undefined) return
    setDraft(emptyDraft(capability))
    setDraftError(null)
    setHostKeyNote(null)
    hostKeyAttempt.current = ''
    setTableList([])
    setTableSearch('')
    setTablesNote(null)
  }

  const toggleConfigMode = (): void => {
    if (draft === null) return
    const capability = catalog.find(item => item.capabilityId === draft.capabilityId)
    if (capability === undefined) return
    const fields = capability.configSchema.filter(field => field.key !== 'secret')
    if (draft.configMode === 'fields') {
      const config = { ...draft.config, ...configFromForm(fields, draft.configValues) }
      setDraft({
        ...draft,
        config,
        configJson: JSON.stringify(config, null, 2),
        configMode: 'json',
      })
      return
    }
    const parsed = objectOf(draft.configJson)
    if (parsed === null) {
      setDraftError(t('error.save'))
      return
    }
    setDraft({
      ...draft,
      config: parsed,
      configValues: configFormValues(fields, parsed),
      configMode: 'fields',
    })
  }

  const openEdit = (item: IntegrationInstance): void => {
    setDraft({
      instanceId: item.instanceId,
      capabilityId: item.capabilityId,
      name: item.name,
      config: item.config,
      configJson: JSON.stringify(item.config, null, 2),
      configValues: configFormValues(catalog.find(entry => entry.capabilityId === item.capabilityId)?.configSchema ?? [], item.config),
      configMode: 'fields',
      accessPolicy: JSON.stringify(item.accessPolicy, null, 2),
      status: item.status,
      secret: '',
    })
    setDraftError(null)
    setHostKeyNote(null)
    hostKeyAttempt.current = ''
  }

  const fetchHostKey = useCallback(async (host: string, port: string): Promise<void> => {
    const trimmedHost = host.trim()
    const portNumber = Number.parseInt(port.trim(), 10)
    if (trimmedHost === '' || !Number.isInteger(portNumber)) {
      setHostKeyNote(t('hostkey.needHost'))
      return
    }
    setHostKeyBusy(true)
    setHostKeyNote(null)
    const result = await api.probeSshHostKey(trimmedHost, portNumber)
    setHostKeyBusy(false)
    if (!result.ok) {
      setHostKeyNote(errorOf(result) ?? t('hostkey.failed'))
      return
    }
    const value = result.value as { host_key_sha256?: unknown }
    const pin = typeof value.host_key_sha256 === 'string' ? value.host_key_sha256 : ''
    if (pin === '') {
      setHostKeyNote(t('hostkey.failed'))
      return
    }
    setDraft(current => current === null ? current : {
      ...current,
      configValues: { ...current.configValues, host_key_sha256: pin },
    })
    setHostKeyNote(t('hostkey.fetched').replace('{pin}', pin))
  }, [api, t])

  // Fill a missing SSH fingerprint automatically once host and port settle,
  // so an operator never has to copy a value that the probe can read directly.
  useEffect(() => {
    if (draft === null || draft.capabilityId !== 'ssh' || draft.configMode !== 'fields') return
    if (hostKeyBusy) return
    const host = String(draft.configValues.host ?? '').trim()
    const port = String(draft.configValues.port ?? '').trim()
    const existing = String(draft.configValues.host_key_sha256 ?? '').trim()
    if (host === '' || port === '' || existing !== '') return
    const key = host + ':' + port
    if (hostKeyAttempt.current === key) return
    const timer = setTimeout(() => {
      hostKeyAttempt.current = key
      void fetchHostKey(host, port)
    }, 600)
    return () => { clearTimeout(timer) }
  }, [draft, fetchHostKey, hostKeyBusy])

  const loadTables = useCallback(async (instanceId: string): Promise<void> => {
    setTablesBusy(true)
    setTablesNote(null)
    const result = await api.listInstanceTables(instanceId)
    setTablesBusy(false)
    if (!result.ok) {
      setTablesNote(errorOf(result) ?? t('tables.failed'))
      return
    }
    const value = result.value as { ok?: boolean; message?: string; tables?: { name?: string }[] }
    const names = (value.tables ?? []).map(item => item.name).filter((name): name is string => typeof name === 'string')
    setTableList(names)
    setTablesNote(value.ok === false ? (value.message ?? t('tables.failed')) : (value.message ?? t('tables.loaded')))
  }, [api, t])

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return
    const capability = catalog.find(item => item.capabilityId === draft.capabilityId)
    if (capability === undefined) {
      setDraftError(t('error.save'))
      return
    }
    const fields = capability.configSchema.filter(field => field.key !== 'secret')
    const missing = fields.find(field => (
      field.required
      && field.type !== 'boolean'
      && String(draft.configValues[field.key] ?? '').trim() === ''
    ))
    if (draft.configMode === 'fields' && missing !== undefined) {
      setDraftError(t('error.required').replace('{field}', fieldLabel(missing)))
      return
    }
    const parsedJson = draft.configMode === 'json' ? objectOf(draft.configJson) : null
    if (draft.configMode === 'json' && parsedJson === null) {
      setDraftError(t('error.save'))
      return
    }
    const existingKeys = new Set(fields.map(field => field.key))
    const preserved = Object.fromEntries(
      Object.entries(draft.config).filter(([key]) => !existingKeys.has(key)),
    )
    const config = draft.configMode === 'fields'
      ? { ...preserved, ...configFromForm(fields, draft.configValues) }
      : parsedJson as Record<string, unknown>
    const accessPolicy = objectOf(draft.accessPolicy)
    if (accessPolicy === null) {
      setDraftError(t('error.save'))
      return
    }
    setBusy('save')
    const body = {
      ...(draft.instanceId === undefined ? {} : { instanceId: draft.instanceId }),
      capability_id: draft.capabilityId,
      name: draft.name,
      config,
      access_policy: accessPolicy,
      status: draft.status,
      ...(draft.secret === '' ? {} : { secret: draft.secret }),
    }
    const result = draft.instanceId === undefined
      ? await api.createIntegration(body)
      : await api.updateIntegration(draft.instanceId, body)
    setBusy('')
    if (!result.ok) {
      setDraftError(errorOf(result) ?? t('error.save'))
      return
    }
    setDraft(null)
    await load()
  }

  const remove = async (item: IntegrationInstance): Promise<void> => {
    if (!window.confirm(`Delete ${item.name}?`)) return
    setBusy(item.instanceId)
    const result = await api.deleteIntegration(item.instanceId)
    setBusy('')
    if (!result.ok) {
      setError(errorOf(result) ?? t('error.delete'))
      return
    }
    await load()
  }

  const test = async (item: IntegrationInstance): Promise<void> => {
    setNotice(null)
    setBusy(item.instanceId)
    const result = await api.testIntegration(item.instanceId)
    setBusy('')
    if (!result.ok) {
      setError(errorOf(result) ?? t('error.save'))
      return
    }
    const value = result.value as { ok?: boolean; message?: string }
    if (value.ok === false) setError(value.message ?? t('error.save'))
    else setNotice(value.message ?? null)
    await load()
  }

  const toggleInstance = async (item: IntegrationInstance): Promise<void> => {
    setBusy(item.instanceId)
    const result = await api.updateIntegration(item.instanceId, {
      capability_id: item.capabilityId,
      name: item.name,
      config: item.config,
      access_policy: item.accessPolicy,
      status: item.status === 'enabled' ? 'disabled' : 'enabled',
    })
    setBusy('')
    if (!result.ok) {
      setError(errorOf(result) ?? t('error.save'))
      return
    }
    await load()
  }

  const toggleBinding = async (item: IntegrationInstance): Promise<void> => {
    const selected = bindings.some(binding => binding.instanceId === item.instanceId && binding.enabled)
    const next = selected
      ? bindings.filter(binding => binding.instanceId !== item.instanceId)
      : [...bindings.filter(binding => binding.enabled), {
        capabilityId: item.capabilityId,
        instanceId: item.instanceId,
        enabled: true,
      }]
    const result = await api.replaceBindings({
      agent_preset: agentPreset,
      bindings: next.map(item => ({
        capability_id: item.capabilityId,
        instance_id: item.instanceId,
        enabled: item.enabled,
      })),
    })
    if (!result.ok) {
      setError(errorOf(result) ?? t('error.save'))
      return
    }
    const value = result.value as { ok?: boolean; message?: string }
    if (value.ok === false) setError(value.message ?? t('error.save'))
    await load()
  }

  const capabilityMap = useMemo(
    () => new Map(catalog.map(item => [item.capabilityId, item])),
    [catalog],
  )
  const categories = useMemo(
    () => [...new Set(catalog.map(item => item.category))].sort(),
    [catalog],
  )
  const instanceCapabilities = useMemo(
    () => catalog.filter(item => item.supportsInstances),
    [catalog],
  )
  const toolCountByCapability = useMemo(
    () => Object.fromEntries(catalog.map(item => [
      item.capabilityId,
      tools.filter(tool => tool.capabilityId === item.capabilityId).length,
    ])),
    [catalog, tools],
  )
  const instanceCountByCapability = useMemo(
    () => Object.fromEntries(catalog.map(item => [
      item.capabilityId,
      instances.filter(instance => instance.capabilityId === item.capabilityId).length,
    ])),
    [catalog, instances],
  )

  const filteredCatalog = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return catalog.filter((item) => {
      if (instanceCategory !== 'all' && item.category !== instanceCategory) return false
      if (instanceCapabilityId !== 'all' && item.capabilityId !== instanceCapabilityId) return false
      if (needle === '') return true
      return [item.capabilityId, item.name, item.description, item.provider, ...item.transports]
        .join(' ').toLowerCase().includes(needle)
    })
  }, [catalog, instanceCapabilityId, instanceCategory, search])

  const filteredInstances = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return instances.filter((item) => {
      const capability = capabilityMap.get(item.capabilityId)
      if (instanceCategory !== 'all' && capability?.category !== instanceCategory) return false
      if (instanceCapabilityId !== 'all' && item.capabilityId !== instanceCapabilityId) return false
      if (needle === '') return true
      return [item.instanceId, item.name, item.capabilityId, capability?.name ?? '']
        .join(' ').toLowerCase().includes(needle)
    })
  }, [capabilityMap, instances, instanceCapabilityId, instanceCategory, search])

  const filteredTools = useMemo(() => {
    const needle = toolSearch.trim().toLowerCase()
    return tools.filter((item) => {
      const capability = capabilityMap.get(item.capabilityId)
      if (toolCapabilityId !== 'all' && item.capabilityId !== toolCapabilityId) return false
      if (toolCategory !== 'all' && capability?.category !== toolCategory) return false
      if (needle === '') return true
      return [
        item.toolId, item.displayName, item.description, item.capabilityId,
        item.capabilityTransport, item.authorizationCapabilityId,
        item.handlerModule, item.handlerFunction, item.runtimeNote,
        ...item.allowedDomains, ...item.allowedAgents, ...item.deniedAgents,
      ].join(' ').toLowerCase().includes(needle)
    })
  }, [capabilityMap, toolCapabilityId, toolCategory, toolSearch, tools])

  const runtimeToolCount = tools.filter(item => item.runtimeAvailable).length
  const interfaceCount = tools.filter(item => item.declarationKind === 'interface').length
  const enabledCount = instances.filter(item => item.status === 'enabled').length

  return (
    <div className="ao-page ao-capability-page">
      <header className="ao-capability-hero">
        <div className="ao-capability-hero-copy">
          <div className="ao-capability-kicker">{t('page.kicker')}</div>
          <h1 className="ao-page-title">{t('page.title')}</h1>
          <p className="ao-page-description">{t('page.description')}</p>
        </div>
        <div className="ao-capability-stats">
          <div><strong>{catalog.length}</strong><span>{t('stat.capabilities')}</span></div>
          <div><strong>{instances.length}</strong><span>{t('stat.instances')}</span></div>
          <div><strong>{enabledCount}</strong><span>{t('stat.enabled')}</span></div>
          <div><strong>{tools.length}</strong><span>已登记工具</span></div>
        </div>
      </header>

      <div className="ao-capability-tabs" role="tablist" aria-label="能力中心视图">
        <button type="button" className={`ao-capability-tab ${tab === 'instances' ? 'active' : ''}`} onClick={() => { setTab('instances') }}>连接器实例</button>
        <button type="button" className={`ao-capability-tab ${tab === 'tools' ? 'active' : ''}`} onClick={() => { setTab('tools') }}>工具与接口</button>
        <button type="button" className={`ao-capability-tab ${tab === 'bindings' ? 'active' : ''}`} onClick={() => { setTab('bindings') }}>Agent 授权</button>
        <div className="ao-capability-control-note">统一判定 = 工作区权限 ∩ Agent 工具授权（denied 优先） ∩ 实例绑定 ∩ 实例启用且凭证可解析 ∩ 运行时可用</div>
      </div>

      {error === null ? null : <div className="ao-capability-error">{error}</div>}
      {notice === null ? null : <div className="ao-capability-notice">{notice}</div>}

      {tab === 'instances' ? (
        <>
          <div className="ao-capability-command-bar">
            <input className="ao-capability-input" value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={t('search.placeholder')} />
            <select className="ao-capability-select" value={instanceCategory} onChange={(event) => { setInstanceCategory(event.target.value) }}>
              <option value="all">全部类别</option>
              {categories.map(item => <option key={item} value={item}>{categoryLabel(item)}</option>)}
            </select>
            <select className="ao-capability-select" value={instanceCapabilityId} onChange={(event) => { setInstanceCapabilityId(event.target.value) }}>
              <option value="all">全部实例能力</option>
              {instanceCapabilities.map(item => <option key={item.capabilityId} value={item.capabilityId}>{item.name}</option>)}
            </select>
            <button type="button" className="ao-capability-icon-button" onClick={() => { void load() }} aria-label={t('refresh')}>
              <IconRefreshOutlineRegular size={15} />
            </button>
          </div>

          {loading ? <div className="ao-capability-empty">{t('loading')}</div> : (
            <div className="ao-capability-card-grid" aria-label={t('tab.instances')}>
              {filteredCatalog.map(item => (
                <article className={`ao-capability-card${instanceCapabilityId === item.capabilityId ? ' active' : ''}`} key={item.capabilityId} onClick={() => { setInstanceCapabilityId(item.capabilityId) }}>
                  <div className="ao-capability-card-head">
                    <div className="ao-capability-provider">{item.provider.toUpperCase()}</div>
                    <RiskPill level={item.riskLevel} />
                  </div>
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                  <div className="ao-capability-tags">
                    <span className="ao-capability-tag subtle">{categoryLabel(item.category)}</span>
                    {item.transports.map(transport => <span className="ao-capability-tag" key={transport}>{transportLabel(transport)}</span>)}
                  </div>
                  <div className="ao-capability-card-foot">
                    <span>
                      {toolCountByCapability[item.capabilityId] ?? 0} 个工具 · {item.supportsInstances
                        ? `${instanceCountByCapability[item.capabilityId] ?? 0} 个实例`
                        : `复用 ${capabilityMap.get(item.authorizationCapabilityId)?.name ?? item.authorizationCapabilityId} 实例`}
                    </span>
                    <div className="ao-capability-card-actions">
                      <button type="button" className="ao-capability-btn secondary sm" onClick={(event) => { event.stopPropagation(); setToolCapabilityId(item.capabilityId); setTab('tools') }}>查看工具</button>
                      {item.supportsInstances ? (
                        <>
                          <button type="button" className="ao-capability-btn secondary sm" onClick={(event) => { event.stopPropagation(); setInstanceCapabilityId(item.capabilityId) }}>查看实例</button>
                          <button type="button" className="ao-capability-btn primary sm" onClick={(event) => { event.stopPropagation(); openCreate(item.capabilityId) }}>新增实例</button>
                        </>
                      ) : (
                        <button type="button" className="ao-capability-btn primary sm" onClick={(event) => { event.stopPropagation(); setInstanceCapabilityId(item.authorizationCapabilityId) }}>
                          复用 {capabilityMap.get(item.authorizationCapabilityId)?.name ?? item.authorizationCapabilityId} 实例
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          <section className="ao-capability-section ao-capability-instance-section">
            <SectionTitle
              title="连接器实例"
              description="凭证只显示“已配置/未配置”，不会回显明文。启用实例后，仍需到 Agent 授权中显式绑定。"
              action={<button type="button" className="ao-capability-btn primary sm" disabled={instanceCapabilities.length === 0} onClick={() => {
                const id = instanceCapabilityId !== 'all' ? instanceCapabilityId : instanceCapabilities[0]?.capabilityId
                if (id !== undefined) openCreate(id)
              }}>新增实例</button>}
            />
            {filteredInstances.length === 0 ? (
              <div className="ao-capability-empty">暂无匹配实例。先选择一种能力并新建连接器实例。</div>
            ) : (
              <div className="ao-capability-table-scroll">
                <table className="ao-capability-table">
                  <thead>
                    <tr>
                      <th>能力</th>
                      <th>接入方式</th>
                      <th>实例</th>
                      <th>状态</th>
                      <th>凭证</th>
                      <th>最近测试</th>
                      <th>更新时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInstances.map((item) => {
                      const capability = capabilityMap.get(item.capabilityId)
                      return (
                        <tr key={item.instanceId}>
                          <td>
                            <strong>{capability?.name ?? item.capabilityId}</strong>
                            <div className="ao-capability-muted mono">{item.capabilityId}</div>
                          </td>
                          <td>
                            <div className="ao-capability-inline-pills">
                              {(capability?.transports ?? []).map(transport => <span className="ao-capability-transport-pill" key={transport}>{transportLabel(transport)}</span>)}
                            </div>
                          </td>
                          <td>
                            <strong>{item.name}</strong>
                            <div className="ao-capability-muted mono">{item.instanceId}</div>
                          </td>
                          <td><StatusPill status={item.status} /></td>
                          <td>
                            {capability?.credentialRequired === false
                              ? <span className="ao-capability-pill muted">无需凭证</span>
                              : <span className={`ao-capability-pill ${item.credentialConfigured ? 'ok' : 'muted'}`}>{item.credentialConfigured ? '已配置' : '未配置'}</span>}
                          </td>
                          <td>
                            <StatusPill status={item.lastTestStatus ?? 'untested'} />
                            {item.lastTestError === null ? null : <div className="ao-capability-error-text" title={item.lastTestError}>{item.lastTestError}</div>}
                            <div className="ao-capability-muted">{formatTime(item.lastTestAt)}</div>
                          </td>
                          <td>{formatTime(item.updatedAt)}</td>
                          <td>
                            <div className="ao-capability-actions">
                              <button type="button" className="ao-capability-btn secondary sm" disabled={busy === item.instanceId} onClick={() => { void test(item) }}>测试</button>
                              <button type="button" className="ao-capability-btn secondary sm" disabled={busy === item.instanceId} onClick={() => { openEdit(item) }}>编辑</button>
                              <button type="button" className="ao-capability-btn secondary sm" disabled={busy === item.instanceId} onClick={() => { void toggleInstance(item) }}>{item.status === 'enabled' ? '停用' : '启用'}</button>
                              <button type="button" className="ao-capability-btn danger sm" disabled={busy === item.instanceId} onClick={() => { void remove(item) }}>删除</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      {tab === 'tools' ? (
        <section className="ao-capability-section">
          <div className="ao-capability-section-head">
            <div>
              <h2>{t('tab.tools')}</h2>
              <p>{t('tools.description')}</p>
            </div>
            <div className="ao-capability-tool-stats">
              <span><strong>{runtimeToolCount}</strong> {t('tools.runtime')}</span>
              <span><strong>{interfaceCount}</strong> {t('tools.interface')}</span>
            </div>
          </div>
          <div className="ao-capability-command-bar">
            <input className="ao-capability-input" value={toolSearch} onChange={(event) => { setToolSearch(event.target.value) }} placeholder="搜索工具、接口或 Agent…" />
            <select className="ao-capability-select" value={toolCategory} onChange={(event) => { setToolCategory(event.target.value) }}>
              <option value="all">全部类别</option>
              {categories.map(item => <option key={item} value={item}>{categoryLabel(item)}</option>)}
            </select>
            <select className="ao-capability-select" aria-label={t('tools.filter')} value={toolCapabilityId} onChange={(event) => { setToolCapabilityId(event.target.value) }}>
              <option value="all">{t('tools.all')}</option>
              {catalog.map(item => <option key={item.capabilityId} value={item.capabilityId}>{item.name}</option>)}
            </select>
          </div>
          {filteredTools.length === 0 ? <div className="ao-capability-state">{t('tools.empty')}</div> : (
            <div className="ao-capability-table-wrap">
              <table className="ao-capability-table ao-capability-tools-table">
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>产品能力</th>
                    <th>实例授权类型</th>
                    <th>接口类型 / Handler</th>
                    <th>Agent 工具授权</th>
                    <th>运行时</th>
                    <th>确认</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTools.map(item => (
                    <tr key={item.toolId}>
                      <td>
                        <strong>{item.displayName}</strong>
                        <div className="ao-capability-muted ao-capability-mono">{item.toolId}</div>
                        <div className="ao-capability-tool-description">{item.description}</div>
                      </td>
                      <td>
                        <strong>{capabilityName(item.capabilityId, catalog)}</strong>
                        <div className="ao-capability-muted ao-capability-mono">{item.capabilityId}</div>
                      </td>
                      <td>
                        <strong className="ao-capability-mono">{item.authorizationCapabilityId || '—'}</strong>
                        <div className="ao-capability-muted">{item.requiresCapabilityInstance ? t('tools.requiresInstance') : t('tools.noInstance')}</div>
                      </td>
                      <td>
                        <span className="ao-capability-transport-pill">{transportLabel(item.capabilityTransport)}</span>
                        <div className="ao-capability-mono">{item.handlerModule || '—'}</div>
                        <div className="ao-capability-muted ao-capability-mono">{item.handlerFunction || '—'}</div>
                      </td>
                      <td>
                        {item.allowedAgents.length === 0 && item.deniedAgents.length === 0
                          ? <div className="ao-capability-muted">{t('tools.accessUnrestricted')}</div>
                          : <>
                            {item.allowedAgents.length === 0 ? null : <div className="ao-capability-muted">{t('tools.allowedAgents')}: {item.allowedAgents.join(', ')}</div>}
                            {item.deniedAgents.length === 0 ? null : <div className="ao-capability-muted">{t('tools.deniedAgents')}: {item.deniedAgents.join(', ')}</div>}
                          </>}
                        <div className="ao-capability-muted">{t('tools.domains')}: {item.allowedDomains.join(', ') || '—'}</div>
                      </td>
                      <td>
                        <span className={item.runtimeAvailable ? 'ao-capability-runtime-ok' : 'ao-capability-runtime-off'}>
                          {item.runtimeAvailable ? t('tools.available') : item.declarationKind === 'interface' ? t('tools.interfaceOnly') : t('tools.unavailable')}
                        </span>
                        {item.runtimeNote === '' ? null : <div className="ao-capability-runtime-note">{item.runtimeNote}</div>}
                      </td>
                      <td>
                        <span className="ao-capability-pill muted">{item.declarationKind === 'interface' ? '仅登记元数据' : '无需额外确认'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'bindings' ? (
        <section className="ao-capability-section">
          <h2>{t('tab.bindings')}</h2>
          <label className="ao-capability-field">{t('binding.agent')}
            {agentPresets.length === 0 ? (
              <input className="ao-capability-search" value={agentPreset} onChange={(event) => { setAgentPreset(event.target.value) }} />
            ) : (
              <select value={agentPreset} onChange={(event) => { setAgentPreset(event.target.value) }}>
                {agentPresets.map(preset => (
                  <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                    {preset.name ?? preset.id}{preset.isDefault ? ` · ${t('binding.default')}` : ''}{preset.broken === undefined ? '' : ` · ${t('binding.broken')}`}
                  </option>
                ))}
              </select>
            )}
          </label>
          {presetError === null ? null : <div className="ao-capability-error">{presetError}</div>}
          {instances.length === 0 ? <div className="ao-capability-state">{t('binding.empty')}</div> : (
            <div className="ao-capability-binding-groups">
              {catalog.filter(item => item.supportsInstances).map((capability) => {
                const rows = instances.filter(item => item.capabilityId === capability.capabilityId)
                if (rows.length === 0) return null
                return (
                  <section className="ao-capability-binding-group" key={capability.capabilityId}>
                    <h3>{capability.name}</h3>
                    <div className="ao-capability-tool-grid">
                      {rows.map((item) => {
                        const selected = bindings.some(binding => binding.instanceId === item.instanceId && binding.enabled)
                        const disabled = item.status !== 'enabled' || !databaseBindingReady(item)
                        return (
                          <label key={item.instanceId} className={`ao-capability-binding${disabled ? ' ao-capability-binding-disabled' : ''}`}>
                            <input type="checkbox" checked={selected} disabled={disabled || agentPreset === ''} onChange={() => { void toggleBinding(item) }} />
                            <span>
                              <strong>{item.name}</strong>
                              <small>{item.instanceId}</small>
                              <small>{t(statusKey(item.status))} · {item.credentialConfigured ? t('instance.configured') : t('instance.missing')}</small>
                              {databaseBindingReady(item) ? null : <small className="ao-capability-runtime-note">{t('binding.databaseTablesRequired')}</small>}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {draft === null ? null : (
        <div className="ao-capability-modal" onMouseDown={() => { setDraft(null) }}>
          <form className="ao-capability-dialog" role="dialog" aria-modal="true" aria-labelledby="ao-capability-dialog-title" onMouseDown={(event) => { event.stopPropagation() }} onSubmit={(event) => {
            event.preventDefault()
            void saveDraft()
          }}>
            <header className="ao-capability-dialog-header">
              <div>
                <div className="ao-capability-kicker">{draft.instanceId === undefined ? 'NEW INTEGRATION' : 'EDIT INTEGRATION'}</div>
                <h2 id="ao-capability-dialog-title">{draft.instanceId === undefined ? t('instance.new') : t('instance.edit')}</h2>
                <p>{catalog.find(item => item.capabilityId === draft.capabilityId)?.description ?? '配置连接器实例的连接参数与加密凭证。'}</p>
              </div>
              <button type="button" className="ao-capability-dialog-close" aria-label="关闭" onClick={() => { setDraft(null) }}>×</button>
            </header>

            <div className="ao-capability-dialog-body">
              <section className="ao-capability-form-section">
                <div className="ao-capability-form-head">
                  <div>
                    <strong>基础信息</strong>
                    <span>用于在能力与连接器中识别和授权这个实例。</span>
                  </div>
                </div>
                <div className="ao-capability-schema-fields">
                  <label className="ao-capability-field">
                    <span className="ao-capability-field-label">{t('instance.capability')}</span>
                    <select value={draft.capabilityId} onChange={(event) => {
                      const capability = catalog.find(item => item.capabilityId === event.target.value)
                      if (capability === undefined) return
                      setDraft({
                        ...draft,
                        capabilityId: capability.capabilityId,
                        config: {},
                        configJson: '{\n  \n}',
                        configValues: configFormValues(capability.configSchema),
                        configMode: 'fields',
                      })
                    }}>
                      {catalog.filter(item => item.supportsInstances).map(item => (
                        <option key={item.capabilityId} value={item.capabilityId}>{item.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="ao-capability-field">
                    <span className="ao-capability-field-label">{t('instance.name')}</span>
                    <input value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} placeholder="例如：生产 OA / 运营群通知" />
                  </label>
                </div>
              </section>

              <section className="ao-capability-form-section">
                <div className="ao-capability-form-head">
                  <div>
                    <strong>连接配置</strong>
                    <span>非敏感配置会明文保存；凭证在下方单独加密。</span>
                  </div>
                  <button type="button" className="ao-capability-mode" onClick={toggleConfigMode}>
                    {draft.configMode === 'fields' ? t('instance.config.advanced') : t('instance.config.fields')}
                  </button>
                </div>
                {draft.configMode === 'fields' ? (
                  <div className="ao-capability-schema-fields">
                    {(catalog.find(item => item.capabilityId === draft.capabilityId)?.configSchema ?? [])
                      .filter(field => field.key !== 'secret')
                      .map(field => (
                        <label className="ao-capability-field" key={field.key}>
                          <span className="ao-capability-field-label">{fieldLabel(field)}{field.required ? <em> *</em> : null}</span>
                          {field.type === 'boolean' ? (
                            <span className="ao-capability-checkbox-row">
                              <input type="checkbox" checked={draft.configValues[field.key] === true} onChange={(event) => { setDraft({ ...draft, configValues: { ...draft.configValues, [field.key]: event.target.checked } }) }} />
                              <span>启用</span>
                            </span>
                          ) : field.type === 'select' ? (
                            <select value={String(draft.configValues[field.key] ?? '')} onChange={(event) => { setDraft({ ...draft, configValues: { ...draft.configValues, [field.key]: event.target.value } }) }}>
                              <option value="">{t('instance.config.select')}</option>
                              {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                          ) : field.type === 'array' ? (
                            <input value={String(draft.configValues[field.key] ?? '')} placeholder={field.placeholder ?? t('instance.config.array')} onChange={(event) => { setDraft({ ...draft, configValues: { ...draft.configValues, [field.key]: event.target.value } }) }} />
                          ) : field.key === 'host_key_sha256' && draft.capabilityId === 'ssh' ? (
                            <span className="ao-capability-hostkey-row">
                              <input value={String(draft.configValues[field.key] ?? '')} placeholder={field.placeholder ?? t('hostkey.placeholder')} onChange={(event) => { setDraft({ ...draft, configValues: { ...draft.configValues, [field.key]: event.target.value } }) }} />
                              <button type="button" className="ao-capability-btn secondary sm" disabled={hostKeyBusy} onClick={() => { hostKeyAttempt.current = ''; void fetchHostKey(String(draft.configValues.host ?? ''), String(draft.configValues.port ?? '')) }}>{hostKeyBusy ? t('hostkey.fetching') : t('hostkey.fetch')}</button>
                            </span>
                          ) : (
                            <input type={field.type === 'number' ? 'number' : 'text'} value={String(draft.configValues[field.key] ?? '')} placeholder={field.placeholder ?? ''} onChange={(event) => { setDraft({ ...draft, configValues: { ...draft.configValues, [field.key]: event.target.value } }) }} />
                          )}
                          {field.description === undefined ? null : <small>{field.description}</small>}
                          {field.key === 'host_key_sha256' && draft.capabilityId === 'ssh' && hostKeyNote !== null ? <small className="ao-capability-hostkey-note">{hostKeyNote}</small> : null}
                        </label>
                      ))}
                  </div>
                ) : (
                  <>
                    <textarea className="ao-capability-json-editor" rows={8} value={draft.configJson} onChange={(event) => {
                      setDraft({ ...draft, configJson: event.target.value })
                    }} />
                    {(() => {
                      const fields = catalog.find(item => item.capabilityId === draft.capabilityId)?.configSchema
                        .filter(field => field.key !== 'secret') ?? []
                      const unsupported = Object.keys(draft.config).filter(key => key !== 'secret' && !fields.some(field => field.key === key))
                      return unsupported.length === 0 ? null : <div className="ao-capability-muted">{t('instance.config.unsupported').replace('{fields}', unsupported.join(', '))}</div>
                    })()}
                  </>
                )}
              </section>

              {(() => {
                if (draft.capabilityId !== 'database') return null
                const engine = String(draft.configValues.engine ?? '').trim()
                const tableSchema = engine === 'postgres'
                  ? (String(draft.configValues.schema ?? '').trim() || 'public')
                  : (String(draft.configValues.database ?? '').trim() || 'main')
                const selectedTables = policyTables(draft.accessPolicy)
                const query = tableSearch.trim().toLowerCase()
                const visibleTables = tableList.filter(name => query === '' || name.toLowerCase().includes(query))
                return (
                  <section className="ao-capability-form-section">
                    <div className="ao-capability-form-head">
                      <div>
                        <strong>{t('tables.title')}</strong>
                        <span>{t('tables.description')}</span>
                      </div>
                      <button
                        type="button"
                        className="ao-capability-mode"
                        disabled={tablesBusy || draft.instanceId === undefined}
                        onClick={() => { if (draft.instanceId !== undefined) void loadTables(draft.instanceId) }}
                      >
                        {tablesBusy ? t('tables.loading') : t('tables.load')}
                      </button>
                    </div>
                    {draft.instanceId === undefined ? <div className="ao-capability-muted">{t('tables.saveFirst')}</div> : null}
                    {tablesNote === null ? null : <small className="ao-capability-hostkey-note">{tablesNote}</small>}
                    {tableList.length === 0 ? null : (
                      <>
                        <input
                          className="ao-capability-table-search"
                          value={tableSearch}
                          placeholder={t('tables.search')}
                          onChange={(event) => { setTableSearch(event.target.value) }}
                        />
                        <div className="ao-capability-table-actions">
                          <button
                            type="button"
                            className="ao-capability-btn secondary sm"
                            onClick={() => {
                              setDraft({ ...draft, accessPolicy: policyWithTables(draft.accessPolicy, tableSchema, tableList) })
                            }}
                          >
                            {t('tables.selectAll')}
                          </button>
                          <button
                            type="button"
                            className="ao-capability-btn secondary sm"
                            onClick={() => { setDraft({ ...draft, accessPolicy: policyWithTables(draft.accessPolicy, tableSchema, []) }) }}
                          >
                            {t('tables.clear')}
                          </button>
                          <span>{t('tables.selected').replace('{count}', String(selectedTables.length)).replace('{total}', String(tableList.length))}</span>
                        </div>
                        <div className="ao-capability-table-list">
                          {visibleTables.map(name => (
                            <label key={name} className="ao-capability-table-item">
                              <input
                                type="checkbox"
                                checked={selectedTables.includes(name)}
                                onChange={(event) => {
                                  const next = event.target.checked
                                    ? [...selectedTables, name]
                                    : selectedTables.filter(item => item !== name)
                                  setDraft({ ...draft, accessPolicy: policyWithTables(draft.accessPolicy, tableSchema, next) })
                                }}
                              />
                              <span>{name}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                )
              })()}

              {catalog.find(item => item.capabilityId === draft.capabilityId)?.credentialRequired === false ? (
                <section className="ao-capability-form-section">
                  <div className="ao-capability-form-head">
                    <div>
                      <strong>凭证说明</strong>
                      <span>当前能力不需要 Token、密码或 Webhook。</span>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="ao-capability-form-section">
                  <div className="ao-capability-form-head">
                    <div>
                      <strong>加密凭证</strong>
                      <span>保存后写入 AgentOps 加密凭证库；编辑时留空表示不修改现有凭证。</span>
                    </div>
                  </div>
                  {(() => {
                    const secretField = catalog
                      .find(item => item.capabilityId === draft.capabilityId)
                      ?.configSchema.find(field => field.key === 'secret')
                    const isWebhook = draft.capabilityId === 'wecom' || draft.capabilityId === 'feishu-bot'
                    return (
                      <label className="ao-capability-field">
                        <span className="ao-capability-field-label">{draft.instanceId === undefined ? t('instance.secret') : '替换凭证（可选）'}</span>
                        <input
                          type="password"
                          value={draft.secret}
                          placeholder={secretField?.placeholder ?? (isWebhook ? 'https://…' : '')}
                          onChange={(event) => { setDraft({ ...draft, secret: event.target.value }) }}
                          autoComplete="new-password"
                        />
                        {secretField?.description === undefined
                          ? null
                          : <small>{secretField.description}</small>}
                        {isWebhook ? <small>{t('webhook.hint')}</small> : null}
                      </label>
                    )
                  })()}
                </section>
              )}
            </div>

            {draftError === null ? null : <div className="ao-capability-dialog-error">{draftError}</div>}
            <footer className="ao-capability-dialog-footer">
              <span>{catalog.find(item => item.capabilityId === draft.capabilityId)?.provider ?? ''}</span>
              <div className="ao-capability-actions">
                <button type="button" className="ao-capability-btn secondary" onClick={() => { setDraft(null) }}>{t('instance.cancel')}</button>
                <button type="submit" className="ao-capability-btn primary" disabled={busy === 'save'}>{draft.instanceId === undefined ? '创建实例' : '保存修改'}</button>
              </div>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}

/** Sidebar glyph for the capability-center entry. */
export function CapabilityPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return <IconCordisPluginOutlineRegular size={size} />
}
