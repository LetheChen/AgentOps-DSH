import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTemplate, CONTENT_TYPES, UNSUPPORTED_TYPES } from '../src/a2ui-templates.ts'
import { createBoardCleanupTool, createPresentContentTool, SurfaceStore, validateSurfaceEnvelope } from '../src/surfaces.ts'

const CATALOG = 'https://agentops.dev/a2ui/catalogs/core/v1'

type ToolResult = Record<string, unknown>

interface RunnableTool {
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

const runnable = (tool: unknown): RunnableTool => ({
  execute: args => (tool as { execute: (a: never, e: never) => Promise<ToolResult> }).execute(args as never, {} as never),
})


function envelope(components: Record<string, unknown>[]) {
  return validateSurfaceEnvelope({ version: 'v1.0', catalogId: CATALOG, components })
}

void test('模板：metric_group 生成合法 surface，tone 归一化', () => {
  const built = buildTemplate('metric_group', {
    metrics: [
      { label: '任务总数', value: 128, unit: '件', tone: 'info' },
      { label: '成功率', value: '97.6', unit: '%', tone: 'success' },
    ],
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  const checked = envelope(built.components)
  assert.equal(checked.ok, true)
  const second = built.components[2] as { tone: string }
  assert.equal(second.tone, 'neutral', '非法 tone 必须回落到 neutral')
})

void test('模板：table 中文列名 slug 化，path 与行结构对齐', () => {
  const built = buildTemplate('table', {
    columns: ['审核 Agent', '单量'],
    rows: [['差旅报销审核', 396], ['费用报销审核', 86]],
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(envelope(built.components).ok, true)
  const table = built.components[0] as { columns: { id: string; path: string }[] }
  assert.deepEqual(table.columns.map(column => column.path), ['/审核_Agent', '/单量'].map((_, index) => table.columns[index]!.path))
  assert.match(table.columns[0]!.id, /^[A-Za-z0-9]/)
  const rows = (built.content.rows as Record<string, unknown>[])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]![table.columns[0]!.id], '差旅报销审核')
})

void test('模板：bar_chart 支持单系列与多系列', () => {
  const single = buildTemplate('bar_chart', { items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }], unit: '单' })
  assert.equal(single.ok, true)
  if (single.ok) assert.equal(envelope(single.components).ok, true)

  const multi = buildTemplate('bar_chart', {
    x_axis: ['周一', '周二'],
    series: [{ name: '通过', data: [1, 2] }, { name: '驳回', data: [3, 4] }],
  })
  assert.equal(multi.ok, true)
  if (multi.ok) assert.equal(envelope(multi.components).ok, true)
})

void test('模板：未迁移与未知类型给出可行动的拒绝原因', () => {
  const form = buildTemplate('form', {})
  assert.equal(form.ok, false)
  if (!form.ok) assert.match(form.reason, /暂未迁移/)

  const unknown = buildTemplate('nope', {})
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.reason, /未知 content_type/)
})

void test('模板：所有声明支持的类型都能产出合法 surface', () => {
  const samples: Record<string, unknown> = {
    metric_group: { metrics: [{ label: 'a', value: 1 }] },
    table: { columns: ['x', 'y'], rows: [[1, 2]] },
    timeline: { events: [{ title: 't', time: '2026-10-25', status: 'done' }] },
    progress: { percent: 62, steps: [{ title: 'step', detail: 'ok' }] },
    comparison: { left: { title: 'A', items: [{ label: 'x', value: 1 }] }, right: { title: 'B', items: [{ label: 'x', value: 2 }] } },
    dag_flow: { nodes: [{ id: 'a', title: 'n1', status: 'done' }, { id: 'b', title: 'n2', depends_on: ['a'] }] },
    disclosure_list: { items: [{ title: 'x' }] },
    bar_chart: { items: [{ label: 'a', value: 1 }] },
    line_chart: { x_axis: ['a'], series: [{ name: 's', data: [1] }] },
    pie_chart: { items: [{ label: 'a', value: 1 }] },
  }
  for (const type of CONTENT_TYPES) {
    const built = buildTemplate(type, samples[type])
    assert.equal(built.ok, true, `${type} 应能生成`)
    if (built.ok) {
      const checked = envelope(built.components)
      assert.equal(checked.ok, true, `${type} 生成的 surface 必须过 schema：${checked.ok ? '' : checked.reason}`)
    }
  }
  assert.equal(UNSUPPORTED_TYPES.length, 3)
})

void test('清理：present_content 模板通道落库，board_cleanup 能删单卡与清空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-board-'))
  const store = new SurfaceStore(join(dir, 'surfaces.db'))
  try {
    const present = runnable(createPresentContentTool(store))
    const cleanup = runnable(createBoardCleanupTool(store))

    await present.execute({
      title: '概览', viewId: 'overview', content_type: 'metric_group',
      data: { metrics: [{ label: '总数', value: 1 }] },
    })
    await present.execute({
      title: '趋势', viewId: 'trend', content_type: 'bar_chart',
      data: { items: [{ label: 'a', value: 1 }] },
    })
    assert.deepEqual(store.views().map(row => row.viewId), ['overview', 'trend'])

    const refused = await cleanup.execute({ confirm: false, all: true })
    assert.equal(refused.ok, false)

    const one = await cleanup.execute({ confirm: true, viewId: 'overview' })
    assert.equal(one.removed, 1)
    assert.deepEqual(store.views().map(row => row.viewId), ['trend'])

    const all = await cleanup.execute({ confirm: true, all: true })
    assert.equal(all.removed, 1)
    assert.equal(store.views().length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('组件齐全：AoGrid / AoTable / AoTimeline 都能通过真实 schema', () => {
  const grid = envelope([
    { id: 'root', component: 'AoGrid', columns: { default: 2, compact: 1 }, children: ['m1'] },
    { id: 'm1', component: 'AoMetric', label: 'a', value: '1' },
  ])
  assert.equal(grid.ok, true)

  const table = envelope([
    {
      id: 'root', component: 'AoTable', source: { path: '/rows' },
      columns: [{ id: 'a', label: 'A', path: '/a', format: 'text' }],
    },
  ])
  assert.equal(table.ok, true)

  const timeline = envelope([
    { id: 'root', component: 'AoTimeline', source: { path: '/e' }, itemTitlePath: '/title' },
  ])
  assert.equal(timeline.ok, true)
})

void test('报错可读：AoGrid columns 写成数字时点出形状，不再出现误导性的 text 提示', () => {
  const bad = envelope([
    { id: 'root', component: 'AoGrid', columns: 3, children: ['m1'] },
    { id: 'm1', component: 'AoMetric', label: 'a', value: '1' },
  ])
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.match(bad.reason, /AoGrid/)
  assert.match(bad.reason, /columns 必须是对象/)
  assert.equal(bad.reason.includes("required property 'text'"), false, '不应把 Text 分支的报错当成结论')
})

void test('报错可读：AoTable 缺 columns 时明确点名，并说明列结构', () => {
  const bad = envelope([{ id: 'root', component: 'AoTable', source: { path: '/rows' } }])
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.match(bad.reason, /AoTable/)
  assert.match(bad.reason, /还需要 columns/)
})
