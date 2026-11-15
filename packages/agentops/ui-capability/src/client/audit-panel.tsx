/**
 * Control-plane audit page for capability mutations.
 *
 * The page owns the audit read path independently from the capability center,
 * so operators can inspect changes from the runtime-observability menu without
 * loading connector configuration and tool catalogues.
 *
 * @module @agentops/dsh-ui-capability/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import { createCapabilityApi, type CapabilityRpcResult } from './api.ts'
import { zh as copy } from './locales.ts'

interface CapabilityAuditEvent {
  readonly seq: number
  readonly actor: string
  readonly action: string
  readonly target: string
  readonly result: 'ok' | 'fail'
  readonly detail: Readonly<Record<string, unknown>>
  readonly at: string
}

const EMPTY_EVENTS: readonly CapabilityAuditEvent[] = []

function errorOf(result: CapabilityRpcResult): string | null {
  return result.ok ? null : `${result.error.code}: ${result.error.message}`
}

function eventsOf(result: CapabilityRpcResult): readonly unknown[] | null {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) return null
  const events = (result.value as Record<string, unknown>).events
  return Array.isArray(events) ? events : null
}

function timeText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/** Render the capability control-plane audit page. */
export function CapabilityAuditPanel(): ReactElement {
  const api = useMemo(() => createCapabilityApi(), [])
  const [events, setEvents] = useState(EMPTY_EVENTS)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestId = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await api.listAudit()
      if (id !== requestId.current) return
      const nextEvents = eventsOf(result)
      const nextError = errorOf(result)
      if (nextError !== null) {
        setError(nextError)
        return
      }
      if (nextEvents === null) {
        setError(copy['error.load'])
        return
      }
      setEvents(nextEvents as CapabilityAuditEvent[])
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const succeeded = events.filter(event => event.result === 'ok').length
  const failed = events.length - succeeded
  const actors = new Set(events.map(event => event.actor)).size

  return (
    <div className="ao-capability-page ao-capability-audit-page">
      <header className="ao-capability-hero">
        <div className="ao-capability-hero-copy">
          <div className="ao-capability-kicker">{copy['audit.kicker']}</div>
          <h1 className="ao-page-title">{copy['audit.title']}</h1>
          <p className="ao-page-description">{copy['audit.description']}</p>
        </div>
        <div className="ao-capability-stats">
          <div><strong>{events.length}</strong><span>{copy['audit.stat.events']}</span></div>
          <div><strong>{succeeded}</strong><span>{copy['audit.stat.succeeded']}</span></div>
          <div><strong>{failed}</strong><span>{copy['audit.stat.failed']}</span></div>
          <div><strong>{actors}</strong><span>{copy['audit.stat.actors']}</span></div>
        </div>
      </header>

      {error === null ? null : <div className="ao-capability-error" role="alert">{error}</div>}

      <section className="ao-capability-section ao-capability-audit-section" aria-busy={loading}>
        <div className="ao-capability-section-head">
          <div>
            <h2>{copy['audit.records']}</h2>
            <p>{copy['audit.recordsDescription']}</p>
          </div>
          <button type="button" className="ao-capability-btn secondary sm" disabled={loading} onClick={() => { void load() }}>
            {loading ? copy['loading'] : copy['refresh']}
          </button>
        </div>

        {loading ? <div className="ao-capability-state" role="status">{copy['loading']}</div>
          : error !== null && events.length === 0 ? null
            : events.length === 0 ? <div className="ao-capability-state">{copy['audit.empty']}</div>
              : (
                <div className="ao-capability-table-wrap">
                  <table className="ao-capability-table ao-capability-audit-table">
                    <thead>
                      <tr>
                        <th>{copy['audit.col.time']}</th>
                        <th>{copy['audit.col.operation']}</th>
                        <th>{copy['audit.col.target']}</th>
                        <th>{copy['audit.col.actor']}</th>
                        <th>{copy['audit.col.result']}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map(event => (
                        <tr key={event.seq}>
                          <td><time dateTime={event.at}>{timeText(event.at)}</time></td>
                          <td><strong>{event.action}</strong></td>
                          <td>{event.target}</td>
                          <td>{event.actor}</td>
                          <td><span className={`ao-capability-pill ${event.result === 'ok' ? 'ok' : 'err'}`}>{event.result}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
      </section>
    </div>
  )
}
