import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createPresentContentTool, detectSurfaceImageMediaType, MAX_COMPONENTS, registerSurfaceRoutes, SurfaceStore, surfaceImageUrl, validateSurfaceEnvelope } from '../src/surfaces.ts'

const CATALOG = 'https://agentops.dev/a2ui/catalogs/core/v1'

type ToolResult = Record<string, unknown>

interface RunnableTool {
  execute: (args: Record<string, unknown>, exec?: Record<string, unknown>) => Promise<ToolResult>
}

const runnable = (tool: unknown): RunnableTool => ({
  execute: (args, exec = {}) => (tool as { execute: (a: never, e: never) => Promise<ToolResult> })
    .execute(args as never, exec as never),
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)


function textSurface(text: string): Record<string, unknown> {
  return { version: 'v1.0', catalogId: CATALOG, components: [{ id: 'root', component: 'Text', text }] }
}

function withStore(run: (store: SurfaceStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-surface-'))
  const store = new SurfaceStore(join(dir, 'surfaces.db'))
  return run(store).finally(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

void test('校验：合法 envelope 通过，版本/目录不符被拒', () => {
  const ok = validateSurfaceEnvelope({ version: 'v1.0', catalogId: CATALOG, components: [{ id: 'root', component: 'Text', text: 'hi' }] })
  assert.equal(ok.ok, true)

  const badVersion = validateSurfaceEnvelope({ version: 'v2', catalogId: CATALOG, components: [] })
  assert.equal(badVersion.ok, false)

  const badCatalog = validateSurfaceEnvelope({ version: 'v1.0', catalogId: 'x', components: [] })
  assert.equal(badCatalog.ok, false)

  const tooMany = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: Array.from({ length: MAX_COMPONENTS + 1 }, () => ({ id: 'x', component: 'Text', text: 't' })),
  })
  assert.equal(tooMany.ok, false)
})

void test('present_content：写入后能读到最新一条，含 content 数据模型', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({
      title: '周报',
      surface: {
        version: 'v1.0',
        catalogId: CATALOG,
        components: [{ id: 'root', component: 'Text', text: 'hi' }],
      },
      content: { bar: [{ label: 'a', value: 1 }] },
    })
    assert.equal(result.stored, true)
    assert.equal(result.components, 1)

    const latest = store.latest()
    assert.equal(latest?.title, '周报')
    assert.deepEqual(latest?.content, { bar: [{ label: 'a', value: 1 }] })
  })
})

void test('present_content：非法 surface 不落库，只回原因', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({ title: '坏数据', surface: { version: 'v9', catalogId: CATALOG, components: [] } })
    assert.equal(result.stored, false)
    assert.ok(typeof result.reason === 'string' && (result.reason).length > 0)
    assert.equal(store.latest(), null)
  })
})

void test('校验：组件缺 component 名被拒，并指出位置与收到的值', () => {
  const missing = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 'root', type: 'Text' }],
  })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.match(missing.reason, /component/)
  }
})

void test('校验：props 包裹与未知组件都被拒，原因可行动', () => {
  const wrapped = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 'm1', component: 'AoMetric', props: { label: 'a', value: '1' } }],
  })
  assert.equal(wrapped.ok, false)
  if (!wrapped.ok) assert.match(wrapped.reason, /props/)

  const unknown = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 'x', component: 'FancyChart' }],
  })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.reason, /不认识/)
})

void test('契约：Text.variant 只认 caption/body，指错即拒并给出字段名', () => {
  const bad = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 't1', component: 'Text', text: 'hi', variant: 'h2' }],
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /variant/)
})

void test('契约：图表必须有 source 与指针，children 不能悬空', () => {
  const noSource = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 'bar', component: 'AoBarChart', itemLabelPath: '/label', itemValuePath: '/value' }],
  })
  assert.equal(noSource.ok, false)
  if (!noSource.ok) assert.match(noSource.reason, /schema 不通过/)

  const dangling = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [{ id: 'root', component: 'AoSection', children: ['m1', 'ghost'] }, { id: 'm1', component: 'AoMetric', label: 'a', value: '1' }],
  })
  assert.equal(dangling.ok, false)
  if (!dangling.ok) assert.match(dangling.reason, /schema 不通过/)
})

