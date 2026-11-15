import { describe, expect, it } from 'vitest'

import { createTaskRpcClient, type TaskRpcCall } from '../src/client/task-rpc-api.js'

interface Recorded {
  endpoint: string
  payload: { method: string; query?: Record<string, string>; body?: unknown }
}

function recorder(result: unknown = { ok: true, value: {} }): { calls: Recorded[]; call: TaskRpcCall } {
  const calls: Recorded[] = []
  const call: TaskRpcCall = (endpoint, payload) => {
    calls.push({ endpoint, payload: { ...payload } })
    return Promise.resolve(result as never)
  }
  return { calls, call }
}

describe('task RPC client', () => {
  it('maps task reads and writes onto agentops/tasks endpoints', async () => {
    const { calls, call } = recorder()
    const client = createTaskRpcClient(call)

    await client.listTasks({ status: 'backlog' })
    await client.getTask('task_1')
    await client.advanceTask('task_1', { target_status: 'in_progress', if_version: 0 })

    expect(calls).toEqual([
      { endpoint: 'agentops/tasks', payload: { method: 'GET', query: { status: 'backlog' } } },
      { endpoint: 'agentops/tasks/task_1', payload: { method: 'GET' } },
      {
        endpoint: 'agentops/tasks/task_1/advance',
        payload: { method: 'POST', body: { target_status: 'in_progress', if_version: 0 } },
      },
    ])
  })

  it('maps inbox reads, capture and triage', async () => {
    const { calls, call } = recorder()
    const client = createTaskRpcClient(call)

    await client.listIdeas({ status: 'captured' })
    await client.captureIdea({ channel: 'manual', content: '导出按钮重复点击' })
    await client.triageIdea('idea_1', { action: 'ready' })

    expect(calls.map(item => item.endpoint)).toEqual([
      'agentops/tasks/ideas',
      'agentops/tasks/ideas',
      'agentops/tasks/ideas/idea_1/triage',
    ])
    expect(calls[2]?.payload).toEqual({ method: 'POST', body: { action: 'ready' } })
  })

  it('passes failures through unchanged', async () => {
    const failure = { ok: false, error: { code: 'version_conflict', message: 'stale', details: {} } }
    const { call } = recorder(failure)
    const client = createTaskRpcClient(call)

    await expect(client.advanceTask('task_1', {})).resolves.toEqual(failure)
  })
})
