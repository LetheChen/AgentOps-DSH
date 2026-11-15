import { describe, expect, it } from 'vitest'

import type { AgentRecord } from '../src/client/agent-catalogue-api.js'
import {
  addKnowledgeBase,
  agentRecordToDraft,
  draftToAgentRecord,
  emptyAgentDraft,
  removeKnowledgeBase,
  setToolPolicy,
  toolPolicyFor,
  validateAgentDraft,
} from '../src/client/agent-form.js'

const RECORD: AgentRecord = {
  agentId: 'log_puller',
  displayName: 'Log puller',
  domain: 'observability',
  description: 'Pulls recent failures.',
  harness: 'local_llm',
  executionBackend: 'auto',
  model: { provider: 'deepseek', id: 'deepseek-chat' },
  systemPrompt: 'Find the first causal failure.',
  tier: 'T1',
  execution: 'skill',
  permissions: {
    allowedTools: ['read_file'],
    deniedTools: ['shell'],
  },
  knowledgeBases: ['runbooks', 'service-catalog'],
  timeoutSeconds: 300,
  maxConcurrentRuns: 2,
  costLimitPerRun: 1.5,
  outputFiles: { report: 'reports/analysis.md' },
}

describe('Agent form', () => {
  it('round-trips a complete record without changing its explicit tier', () => {
    const draft = agentRecordToDraft(RECORD)

    expect(draft.tier).toBe('T1')
    expect(draftToAgentRecord(draft)).toEqual(RECORD)
  })

  it('preserves workflow ownership through an edit that does not touch it', () => {
    const owned: AgentRecord = { ...RECORD, execution: 'workflow', workflow: 'log-patrol' }

    const draft = agentRecordToDraft(owned)
    expect(draft.execution).toBe('workflow')
    expect(draft.workflow).toBe('log-patrol')
    expect(draftToAgentRecord(draft)).toEqual(owned)
  })

  it('drops a stale workflow id once the Agent is explicitly switched to skill', () => {
    const owned: AgentRecord = { ...RECORD, execution: 'workflow', workflow: 'log-patrol' }

    const demoted = draftToAgentRecord({ ...agentRecordToDraft(owned), execution: 'skill' })
    expect(demoted.execution).toBe('skill')
    expect(demoted.workflow).toBeUndefined()
  })

  it('keeps allowed, denied, and default tool states mutually exclusive', () => {
    const initial = emptyAgentDraft()
    const denied = setToolPolicy(initial, ' read_file ', 'denied')
    expect(toolPolicyFor(denied, 'read_file')).toBe('denied')
    expect(denied.allowedTools).toEqual([])
    expect(denied.deniedTools).toEqual(['read_file'])

    const allowed = setToolPolicy(denied, 'read_file', 'allowed')
    expect(toolPolicyFor(allowed, 'read_file')).toBe('allowed')
    expect(allowed.allowedTools).toEqual(['read_file'])
    expect(allowed.deniedTools).toEqual([])

    const reset = setToolPolicy(allowed, 'read_file', 'default')
    expect(toolPolicyFor(reset, 'read_file')).toBe('default')
    expect(reset.allowedTools).toEqual([])
    expect(reset.deniedTools).toEqual([])
  })

  it('deduplicates knowledge-base identifiers after trimming', () => {
    const first = addKnowledgeBase(emptyAgentDraft(), ' runbooks ')
    const duplicate = addKnowledgeBase(first, 'runbooks')

    expect(duplicate.knowledgeBases).toEqual(['runbooks'])
    expect(removeKnowledgeBase(duplicate, 'runbooks').knowledgeBases).toEqual([])
  })

  it('rejects duplicate output ports and paths outside the workspace', () => {
    const issues = validateAgentDraft({
      ...emptyAgentDraft(),
      agentId: 'reporter',
      displayName: 'Reporter',
      domain: 'reporting',
      outputFiles: [
        { key: 'one', port: 'report', path: 'reports/first.md' },
        { key: 'two', port: 'report', path: '../outside.md' },
      ],
    })

    expect(issues).toContainEqual({ field: 'outputFiles', code: 'duplicateOutputPort', detail: 'report' })
    expect(issues).toContainEqual({ field: 'outputFiles', code: 'invalidOutputPath', detail: '../outside.md' })
  })
})
