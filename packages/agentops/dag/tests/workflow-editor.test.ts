import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { digestOf, WorkflowCatalog } from '@agentops/dsh-workflow-catalog'

import { registerWorkflowEditorRoutes } from '../src/workflow-editor.ts'

const SOURCE_PATH = '/api/agentops/workflow-source'
const VALIDATE_PATH = '/api/agentops/workflow-validate'
const CREATE_PATH = '/api/agentops/workflow-create'
const SAVE_PATH = '/api/agentops/workflow-save'
const EDIT_PATH = '/api/agentops/workflow-edit'
const DELETE_PATH = '/api/agentops/workflow-delete'
const MAX_SOURCE_BYTES = 1_048_576

const VALID = `workflow_id: log-patrol
version: 2
business_id: maxkb
nodes:
  - id: scan
    agent: log_analyst
    role_prompt: scan logs
  - id: report
    agent: log_analyst
    role_prompt: write report
    after: [scan]
    timeout_seconds: 30
`

type CatalogSurface = Pick<
  WorkflowCatalog,
  'readSource' | 'validateAndCompile' | 'compileDefinition' | 'create' | 'save' | 'remove'
>

interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

interface Harness {
  readonly ctx: never
  readonly routes: Map<string, CapturedRoute>
  readonly effectLabels: readonly string[]
  readonly disposeAll: () => Promise<void>
}

function harness(catalog: CatalogSurface): Harness {
  const routes = new Map<string, CapturedRoute>()
  const effectLabels: string[] = []
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    workflowCatalog: catalog,
    effect: (factory: () => unknown, label: string): void => {
      effectLabels.push(label)
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => void | Promise<void>)
    },
    connection: {
      fetch: {
        register: (route: CapturedRoute): (() => Promise<void>) => {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
  }
  return {
    ctx: ctx as never,
    routes,
    effectLabels,
    disposeAll: async () => {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-editor-'))
  return run(dir).finally(() => { rmSync(dir, { recursive: true, force: true }) })
}

function route(h: Harness, path: string): CapturedRoute {
  const found = h.routes.get(path)
  assert.ok(found, `missing route ${path}`)
  return found
}

function post(path: string, body: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function sizedDocument(bytes: number): string {
  const header = 'workflow_id: sized\nnodes:\n  - id: only\n    agent: worker\n    role_prompt: ok\n'
  const prefix = `${header}# `
  const remaining = bytes - Buffer.byteLength(prefix, 'utf8')
  assert.ok(remaining >= 0)
  return `${prefix}${'x'.repeat(remaining)}`
}

void test('workflow editor routes：读取原始 YAML 与 digest', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, SOURCE_PATH).fetch(
      new Request(`https://example.test${SOURCE_PATH}?id=log-patrol`),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { text: VALID, digest: digestOf(VALID) })
  })
})

void test('workflow editor routes：非法 id 返回 400，缺失文件仅 ENOENT 返回 404', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const invalid = await route(h, SOURCE_PATH).fetch(
      new Request(`https://example.test${SOURCE_PATH}?id=${encodeURIComponent('../escape')}`),
    )
    assert.equal(invalid.status, 400)

    const missing = await route(h, SOURCE_PATH).fetch(
      new Request(`https://example.test${SOURCE_PATH}?id=missing`),
    )
    assert.equal(missing.status, 404)
  })
})

