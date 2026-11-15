/**
 * Monitor aggregates over persisted LLM usage.
 *
 * The monitor reports only fields the collector actually observes. Cost and
 * Agent runtime outcomes are not inferred from token usage or task state.
 *
 * @module @agentops/dsh-security/monitor
 */

import type { UsageRecord } from './types.ts'

const DAY_MS = 86_400_000

/** Ranges offered by the monitor's usage controls. */
export const MONITOR_RANGE_DAYS = [7, 14, 30, 90] as const

/** One selectable monitor usage range. */
export type MonitorRangeDays = typeof MONITOR_RANGE_DAYS[number]

/** Daily token and call totals without a provider split. */
export interface MonitorDailyUsage {
  date: string
  tokens: number
  calls: number
}

/** Daily token and call totals for one provider. */
export interface MonitorDailyProviderUsage extends MonitorDailyUsage {
  provider: string
}

/** Provider token and call totals. */
export interface MonitorProviderUsage {
  provider: string
  tokens: number
  calls: number
}

/** Model token and call totals. */
export interface MonitorModelUsage {
  model: string
  tokens: number
  calls: number
}

/** Purpose token and call totals. */
export interface MonitorPurposeUsage {
  purpose: string
  tokens: number
  calls: number
}

/** Selected-range usage totals and breakdowns. */
export interface MonitorSummary {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  calls: number
  daily: MonitorDailyProviderUsage[]
  byProvider: MonitorProviderUsage[]
  byModel: MonitorModelUsage[]
  byPurpose: MonitorPurposeUsage[]
}

/**
 * Parse the `days` query parameter, defaulting unsupported values to 30 days.
 * @param raw - raw query value.
 * @returns one of the supported monitor ranges.
 */
export function parseMonitorDays(raw: string | null | undefined): MonitorRangeDays {
  const value = Number(raw)
  return (MONITOR_RANGE_DAYS as readonly number[]).includes(value) ? value as MonitorRangeDays : 30
}

/**
 * Start of a UTC-day range that includes the current day.
 * @param days - number of calendar days to include.
 * @param now - injectable current time.
 * @returns inclusive UTC midnight as an ISO timestamp.
 */
export function monitorSince(days: number, now: Date = new Date()): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const count = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1
  return new Date(today - (count - 1) * DAY_MS).toISOString()
}

/**
 * Convert an ISO timestamp to the UTC calendar day used for aggregation.
 * @param at - persisted timestamp.
 * @returns `YYYY-MM-DD`, or `invalid` when the timestamp cannot be parsed.
 */
export function utcDayKey(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? 'invalid' : date.toISOString().slice(0, 10)
}

/**
 * Aggregate persisted usage rows for the monitor.
 * @param rows - usage rows from the selected range.
 * @returns totals plus daily, provider, model and purpose breakdowns.
 */
export function buildMonitorSummary(rows: readonly UsageRecord[]): MonitorSummary {
  const daily = new Map<string, MonitorDailyProviderUsage>()
  const byProvider = new Map<string, { tokens: number; calls: number }>()
  const byModel = new Map<string, { tokens: number; calls: number }>()
  const byPurpose = new Map<string, { tokens: number; calls: number }>()
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  for (const row of rows) {
    const provider = normalized(row.provider)
    const model = normalized(row.model)
    const purpose = normalized(row.agent)
    const date = utcDayKey(row.at)

    promptTokens += row.promptTokens
    completionTokens += row.completionTokens
    totalTokens += row.totalTokens
    addUsage(byProvider, provider, row.totalTokens)
    addUsage(byModel, model, row.totalTokens)
    addUsage(byPurpose, purpose, row.totalTokens)

    const dailyKey = `${date}\u0000${provider}`
    const day = daily.get(dailyKey) ?? { date, provider, tokens: 0, calls: 0 }
    day.tokens += row.totalTokens
    day.calls += 1
    daily.set(dailyKey, day)
  }

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    calls: rows.length,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider)),
    byProvider: sortedUsage(byProvider, 'provider'),
    byModel: sortedUsage(byModel, 'model'),
    byPurpose: sortedUsage(byPurpose, 'purpose'),
  }
}

/**
 * Aggregate token usage by UTC calendar day.
 * @param rows - usage rows from the heatmap window.
 * @returns daily totals ordered oldest first.
 */
export function buildDailyUsage(rows: readonly UsageRecord[]): MonitorDailyUsage[] {
  const daily = new Map<string, MonitorDailyUsage>()
  for (const row of rows) {
    const date = utcDayKey(row.at)
    const day = daily.get(date) ?? { date, tokens: 0, calls: 0 }
    day.tokens += row.totalTokens
    day.calls += 1
    daily.set(date, day)
  }
  return [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function normalized(value: string): string {
  return value.trim().length > 0 ? value.trim() : 'unknown'
}

function addUsage(target: Map<string, { tokens: number; calls: number }>, key: string, tokens: number): void {
  const value = target.get(key) ?? { tokens: 0, calls: 0 }
  value.tokens += tokens
  value.calls += 1
  target.set(key, value)
}

function sortedUsage<K extends 'provider' | 'model' | 'purpose'>(
  values: Map<string, { tokens: number; calls: number }>,
  key: K,
): Array<{ tokens: number; calls: number } & Record<K, string>> {
  return [...values]
    .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ [key]: label, ...value }) as { tokens: number; calls: number } & Record<K, string>)
}
