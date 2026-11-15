import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { WorkflowCatalogService } from '@agentops/dsh-workflow-catalog'

import { apply } from '../src/dsh.ts'
import { SqliteRunStore } from '../src/run-store.ts'
import {
  createRunActivityHandler,
  createRunDetailHandler,
  createRunListHandler,
} from '../src/runs.ts'
import type { NodeState, RunState } from '../src/types.ts'

const ACTIVITY_SOURCE = `workflow_id: log-patrol
version: 2
business_id: maxkb
nodes:
  - id: scan
    name: Scan logs
    agent: log_analyst
    business_role: Log analyst
    harness: codex
    model: model-a
    outputs:
      raw: analyze
  - id: analyze
    name: Analyze
    agent: log_analyst
    business_role: Log analyst
  - id: report
    name: Report
    agent: log_analyst
    business_role: Reporter
    after: [analyze]
`

interface ActivityWire {
  runId: string
  workflowId: string
  lanes: { id: string; nodeIds: string[] }[]
  nodes: {
    id: string
    status: string
    attempts: number
    outputs?: Record<string, unknown>
  }[]
  scheduleEdges: { from: string; to: string }[]
  dataEdges: { from: string; to: string; port: string }[]
  timeline: { type: string }[]
  handoffs: unknown[]
}

interface ActivityErrorWire {
  error: {
    code: string
    message: string
    issues?: string[]
  }
}

interface RunListWire {
  runs: {
    runId: string
    workflowId: string
    status: string
    startedAt: string
    finishedAt?: string
    error?: string
  }[]
  total: number
}

interface RunDetailWire {
  runId: string
  workflowId: string
  status: string
  startedAt: string
  finishedAt?: string
  error?: string
  nodes: {
    id: string
    status: string
    attempts: number
    startedAt?: string
    finishedAt?: string
    error?: string
    chosenPort?: string
    outputs?: Record<string, unknown>
  }[]
}

class TestCredentials extends CredentialProvider {
  record: CredentialRecord | undefined

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.record)
  }

  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve(this.record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: this.record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override async modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.record)
    if (next !== undefined) this.record = next
    return this.record
  }

  override deleteRecord(_key: CredentialKey): Promise<void> {
    this.record = undefined
    return Promise.resolve()
  }

}

function state(
  runId: string,
  startedAt: string,
  status: RunState['status'],
  options: { finishedAt?: string; error?: string; node?: NodeState } = {},
): RunState {
  return {
    runId,
    status,
    startedAt,
    nodes: {
      scan: options.node ?? {
        status: 'completed',
        attempts: 1,
        startedAt,
        finishedAt: options.finishedAt ?? startedAt,
        outputs: { records: ['analyze'] },
      },
    },
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    ...(options.error === undefined ? {} : { error: options.error }),
  }
}

async function withStore(run: (store: SqliteRunStore) => Promise<void> | void): Promise<void> {
  const store = new SqliteRunStore(':memory:')
  try {
    await run(store)
  } finally {
    store.close()
  }
}

async function listBody(response: Response): Promise<RunListWire> {
  return await response.json() as RunListWire
}

async function detailBody(response: Response): Promise<RunDetailWire> {
  return await response.json() as RunDetailWire
}

function activityRequest(id?: string): Request {
  const url = new URL('https://example.test/api/agentops/run-activity')
  if (id !== undefined) url.searchParams.set('id', id)
  return new Request(url)
}

async function activityError(response: Response): Promise<ActivityErrorWire> {
  return await response.json() as ActivityErrorWire
}