void test('workflow editor routes：实时校验返回 issue 和可绘制的分层依赖', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
    const catalog = new WorkflowCatalog(dir)
    const h = harness(catalog)
    registerWorkflowEditorRoutes(h.ctx)

    const ok = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text: VALID }))
    assert.equal(ok.status, 200)
    const payload = await ok.json() as {
      ok: boolean
      issues: unknown[]
      nodes: {
        id: string
        type: string
        level: number
        agentRef?: string
        rolePrompt: string
        after: string[]
        outputs: Record<string, string[]>
        inputs: string[]
        timeoutMs?: number
      }[]
      edges: { from: string; to: string }[]
      dataEdges: { from: string; to: string; port: string }[]
      compiled: {
        source: string
        layers: string[][]
        digest: string
      }
    }
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.nodes, [
      {
        id: 'scan',
        type: 'agent',
        level: 0,
        agentRef: 'log_analyst',
        rolePrompt: 'scan logs',
        after: [],
        outputs: {},
        inputs: [],
      },
      {
        id: 'report',
        type: 'agent',
        level: 1,
        agentRef: 'log_analyst',
        rolePrompt: 'write report',
        after: ['scan'],
        outputs: {},
        inputs: [],
        timeoutMs: 30_000,
      },
    ])
    assert.deepEqual(payload.edges, [{ from: 'scan', to: 'report' }])
    assert.deepEqual(payload.dataEdges, [])
    const compiled = await catalog.compile('log-patrol')
    if (!compiled.ok) throw new Error('expected the valid workflow to compile')
    assert.deepEqual(payload.compiled, compiled.value)

    const withData = VALID.replace(
      '    role_prompt: scan logs',
      '    role_prompt: scan logs\n    outputs:\n      records: report',
    )
    const dataResponse = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text: withData }))
    assert.equal(dataResponse.status, 200)
    const dataPayload = await dataResponse.json() as {
      dataEdges: { from: string; to: string; port: string }[]
    }
    assert.deepEqual(dataPayload.dataEdges, [{ from: 'scan', to: 'report', port: 'records' }])

    const cyclic = VALID.replace(
      '    role_prompt: scan logs',
      '    role_prompt: scan logs\n    after: [report]',
    )
    const invalid = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text: cyclic }))
    assert.equal(invalid.status, 422)
    const issues = await invalid.json() as {
      ok: boolean
      issues: { kind?: string; nodeIds?: string[] }[]
      compiled?: unknown
    }
    assert.equal(issues.ok, false)
    assert.equal('compiled' in issues, false)
    const cycle = issues.issues.find(issue => issue.kind === 'cycle')
    assert.ok(cycle)
    assert.deepEqual(cycle.nodeIds?.slice().sort(), ['report', 'scan'])
  })
})

void test('workflow editor routes：校验正文恰好 1 MiB 可接受，超过 1 个字节返回 413', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const exact = sizedDocument(MAX_SOURCE_BYTES)
    assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_SOURCE_BYTES)
    const accepted = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text: exact }))
    assert.equal(accepted.status, 200)

    const over = `${exact}x`
    const rejected = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text: over }))
    assert.equal(rejected.status, 413)
  })
})

void test('workflow editor routes：大小限制按 UTF-8 字节而非字符数', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const prefix = 'workflow_id: multibyte\nnodes:\n  - id: only\n    agent: worker\n    role_prompt: ok\n# '
    const repetitions = Math.ceil((MAX_SOURCE_BYTES - Buffer.byteLength(prefix, 'utf8')) / Buffer.byteLength('中', 'utf8'))
    const text = `${prefix}${'中'.repeat(repetitions)}`
    assert.ok(text.length < MAX_SOURCE_BYTES)
    assert.ok(Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES)

    const response = await route(h, VALIDATE_PATH).fetch(post(VALIDATE_PATH, { text }))
    assert.equal(response.status, 413)
  })
})

void test('workflow editor routes：原子创建成功且绝不覆盖已有文件', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)
    const file = join(dir, 'log-patrol.yaml')

    const created = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'log-patrol',
      text: VALID,
    }))
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { digest: digestOf(VALID) })
    assert.equal(readFileSync(file, 'utf8'), VALID)

    const changed = VALID.replace('scan logs', 'must not overwrite')
    const conflict = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'log-patrol',
      text: changed,
    }))
    assert.equal(conflict.status, 409)
    assert.equal(readFileSync(file, 'utf8'), VALID)
  })
})

void test('workflow editor routes：创建请求严格校验字段、ID 与 UTF-8 大小', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const missing = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, { workflowId: 'demo' }))
    assert.equal(missing.status, 400)
    const extra = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'demo',
      text: VALID,
      expectedDigest: null,
    }))
    assert.equal(extra.status, 400)
    const invalidId = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: '../escape',
      text: VALID,
    }))
    assert.equal(invalidId.status, 400)

    const oversized = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'log-patrol',
      text: `${VALID}${'x'.repeat(MAX_SOURCE_BYTES)}`,
    }))
    assert.equal(oversized.status, 413)
  })
})

void test('workflow editor routes：创建时 YAML 或内嵌 ID 非法返回 422', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const invalidYaml = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'log-patrol',
      text: 'workflow_id: log-patrol\nnodes: []\n',
    }))
    assert.equal(invalidYaml.status, 422)
    const wrongId = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'another',
      text: VALID,
    }))
    assert.equal(wrongId.status, 422)
  })
})

void test('workflow editor routes：创建未知错误返回通用 500，不泄漏路径', async () => {
  await withDir(async (dir) => {
    const secret = join(dir, 'secret-create.yaml')
    const catalog: CatalogSurface = {
      readSource: async () => { throw new Error('unused') },
      validateAndCompile: () => { throw new Error('unused') },
      compileDefinition: () => { throw new Error('unused') },
      create: async () => { throw Object.assign(new Error(`EACCES ${secret}`), { code: 'EACCES' }) },
      save: async () => { throw new Error('unused') },
      remove: async () => { throw new Error('unused') },
    }
    const h = harness(catalog)
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, CREATE_PATH).fetch(post(CREATE_PATH, {
      workflowId: 'log-patrol',
      text: VALID,
    }))
    assert.equal(response.status, 500)
    const body = await response.text()
    assert.doesNotMatch(body, /EACCES|secret-create/)
  })
})

