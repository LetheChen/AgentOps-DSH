import { describe, expect, it } from 'vitest'

import { scheduleLevels } from '../src/client/collaboration-layout.js'

const NODES = [
  { id: 'scan' },
  { id: 'analyze' },
  { id: 'notify' },
  { id: 'report' },
] as const

describe('collaboration schedule levels', () => {
  it('computes longest-path levels from schedule edges only', () => {
    const levels = scheduleLevels(NODES, [
      { from: 'scan', to: 'analyze' },
      { from: 'scan', to: 'report' },
      { from: 'analyze', to: 'notify' },
    ])

    expect([...levels]).toEqual([
      ['scan', 0],
      ['analyze', 1],
      ['notify', 2],
      ['report', 1],
    ])
  })

  it('ignores unknown nodes, duplicate edges, and self edges', () => {
    const levels = scheduleLevels(NODES, [
      { from: 'scan', to: 'analyze' },
      { from: 'scan', to: 'analyze' },
      { from: 'scan', to: 'scan' },
      { from: 'missing', to: 'notify' },
      { from: 'report', to: 'missing' },
    ])

    expect(levels.get('scan')).toBe(0)
    expect(levels.get('analyze')).toBe(1)
    expect(levels.get('notify')).toBe(0)
    expect(levels.get('report')).toBe(0)
    expect(levels.size).toBe(NODES.length)
  })

  it('keeps cycle relaxation bounded and deterministic', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as const
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'a', to: 'c' },
    ] as const

    const first = scheduleLevels(nodes, edges)
    const second = scheduleLevels(nodes, edges)

    expect([...first]).toEqual([...second])
    expect([...first.values()].every(level => Number.isFinite(level))).toBe(true)
    expect(first.get('c')).toBeGreaterThan(first.get('a') ?? -1)
  })
})
