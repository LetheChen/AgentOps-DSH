/**
 * Decision memory tests: four-state lifecycle, user-only authority mutations,
 * append-only evidence/audit, authority uniqueness and mutually exclusive search.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { TaskService, type Actor, type DecisionRecord, type ProposeDecisionInput } from '../src/service.ts'

const NOW = '2026-11-07T00:00:00Z'
const EARLIER = '2026-11-06T00:00:00Z'
const USER: Actor = { type: 'user', id: 'u1' }
const AGENT: Actor = { type: 'agent', id: 'a1' }

interface Harness {
  db: DatabaseSync
  service: TaskService
}

function harness(): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  let counter = 0
  const service = new TaskService(db, { now: () => NOW, newId: () => `id${(counter += 1)}` })
  service.createProject({ name: 'Orders', projectId: 'p1' })
  service.createProject({ name: 'Other', projectId: 'p2' })
  return { db, service }
}

function base(overrides: Partial<ProposeDecisionInput> = {}): ProposeDecisionInput {
  return {
    projectId: 'p1',
    decisionKey: 'task-admission-gate',
    title: 'Admission gate',
    subjectType: 'project',
    authorityScope: 'project',
    authorityLevel: 'policy',
    problem: 'Draft tasks bypass analysis.',
    proposal: 'Candidates must pass a gate.',
    rationale: 'Preserve lifecycle quality.',
    noteClass: 'architecture',
    actor: USER,
    ...overrides,
  }
}

function propose(service: TaskService, overrides: Partial<ProposeDecisionInput> = {}): DecisionRecord {
  return service.decisionPropose(base(overrides))
}

function implement(service: TaskService, decision: DecisionRecord, ref = `pr://${decision.decisionId}`): DecisionRecord {
  return service.decisionImplement({
    decisionId: decision.decisionId,
    ifVersion: decision.version,
    effectiveFrom: EARLIER,
    evidence: [{ kind: 'pull_request', ref }],
    actor: USER,
  })
}

function code(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'not-a-service-error'
}

void test('Decision: propose -> revise -> implement -> archive keeps evidence and audit', () => {
  const h = harness()
  const proposed = propose(h.service, { decisionId: 'd1' })
  assert.equal(proposed.status, 'proposed')
  assert.equal(proposed.version, 0)

  const revised = h.service.decisionRevise({
    decisionId: proposed.decisionId,
    ifVersion: proposed.version,
    title: 'Admission gate v2',
    actor: USER,
  })
  assert.equal(revised.status, 'proposed')
  assert.equal(revised.version, 1)
  assert.equal(revised.title, 'Admission gate v2')

  const implemented = h.service.decisionImplement({
    decisionId: revised.decisionId,
    ifVersion: revised.version,
    effectiveFrom: EARLIER,
    evidence: [{ kind: 'pull_request', ref: 'https://example.test/pr/1' }],
    actor: USER,
  })
  assert.equal(implemented.status, 'implemented')
  assert.equal(implemented.version, 2)
  assert.equal(implemented.approvedBy, 'u1')
  assert.equal(implemented.effectiveFrom, EARLIER)
  assert.throws(
    () => h.service.decisionRevise({ decisionId: implemented.decisionId, ifVersion: implemented.version, actor: USER }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )

  const archived = h.service.decisionArchive({
    decisionId: implemented.decisionId,
    ifVersion: implemented.version,
    reason: 'obsolete',
    actor: USER,
  })
  assert.equal(archived.status, 'archived')
  assert.equal(archived.version, 3)
  assert.equal(archived.archiveReason, 'obsolete')

  const detail = h.service.decisionGet(archived.decisionId)
  assert.equal(detail.evidence.length, 1)
  assert.deepEqual(
    detail.audit.map(row => row.eventType),
    ['decision_proposed', 'decision_revised', 'decision_implemented', 'decision_archived'],
  )
  h.db.close()
})

void test('Decision: reject is terminal and authority mutations require a user', () => {
  const h = harness()
  const proposed = propose(h.service, { decisionId: 'd1' })
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: proposed.decisionId,
      ifVersion: proposed.version,
      evidence: [{ kind: 'manual', ref: 'agent-check' }],
      actor: AGENT,
    }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  assert.throws(
    () => h.service.decisionReject({
      decisionId: proposed.decisionId,
      ifVersion: proposed.version,
      reason: 'not yet',
      actor: AGENT,
    }),
    (error: unknown) => code(error) === 'user_approval_required',
  )

  const rejected = h.service.decisionReject({
    decisionId: proposed.decisionId,
    ifVersion: proposed.version,
    reason: 'The design is incomplete.',
    actor: USER,
  })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectReason, 'The design is incomplete.')
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: rejected.decisionId,
      ifVersion: rejected.version,
      evidence: [{ kind: 'manual', ref: 'late' }],
      actor: USER,
    }),
    (error: unknown) => code(error) === 'invalid_transition',
  )

  const implementedProposal = propose(h.service, { decisionId: 'd2', decisionKey: 'archive-guard' })
  const implemented = implement(h.service, implementedProposal)
  assert.throws(
    () => h.service.decisionArchive({
      decisionId: implemented.decisionId,
      ifVersion: implemented.version,
      reason: 'obsolete',
      actor: AGENT,
    }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  assert.throws(
    () => h.service.decisionSupersede({
      decisionId: implemented.decisionId,
      ifVersion: implemented.version,
      successorDecisionId: proposed.decisionId,
      actor: AGENT,
    }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  h.db.close()
})

void test('Decision: implement requires evidence and a valid effectiveFrom', () => {
  const h = harness()
  const proposed = propose(h.service, { decisionId: 'd1' })
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: proposed.decisionId,
      ifVersion: proposed.version,
      evidence: [],
      actor: USER,
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: proposed.decisionId,
      ifVersion: proposed.version,
      effectiveFrom: '2026-11-08T00:00:00Z',
      evidence: [{ kind: 'test', ref: 'suite' }],
      actor: USER,
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  assert.equal(h.service.decisionGet(proposed.decisionId).decision.status, 'proposed')
  assert.equal(h.service.decisionGet(proposed.decisionId).evidence.length, 0)
  h.db.close()
})

void test('Decision: stale and illegal transitions return stable errors', () => {
  const h = harness()
  const proposed = propose(h.service, { decisionId: 'd1' })
  const implemented = implement(h.service, proposed)
  assert.throws(
    () => h.service.decisionArchive({
      decisionId: implemented.decisionId,
      ifVersion: proposed.version,
      reason: 'obsolete',
      actor: USER,
    }),
    (error: unknown) => code(error) === 'version_conflict',
  )
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: implemented.decisionId,
      ifVersion: implemented.version,
      evidence: [{ kind: 'manual', ref: 'again' }],
      actor: USER,
    }),
    (error: unknown) => code(error) === 'invalid_transition',
  )
  h.db.close()
})

void test('Decision: supersede archives the old decision and records both audit sides', () => {
  const h = harness()
  const old = implement(h.service, propose(h.service, { decisionId: 'd-old' }))
  const successor = propose(h.service, { decisionId: 'd-new', decisionKey: 'task-admission-gate-v2' })
  const result = h.service.decisionSupersede({
    decisionId: old.decisionId,
    ifVersion: old.version,
    successorDecisionId: successor.decisionId,
    actor: USER,
  })

  assert.equal(result.archived.status, 'archived')
  assert.equal(result.archived.archiveReason, 'superseded')
  assert.equal(result.archived.version, old.version + 1)
  assert.equal(result.successor.status, 'proposed')
  assert.equal(result.successor.supersedesId, old.decisionId)
  assert.equal(result.successor.version, successor.version + 1)

  const oldDetail = h.service.decisionGet(old.decisionId)
  assert.equal(oldDetail.relations.length, 1)
  assert.equal(oldDetail.relations[0]?.sourceDecisionId, successor.decisionId)
  assert.equal(oldDetail.relations[0]?.targetDecisionId, old.decisionId)
  assert.ok(oldDetail.audit.some(row => row.eventType === 'decision_superseded'))
  const successorDetail = h.service.decisionGet(successor.decisionId)
  assert.ok(successorDetail.audit.some(row => row.eventType === 'decision_marked_successor'))
  h.db.close()
})

void test('Decision: implemented authority is unique per scope and decision key', () => {
  const h = harness()
  const first = implement(h.service, propose(h.service, { decisionId: 'd1' }))
  const second = propose(h.service, { decisionId: 'd2' })
  assert.throws(
    () => h.service.decisionImplement({
      decisionId: second.decisionId,
      ifVersion: second.version,
      effectiveFrom: EARLIER,
      evidence: [{ kind: 'test', ref: 'duplicate-authority' }],
      actor: USER,
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  assert.equal(h.service.decisionGet(first.decisionId).decision.status, 'implemented')
  assert.equal(h.service.decisionGet(second.decisionId).decision.status, 'proposed')
  assert.equal(h.service.decisionGet(second.decisionId).evidence.length, 0)
  h.db.close()
})

void test('Decision: relaxation evidence must exist and hard constraints cannot relax', () => {
  const h = harness()
  const baseDecision = propose(h.service, {
    decisionId: 'd-base',
    decisionKey: 'base-policy',
    evidence: [{ kind: 'document', ref: 'doc://base' }],
  })
  const evidenceId = h.service.decisionGet(baseDecision.decisionId).evidence[0]?.evidenceId
  assert.ok(evidenceId !== undefined)

  assert.throws(
    () => propose(h.service, {
      decisionId: 'd-hard',
      decisionKey: 'hard-relax',
      authorityLevel: 'hard_constraint',
      relaxesDecisionId: baseDecision.decisionId,
      relaxesEvidenceId: evidenceId,
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  assert.throws(
    () => propose(h.service, {
      decisionId: 'd-no-evidence',
      decisionKey: 'policy-no-evidence',
      relaxesDecisionId: baseDecision.decisionId,
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )

  const relaxed = propose(h.service, {
    decisionId: 'd-policy',
    decisionKey: 'policy-relax',
    relaxesDecisionId: baseDecision.decisionId,
    relaxesEvidenceId: evidenceId,
  })
  assert.equal(relaxed.relaxesDecisionId, baseDecision.decisionId)
  assert.equal(relaxed.relaxesEvidenceId, evidenceId)
  h.db.close()
})

void test('Decision search: proposed, authoritative and historical collections are mutually exclusive', () => {
  const h = harness()
  const proposed = propose(h.service, { decisionId: 'd-prop', decisionKey: 'prop' })
  const authoritative = implement(h.service, propose(h.service, { decisionId: 'd-auth', decisionKey: 'auth' }))
  const rejected = h.service.decisionReject({
    decisionId: propose(h.service, { decisionId: 'd-rej', decisionKey: 'rej' }).decisionId,
    ifVersion: 0,
    reason: 'rejected',
    actor: USER,
  })
  const archivedBase = implement(h.service, propose(h.service, { decisionId: 'd-arch', decisionKey: 'arch' }))
  const archived = h.service.decisionArchive({
    decisionId: archivedBase.decisionId,
    ifVersion: archivedBase.version,
    reason: 'invalidated',
    actor: USER,
  })

  const byProposed = h.service.decisionSearch({ projectId: 'p1', collection: 'proposed' })
  const byAuthoritative = h.service.decisionSearch({ projectId: 'p1', collection: 'authoritative' })
  const byHistorical = h.service.decisionSearch({ projectId: 'p1', collection: 'historical' })
  const all = h.service.decisionSearch({ projectId: 'p1', collection: 'all' })

  assert.deepEqual(byProposed.decisions.map(row => row.decisionId), [proposed.decisionId])
  assert.deepEqual(byAuthoritative.decisions.map(row => row.decisionId), [authoritative.decisionId])
  assert.deepEqual(byHistorical.decisions.map(row => row.decisionId).sort(), [rejected.decisionId, archived.decisionId].sort())
  assert.equal(all.total, 4)
  assert.equal(all.searchCoverage, 'partial')
  h.db.close()
})

void test('Decision: evidence and audit are append-only and approval fields are frozen', () => {
  const h = harness()
  const implemented = implement(h.service, propose(h.service, { decisionId: 'd1' }))
  const detail = h.service.decisionGet(implemented.decisionId)
  const evidenceId = detail.evidence[0]?.evidenceId
  const auditId = detail.audit[0]?.auditId
  assert.ok(evidenceId !== undefined)
  assert.ok(auditId !== undefined)

  assert.throws(
    () => h.db.prepare('UPDATE decision_evidence SET ref = ? WHERE evidence_id = ?').run('changed', evidenceId),
    /APPEND_ONLY_TABLE/,
  )
  assert.throws(
    () => h.db.prepare('DELETE FROM decision_audit WHERE audit_id = ?').run(auditId),
    /APPEND_ONLY_TABLE/,
  )
  assert.throws(
    () => h.db.prepare('UPDATE decisions SET approved_by = ? WHERE decision_id = ?').run('other', implemented.decisionId),
    /DECISION_APPROVAL_IMMUTABLE/,
  )
  assert.throws(
    () => h.db.prepare("UPDATE decisions SET status = 'proposed' WHERE decision_id = ?").run(implemented.decisionId),
    /DECISION_INVALID_TRANSITION/,
  )
  h.db.close()
})
