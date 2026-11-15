/**
 * Monitor page using only data collected by DSH-side AgentOps stores.
 *
 * The layout follows the legacy monitoring center, while unavailable runtime
 * and cost metrics stay explicitly labelled as not collected.
 *
 * @module @agentops/dsh-client/client/monitor-panel
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { loadAgentRunStats, type AgentRunStats } from './agent-run-stats.js'
import { createTaskRpcClient } from './task-rpc-api.ts'
import { loadWorkflowCatalog } from './workflow-editor-api.js'

const taskClient = createTaskRpcClient()

const RANGE_OPTIONS = [7, 14, 30, 90] as const
const HEATMAP_WEEKS = 26
const HEATMAP_DAY_MS = 86_400_000
const PROVIDER_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#A855F7', '#06B6D4', '#F43F5E', '#84CC16', '#64748B']

interface UsageBreakdown {
  tokens: number
  calls: number
}

interface ProviderUsage extends UsageBreakdown {
  provider: string
}

interface ModelUsage extends UsageBreakdown {
  model: string
}

interface PurposeUsage extends UsageBreakdown {
  purpose: string
}

interface DailyProviderUsage {
  date: string
  provider: string
  tokens: number
  calls: number
}

interface MonitorSummary {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  calls: number
  daily: DailyProviderUsage[]
  byProvider: ProviderUsage[]
  byModel: ModelUsage[]
  byPurpose: PurposeUsage[]
}

interface MonitorResponse {
  generatedAt: string
  range: { days: number; since: string }
  summary: MonitorSummary
  heatmap: {
    weeks: number
    days: number
    since: string
    daily: { date: string; tokens: number; calls: number }[]
  }
  capabilities: {
    cost: boolean
    agentRuntime: boolean
    tips: boolean
  }
}

interface AgentSummary {
  id: string
  name: string
  domain: string
  harness: string
  execution_backend: string
  execution: 'skill' | 'workflow'
  workflow: string
  model: string
  source: string
}

interface AgentDirectory {
  dir: string
  missing: boolean
  entries: AgentSummary[]
}

interface TaskEvent {
  seq: number
  taskId: string
  kind: string
  fromStatus?: string
  toStatus?: string
  actor: string
  reason?: string
  at: string
  taskTitle: string
}

interface BreakdownEntry {
  label: string
  tokens: number
  calls: number
}

interface TrendDay {
  date: string
  tokens: number
  segments: Array<{ provider: string; tokens: number }>
}

interface HeatmapCell {
  date: string
  tokens: number
  calls: number
  future: boolean
}

interface HeatmapModel {
  cells: HeatmapCell[]
  monthLabels: Array<{ week: number; label: string }>
  activeDays: number
  elapsedDays: number
  peak: number
  max: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isUsageBreakdown(value: unknown): value is UsageBreakdown {
  return isRecord(value)
    && isFiniteNumber(value.tokens)
    && isFiniteNumber(value.calls)
}

function isProviderUsage(value: unknown): value is ProviderUsage {
  return isUsageBreakdown(value)
    && isRecord(value)
    && typeof value.provider === 'string'
}

function isModelUsage(value: unknown): value is ModelUsage {
  return isUsageBreakdown(value)
    && isRecord(value)
    && typeof value.model === 'string'
}

function isPurposeUsage(value: unknown): value is PurposeUsage {
  return isUsageBreakdown(value)
    && isRecord(value)
    && typeof value.purpose === 'string'
}

function isDailyProviderUsage(value: unknown): value is DailyProviderUsage {
  return isRecord(value)
    && typeof value.date === 'string'
    && typeof value.provider === 'string'
    && isFiniteNumber(value.tokens)
    && isFiniteNumber(value.calls)
}

function isMonitorSummary(value: unknown): value is MonitorSummary {
  return isRecord(value)
    && isFiniteNumber(value.totalTokens)
    && isFiniteNumber(value.promptTokens)
    && isFiniteNumber(value.completionTokens)
    && isFiniteNumber(value.calls)
    && Array.isArray(value.daily)
    && value.daily.every(isDailyProviderUsage)
    && Array.isArray(value.byProvider)
    && value.byProvider.every(isProviderUsage)
    && Array.isArray(value.byModel)
    && value.byModel.every(isModelUsage)
    && Array.isArray(value.byPurpose)
    && value.byPurpose.every(isPurposeUsage)
}

function isDailyUsage(value: unknown): value is { date: string; tokens: number; calls: number } {
  return isRecord(value)
    && typeof value.date === 'string'
    && isFiniteNumber(value.tokens)
    && isFiniteNumber(value.calls)
}

function isMonitorResponse(value: unknown): value is MonitorResponse {
  if (!isRecord(value)
    || typeof value.generatedAt !== 'string'
    || Number.isNaN(Date.parse(value.generatedAt))) return false
  if (!isRecord(value.range)
    || !isFiniteNumber(value.range.days)
    || typeof value.range.since !== 'string') return false
  if (!isMonitorSummary(value.summary)) return false
  if (!isRecord(value.heatmap)
    || !isFiniteNumber(value.heatmap.weeks)
    || !isFiniteNumber(value.heatmap.days)
    || typeof value.heatmap.since !== 'string'
    || !Array.isArray(value.heatmap.daily)
    || !value.heatmap.daily.every(isDailyUsage)) return false
  return isRecord(value.capabilities)
    && typeof value.capabilities.cost === 'boolean'
    && typeof value.capabilities.agentRuntime === 'boolean'
    && typeof value.capabilities.tips === 'boolean'
}

function isAgentSummary(value: unknown): value is AgentSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.domain === 'string'
    && typeof value.harness === 'string'
    && typeof value.execution_backend === 'string'
    && (value.execution === 'skill' || value.execution === 'workflow')
    && typeof value.workflow === 'string'
    && typeof value.model === 'string'
    && typeof value.source === 'string'
}

function isAgentDirectory(value: unknown): value is AgentDirectory {
  return isRecord(value)
    && typeof value.dir === 'string'
    && typeof value.missing === 'boolean'
    && Array.isArray(value.entries)
    && value.entries.every(isAgentSummary)
}

async function readApiJson<T>(
  response: Response,
  guard: (value: unknown) => value is T,
  invalidMessage: string,
): Promise<T> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error(invalidMessage)
  }
  if (!guard(value)) throw new Error(invalidMessage)
  return value
}

/**
 * Render the AgentOps monitoring center.
 * @returns monitor page.
 */