void test('workflow editor routes：画布操作返回回写文本、校验 issue 和两类边', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const withoutSchedule = VALID.replace('    after: [scan]\n', '')
    const response = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      text: withoutSchedule,
      operation: {
        kind: 'add-schedule-edge',
        from: 'scan',
        to: 'report',
      },
    }))
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      ok: boolean
      text: string
      issues: unknown[]
      nodes: {
        id: string
        type: string
        level: number
        agentRef?: string
        rolePrompt: string
        after: string[]
        outputs: Record<string, string[]>
        inputs: string[]
        timeoutMs?: number
      }[]
      edges: { from: string; to: string }[]
      dataEdges: { from: string; to: string; port: string }[]
      compiled: {
        source: string
        layers: string[][]
        digest: string
      }
    }
    assert.equal(payload.ok, true)
    assert.match(payload.text, /after: \[scan\]/)
    assert.deepEqual(payload.nodes.map(node => ({
      id: node.id,
      level: node.level,
      agentRef: node.agentRef,
      rolePrompt: node.rolePrompt,
      after: node.after,
      inputs: node.inputs,
      timeoutMs: node.timeoutMs,
    })), [
      {
        id: 'scan',
        level: 0,
        agentRef: 'log_analyst',
        rolePrompt: 'scan logs',
        after: [],
        inputs: [],
        timeoutMs: undefined,
      },
      {
        id: 'report',
        level: 1,
        agentRef: 'log_analyst',
        rolePrompt: 'write report',
        after: ['scan'],
        inputs: [],
        timeoutMs: 30_000,
      },
    ])
    assert.deepEqual(payload.edges, [{ from: 'scan', to: 'report' }])
    assert.deepEqual(payload.dataEdges, [])
    assert.deepEqual(payload.compiled.layers, [['scan'], ['report']])
    assert.match(payload.compiled.source, /generated from workflow log-patrol/)
  })
})

void test('workflow editor routes：编辑请求严格校验顶层与 operation 字段', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const extraTopLevel = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      text: VALID,
      operation: { kind: 'remove-node', id: 'scan' },
      extra: true,
    }))
    assert.equal(extraTopLevel.status, 400)

    const extraOperationField = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      text: VALID,
      operation: { kind: 'remove-node', id: 'scan', extra: true },
    }))
    assert.equal(extraOperationField.status, 400)

    const missingText = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      operation: { kind: 'remove-node', id: 'scan' },
    }))
    assert.equal(missingText.status, 400)
  })
})

void test('workflow editor routes：编辑后成环返回 422 与结构化 issue', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      text: VALID,
      operation: {
        kind: 'add-schedule-edge',
        from: 'report',
        to: 'scan',
      },
    }))
    assert.equal(response.status, 422)
    const payload = await response.json() as {
      ok: boolean
      issues: { kind?: string; path: string; message: string }[]
      compiled?: unknown
    }
    assert.equal(payload.ok, false)
    assert.equal('compiled' in payload, false)
    assert.ok(payload.issues.some(issue => issue.kind === 'cycle'))
  })
})

void test('workflow editor routes：编辑正文超过 1 MiB 返回 413', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const text = `${VALID}${'x'.repeat(MAX_SOURCE_BYTES)}`
    const response = await route(h, EDIT_PATH).fetch(post(EDIT_PATH, {
      text,
      operation: { kind: 'remove-node', id: 'scan' },
    }))
    assert.equal(response.status, 413)
  })
})

void test('workflow editor routes：保存写回原始草稿且 CAS 冲突不改盘', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'log-patrol.yaml')
    writeFileSync(file, VALID, 'utf8')
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const edited = `${VALID}\n# user formatting stays exactly as typed\n`
    const saved = await route(h, SAVE_PATH).fetch(post(SAVE_PATH, {
      workflowId: 'log-patrol',
      text: edited,
      expectedDigest: digestOf(VALID),
    }))
    assert.equal(saved.status, 200)
    assert.deepEqual(await saved.json(), { digest: digestOf(edited) })
    assert.equal(readFileSync(file, 'utf8'), edited)

    const stale = await route(h, SAVE_PATH).fetch(post(SAVE_PATH, {
      workflowId: 'log-patrol',
      text: VALID,
      expectedDigest: digestOf(VALID),
    }))
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), { actualDigest: digestOf(edited) })
    assert.equal(readFileSync(file, 'utf8'), edited)
  })
})