void test('契约：合法 surface 通过（含图表绑定）', () => {
  const ok = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [
      { id: 'root', component: 'AoSection', title: '概览', tone: 'info', children: ['m1', 'bar'] },
      { id: 'm1', component: 'AoMetric', label: '总数', value: '42', unit: '个', tone: 'positive' },
      { id: 'bar', component: 'AoBarChart', source: { path: '/bar' }, itemLabelPath: '/label', itemValuePath: '/value' },
    ],
  })
  assert.equal(ok.ok, true)
})

void test('契约：AoGrid.columns 必须是对象，数字会被拒', () => {
  const numeric = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [
      { id: 'root', component: 'AoSection', children: ['g'] },
      { id: 'g', component: 'AoGrid', columns: 3, children: ['m1'] },
      { id: 'm1', component: 'AoMetric', label: 'a', value: '1' },
    ],
  })
  assert.equal(numeric.ok, false)
  if (!numeric.ok) assert.match(numeric.reason, /schema 不通过/)

  const shaped = validateSurfaceEnvelope({
    version: 'v1.0',
    catalogId: CATALOG,
    components: [
      { id: 'root', component: 'AoSection', children: ['g'] },
      { id: 'g', component: 'AoGrid', columns: { default: 3, compact: 1 }, children: ['m1'] },
      { id: 'm1', component: 'AoMetric', label: 'a', value: '1' },
    ],
  })
  assert.equal(shaped.ok, true)
})

void test('图片资产：按字节识别光栅格式并以 SHA-256 内容寻址', async () => {
  await withStore(async (store) => {
    assert.equal(detectSurfaceImageMediaType(PNG), 'image/png')
    const asset = store.putImage(PNG, 'image/png', '2026-11-27T00:00:00.000Z')
    assert.match(asset.digest, /^[a-f0-9]{64}$/)
    assert.equal(asset.bytes, PNG.byteLength)
    assert.deepEqual(Buffer.from(store.image(asset.digest)?.data ?? []), PNG)
    assert.equal(store.image('../escape'), null)
    store.put({
      version: 'v1.0',
      catalogId: CATALOG,
      components: [
        { id: 'root', component: 'Image', url: surfaceImageUrl(asset.digest), variant: 'largeFeature' },
      ],
    }, { title: 'image' })
    assert.ok(store.image(asset.digest) !== null)
    store.clear()
    assert.equal(store.image(asset.digest), null)
  })
})

void test('图片路由：只在摘要命中时返回存储字节和不可变缓存头', async () => {
  await withStore(async (store) => {
    const asset = store.putImage(PNG, 'image/png')
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const ctx = {
      effect: (factory: () => unknown) => { factory(); return () => {} },
      connection: {
        fetch: {
          register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
            routes.set(route.path, route.fetch)
            return async () => {}
          },
        },
      },
    }
    registerSurfaceRoutes(ctx as never, store)
    const route = routes.get('/api/agentops/surfaces/asset')
    assert.ok(route !== undefined)
    const found = await route(new Request(`http://localhost/api/agentops/surfaces/asset?digest=${asset.digest}`))
    assert.equal(found.status, 200)
    assert.equal(found.headers.get('content-type'), 'image/png')
    assert.equal(found.headers.get('cache-control'), 'private, max-age=31536000, immutable')
    assert.deepEqual(Buffer.from(await found.arrayBuffer()), PNG)
    const missing = await route(new Request('http://localhost/api/agentops/surfaces/asset?digest=missing'))
    assert.equal(missing.status, 404)
  })
})

void test('present_content image：安全图片 URL 发布成可渲染的图片卡片', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({
      title: '页面截图',
      content_type: 'image',
      data: { source: 'https://example.com/shot.png', caption: '登录页' },
      viewId: 'shot',
    })
    assert.equal(result.stored, true)
    const latest = store.latest()
    assert.equal(latest?.viewId, 'shot')
    const surface = latest?.surface as { components: { component: string; url?: string }[] }
    const image = surface.components.find(component => component.component === 'Image')
    assert.equal(image?.url, 'https://example.com/shot.png')
  })
})