async function mountedEnvironment(dbPath: string): Promise<{
  fetch: (path: string) => Promise<Response>
  addCatalog: (directory: string) => Promise<() => Promise<void>>
  disposeConnection: () => Promise<void>
  dispose: () => Promise<void>
}> {
  const root = new Context()
  const credentialFiber = root.plugin((ctx) => { new TestCredentials(ctx) })
  await credentialFiber.await()
  const credentials = root.get('credentials')
  if (credentials === undefined) throw new Error('credentials service missing')
  const auth = await BrowserAuth.create(root, credentials, 30)
  const connectionFiber = root.plugin((ctx) => { new HostConnectionService(ctx, [], auth) })
  await connectionFiber.await()
  const connection = root.get('connection')
  if (connection === undefined) throw new Error('connection service missing')
  const shared = connection.createSharedFetchHandler('/api')
  const applicationFiber = root.plugin((ctx) => { apply(ctx, { workflowDir: '', runDbPath: dbPath }) })
  await applicationFiber.await()

  return {
    fetch: path => shared.fetch(new Request(`http://host/api${path}`), connection.browserPeer),
    addCatalog: async (directory) => {
      const catalogFiber = root.plugin((ctx) => { new WorkflowCatalogService(ctx, { directory }) })
      await catalogFiber.await()
      return () => catalogFiber.dispose()
    },
    disposeConnection: () => connectionFiber.dispose(),
    dispose: async () => {
      await applicationFiber.dispose()
      await connectionFiber.dispose()
      await credentialFiber.dispose()
    },
  }
}

void test('运行列表：offset 分页并返回筛选后的 total', async () => {
  await withStore(async (store) => {
    store.save(state('run-1', '2026-10-25T00:01:00.000Z', 'completed'), 'workflow-a')
    store.save(state('run-2', '2026-10-25T00:02:00.000Z', 'failed', { error: 'agent failed' }), 'workflow-a')
    store.save(state('run-3', '2026-10-25T00:03:00.000Z', 'completed'), 'workflow-b')

    const response = createRunListHandler(store)(new Request(
      'http://localhost/api/agentops/runs?limit=1&offset=1',
    ))
    assert.equal(response.status, 200)
    const body = await listBody(response)
    assert.equal(body.total, 3)
    assert.deepEqual(body.runs.map(run => run.runId), ['run-2'])
    assert.equal(body.runs[0]!.error, 'agent failed')
  })
})

void test('运行列表：status 与 workflowId 共同筛选', async () => {
  await withStore(async (store) => {
    store.save(state('run-1', '2026-10-25T00:01:00.000Z', 'completed'), 'logs')
    store.save(state('run-2', '2026-10-25T00:02:00.000Z', 'failed'), 'logs')
    store.save(state('run-3', '2026-10-25T00:03:00.000Z', 'failed'), 'reports')

    const response = createRunListHandler(store)(new Request(
      'http://localhost/api/agentops/runs?status=failed&workflowId=logs',
    ))
    assert.equal(response.status, 200)
    const body = await listBody(response)
    assert.equal(body.total, 1)
    assert.equal(body.runs[0]!.runId, 'run-2')
  })
})

void test('运行详情：保留节点输出、端口和失败信息', async () => {
  await withStore(async (store) => {
    store.save(state('run-detail', '2026-10-25T00:00:00.000Z', 'failed', {
      finishedAt: '2026-10-25T00:00:08.000Z',
      error: 'workflow failed',
      node: {
        status: 'failed',
        attempts: 2,
        startedAt: '2026-10-25T00:00:01.000Z',
        finishedAt: '2026-10-25T00:00:07.500Z',
        error: 'model timeout',
        chosenPort: 'retry',
        outputs: { records: ['one', 'two'], nested: { ok: true } },
      },
    }), 'log-patrol')

    const body = await detailBody(createRunDetailHandler(store)(new Request(
      'http://localhost/api/agentops/run?id=run-detail',
    )))
    assert.deepEqual(body, {
      runId: 'run-detail',
      workflowId: 'log-patrol',
      status: 'failed',
      startedAt: '2026-10-25T00:00:00.000Z',
      finishedAt: '2026-10-25T00:00:08.000Z',
      error: 'workflow failed',
      nodes: [{
        id: 'scan',
        status: 'failed',
        attempts: 2,
        startedAt: '2026-10-25T00:00:01.000Z',
        finishedAt: '2026-10-25T00:00:07.500Z',
        error: 'model timeout',
        chosenPort: 'retry',
        outputs: { records: ['one', 'two'], nested: { ok: true } },
      }],
    })
  })
})