void test('workflow editor routes：保存校验失败返回 422，草稿由调用方保留', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, SAVE_PATH).fetch(post(SAVE_PATH, {
      workflowId: 'log-patrol',
      text: 'workflow_id: log-patrol\nnodes: []\n',
      expectedDigest: null,
    }))
    assert.equal(response.status, 422)
    const payload = await response.json() as { issues: unknown[] }
    assert.ok(payload.issues.length > 0)
  })
})

void test('workflow editor routes：非法请求返回 400', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const malformed = await route(h, VALIDATE_PATH).fetch(new Request(`https://example.test${VALIDATE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }))
    assert.equal(malformed.status, 400)

    const missing = await route(h, SAVE_PATH).fetch(post(SAVE_PATH, { text: VALID, expectedDigest: null }))
    assert.equal(missing.status, 400)

    const wrongType = await route(h, SAVE_PATH).fetch(post(SAVE_PATH, {
      workflowId: 'log-patrol',
      text: VALID,
      expectedDigest: 42,
    }))
    assert.equal(wrongType.status, 400)
  })
})

void test('workflow editor routes：未知文件系统错误返回通用 500，不泄漏路径', async () => {
  await withDir(async (dir) => {
    const secret = join(dir, 'secret-path.yaml')
    const catalog: CatalogSurface = {
      readSource: async () => { throw Object.assign(new Error(`EACCES ${secret}`), { code: 'EACCES' }) },
      validateAndCompile: () => { throw new Error('unused') },
      compileDefinition: () => { throw new Error('unused') },
      create: async () => { throw new Error('unused') },
      save: async () => { throw new Error('unused') },
      remove: async () => { throw new Error('unused') },
    }
    const h = harness(catalog)
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, SOURCE_PATH).fetch(
      new Request(`https://example.test${SOURCE_PATH}?id=log-patrol`),
    )
    assert.equal(response.status, 500)
    const body = await response.text()
    assert.match(body, /internal server error/i)
    assert.doesNotMatch(body, /secret-path|EACCES/)
  })
})

void test('workflow editor routes：注册通过 effect 管理，并随插件释放撤回', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    assert.deepEqual(h.effectLabels, [
      'agentops-dag: /api/agentops/workflow-source',
      'agentops-dag: /api/agentops/workflow-validate',
      'agentops-dag: /api/agentops/workflow-create',
      'agentops-dag: /api/agentops/workflow-save',
      'agentops-dag: /api/agentops/workflow-edit',
      'agentops-dag: /api/agentops/workflow-delete',
    ])
    assert.equal(h.routes.size, 6)
    await h.disposeAll()
    assert.equal(h.routes.size, 0)
  })
})

void test('workflow editor routes：删除只提交 workflowId 并移除对应文件', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'log-patrol.yaml')
    writeFileSync(file, VALID, 'utf8')
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const response = await route(h, DELETE_PATH).fetch(post(DELETE_PATH, { workflowId: 'log-patrol' }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.throws(() => readFileSync(file))
  })
})

void test('workflow editor routes：删除非法请求与非法 id 返回 400', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)

    const missing = await route(h, DELETE_PATH).fetch(post(DELETE_PATH, {}))
    assert.equal(missing.status, 400)
    const extra = await route(h, DELETE_PATH).fetch(post(DELETE_PATH, {
      workflowId: 'log-patrol',
      unexpected: true,
    }))
    assert.equal(extra.status, 400)
    const invalid = await route(h, DELETE_PATH).fetch(post(DELETE_PATH, { workflowId: '../escape' }))
    assert.equal(invalid.status, 400)
  })
})

void test('workflow editor routes：删除缺失文件返回 404，其他错误返回 500', async () => {
  await withDir(async (dir) => {
    const h = harness(new WorkflowCatalog(dir))
    registerWorkflowEditorRoutes(h.ctx)
    const missing = await route(h, DELETE_PATH).fetch(post(DELETE_PATH, { workflowId: 'missing' }))
    assert.equal(missing.status, 404)

    const secret = join(dir, 'secret-path.yaml')
    const catalog: CatalogSurface = {
      readSource: async () => { throw new Error('unused') },
      validateAndCompile: () => { throw new Error('unused') },
      compileDefinition: () => { throw new Error('unused') },
      create: async () => { throw new Error('unused') },
      save: async () => { throw new Error('unused') },
      remove: async () => { throw Object.assign(new Error(`EACCES ${secret}`), { code: 'EACCES' }) },
    }
    const failed = harness(catalog)
    registerWorkflowEditorRoutes(failed.ctx)
    const response = await route(failed, DELETE_PATH).fetch(post(DELETE_PATH, { workflowId: 'log-patrol' }))
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /secret-path|EACCES/)
  })
})
