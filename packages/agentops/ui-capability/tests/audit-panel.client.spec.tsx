// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { CapabilityAuditPanel } from '../src/client/audit-panel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function reply(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
}

describe('capability audit panel', () => {
  it('loads only control-plane audit events and renders their operation context', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('request body must be serialized JSON')
      const body = JSON.parse(init.body) as { endpoint: string }
      calls.push(body.endpoint)
      return reply({ events: [
        { seq: 2, actor: 'operator', action: 'capability.bindings.update', target: 'smart_query', result: 'ok', detail: {}, at: '2026-11-14T03:19:24.000Z' },
        { seq: 1, actor: 'operator', action: 'integration.create', target: 'audit_reader', result: 'fail', detail: {}, at: '2026-11-13T12:00:00.000Z' },
      ] })
    }))

    render(<CapabilityAuditPanel />)

    expect(await screen.findByRole('heading', { name: '控制面审计' })).toBeTruthy()
    expect(await screen.findByText('capability.bindings.update')).toBeTruthy()
    expect(screen.getByText('integration.create')).toBeTruthy()
    expect(screen.getByText('smart_query')).toBeTruthy()
    expect(screen.getAllByText('operator')).toHaveLength(2)
    expect(screen.getByText('ok')).toBeTruthy()
    expect(screen.getByText('fail')).toBeTruthy()
    expect(calls).toEqual(['agentops/capabilities/audit'])
  })
})
