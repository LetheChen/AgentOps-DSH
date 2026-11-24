import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPresentContentTool, MAX_COMPONENTS, SurfaceStore, validateSurfaceEnvelope } from '../src/surfaces.ts'

const CATALOG = 'https://agentops.dev/a2ui/catalogs/core/v1'

type ToolResult = Record<string, unknown>

interface RunnableTool {
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

const runnable = (tool: unknown): RunnableTool => ({
  execute: args => (tool as { execute: (a: never, e: never) => Promise<ToolResult> }).execute(args as never, {} as never),
})


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
    const tool = runnable(createPresentContentTool(store))
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
    const tool = runnable(createPresentContentTool(store))
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

void test('清理：invalidIds 找出缺组件名的行，remove 只删指定的那条', async () => {
  await withStore(async (store) => {
    const tool = runnable(createPresentContentTool(store))
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
    const tool = runnable(createPresentContentTool(store))
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