void test('未知运行返回 404，非法列表参数返回 400', async () => {
  await withStore((store) => {
    const detail = createRunDetailHandler(store)(new Request(
      'http://localhost/api/agentops/run?id=missing',
    ))
    assert.equal(detail.status, 404)

    const list = createRunListHandler(store)
    for (const query of [
      'status=unknown',
      'limit=0',
      'limit=201',
      'limit=not-a-number',
      'offset=-1',
      'offset=1.5',
    ]) {
      assert.equal(list(new Request(`http://localhost/api/agentops/runs?${query}`)).status, 400)
    }
  })
})

void test('相同开始时间按 run_id 倒序稳定排列', async () => {
  await withStore((store) => {
    const startedAt = '2026-10-25T00:00:00.000Z'
    store.save(state('run-a', startedAt, 'completed'), 'workflow')
    store.save(state('run-b', startedAt, 'completed'), 'workflow')
    store.save(state('run-c', startedAt, 'completed'), 'workflow')

    assert.deepEqual(store.listPage(2).map(run => run.runId), ['run-c', 'run-b'])
    assert.deepEqual(store.listPage(2, { offset: 2 }).map(run => run.runId), ['run-a'])
  })
})

void test('协作活动：返回泳道、真实节点状态、两类边与时间线', async () => {
  await withStore(async (store) => {
    store.save(state('activity-run', '2026-10-31T00:00:00.000Z', 'running', {
      node: {
        status: 'completed',
        attempts: 1,
        startedAt: '2026-10-31T00:00:01.000Z',
        finishedAt: '2026-10-31T00:00:03.500Z',
        outputs: { records: ['one'] },
      },
    }), 'log-patrol')

    const handler = createRunActivityHandler(store, async () => ({ text: ACTIVITY_SOURCE }))
    const response = await handler(activityRequest('  activity-run  '))
    assert.equal(response.status, 200)
    const body = await response.json() as ActivityWire
    assert.equal(body.runId, 'activity-run')
    assert.equal(body.workflowId, 'log-patrol')
    assert.deepEqual(body.lanes.map(lane => lane.id), ['Log analyst', 'Reporter'])
    assert.deepEqual(body.nodes.map(node => [node.id, node.status, node.attempts]), [
      ['scan', 'completed', 1],
      ['analyze', 'pending', 0],
      ['report', 'pending', 0],
    ])
    assert.deepEqual(body.nodes[0]!.outputs, { records: ['one'] })
    assert.deepEqual(body.scheduleEdges, [{ from: 'analyze', to: 'report' }])
    assert.deepEqual(body.dataEdges, [{ from: 'scan', to: 'analyze', port: 'raw' }])
    assert.deepEqual(body.timeline.map(entry => entry.type), [
      'run.started',
      'node.started',
      'node.completed',
    ])
    assert.deepEqual(body.handoffs, [])
  })
})

void test('协作活动：缺失、空或仅空白的 id 返回 400，未知运行返回 404', async () => {
  await withStore(async (store) => {
    const handler = createRunActivityHandler(store, async () => ({ text: ACTIVITY_SOURCE }))
    for (const request of [activityRequest(), activityRequest(''), activityRequest('   ')]) {
      const response = await handler(request)
      assert.equal(response.status, 400)
      assert.equal((await activityError(response)).error.code, 'invalid_query')
    }

    const missing = await handler(activityRequest('missing'))
    assert.equal(missing.status, 404)
    assert.equal((await activityError(missing)).error.code, 'unknown_run')
  })
})

void test('协作活动：工作流缺失、YAML 非法、拓扑非法和 id 不一致返回结构化错误', async () => {
  await withStore(async (store) => {
    store.save(state('activity-run', '2026-10-31T00:00:00.000Z', 'completed'), 'log-patrol')
    const cases = [
      {
        reader: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
        status: 404,
        code: 'workflow_missing',
      },
      {
        reader: async () => { throw new RangeError('invalid id') },
        status: 404,
        code: 'workflow_missing',
      },
      {
        reader: async () => ({ text: 'nodes: [' }),
        status: 422,
        code: 'workflow_invalid',
      },
      {
        reader: async () => ({
          text: 'workflow_id: log-patrol\nnodes:\n  - id: scan\n    after: [missing]\n',
        }),
        status: 422,
        code: 'workflow_invalid',
      },
      {
        reader: async () => ({ text: 'workflow_id: another-workflow\nnodes:\n  - id: scan\n    agent: log_analyst\n' }),
        status: 409,
        code: 'workflow_mismatch',
      },
    ] as const

    for (const item of cases) {
      const response = await createRunActivityHandler(store, item.reader)(activityRequest('activity-run'))
      assert.equal(response.status, item.status)
      assert.equal((await activityError(response)).error.code, item.code)
    }
  })
})

