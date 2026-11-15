// @vitest-environment jsdom
/** Rerun feedback stays at the shell overlay after its source disappears. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createRerunFeedback } from '../src/client/collaboration-feedback.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const feedback = createRerunFeedback()
  const owner = await runtime.mount({ inject: ['slots'], apply: feedback.register })
  await runtime.root.declare(
    { 'shell.overlay': { kind: 'list', scope: 'root' } },
    ({ renderSlot }) => renderSlot('shell.overlay', {}),
  )
  runtime.renderRoot()
  return { feedback, owner, runtime }
}

it('registers one shell overlay and renders a success toast', async () => {
  const { feedback, runtime } = await bench()
  expect(runtime.slots.entries('shell.overlay')).toHaveLength(1)

  act(() => { feedback.publish('重跑会话已创建，指令已入队；这不表示节点已经执行完成。') })

  expect(screen.getByRole('alert').textContent).toContain(
    '重跑会话已创建，指令已入队；这不表示节点已经执行完成。',
  )
})

it('keeps the toast after its source unmounts', async () => {
  const { feedback } = await bench()
  const source = render(
    <button type="button" onClick={() => { feedback.publish('重跑已入队') }}>创建重跑</button>,
  )

  fireEvent.click(source.getByRole('button', { name: '创建重跑' }))
  source.unmount()

  expect(screen.getByRole('alert').textContent).toContain('重跑已入队')
})

it('restarts the presentation window for repeated identical text', async () => {
  const { feedback } = await bench()
  vi.useFakeTimers()

  act(() => { feedback.publish('重跑已入队') })
  act(() => { vi.advanceTimersByTime(3_500) })
  expect(screen.getByRole('alert')).toBeTruthy()

  act(() => { feedback.publish('重跑已入队') })
  act(() => { vi.advanceTimersByTime(3_500) })
  expect(screen.getByRole('alert')).toBeTruthy()

  act(() => { vi.advanceTimersByTime(600) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears the notice after the toast reports done', async () => {
  const { feedback } = await bench()
  vi.useFakeTimers()

  act(() => { feedback.publish('重跑已入队') })
  expect(feedback.notice.getSnapshot()).not.toBeNull()
  act(() => { vi.advanceTimersByTime(4_000) })

  expect(screen.queryByRole('alert')).toBeNull()
  expect(feedback.notice.getSnapshot()).toBeNull()
})