void test('present_content image：工作区路径经过 fs 读取并转成面板图片 URL', async () => {
  await withStore(async (store) => {
    const fakeFs = {
      resolve: (path: string) => Promise.resolve({ targetKey: 'image-target', displayPath: path }),
      stat: () => Promise.resolve({ type: 'file' }),
      readBytes: () => Promise.resolve(PNG),
    }
    const ctx = {
      get: (name: string) => name === 'fs' ? fakeFs : undefined,
    }
    const tool = runnable(createPresentContentTool(ctx as never, store))
    const result = await tool.execute(
      { title: '本地截图', content_type: 'image', data: { source: 'tmp/shot.png' } },
      { signal: new AbortController().signal },
    )
    assert.equal(result.stored, true)
    const latest = store.latest()
    const surface = latest?.surface as { components: { component: string; url?: string }[] }
    const image = surface.components.find(component => component.component === 'Image')
    assert.match(image?.url ?? '', /^\/api\/agentops\/surfaces\/asset\?digest=[a-f0-9]{64}$/)
  })
})

void test('present_content image：latest-screenshot 读取同一 Session 的截图附件', async () => {
  await withStore(async (store) => {
    const ref = {
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
    }
    const events = [
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-shot', name: 'mcp__playwright-mcp__browser_take_screenshot', arguments: '{}' },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'call-shot', content: [{ type: 'image', attachment: ref }] },
        },
      },
    ]
    const ctx = {
      get: (name: string) => {
        if (name === 'attachments') return { readImage: () => Promise.resolve({ ref, data: PNG }) }
        if (name === 'sessionQuery') {
          return {
            observeSession: () => Promise.resolve({
              events,
              [Symbol.dispose]: () => {},
            }),
          }
        }
        return undefined
      },
    }
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-1', header: { cwd: 'C:/work' } } },
    }
    const tool = runnable(createPresentContentTool(ctx as never, store))
    const result = await tool.execute({ title: '最新截图', content_type: 'image', data: {} }, exec)
    assert.equal(result.stored, true)
    const latest = store.latest()
    const surface = latest?.surface as { components: { component: string; url?: string }[] }
    const image = surface.components.find(component => component.component === 'Image')
    assert.match(image?.url ?? '', /^\/api\/agentops\/surfaces\/asset\?digest=[a-f0-9]{64}$/)
  })
})