void test('协作活动：读取或投影异常返回 500，错误体不泄露文件路径', async () => {
  await withStore(async (store) => {
    store.save(state('activity-run', '2026-10-31T00:00:00.000Z', 'completed'), 'log-patrol')
    const secretPath = 'E:/private/agentops/definitions/log-patrol.yaml'
    const readFailure = await createRunActivityHandler(store, async () => {
      throw new Error(secretPath)
    })(activityRequest('activity-run'))
    assert.equal(readFailure.status, 500)
    const readBody = await activityError(readFailure)
    assert.equal(readBody.error.code, 'internal_error')
    assert.equal(readBody.error.message.includes(secretPath), false)

    const brokenState = state('projection-run', '2026-10-31T00:00:00.000Z', 'completed')
    Object.defineProperty(brokenState, 'startedAt', {
      get(): never { throw new Error(secretPath) },
    })
    const brokenStore = {
      loadRecord(runId: string) {
        return runId === 'projection-run'
          ? { workflowId: 'log-patrol', state: brokenState }
          : null
      },
    }
    const projectionFailure = await createRunActivityHandler(
      brokenStore,
      async () => ({ text: ACTIVITY_SOURCE }),
    )(activityRequest('projection-run'))
    assert.equal(projectionFailure.status, 500)
    const projectionBody = await activityError(projectionFailure)
    assert.equal(projectionBody.error.code, 'internal_error')
    assert.equal(JSON.stringify(projectionBody).includes(secretPath), false)
  })
})

void test('运行路由生命周期：catalog 控制 activity，connection 控制全部路由并关闭数据库', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentops-dag-routes-'))
  const dbPath = join(directory, 'runs.db')
  const workflowDirectory = join(directory, 'workflows')
  writeFileSync(join(directory, 'log-patrol.yaml'), ACTIVITY_SOURCE)
  const seed = new SqliteRunStore(dbPath)
  seed.save(state('activity-run', '2026-10-31T00:00:00.000Z', 'running', {
    node: {
      status: 'completed',
      attempts: 1,
      startedAt: '2026-10-31T00:00:01.000Z',
      finishedAt: '2026-10-31T00:00:02.000Z',
    },
  }), 'log-patrol')
  seed.close()
  rmSync(workflowDirectory, { recursive: true, force: true })

  const environment = await mountedEnvironment(dbPath)
  try {
    assert.equal((await environment.fetch('/agentops/runs')).status, 200)
    assert.equal((await environment.fetch('/agentops/run?id=activity-run')).status, 200)
    assert.equal((await environment.fetch('/agentops/run-activity?id=activity-run')).status, 404)

    const removeCatalog = await environment.addCatalog(directory)
    assert.equal((await environment.fetch('/agentops/run-activity?id=activity-run')).status, 200)
    await removeCatalog()
    assert.equal((await environment.fetch('/agentops/run-activity?id=activity-run')).status, 404)
    assert.equal((await environment.fetch('/agentops/runs')).status, 200)
    assert.equal((await environment.fetch('/agentops/run?id=activity-run')).status, 200)

    await environment.disposeConnection()
    assert.equal((await environment.fetch('/agentops/runs')).status, 404)
    assert.equal((await environment.fetch('/agentops/run?id=activity-run')).status, 404)

    const reopened = new SqliteRunStore(dbPath)
    try {
      assert.equal(reopened.loadRecord('activity-run')?.workflowId, 'log-patrol')
    } finally {
      reopened.close()
    }
  } finally {
    await environment.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
