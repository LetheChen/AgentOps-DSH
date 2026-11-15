import { describe, expect, it } from 'vitest'

import { requestCollaborationRun, takeCollaborationRun } from '../src/client/collaboration-target.js'

describe('collaboration run handoff', () => {
  it('hands the parked run to the first claim only', () => {
    requestCollaborationRun('run-7')

    expect(takeCollaborationRun()).toBe('run-7')
    expect(takeCollaborationRun()).toBeNull()
  })

  it('keeps the latest parked run', () => {
    requestCollaborationRun('run-1')
    requestCollaborationRun('run-2')

    expect(takeCollaborationRun()).toBe('run-2')
  })

  it('claims nothing when no run was parked', () => {
    expect(takeCollaborationRun()).toBeNull()
  })
})
