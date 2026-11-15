/**
 * Session replay routes, read through DSH's own `sessionQuery` service.
 *
 * The service already replays and validates logs, so this module only maps its
 * records into a small shape: newest-first session list plus one session's
 * events. Event payloads are summarised (type + one-line preview), never
 * rewritten.
 *
 * @module @agentops/dsh-host/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** The slice of `sessionQuery` this module needs. */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<{
    header: { id: string; title?: string; createdAt?: string; updatedAt?: string }
    live: boolean
    persisted: boolean
  }[]>
  readSession(id: string): Promise<{
    session: { id: string; title?: string }
    events: unknown[]
  }>
}

/** One session as listed by the replay page. */
export interface SessionSummary {
  id: string
  title: string
  live: boolean
  persisted: boolean
  updatedAt: string | null
  eventCount: number | null
}

/**
 * Map one record to the list row; counts stay null unless already known.
 * @param record - the session record returned by `sessionQuery`.
 * @returns the list row for that session.
 */
export function toSummary(record: {
  header: { id: string; title?: string; updatedAt?: string }
  live: boolean
  persisted: boolean
}): SessionSummary {
  return {
    id: record.header.id,
    title: record.header.title ?? '(untitled)',
    live: record.live,
    persisted: record.persisted,
    updatedAt: record.header.updatedAt ?? null,
    eventCount: null,
  }
}

/**
 * Summarise one raw log event without interpreting it.
 * @param event - raw session event.
 * @returns the event type, its timestamp, and a one-line preview.
 */
export function summariseEvent(event: unknown): { type: string; at: string | null; preview: string } {
  if (event === null || typeof event !== 'object') {
    return { type: 'unknown', at: null, preview: String(event).slice(0, 200) }
  }
  const record = event as Record<string, unknown>
  const type = typeof record.type === 'string'
    ? record.type
    : typeof record.kind === 'string' ? record.kind : 'event'
  const at = typeof record.at === 'string'
    ? record.at
    : typeof record.timestamp === 'string' ? record.timestamp : null
  const payload = record.message ?? record.data ?? record.payload ?? record
  let preview: string
  try {
    preview = JSON.stringify(payload).slice(0, 1200)
  } catch {
    preview = '[unserialisable]'
  }
  return { type, at, preview }
}

/**
 * Register the replay routes.
 * @param ctx - context carrying Connection.
 * @param query - DSH session query service.
 */
export function registerSessionRoutes(ctx: Context, query: SessionQueryLike): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/sessions',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const records = await query.listSessions()
      return json({ sessions: records.map(toSummary) })
    },
  }), 'agentops-system: /api/agentops/sessions')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/session-log',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (id.length === 0) return new Response('missing id', { status: 400 })
      try {
        const snapshot = await query.readSession(id)
        return json({
          id: snapshot.session.id,
          title: snapshot.session.title ?? '',
          total: snapshot.events.length,
          events: snapshot.events.slice(0, 200).map(summariseEvent),
        })
      } catch (error) {
        // Replay validation can reject old logs; say so instead of pretending empty.
        return json({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'agentops-system: /api/agentops/session-log')
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
