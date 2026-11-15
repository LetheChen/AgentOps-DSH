/**
 * Security domain types: users, roles, sessions, token usage and audit trail.
 *
 * Deliberately independent of the legacy `audit.db`: the migration starts a new
 * project, so this schema is ours and carries no historical rows.
 */

export type UserStatus = 'active' | 'disabled'

/** One account that may call the AgentOps services. */
export interface User {
  id: string
  name: string
  email: string | null
  status: UserStatus
  createdAt: string
  /** Free-form metadata (department, employee code), never credentials. */
  metadata: Record<string, unknown>
  /** Optimistic-lock version; every status change bumps it. */
  version: number
}

/** One issued API token; only its prefix is stored. */
export interface ApiToken {
  id: string
  userId: string
  name: string
  /** First characters only, for display; the full value is never stored. */
  prefix: string
  createdAt: string
  revokedAt: string | null
}

/** One role and the permission ids it grants. */
export interface Role {
  id: string
  name: string
  description: string
  /** Permission ids this role grants, e.g. `task.advance`. */
  permissions: string[]
}

/** One role granted to a user. */
export interface RoleAssignment {
  userId: string
  roleId: string
  grantedAt: string
  grantedBy: string
}

/** One recorded usage session. */
export interface SessionRecord {
  id: string
  userId: string
  agent: string
  startedAt: string
  endedAt: string | null
  status: 'active' | 'ended'
}

/** One model call, aggregated later for the token page. */
export interface UsageRecord {
  id: string
  userId: string
  /** DSH session the call belonged to, when the caller passed one. */
  sessionId?: string
  agent: string
  /** Model provider reported by the LLM request. */
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  at: string
}

/** Append-only record of write operations that needed a guardrail. */
export interface AuditEvent {
  seq: number
  actor: string
  action: string
  target: string
  at: string
  detail: Record<string, unknown>
}

/** Token usage aggregated by model and by user. */
export interface UsageSummary {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  calls: number
  byModel: { model: string; tokens: number; calls: number }[]
  byUser: { userId: string; tokens: number; calls: number }[]
}

/**
 * Aggregate usage rows.
 * @param rows - raw usage records.
 * @returns the aggregated usage.
 */
export function summarizeUsage(rows: readonly UsageRecord[]): UsageSummary {
  const byModel = new Map<string, { tokens: number; calls: number }>()
  const byUser = new Map<string, { tokens: number; calls: number }>()
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  for (const row of rows) {
    promptTokens += row.promptTokens
    completionTokens += row.completionTokens
    totalTokens += row.totalTokens
    const model = byModel.get(row.model) ?? { tokens: 0, calls: 0 }
    model.tokens += row.totalTokens
    model.calls += 1
    byModel.set(row.model, model)
    const user = byUser.get(row.userId) ?? { tokens: 0, calls: 0 }
    user.tokens += row.totalTokens
    user.calls += 1
    byUser.set(row.userId, user)
  }

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    calls: rows.length,
    byModel: [...byModel].map(([model, value]) => ({ model, ...value })).sort((a, b) => b.tokens - a.tokens),
    byUser: [...byUser].map(([userId, value]) => ({ userId, ...value })).sort((a, b) => b.tokens - a.tokens),
  }
}
