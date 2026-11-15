/**
 * Contract tests for the task database and HTTP surface.
 *
 * The tests validate semantic invariants rather than copying derived counts:
 * unique table/index/trigger/route names, complete revision coverage, required
 * admission and decision guards, static-route ordering, and lifecycle edges that
 * only reference declared states.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPEND_ONLY_TABLES,
  BUSINESS_TRIGGER_NAMES,
  PARENT_CYCLE_TRIGGER,
  REVISION_TRIGGER_PREFIXES,
  TASK_CANONICAL_ROUTES,
  TASK_CONTRACT_VERSION,
  TASK_INDEXES,
  TASK_MIGRATED_ROUTES,
  TASK_NON_REVISION_TABLES,
  TASK_RELATION_TRIGGERS,
  TASK_REVISION_TABLES,
  TASK_TABLES,
  appendOnlyTriggerNames,
  buildTaskContractSnapshot,
  revisionTriggerNames,
} from '../src/contracts.ts'
import { P0_STATUSES, P0_TERMINAL, P0_TRANSITIONS } from '../src/lifecycle/p0.ts'
import { TASK_STATUSES, TERMINAL, TRANSITIONS } from '../src/status.ts'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT_PATH = join(PACKAGE_ROOT, 'contracts', 'task-contracts.v1.json')

void test('契约版本与派生计数来自同一源码定义', () => {
  const snapshot = buildTaskContractSnapshot()
  assert.equal(snapshot.contractVersion, TASK_CONTRACT_VERSION)
  assert.deepEqual(snapshot.tables, [...TASK_TABLES])
  assert.deepEqual(snapshot.revisionTables, [...TASK_REVISION_TABLES])
  assert.deepEqual(snapshot.nonRevisionTables, [...TASK_NON_REVISION_TABLES])
  assert.deepEqual(snapshot.indexes, TASK_INDEXES)
  assert.deepEqual(snapshot.routes, TASK_MIGRATED_ROUTES)
  assert.deepEqual(snapshot.canonicalRoutes, TASK_CANONICAL_ROUTES)
  assert.deepEqual(snapshot.counts, {
    tables: TASK_TABLES.length,
    revisionTables: TASK_REVISION_TABLES.length,
    indexes: TASK_INDEXES.length,
    triggers: revisionTriggerNames().length,
    routes: TASK_MIGRATED_ROUTES.length,
    canonicalRoutes: TASK_CANONICAL_ROUTES.length,
    p0Edges: P0_TRANSITIONS.length,
    v1Edges: TRANSITIONS.length,
  })
})

void test('表集合唯一，且修订表与非修订表恰好覆盖全部表', () => {
  assert.equal(new Set(TASK_TABLES).size, TASK_TABLES.length)
  const covered = [...TASK_REVISION_TABLES, ...TASK_NON_REVISION_TABLES].sort()
  assert.deepEqual(covered, [...TASK_TABLES].sort())
  assert.equal(new Set(covered).size, covered.length)
})

void test('索引名唯一，且关键唯一性约束存在', () => {
  const names = TASK_INDEXES.map(index => index.name)
  assert.equal(new Set(names).size, names.length)
  const byName = new Map(TASK_INDEXES.map(index => [index.name, index.definition]))

  assert.ok(byName.get('idx_task_runs_one_active')?.startsWith('UNIQUE task_runs(task_id) WHERE'))
  assert.ok(byName.get('idx_task_runs_idempotency')?.includes('WHERE idempotency_key IS NOT NULL'))
  assert.ok(byName.get('idx_decisions_authoritative')?.startsWith('UNIQUE decisions('))
  assert.ok(byName.get('idx_decisions_authoritative')?.includes("WHERE status = 'implemented'"))
  assert.ok(byName.get('idx_gate_idempotency')?.startsWith('UNIQUE candidate_gate_events('))
  assert.ok(byName.get('idx_gate_one_approve')?.includes("WHERE action = 'approve'"))
  assert.ok(byName.get('idx_task_rel_one_parent')?.includes("WHERE relation_type = 'parent'"))
  assert.ok(byName.get('idx_task_decision_links_one_active')?.includes('WHERE active = 1'))
})

void test('触发器完整覆盖修订表与 append-only 表，且名称唯一', () => {
  const names = revisionTriggerNames()
  const expectedCount =
    TASK_REVISION_TABLES.length * 3 + APPEND_ONLY_TABLES.length * 2 + BUSINESS_TRIGGER_NAMES.length

  assert.equal(names.length, expectedCount)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes(PARENT_CYCLE_TRIGGER))
  assert.ok(names.includes('stages_rev_after_insert'))
  assert.ok(!names.some(name => name.startsWith('task_stages_rev_after_')))

  for (const table of TASK_REVISION_TABLES) {
    const prefix = REVISION_TRIGGER_PREFIXES[table]
    assert.ok(names.includes(`${prefix}insert`), `${table} insert trigger`)
    assert.ok(names.includes(`${prefix}update`), `${table} update trigger`)
    assert.ok(names.includes(`${prefix}delete`), `${table} delete trigger`)
  }

  for (const table of APPEND_ONLY_TABLES) {
    assert.ok((TASK_REVISION_TABLES as readonly string[]).includes(table), `${table} must bump revision`)
    assert.ok(names.includes(`${table}_append_only_update`), `${table} append-only update guard`)
    assert.ok(names.includes(`${table}_append_only_delete`), `${table} append-only delete guard`)
  }
})

void test('关键准入、关系与决策业务触发器存在', () => {
  const names = revisionTriggerNames()
  const required = [
    'candidate_gate_events_require_matching_snapshot',
    'tasks_require_gated_candidate',
    'tasks_prevent_insert_or_replace',
    'tasks_prevent_project_move',
    'tasks_prevent_candidate_rebind',
    'task_candidates_require_gate_for_conversion',
    'task_candidates_require_selected_links_on_conversion',
    'task_decision_links_require_selected_decision',
    'decisions_prevent_invalid_status_transition',
    'decisions_prevent_implement_without_evidence',
    'decisions_freeze_approval_fields',
    ...Object.values(TASK_RELATION_TRIGGERS),
  ]
  for (const name of required) assert.ok(names.includes(name), name)
  for (const name of appendOnlyTriggerNames()) assert.ok(names.includes(name), name)
})

void test('路由唯一，全部挂在 tasks 或 candidates 下，且不含执行载体路径', () => {
  const keys = TASK_MIGRATED_ROUTES.map(route => `${route.method} ${route.path}`)
  assert.equal(new Set(keys).size, keys.length)
  for (const route of TASK_MIGRATED_ROUTES) {
    assert.ok(
      route.path.startsWith('/api/agentops/tasks')
        || route.path.startsWith('/api/agentops/candidates')
        || route.path.startsWith('/api/agentops/decisions'),
      route.path,
    )
    assert.ok(!route.path.includes('terminal'), route.path)
    assert.ok(!route.path.includes('/sessions'), route.path)
  }
})

void test('静态路径先于动态参数路由注册', () => {
  const candidateDynamicAt = TASK_MIGRATED_ROUTES.findIndex(
    route => route.path === '/api/agentops/candidates/{candidate_id}',
  )
  assert.ok(candidateDynamicAt > 0)
  const candidateStaticPaths = [
    '/api/agentops/candidates',
    '/api/agentops/candidates/{candidate_id}/analyze',
    '/api/agentops/candidates/{candidate_id}/preflight-search',
    '/api/agentops/candidates/{candidate_id}/gate',
  ]
  for (const path of candidateStaticPaths) {
    const at = TASK_MIGRATED_ROUTES.findIndex(route => route.path === path)
    assert.ok(at >= 0 && at < candidateDynamicAt, `${path} must precede {candidate_id}`)
  }

  const decisionDynamicAt = TASK_MIGRATED_ROUTES.findIndex(
    route => route.path === '/api/agentops/decisions/{decision_id}',
  )
  assert.ok(decisionDynamicAt > 0)
  const decisionSearchAt = TASK_MIGRATED_ROUTES.findIndex(
    route => route.path === '/api/agentops/decisions/search',
  )
  assert.ok(decisionSearchAt >= 0 && decisionSearchAt < decisionDynamicAt, 'decision search must precede {decision_id}')
  assert.ok(
    TASK_MIGRATED_ROUTES.findIndex(route => route.path === '/api/agentops/decisions') < decisionDynamicAt,
    'decision root must precede {decision_id}',
  )

  const dynamicAt = TASK_MIGRATED_ROUTES.findIndex(route => route.path === '/api/agentops/tasks/{task_id}')
  assert.ok(dynamicAt > 0)
  const staticPaths = [
    '/api/agentops/tasks/projects',
    '/api/agentops/tasks/ideas',
    '/api/agentops/tasks/relations',
    '/api/agentops/tasks/proposals',
    '/api/agentops/tasks/revision',
    '/api/agentops/tasks/search',
    '/api/agentops/tasks/graph',
    '/api/agentops/tasks/dashboard',
    '/api/agentops/tasks',
  ]
  for (const path of staticPaths) {
    const at = TASK_MIGRATED_ROUTES.findIndex(route => route.path === path)
    assert.ok(at >= 0 && at < dynamicAt, `${path} must precede {task_id}`)
  }
})

void test('canonical 路由不带 task_id，且路由键唯一', () => {
  const keys = TASK_CANONICAL_ROUTES.map(route => `${route.method} ${route.path}`)
  assert.equal(new Set(keys).size, keys.length)
  for (const route of TASK_CANONICAL_ROUTES) assert.ok(!route.path.includes('{task_id}'))
})

void test('P0 与 V1 边只引用各自状态集合，且边不重复', () => {
  for (const status of P0_STATUSES) assert.ok((TASK_STATUSES as readonly string[]).includes(status), status)
  for (const edge of P0_TRANSITIONS) {
    assert.ok((P0_STATUSES as readonly string[]).includes(edge.from), edge.from)
    assert.ok((P0_STATUSES as readonly string[]).includes(edge.to), edge.to)
  }
  for (const edge of TRANSITIONS) {
    assert.ok((TASK_STATUSES as readonly string[]).includes(edge.from), edge.from)
    assert.ok((TASK_STATUSES as readonly string[]).includes(edge.to), edge.to)
  }
  assert.equal(new Set(P0_TRANSITIONS.map(edge => `${edge.from}->${edge.to}`)).size, P0_TRANSITIONS.length)
  assert.equal(new Set(TRANSITIONS.map(edge => `${edge.from}->${edge.to}`)).size, TRANSITIONS.length)
  assert.deepEqual([...P0_TERMINAL], ['closed'])
  assert.deepEqual([...TERMINAL].sort(), ['abandoned', 'canceled', 'closed'])
})

void test('快照文件与源码派生结果一致', () => {
  const expected = `${JSON.stringify(buildTaskContractSnapshot(), null, 2)}\n`
  const actual = readFileSync(SNAPSHOT_PATH, 'utf8')
  assert.equal(actual, expected)
})
