// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SurfaceScreen } from '../src/client/surface-screen/ScreenBody.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

interface ApiCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

type ApiHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installApi(handler: ApiHandler): { readonly calls: ApiCall[] } {
  const calls: ApiCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = urlOf(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  vi.stubGlobal('fetch', fetchImpl)
  return { calls }
}

function row(id: number, viewId: string, title: string) {
  return {
    id,
    viewId,
    title,
    createdAt: '2026-11-01T09:00:00.000Z',
    content: {},
    surface: {
      version: 'v1.0',
      catalogId: 'https://agentops.dev/a2ui/catalogs/core/v1',
      components: [{ id: 'root', component: 'Text', text: title }],
    },
  }
}

function boardApi(views: readonly unknown[], reorder: () => Response): ApiHandler {
  return (url) => {
    if (url.includes('/surfaces/reorder')) return reorder()
    if (url.includes('/surfaces/views')) return jsonResponse({ views })
    return jsonResponse({}, 404)
  }
}

function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body
  if (typeof body !== 'string') throw new Error('expected a JSON string body')
  return JSON.parse(body) as Record<string, unknown>
}

function cards() {
  return Array.from(document.querySelectorAll('[data-agentops-card]'))
}

function cardTitled(title: string): HTMLElement {
  const card = cards().find(element => element.querySelector('header span')?.textContent === title)
  if (card === undefined || !(card instanceof HTMLElement)) throw new Error(`missing card ${title}`)
  return card
}

function drag(sourceTitle: string, targetTitle: string): void {
  const dataTransfer = { effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(cardTitled(sourceTitle), { dataTransfer })
  fireEvent.dragOver(cardTitled(targetTitle), { dataTransfer })
  fireEvent.drop(cardTitled(targetTitle), { dataTransfer })
  fireEvent.dragEnd(cardTitled(sourceTitle), { dataTransfer })
}

describe('surface board drag reorder', () => {
  it('drops a lower card above a higher target and sends the full order', async () => {
    stubResizeObserver()
    const { calls } = installApi(boardApi([row(3, 'c', 'C'), row(2, 'b', 'B'), row(1, 'a', 'A')], () => jsonResponse({ ok: true })))

    render(<SurfaceScreen />)
    await waitFor(() => { expect(cards()).toHaveLength(3) })
    drag('C', 'B')

    await waitFor(() => {
      const call = calls.find(entry => entry.url.includes('/surfaces/reorder'))
      expect(call).toBeTruthy()
      expect(readBody(call?.init)).toEqual({ viewIds: ['b', 'c', 'a'] })
    })
  })

  it('drops a higher card below a lower target so it occupies the target slot', async () => {
    stubResizeObserver()
    const { calls } = installApi(boardApi([row(3, 'c', 'C'), row(2, 'b', 'B'), row(1, 'a', 'A')], () => jsonResponse({ ok: true })))

    render(<SurfaceScreen />)
    await waitFor(() => { expect(cards()).toHaveLength(3) })
    drag('A', 'C')

    await waitFor(() => {
      const call = calls.find(entry => entry.url.includes('/surfaces/reorder'))
      expect(call).toBeTruthy()
      expect(readBody(call?.init)).toEqual({ viewIds: ['a', 'c', 'b'] })
    })
  })

  it('restores the previous order when the reorder request is rejected', async () => {
    stubResizeObserver()
    const initial = [row(3, 'c', 'C'), row(2, 'b', 'B'), row(1, 'a', 'A')]
    installApi(boardApi(initial, () => jsonResponse({ ok: false })))

    render(<SurfaceScreen />)
    await waitFor(() => { expect(cards()).toHaveLength(3) })
    drag('C', 'B')

    await waitFor(() => {
      expect(cards().map(element => element.querySelector('header span')?.textContent)).toEqual(['C', 'B', 'A'])
    })
  })

  it('does not make cards draggable or show the reorder hint in a read-only preview', async () => {
    stubResizeObserver()
    installApi(boardApi([row(1, 'a', 'A')], () => jsonResponse({ ok: true })))

    render(<SurfaceScreen readOnly chrome />)
    await waitFor(() => { expect(cards()).toHaveLength(1) })
    expect(cards()[0]?.getAttribute('draggable')).not.toBe('true')
    expect(screen.queryByText(/拖动卡片可调整顺序/)).toBeNull()
    expect(screen.getByText(/只读看板/)).toBeTruthy()
  })
})
