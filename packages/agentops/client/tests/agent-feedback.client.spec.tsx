// @vitest-environment jsdom
/** Agent feedback remains in the shell overlay after its reporting panel unmounts. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createAgentFeedback } from '../src/client/agent-feedback.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const feedback = createAgentFeedback()
  const owner = await runtime.mount({ inject: ['slots'], apply: feedback.register })
  await runtime.root.declare(
    { 'shell.overlay': { kind: 'list', scope: 'root' } },
    ({ renderSlot }) => renderSlot('shell.overlay', {}),
  )
  runtime.renderRoot()
  return { feedback, owner, runtime }
}

it('registers one shell overlay and renders success and failure copy', async () => {
  const { feedback, runtime } = await bench()
  expect(runtime.slots.entries('shell.overlay')).toHaveLength(1)

  act(() => { feedback.publishSuccess('Agent 已创建') })
  expect(screen.getByRole('alert').textContent).toContain('Agent 已创建')

  act(() => { feedback.publishFailure('Agent 保存失败') })
  expect(screen.getByRole('alert').textContent).toContain('Agent 保存失败')
})

it('keeps the toast after its source unmounts', async () => {
  const { feedback } = await bench()
  const source = render(
    <button type="button" onClick={() => { feedback.publishSuccess('Agent 已创建') }}>
      创建 Agent
    </button>,
  )

  fireEvent.click(source.getByRole('button', { name: '创建 Agent' }))
  source.unmount()

  expect(screen.getByRole('alert').textContent).toContain('Agent 已创建')
})

it('restarts the presentation window for repeated identical text', async () => {
  const { feedback } = await bench()
  vi.useFakeTimers()

  act(() => { feedback.publishFailure('Agent 保存失败') })
  act(() => { vi.advanceTimersByTime(3_500) })
  expect(screen.getByRole('alert')).toBeTruthy()

  act(() => { feedback.publishFailure('Agent 保存失败') })
  act(() => { vi.advanceTimersByTime(3_500) })
  expect(screen.getByRole('alert')).toBeTruthy()

  act(() => { vi.advanceTimersByTime(600) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears the notice after the toast reports done', async () => {
  const { feedback } = await bench()
  vi.useFakeTimers()

  act(() => { feedback.publishSuccess('Agent 已创建') })
  expect(feedback.notice.getSnapshot()).not.toBeNull()
  act(() => { vi.advanceTimersByTime(4_000) })

  expect(screen.queryByRole('alert')).toBeNull()
  expect(feedback.notice.getSnapshot()).toBeNull()
})
