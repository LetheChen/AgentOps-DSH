/**
 * Read-only security routes for the users / roles / sessions / tokens pages.
 *
 * Writes stay out: they belong to guarded tool calls or the DSH settings, not to
 * a page-level POST. Every route here is a GET.
 *
 * @module @agentops/dsh-security/http
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import { buildDailyUsage, buildMonitorSummary, monitorSince, parseMonitorDays } from './monitor.ts'
import type { SecurityStore } from './store.ts'

const MONITOR_HEATMAP_DAYS = 26 * 7

/**
 * Register the read-only security routes.
 * @param ctx - context carrying Connection.
 * @param store - security persistence.
 */
export function registerSecurityRoutes(ctx: Context, store: SecurityStore): void {
  const routes: { path: string; body: (request: Request) => unknown }[] = [
    {
      path: '/api/agentops/security/users',
      body: () => ({
        users: store.listUsers().map(user => ({
          ...user,
          roleIds: store.listAssignments(user.id).map(assignment => assignment.roleId),
        })),
      }),
    },
    { path: '/api/agentops/security/roles', body: () => ({ roles: store.listRoles() }) },
    { path: '/api/agentops/security/sessions', body: () => ({ sessions: store.listSessions() }) },
    { path: '/api/agentops/security/tokens', body: () => ({ tokens: store.listTokens() }) },
    { path: '/api/agentops/security/usage', body: () => store.usage() },
    { path: '/api/agentops/security/audit', body: () => ({ events: store.listAudit() }) },
    {
      path: '/api/agentops/monitor',
      body: (request) => {
        const now = new Date()
        const days = parseMonitorDays(new URL(request.url).searchParams.get('days'))
        const since = monitorSince(days, now)
        const heatmapSince = monitorSince(MONITOR_HEATMAP_DAYS, now)
        return {
          generatedAt: now.toISOString(),
          range: { days, since },
          summary: buildMonitorSummary(store.usageRecords(since)),
          heatmap: {
            weeks: 26,
            days: MONITOR_HEATMAP_DAYS,
            since: heatmapSince,
            daily: buildDailyUsage(store.usageRecords(heatmapSince)),
          },
          capabilities: { cost: false, agentRuntime: false, tips: true },
          usage: store.usage(),
          recent: store.recentUsage(20),
          sessions: store.listSessions().slice(0, 20),
          audit: store.listAudit(20),
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => new Response(JSON.stringify(route.body(request)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    }), `agentops-security: ${route.path}`)
  }
}