export function MonitorPanel(): ReactElement {
  const [days, setDays] = useState<(typeof RANGE_OPTIONS)[number]>(30)
  const [monitor, setMonitor] = useState<MonitorResponse | null>(null)
  const [monitorError, setMonitorError] = useState('')
  const [monitorLoading, setMonitorLoading] = useState(true)

  const [agents, setAgents] = useState<AgentDirectory | null>(null)
  const [agentsError, setAgentsError] = useState('')
  const [agentsLoading, setAgentsLoading] = useState(true)

  const [activity, setActivity] = useState<TaskEvent[]>([])
  const [activityError, setActivityError] = useState('')
  const [activityLoading, setActivityLoading] = useState(true)
  const [agentWorkflows, setAgentWorkflows] = useState<ReadonlyMap<string, readonly string[]>>(new Map())

  useEffect(() => {
    const controller = new AbortController()
    setMonitorLoading(true)
    setMonitorError('')
    setMonitor(null)

    fetch(`/api/agentops/monitor?days=${days}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return readApiJson(response, isMonitorResponse, '\u76d1\u63a7\u6570\u636e\u683c\u5f0f\u4e0d\u5b8c\u6574')
      })
      .then((data) => {
        setMonitor(data)
        setMonitorLoading(false)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setMonitorError(reason instanceof Error ? reason.message : String(reason))
        setMonitorLoading(false)
      })

    return () => { controller.abort() }
  }, [days])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/agentops/agents', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return readApiJson(response, isAgentDirectory, 'Agent \u6570\u636e\u683c\u5f0f\u4e0d\u5b8c\u6574')
      })
      .then((data) => {
        setAgents(data)
        setAgentsLoading(false)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setAgentsError(reason instanceof Error ? reason.message : String(reason))
        setAgentsLoading(false)
      })
    return () => { controller.abort() }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadWorkflowRefs = async (): Promise<void> => {
      try {
        const catalog = await loadWorkflowCatalog()
        if (cancelled) return
        const refs = new Map<string, string[]>()
        for (const workflow of catalog.entries) {
          for (const node of workflow.nodes) {
            if (node.agentRef === undefined || node.agentRef.trim() === '') continue
            const ids = refs.get(node.agentRef) ?? []
            if (!ids.includes(workflow.id)) ids.push(workflow.id)
            refs.set(node.agentRef, ids)
          }
        }
        for (const ids of refs.values()) ids.sort()
        setAgentWorkflows(refs)
      } catch {
        // The agent catalogue still renders from its declared workflow binding.
      }
    }

    void loadWorkflowRefs()
    const timer = window.setInterval(() => { void loadWorkflowRefs() }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadActivity = async (): Promise<void> => {
      try {
        const result = await taskClient.listActivities({ limit: '20' })
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        const data = result.value as { activities: typeof activity }
        if (cancelled) return
        setActivity(data.activities)
        setActivityError('')
      } catch (reason: unknown) {
        if (cancelled) return
        setActivityError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setActivityLoading(false)
      }
    }

    void loadActivity()
    const timer = window.setInterval(() => { void loadActivity() }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="ao-page ao-monitor agentops-surface">
      <header className="ao-page-header">
        <div className="ao-page-heading">
          <h1 className="ao-page-title">监控中心</h1>
          <p className="ao-page-description">集中查看模型用量、Agent 运行状态与任务动态提示。</p>
        </div>
      </header>

      <div className="ao-monitor__top-grid">
        <UsageSummaryCard
          days={days}
          error={monitorError}
          loading={monitorLoading}
          monitor={monitor}
          onDaysChange={setDays}
        />
        <UsageTrendCard
          days={days}
          error={monitorError}
          loading={monitorLoading}
          monitor={monitor}
          onDaysChange={setDays}
        />
        <UsageHeatmapCard error={monitorError} loading={monitorLoading} monitor={monitor} />
      </div>

      <AgentStatusGrid
        agents={agents}
        agentWorkflows={agentWorkflows}
        error={agentsError}
        loading={agentsLoading}
        runtimeAvailable={monitor?.capabilities.agentRuntime === true}
      />

      <TipsStream
        error={activityError}
        events={activity}
        loading={activityLoading}
      />

      <p className="ao-monitor__footnote">
        用量来自 DSH 的 LLM 调用采集，不含旧平台历史；日期按 UTC 聚合。动态提示每 5 秒轮询任务事件，不是实时推送。
      </p>
    </div>
  )
}

function UsageSummaryCard({
  days,
  error,
  loading,
  monitor,
  onDaysChange,
}: {
  days: number
  error: string
  loading: boolean
  monitor: MonitorResponse | null
  onDaysChange: (days: (typeof RANGE_OPTIONS)[number]) => void
}): ReactElement {
  const summary = monitor?.summary
  const activeDays = useMemo(() => countActiveDays(summary), [summary])
  const providerEntries = useMemo<BreakdownEntry[]>(
    () => (summary?.byProvider ?? []).map(item => ({
      label: displayUnknown(item.provider),
      tokens: item.tokens,
      calls: item.calls,
    })),
    [summary],
  )
  const modelEntries = useMemo<BreakdownEntry[]>(
    () => (summary?.byModel ?? []).map(item => ({
      label: displayUnknown(item.model),
      tokens: item.tokens,
      calls: item.calls,
    })),
    [summary],
  )
  const purposeEntries = useMemo<BreakdownEntry[]>(
    () => (summary?.byPurpose ?? []).map(item => ({
      label: displayUnknown(item.purpose),
      tokens: item.tokens,
      calls: item.calls,
    })),
    [summary],
  )

  return (
    <section className="ao-monitor__card ao-monitor__usage-summary" aria-label="用量与成本">
      <div className="ao-monitor__section-head">
        <div>
          <h2 className="ao-monitor__section-title">用量与成本</h2>
          <p className="ao-monitor__section-subtitle">区间用量 · 真实采集</p>
        </div>
        <RangeButtons days={days} onChange={onDaysChange} />
      </div>

      {error !== '' && <div className="ao-monitor__inline-error" role="alert">用量加载失败：{error}</div>}

      <div className="ao-monitor__usage-hero">
        <div className="ao-monitor__hero-main">
          <span className="ao-monitor__hero-label">总 Token</span>
          <strong className="ao-monitor__hero-value">
            {loading && monitor === null ? '—' : formatTokens(summary?.totalTokens ?? 0)}
          </strong>
          <span className="ao-monitor__hero-note">精确值 {formatNumber(summary?.totalTokens ?? 0)}</span>
        </div>
        <div className="ao-monitor__hero-side">
          <span className="ao-monitor__hero-label">区间成本</span>
          <strong className="ao-monitor__cost-state">成本未采集</strong>
          <span className="ao-monitor__hero-note">DSH 尚未上报价格</span>
        </div>
      </div>

      <div className="ao-monitor__mini-grid">
        <MiniStat label="Prompt" value={summary === undefined ? '—' : formatTokens(summary.promptTokens)} />
        <MiniStat label="Completion" value={summary === undefined ? '—' : formatTokens(summary.completionTokens)} />
        <MiniStat label="调用次数" value={summary === undefined ? '—' : formatNumber(summary.calls)} />
        <MiniStat label="活跃日" value={summary === undefined ? '—' : `${activeDays} / ${days}`} />
      </div>

      <div className="ao-monitor__breakdown-grid">
        <BreakdownColumn title="提供方" entries={providerEntries} />
        <BreakdownColumn title="模型" entries={modelEntries} />
        <BreakdownColumn title="调用用途" entries={purposeEntries} />
      </div>
    </section>
  )
}

function UsageTrendCard({
  days,
  error,
  loading,
  monitor,
  onDaysChange,
}: {
  days: number
  error: string
  loading: boolean
  monitor: MonitorResponse | null
  onDaysChange: (days: (typeof RANGE_OPTIONS)[number]) => void
}): ReactElement {
  const trend = useMemo(() => buildTrend(monitor), [monitor])
  const total = trend.reduce((sum, day) => sum + day.tokens, 0)
  const max = Math.max(0, ...trend.map(day => day.tokens))
  const providerOrder = monitor?.summary.byProvider.map(item => item.provider) ?? []
  const providerIndex = new Map(providerOrder.map((provider, index) => [provider, index]))

  return (
    <section className="ao-monitor__card ao-monitor__usage-trend" aria-label="用量趋势">
      <div className="ao-monitor__section-head">
        <div>
          <h2 className="ao-monitor__section-title">用量趋势</h2>
          <p className="ao-monitor__section-subtitle">按日 · 按提供方堆叠</p>
        </div>
        <RangeButtons days={days} onChange={onDaysChange} />
      </div>

      {error !== '' && <div className="ao-monitor__inline-error" role="alert">趋势加载失败：{error}</div>}

      <div className="ao-monitor__trend-body">
        {loading && monitor === null ? (
          <div className="ao-monitor__empty">加载中…</div>
        ) : total === 0 ? (
          <div className="ao-monitor__empty">区间内暂无用量</div>
        ) : (
          <>
            <div className="ao-monitor__bars" role="img" aria-label={`近 ${days} 天按提供方堆叠的 Token 用量`}>
              {trend.map((day, dayIndex) => {
                const height = max === 0 ? 0 : (day.tokens / max) * 100
                return (
                  <div
                    key={day.date}
                    className="ao-monitor__bar-day"
                    title={[
                      day.date,
                      `Token ${formatNumber(day.tokens)}`,
                      ...day.segments.map(segment => `${displayUnknown(segment.provider)} ${formatNumber(segment.tokens)}`),
                    ].join('\n')}
                  >
                    <div className="ao-monitor__bar-stack" style={{ height: `${height}%` }}>
                      {day.segments.map(segment => (
                        <span
                          key={`${day.date}-${segment.provider}`}
                          className="ao-monitor__bar-segment"
                          style={{
                            background: PROVIDER_COLORS[providerIndex.get(segment.provider) ?? 0],
                            flexGrow: segment.tokens,
                          }}
                        />
                      ))}
                    </div>
                    {shouldShowDateLabel(dayIndex, trend.length) && (
                      <span className="ao-monitor__bar-date">{shortDate(day.date)}</span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="ao-monitor__legend" aria-label="提供方图例">
              {providerOrder.map((provider, index) => (
                <span key={provider} className="ao-monitor__legend-item">
                  <span className="ao-monitor__legend-dot" style={{ background: PROVIDER_COLORS[index] }} />
                  {displayUnknown(provider)}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function UsageHeatmapCard({
  error,
  loading,
  monitor,
}: {
  error: string
  loading: boolean
  monitor: MonitorResponse | null
}): ReactElement {
  const model = useMemo(() => buildHeatmap(monitor), [monitor])
  const activeRate = model.elapsedDays === 0 ? 0 : (model.activeDays / model.elapsedDays) * 100

  return (
    <section className="ao-monitor__card ao-monitor__usage-heatmap" aria-label="调用热力图">
      <div className="ao-monitor__section-head">
        <div>
          <h2 className="ao-monitor__section-title">调用热力图</h2>
          <p className="ao-monitor__section-subtitle">近 {HEATMAP_WEEKS} 周 · UTC 日期</p>
        </div>
        <span className="ao-monitor__neutral-pill">Token 强度</span>
      </div>

      {error !== '' && <div className="ao-monitor__inline-error" role="alert">热力图加载失败：{error}</div>}

      {loading && monitor === null ? (
        <div className="ao-monitor__empty ao-monitor__heatmap-empty">加载中…</div>
      ) : (
        <>
          <div className="ao-monitor__heatmap-scroll">
            <svg
              className="ao-monitor__heatmap-svg"
              viewBox="0 0 332 98"
              role="img"
              aria-label={`近 ${HEATMAP_WEEKS} 周每日 Token 调用强度`}
            >
              <g transform="translate(20 14)">
                {model.monthLabels.map(label => (
                  <text
                    key={`${label.week}-${label.label}`}
                    x={label.week * 12}
                    y={-4}
                    className="ao-monitor__heatmap-month"
                  >
                    {label.label}
                  </text>
                ))}
                {[0, 2, 4].map(row => (
                  <text
                    key={row}
                    x={-5}
                    y={row * 12 + 9}
                    textAnchor="end"
                    className="ao-monitor__heatmap-weekday"
                  >
                    {['一', '三', '五'][row / 2]}
                  </text>
                ))}
                {model.cells.map((cell, index) => {
                  const week = Math.floor(index / 7)
                  const row = index % 7
                  const level = cell.future ? 0 : heatLevel(cell.tokens, model.max)
                  return (
                    <rect
                      key={cell.date}
                      x={week * 12}
                      y={row * 12}
                      width={9}
                      height={9}
                      rx={2}
                      className={cell.future
                        ? 'ao-monitor__heat-cell ao-monitor__heat-cell--future'
                        : `ao-monitor__heat-cell ao-monitor__heat-cell--${level}`}
                    >
                      {!cell.future && (
                        <title>{`${cell.date}：${formatNumber(cell.tokens)} Token · ${cell.calls} 次调用`}</title>
                      )}
                    </rect>
                  )
                })}
              </g>
            </svg>
          </div>

          <div className="ao-monitor__heat-stats">
            <HeatStat value={formatNumber(model.activeDays)} label="活跃日" />
            <HeatStat value={`${activeRate.toFixed(0)}%`} label="活跃率" />
            <HeatStat value={formatTokens(model.peak)} label="单日峰值" />
          </div>
          <div className="ao-monitor__heat-legend" aria-label="热力等级图例">
            <span>少</span>
            {[0, 1, 2, 3, 4].map(level => (
              <span key={level} className={`ao-monitor__heat-legend-cell ao-monitor__heat-cell--${level}`} />
            ))}
            <span>多</span>
          </div>
        </>
      )}
    </section>
  )
}

function AgentStatusGrid({
  agents,
  agentWorkflows,
  error,
  loading,
  runtimeAvailable,
}: {
  agents: AgentDirectory | null
  agentWorkflows: ReadonlyMap<string, readonly string[]>
  error: string
  loading: boolean
  runtimeAvailable: boolean
}): ReactElement {
  const entries = agents?.entries ?? []

  return (
    <section className="ao-monitor__card ao-monitor__agents" aria-label="Agent 状态">
      <div className="ao-monitor__section-head">
        <div>
          <h2 className="ao-monitor__section-title">Agent 状态</h2>
          <p className="ao-monitor__section-subtitle">Agent 定义 + DSH 工作流运行历史</p>
        </div>
        <span className="ao-monitor__neutral-pill">{runtimeAvailable ? '实时状态已采集' : '实时状态未采集'} · {entries.length} 总计</span>
      </div>

      {error !== '' && <div className="ao-monitor__inline-error" role="alert">Agent 列表加载失败：{error}</div>}

      {loading && agents === null ? (
        <div className="ao-monitor__empty">加载 Agent…</div>
      ) : agents?.missing === true ? (
        <div className="ao-monitor__empty">
          Agent 目录不存在：<span className="ao-monitor__mono">{agents.dir}</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="ao-monitor__empty">暂无已注册 Agent</div>
      ) : (
        <div className="ao-monitor__agent-grid">
          {entries.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              referencedWorkflows={agentWorkflows.get(agent.id) ?? []}
            />
          ))}
        </div>
      )}

      <p className="ao-monitor__section-note">
        工作流型 Agent 的运行数、完成/失败数和最近运行时间来自 DSH 持久化工作流运行记录；技能型 Agent 没有固定工作流绑定，不展示推测值。实时健康状态仍未采集。
      </p>
    </section>
  )
}

function AgentCard({
  agent,
  referencedWorkflows,
}: {
  agent: AgentSummary
  referencedWorkflows: readonly string[]
}): ReactElement {
  const [stats, setStats] = useState<AgentRunStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [statsLoading, setStatsLoading] = useState(false)
  const workflowIds = useMemo(() => {
    const ids = new Set(referencedWorkflows)
    if (agent.execution === 'workflow' && agent.workflow.trim() !== '') ids.add(agent.workflow.trim())
    return [...ids].sort()
  }, [agent.execution, agent.workflow, referencedWorkflows])

  useEffect(() => {
    let cancelled = false
    if (workflowIds.length === 0) {
      setStats(null)
      setStatsError('')
      setStatsLoading(false)
      return () => { cancelled = true }
    }

    const load = async (): Promise<void> => {
      setStatsError('')
      setStatsLoading(true)
      try {
        const next = await loadAgentRunStats(workflowIds)
        if (!cancelled) setStats(next)
      } catch (reason) {
        if (!cancelled) setStatsError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setStatsLoading(false)
      }
    }

    void load()
    const timer = window.setInterval(() => { void load() }, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [workflowIds])

  const runtime = agentRuntimeText(workflowIds, stats, statsLoading, statsError)
  const latest = stats?.latest === undefined ? '—' : formatTimestamp(stats.latest.startedAt)

  return (
    <article className="ao-monitor__agent-card">
      <div className="ao-monitor__agent-head">
        <div className="ao-monitor__agent-idblock">
          <span className="ao-monitor__agent-name">{agent.name}</span>
          <span className="ao-monitor__agent-id">{agent.id}</span>
        </div>
        <div className="ao-monitor__badges">
          <span className="ao-monitor__badge">{executionBackendLabel(agent.execution_backend)}</span>
          <span className="ao-monitor__badge ao-monitor__badge--muted">{sourceLabel(agent.source)}</span>
        </div>
      </div>

      <div className="ao-monitor__agent-tags">
        <span>{agent.domain || '未分类'}</span>
        <span className="ao-monitor__mono">{agent.model || '模型未标注'}</span>
        <span className="ao-monitor__mono">
          {workflowIds.length === 0
            ? '无工作流引用'
            : workflowIds.length === 1
              ? `工作流 ${workflowIds[0]}`
              : `${workflowIds.length} 个工作流引用`}
        </span>
      </div>

      <div className={`ao-monitor__agent-runtime ao-monitor__agent-runtime--${runtime.tone}`}>
        <span className="ao-monitor__status-dot" />
        <div>
          <strong>{runtime.title}</strong>
          <span>{runtime.detail}</span>
        </div>
      </div>

      <div className="ao-monitor__agent-stats">
        <AgentStat label="总运行" value={stats === null ? '—' : formatNumber(stats.total)} />
        <AgentStat label="完成" value={stats === null ? '—' : formatNumber(stats.completed)} />
        <AgentStat label="失败" value={stats === null ? '—' : formatNumber(stats.failed)} />
        <AgentStat label="最近" value={latest} />
      </div>
    </article>
  )
}

function TipsStream({
  error,
  events,
  loading,
}: {
  error: string
  events: TaskEvent[]
  loading: boolean
}): ReactElement {
  const recent = events.slice(0, 6)

  return (
    <section className="ao-monitor__card ao-monitor__tips" aria-label="动态提示">
      <div className="ao-monitor__section-head">
        <div>
          <h2 className="ao-monitor__section-title">动态提示</h2>
          <p className="ao-monitor__section-subtitle">最近任务事件</p>
        </div>
        <span className="ao-monitor__poll-state">
          <span className="ao-monitor__poll-dot" />
          5s 轮询
        </span>
      </div>

      {error !== '' && <div className="ao-monitor__inline-error" role="alert">动态提示加载失败：{error}</div>}

      {loading && events.length === 0 ? (
        <div className="ao-monitor__empty ao-monitor__tips-empty">加载中…</div>
      ) : recent.length === 0 ? (
        <div className="ao-monitor__empty ao-monitor__tips-empty">暂无提示事件</div>
      ) : (
        <ul className="ao-monitor__tips-list">
          {recent.map(event => (
            <li key={`${event.seq}-${event.taskId}`} className="ao-monitor__tip-item">
              <span className={`ao-monitor__tip-dot ao-monitor__tip-dot--${eventTone(event.kind)}`} />
              <div className="ao-monitor__tip-content">
                <span className="ao-monitor__tip-title">{event.taskTitle}</span>
                <span className="ao-monitor__tip-detail">{eventDescription(event)}</span>
              </div>
              <time className="ao-monitor__tip-time" dateTime={event.at}>{formatTimestamp(event.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RangeButtons({
  days,
  onChange,
}: {
  days: number
  onChange: (days: (typeof RANGE_OPTIONS)[number]) => void
}): ReactElement {
  return (
    <div className="ao-monitor__ranges" role="group" aria-label="监控区间">
      {RANGE_OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          className={`ao-monitor__range-button${days === option ? ' ao-monitor__range-button--active' : ''}`}
          aria-pressed={days === option}
          onClick={() => { onChange(option) }}
        >
          {option}天
        </button>
      ))}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="ao-monitor__mini-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function BreakdownColumn({ title, entries }: { title: string; entries: BreakdownEntry[] }): ReactElement {
  return (
    <div className="ao-monitor__breakdown">
      <span className="ao-monitor__breakdown-title">{title}</span>
      {entries.length === 0 ? (
        <span className="ao-monitor__breakdown-empty">暂无</span>
      ) : (
        entries.slice(0, 3).map(entry => (
          <span key={entry.label} className="ao-monitor__breakdown-row" title={`${formatNumber(entry.tokens)} Token · ${entry.calls} 次调用`}>
            <span className="ao-monitor__breakdown-label">{entry.label}</span>
            <span className="ao-monitor__mono">{formatTokens(entry.tokens)}</span>
          </span>
        ))
      )}
    </div>
  )
}

function HeatStat({ value, label }: { value: string; label: string }): ReactElement {
  return (
    <span className="ao-monitor__heat-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  )
}

function AgentStat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span className="ao-monitor__agent-stat">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </span>
  )
}

function executionBackendLabel(value: string): string {
  switch (value.trim()) {
    case 'dsh_native': return 'DSH 原生'
    case 'auto': return 'DSH 自动'
    case 'codex': return 'Codex'
    case 'claude_code': return 'Claude Code'
    default: return displayUnknown(value)
  }
}

function sourceLabel(value: string): string {
  return value === 'yaml' ? 'Agent YAML' : displayUnknown(value)
}

function agentRuntimeText(
  workflowIds: readonly string[],
  stats: AgentRunStats | null,
  loading: boolean,
  error: string,
): { readonly title: string; readonly detail: string; readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'error' } {
  const workflows = workflowIds.length === 0 ? '无工作流引用' : workflowIds.join('、')
  if (workflowIds.length === 0) {
    return {
      title: '技能型 Agent',
      detail: '在 DSH 会话中按需执行，当前 DAG 未引用该 Agent',
      tone: 'neutral',
    }
  }
  if (loading && stats === null) {
    return { title: '加载运行记录…', detail: workflows, tone: 'neutral' }
  }
  if (error !== '') {
    return { title: '运行记录加载失败', detail: error, tone: 'error' }
  }
  if (stats === null || stats.total === 0) {
    return { title: '暂无运行记录', detail: workflows, tone: 'neutral' }
  }
  if (stats.running > 0) {
    return { title: `${stats.running} 个运行中`, detail: `${workflows} · 累计 ${stats.total} 次`, tone: 'info' }
  }
  if (stats.failed > 0) {
    return { title: `${stats.failed} 次失败记录`, detail: `${workflows} · 完成 ${stats.completed} 次`, tone: 'warning' }
  }
  return { title: `已完成 ${stats.completed} 次`, detail: `${workflows} · 累计 ${stats.total} 次`, tone: 'success' }
}

function buildTrend(monitor: MonitorResponse | null): TrendDay[] {
  if (monitor === null) return []

  const providers = monitor.summary.byProvider.map(item => item.provider)
  const daily = new Map<string, Map<string, number>>()
  for (const row of monitor.summary.daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue
    const byProvider = daily.get(row.date) ?? new Map<string, number>()
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.tokens)
    daily.set(row.date, byProvider)
  }

  const start = new Date(`${monitor.range.since.slice(0, 10)}T00:00:00.000Z`)
  const end = new Date(`${monitor.generatedAt.slice(0, 10)}T00:00:00.000Z`)
  const result: TrendDay[] = []
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += HEATMAP_DAY_MS) {
    const date = new Date(cursor).toISOString().slice(0, 10)
    const values = daily.get(date) ?? new Map<string, number>()
    const segments = providers
      .map(provider => ({ provider, tokens: values.get(provider) ?? 0 }))
      .filter(segment => segment.tokens > 0)
    result.push({
      date,
      tokens: segments.reduce((sum, segment) => sum + segment.tokens, 0),
      segments,
    })
  }
  return result
}

function buildHeatmap(monitor: MonitorResponse | null): HeatmapModel {
  if (monitor === null) {
    return { cells: [], monthLabels: [], activeDays: 0, elapsedDays: 0, peak: 0, max: 0 }
  }

  const usage = new Map(monitor.heatmap.daily.map(day => [day.date, day]))
  const today = new Date(`${monitor.generatedAt.slice(0, 10)}T00:00:00.000Z`)
  const todayKey = today.toISOString().slice(0, 10)
  const weekday = (today.getUTCDay() + 6) % 7
  const start = new Date(today.getTime() - (weekday + (HEATMAP_WEEKS - 1) * 7) * HEATMAP_DAY_MS)
  const cells: HeatmapCell[] = []
  const monthLabels: Array<{ week: number; label: string }> = []
  let lastMonth = -1
  let activeDays = 0
  let elapsedDays = 0
  let peak = 0
  let max = 0

  for (let week = 0; week < HEATMAP_WEEKS; week++) {
    const monday = new Date(start.getTime() + week * 7 * HEATMAP_DAY_MS)
    const month = monday.getUTCMonth()
    if (month !== lastMonth) {
      lastMonth = month
      monthLabels.push({ week, label: `${month + 1}月` })
    }
    for (let row = 0; row < 7; row++) {
      const date = new Date(start.getTime() + (week * 7 + row) * HEATMAP_DAY_MS)
      const key = date.toISOString().slice(0, 10)
      const future = key > todayKey
      const day = usage.get(key)
      const tokens = day?.tokens ?? 0
      const calls = day?.calls ?? 0
      if (!future) {
        elapsedDays += 1
        if (tokens > 0) activeDays += 1
        peak = Math.max(peak, tokens)
        max = Math.max(max, tokens)
      }
      cells.push({ date: key, tokens, calls, future })
    }
  }

  return { cells, monthLabels, activeDays, elapsedDays, peak, max }
}

function countActiveDays(summary: MonitorSummary | undefined): number {
  if (summary === undefined) return 0
  return new Set(summary.daily
    .map(day => day.date)
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))).size
}

function heatLevel(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4)))
}

function shouldShowDateLabel(index: number, length: number): boolean {
  return length > 0 && (index === 0 || index === Math.floor((length - 1) / 2) || index === length - 1)
}

function eventDescription(event: TaskEvent): string {
  const transition = event.fromStatus === undefined
    ? event.kind
    : `${event.fromStatus} → ${event.toStatus ?? '?'}`
  return [transition, event.actor, event.reason].filter(part => part !== undefined && part !== '').join(' · ')
}

function eventTone(kind: string): 'info' | 'warning' | 'error' | 'success' {
  const normalized = kind.toLowerCase()
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('reject')) return 'error'
  if (normalized.includes('complete') || normalized.includes('success') || normalized.includes('done')) return 'success'
  if (normalized.includes('warn') || normalized.includes('retry') || normalized.includes('block')) return 'warning'
  return 'info'
}

function displayUnknown(value: string): string {
  return value.trim() === '' || value === 'unknown' ? '未标注' : value
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function shortDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${month}/${day} ${hour}:${minute}:${second}`
}

/**
 * Sidebar icon for the monitoring center.
 * @param props - optional icon dimensions.
 * @returns monitor icon.
 */
export function MonitorIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h4l3 7 4-14 3 7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