void test('present_content image：latest-screenshot 解析 Chrome DevTools 保存的临时文件路径', async () => {
  await withStore(async (store) => {
    const screenshotPath = 'C:\\Users\\tester\\AppData\\Local\\Temp\\chrome-devtools-mcp\\oa-login-qr.png'
    const events = [
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-shot', name: 'mcp__chrome-devtools-mcp__take_screenshot', arguments: '{}' },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'call-shot',
            content: [{
              type: 'text',
              text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${screenshotPath}.`,
            }],
          },
        },
      },
    ]
    let resolvedPath = ''
    const ctx = {
      get: (name: string) => {
        if (name === 'sessionQuery') {
          return {
            observeSession: () => Promise.resolve({
              events,
              [Symbol.dispose]: () => {},
            }),
          }
        }
        if (name === 'fs') {
          return {
            resolve: (path: string) => {
              resolvedPath = path
              return Promise.resolve({ targetKey: 'image-target', displayPath: path })
            },
            stat: () => Promise.resolve({ type: 'file' }),
            readBytes: () => Promise.resolve(PNG),
          }
        }
        return undefined
      },
    }
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-1', header: { cwd: 'C:/work' } } },
    }
    const tool = runnable(createPresentContentTool(ctx as never, store))
    const result = await tool.execute({ title: 'Chrome 截图', content_type: 'image', data: {} }, exec)
    assert.equal(result.stored, true)
    assert.equal(resolvedPath, screenshotPath)
    const surface = store.latest()?.surface as { components: { component: string; url?: string }[] }
    const image = surface.components.find(component => component.component === 'Image')
    assert.match(image?.url ?? '', /^\/api\/agentops\/surfaces\/asset\?digest=[a-f0-9]{64}$/)
  })
})

void test('present_content：兼容模型传成 JSON 字符串的 image data', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({
      title: 'JSON 字符串图片数据',
      content_type: 'image',
      data: JSON.stringify({ source: 'https://example.com/shot.png', caption: '截图' }),
      viewId: 'image-json-string',
    })
    assert.equal(result.stored, true)
    const surface = store.latest()?.surface as { components: { component: string; url?: string }[] }
    const image = surface.components.find(component => component.component === 'Image')
    assert.equal(image?.url, 'https://example.com/shot.png')
  })
})

void test('present_content：兼容模型传成 JSON 字符串的 table data', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({
      title: 'JSON 字符串表格数据',
      content_type: 'table',
      data: JSON.stringify({
        columns: [{ id: 'title', label: '事项', path: '/title' }],
        rows: [{ title: '待办 A' }],
      }),
      viewId: 'table-json-string',
    })
    assert.equal(result.stored, true)
  })
})

void test('present_content：兼容模型传成 JSON 字符串的 surface 与 content', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const result = await tool.execute({
      title: 'JSON 字符串逃生通道',
      viewId: 'surface-json-string',
      surface: JSON.stringify({
        version: 'v1.0',
        catalogId: CATALOG,
        components: [{ id: 'root', component: 'Text', text: 'hello' }],
      }),
      content: JSON.stringify({ answer: 42 }),
    })
    assert.equal(result.stored, true)
    assert.deepEqual(store.latest()?.content, { answer: 42 })
  })
})

void test('清理：invalidIds 找出缺组件名的行，remove 只删指定的那条', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    await tool.execute({
      title: 'good',
      surface: { version: 'v1.0', catalogId: CATALOG, components: [{ id: 'root', component: 'Text', text: 'hi' }] },
    })
    // 直接写库模拟历史坏数据（绕过校验）
    store.put({ version: 'v1.0', catalogId: CATALOG, components: [{ id: 'root', type: 'Text' }] }, { title: 'bad', viewId: 'bad' })

    const invalid = store.invalidIds()
    assert.equal(invalid.length, 1)
    assert.equal(store.remove(invalid[0]!), true)
    assert.equal(store.invalidIds().length, 0)
    assert.equal(store.list().length, 1)
  })
})

void test('看板：同 viewId 就地替换，不同 viewId 新增卡片', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const surface = (text: string) => ({
      version: 'v1.0',
      catalogId: CATALOG,
      components: [{ id: 'root', component: 'Text', text }],
    })

    await tool.execute({ title: '概览 v1', viewId: 'overview', surface: surface('a') })
    await tool.execute({ title: '趋势', viewId: 'trend', surface: surface('b') })
    assert.deepEqual(store.views().map(row => row.viewId).sort(), ['overview', 'trend'])

    await tool.execute({ title: '概览 v2', viewId: 'overview', surface: surface('c') })
    const views = store.views()
    assert.equal(views.length, 2, '同 id 不应新增卡片')
    const overview = views.find(row => row.viewId === 'overview')
    assert.equal(overview?.title, '概览 v2')
    assert.equal(store.list(500).length, 2)
  })
})

void test('看板顺序：新卡片追加在末尾，重发同 viewId 保持位置', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool({ get: () => undefined } as never, store))
    const surface = (text: string) => textSurface(text)
    await tool.execute({ title: 'A', viewId: 'a', surface: surface('a') })
    await tool.execute({ title: 'B', viewId: 'b', surface: surface('b') })
    await tool.execute({ title: 'C', viewId: 'c', surface: surface('c') })
    assert.deepEqual(store.views().map(row => row.viewId), ['a', 'b', 'c'])
    await tool.execute({ title: 'A2', viewId: 'a', surface: surface('a2') })
    assert.deepEqual(store.views().map(row => row.viewId), ['a', 'b', 'c'], '重发不能把卡片移到末尾')
    assert.deepEqual(store.views().map(row => row.order), [0, 1, 2])
  })
})

void test('看板重排：按传入的完整顺序写回并持久化', async () => {
  await withStore(async (store) => {
    for (const id of ['a', 'b', 'c', 'd']) {
      store.put({
        version: 'v1.0',
        catalogId: CATALOG,
        components: [{ id: 'root', component: 'Text', text: id }],
      }, { title: id, viewId: id })
    }
    assert.equal(store.reorder(['d', 'b', 'a', 'c']), true)
    assert.deepEqual(store.views().map(row => row.viewId), ['d', 'b', 'a', 'c'])
    assert.deepEqual(store.views().map(row => row.order), [0, 1, 2, 3])
    // A partial or duplicated sequence must be rejected without touching the board.
    assert.equal(store.reorder(['a', 'b']), false)
    assert.equal(store.reorder(['a', 'b', 'c', 'c']), false)
    assert.equal(store.reorder(['a', 'b', 'c', 'x']), false)
    assert.deepEqual(store.views().map(row => row.viewId), ['d', 'b', 'a', 'c'])
  })
})

void test('看板重排路由：校验参数并把成功/失败映射为 ok', async () => {
  await withStore(async (store) => {
    for (const id of ['a', 'b', 'c']) {
      store.put({
        version: 'v1.0',
        catalogId: CATALOG,
        components: [{ id: 'root', component: 'Text', text: id }],
      }, { title: id, viewId: id })
    }
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const ctx = {
      effect: (factory: () => unknown) => { factory(); return () => {} },
      connection: {
        fetch: {
          register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
            routes.set(route.path, route.fetch)
            return async () => {}
          },
        },
      },
    }
    registerSurfaceRoutes(ctx as never, store)
    const route = routes.get('/api/agentops/surfaces/reorder')
    assert.ok(route !== undefined)
    const post = (body: unknown) => route(new Request('http://localhost/api/agentops/surfaces/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    const missing = await post({})
    assert.equal(missing.status, 400)
    assert.equal((await missing.json() as { reason: string }).reason, '需要 viewIds 数组')
    const nonString = await post({ viewIds: ['a', 3] })
    assert.equal(nonString.status, 400)
    const bad = await post({ viewIds: ['a', 'b'] })
    assert.deepEqual(await bad.json(), { ok: false })
    const moved = await post({ viewIds: ['c', 'a', 'b'] })
    assert.deepEqual(await moved.json(), { ok: true })
    assert.deepEqual(store.views().map(row => row.viewId), ['c', 'a', 'b'])
  })
})

void test('旧库迁移：缺少 sort_order 时按 id 回填并保持可移动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-surface-legacy-'))
  const file = join(dir, 'surfaces.db')
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE surfaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        view_id TEXT NOT NULL DEFAULT 'main',
        session_id TEXT,
        title TEXT NOT NULL,
        surface_json TEXT NOT NULL,
        content_json TEXT,
        created_at TEXT NOT NULL
      );
    `)
    const surface = JSON.stringify({
      version: 'v1.0',
      catalogId: CATALOG,
      components: [{ id: 'root', component: 'Text', text: 'x' }],
    })
    const insert = legacy.prepare(
      'INSERT INTO surfaces (view_id, session_id, title, surface_json, content_json, created_at) VALUES (?, NULL, ?, ?, NULL, ?)',
    )
    insert.run('a', 'a', surface, '2026-11-01T00:00:00.000Z')
    insert.run('b', 'b', surface, '2026-11-02T00:00:00.000Z')
    legacy.close()

    const store = new SurfaceStore(file)
    try {
      assert.deepEqual(store.views().map(row => row.viewId), ['a', 'b'])
      assert.deepEqual(store.views().map(row => row.order), [1, 2])
      assert.equal(store.reorder(['b', 'a']), true)
      assert.deepEqual(store.views().map(row => row.viewId), ['b', 'a'])
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
