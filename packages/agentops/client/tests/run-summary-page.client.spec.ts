import { describe, expect, it } from 'vitest'

import type { RunSummary } from '../src/client/run-history-api.js'
import { appendRunSummaries } from '../src/client/run-summary-page.js'

function summary(runId: string): RunSummary {
  return {
    runId,
    workflowId: 'log-patrol',
    status: 'completed',
    startedAt: '2026-10-31T00:00:00.000Z',
  }
}

describe('append run summaries', () => {
  it('returns an empty list when both pages are empty', () => {
    expect(appendRunSummaries([], [])).toEqual([])
  })

  it('appends unseen runs while de-duplicating the incoming page', () => {
    const result = appendRunSummaries(
      [summary('run-1')],
      [summary('run-2'), summary('run-2'), summary('run-3')],
    )

    expect(result.map(run => run.runId)).toEqual(['run-1', 'run-2', 'run-3'])
  })

  it('preserves the existing order when the incoming page repeats existing runs', () => {
    const first = summary('run-1')
    const second = summary('run-2')
    const result = appendRunSummaries([first, second], [summary('run-1'), summary('run-3')])

    expect(result).toEqual([first, second, summary('run-3')])
  })
})
