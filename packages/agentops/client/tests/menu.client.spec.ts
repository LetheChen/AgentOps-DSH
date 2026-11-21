import { describe, expect, it } from 'vitest'

import {
  AGENTOPS_MENU_ROWS,
  AGENTOPS_MENU_SECTIONS,
  type AgentOpsMenuRow,
} from '../src/client/menu.js'

function rowsOf(section: string | undefined): readonly AgentOpsMenuRow[] {
  return AGENTOPS_MENU_ROWS.filter(row => row.section === section)
}

describe('AgentOps sidebar menu', () => {
  it('gives every entry a distinct panel id', () => {
    const ids = AGENTOPS_MENU_ROWS.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('places every entry in a declared section', () => {
    const sectionIds = AGENTOPS_MENU_SECTIONS.map(section => section.id)
    for (const row of AGENTOPS_MENU_ROWS) {
      if (row.section !== undefined) expect(sectionIds).toContain(row.section)
    }
  })

  it('declares the groups in sidebar order', () => {
    expect(AGENTOPS_MENU_SECTIONS.map(section => [section.id, section.order, section.defaultOpen]))
      .toEqual([
        ['agent-management', 50, true],
        ['capability-center', 52.5, true],
        ['task-management', 53, true],
        ['observability', 57.5, true],
        ['security-management', 59, false],
      ])
  })

  it('groups the agent lifecycle surfaces under agent management', () => {
    expect(rowsOf('agent-management').map(row => [row.id, row.order])).toEqual([
      ['agentops-collaboration', 52],
      ['agentops-workflows', 53],
      ['agentops-agents', 54],
    ])
  })

  it('groups monitoring, the unified run log, and control-plane audit under runtime observability', () => {
    expect(rowsOf('observability').map(row => [row.id, row.order]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      ['agentops-monitor', 57.5],
      ['agentops-run-log', 57.6],
      ['agentops-capability-audit', 57.7],
    ])
  })

  it('groups the task surfaces under task management', () => {
    expect(rowsOf('task-management').map(row => [row.id, row.order])).toEqual([
      ['agentops-task-center', 48],
      ['agentops-projects', 49],
      ['agentops-inbox', 50],
    ])
  })

  it('groups the read-only security surfaces under security management', () => {
    expect(rowsOf('security-management').map(row => [row.id, row.order])).toEqual([
      ['agentops-security-users', 59.1],
      ['agentops-security-roles', 59.2],
      ['agentops-security-sessions', 59.3],
      ['agentops-security-tokens', 59.4],
    ])
  })

  it('groups connector instances, logs, skills, and schedules under capability center', () => {
    expect(rowsOf('capability-center').map(row => [row.id, row.order]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      ['agentops-capability', 52.6],
      ['agentops-skills', 52.62],
      ['agentops-logs', 52.65],
      ['agentops-deployments', 52.66],
      ['agentops-schedules', 52.7],
    ])
  })

  it('keeps the top-level rows at their own order', () => {
    expect(rowsOf(undefined).map(row => [row.id, row.order])).toEqual([
      ['agentops-knowledge', 51],
    ])
  })

  it('gives every section at least one entry', () => {
    for (const section of AGENTOPS_MENU_SECTIONS) {
      expect(rowsOf(section.id).length).toBeGreaterThan(0)
    }
  })

  it('orders the top-level rows the way the sidebar renders them', () => {
    const topLevel = [
      ...AGENTOPS_MENU_SECTIONS.map(section => section.order),
      ...AGENTOPS_MENU_ROWS.filter(row => row.section === undefined).map(row => row.order),
    ].sort((a, b) => a - b)
    expect(topLevel).toEqual([50, 51, 52.5, 53, 57.5, 59])
  })
})
