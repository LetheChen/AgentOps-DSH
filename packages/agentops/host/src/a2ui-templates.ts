/**
 * `content_type` templates for `present_content`.
 *
 * Ported from the legacy `orchestrator/present_content.py` mappers, adapted to
 * this catalog's field names (AoDag uses `itemLabelPath`, not `itemTitlePath`)
 * and to the generated JSON Schema the renderer validates with. A template that
 * cannot be expressed here is refused by name instead of producing a surface
 * that only degrades — the model then sees a clear "not migrated" reason.
 */

export interface TemplateResult {
  readonly ok: true
  readonly components: Record<string, unknown>[]
  readonly content: Record<string, unknown>
}

/** Reason a `content_type` cannot be turned into a surface. */
export type TemplateFailure = { readonly ok: false; readonly reason: string }

/** The `content_type` values this catalog can render. */
export const CONTENT_TYPES = [
  'metric_group', 'table', 'timeline', 'progress', 'comparison', 'dag_flow',
  'disclosure_list', 'bar_chart', 'line_chart', 'pie_chart',
] as const

/** One of the supported `content_type` values. */
export type ContentType = (typeof CONTENT_TYPES)[number]

/** Types the legacy tool had but this port does not implement yet. */
export const UNSUPPORTED_TYPES = ['media', 'form', 'dashboard'] as const

const TONES = ['neutral', 'info', 'positive', 'warning', 'critical'] as const
type Tone = (typeof TONES)[number]

function toneOf(value: unknown, fallback: Tone = 'neutral'): Tone {
  return TONES.includes(value as Tone) ? value as Tone : fallback
}

function primitiveText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol') return value.toString()
  return undefined
}

function str(value: unknown, fallback = ''): string {
  return primitiveText(value) ?? fallback
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pick(row: unknown, keys: string[], fallback = ''): string {
  if (row === null || typeof row !== 'object') return fallback
  for (const key of keys) {
    const value = primitiveText((row as Record<string, unknown>)[key])
    if (value !== undefined) return value
  }
  return fallback
}

/** A2UI identifier pattern: ^[A-Za-z0-9][A-Za-z0-9._:-]*$ */
function slug(raw: string, index: number): string {
  const text = raw.trim()
  if (text === '') return `col${index}`
  let cleaned = text.replace(/[^A-Za-z0-9._:-]/g, '_')
  if (cleaned === '' || !/^[A-Za-z0-9]/.test(cleaned)) cleaned = `c${cleaned}`
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cleaned) ? cleaned : `col${index}`
}

const FORMATS = new Set(['text', 'number', 'percent', 'datetime', 'duration', 'status', 'tone'])
const FORMAT_ALIASES: Record<string, string> = {
  badge: 'status', tag: 'text', string: 'text', str: 'text', int: 'number',
  float: 'number', date: 'datetime', time: 'datetime',
}

/**
 * Build a surface from a content type and its data.
 * @param type - one of {@link CONTENT_TYPES}.
 * @param data - template-shaped data.
 * @param tone - optional tone applied where the template supports it.
 * @returns the generated surface, or the reason it cannot be generated.
 */
export function buildTemplate(type: string, data: unknown, tone?: unknown): TemplateResult | TemplateFailure {
  if (!CONTENT_TYPES.includes(type as ContentType)) {
    const legacy = UNSUPPORTED_TYPES.includes(type as (typeof UNSUPPORTED_TYPES)[number])
    return {
      ok: false,
      reason: legacy
        ? `content_type「${type}」暂未迁移；可用：${CONTENT_TYPES.join(' / ')}`
        : `未知 content_type「${type}」；可用：${CONTENT_TYPES.join(' / ')}`,
    }
  }
  const source = (data ?? {}) as Record<string, unknown>
  try {
    switch (type as ContentType) {
      case 'metric_group': return metricGroup(source, tone)
      case 'table': return table(source)
      case 'timeline': return timeline(source)
      case 'progress': return progress(source, tone)
      case 'comparison': return comparison(source)
      case 'dag_flow': return dagFlow(source)
      case 'disclosure_list': return disclosureList(source)
      case 'bar_chart': return barChart(source)
      case 'line_chart': return lineChart(source)
      case 'pie_chart': return pieChart(source)
    }
  } catch (reason) {
    return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) }
  }
}

function metricGroup(data: Record<string, unknown>, tone: unknown): TemplateResult {
  const metrics = arrayOf(data.metrics)
  if (metrics.length === 0) throw new Error('metric_group 需要 metrics[]')
  const children = metrics.map((_, index) => `m${index + 1}`)
  return {
    ok: true,
    components: [
      { id: 'root', component: 'AoGrid', columns: { default: Math.min(metrics.length, 3), compact: 1 }, children },
      ...metrics.map((metric, index) => {
        const row = (metric ?? {}) as Record<string, unknown>
        return {
          id: children[index] ?? `m${index + 1}`,
          component: 'AoMetric',
          label: pick(row, ['label', 'name', 'title'], `指标 ${index + 1}`),
          value: str(row.value, '—'),
          ...(row.unit === undefined ? {} : { unit: str(row.unit) }),
          tone: toneOf(row.tone ?? tone),
        }
      }),
    ],
    content: {},
  }
}

function table(data: Record<string, unknown>): TemplateResult {
  const rawColumns = arrayOf(data.columns)
  if (rawColumns.length === 0) throw new Error('table 需要 columns[]')
  const rows = arrayOf(data.rows)
  const sample = rows[0]
  const objectSample = sample !== null && typeof sample === 'object' && !Array.isArray(sample)
    ? sample as Record<string, unknown> : null
  const sampleKeys = objectSample === null ? [] : Object.keys(objectSample)

  const columns = rawColumns.map((column, index) => {
    const label = typeof column === 'string'
      ? column
      : pick(column, ['label', 'title', 'header', 'text', 'name', 'id', 'key', 'field'], `col${index}`)
    const id = slug(label, index)
    const declared = typeof column === 'object' && column !== null
      ? pick(column, ['format', 'type', 'fmt']).toLowerCase() : ''
    const format = FORMAT_ALIASES[declared] ?? declared
    const path = objectSample === null ? `/${id}` : `/${sampleKeys[index] ?? id}`
    return {
      id,
      label,
      path,
      ...(FORMATS.has(format) ? { format } : {}),
    }
  })

  const normalized = rows.map((row) => {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) return row
    if (Array.isArray(row)) {
      const out: Record<string, unknown> = {}
      columns.forEach((column, index) => { out[column.id] = row[index] ?? null })
      return out
    }
    return { [columns[0]?.id ?? '']: row }
  })

  return {
    ok: true,
    components: [{ id: 'root', component: 'AoTable', source: { path: '/rows' }, columns }],
    content: { rows: normalized },
  }
}

function timeline(data: Record<string, unknown>): TemplateResult {
  const events = arrayOf(data.events)
  if (events.length === 0) throw new Error('timeline 需要 events[]')
  return {
    ok: true,
    components: [{
      id: 'root', component: 'AoTimeline',
      source: { path: '/events' },
      itemTitlePath: '/title',
      itemDetailPath: '/detail',
      itemTimePath: '/time',
      itemStatusPath: '/status',
    }],
    content: {
      events: events.map((event, index) => {
        const row = (event ?? {}) as Record<string, unknown>
        return {
          title: pick(row, ['title', 'name', 'label'], `事件 ${index + 1}`),
          detail: pick(row, ['detail', 'description', 'desc']),
          time: pick(row, ['time', 'at', 'timestamp', 'date']),
          status: pick(row, ['status', 'state']),
        }
      }),
    },
  }
}

function progress(data: Record<string, unknown>, tone: unknown): TemplateResult {
  const percent = Number(data.percent ?? data.value ?? 0)
  const steps = arrayOf(data.steps)
  const children = ['p1', ...(steps.length > 0 ? ['s1'] : [])]
  return {
    ok: true,
    components: [
      { id: 'root', component: 'Column', children },
      {
        id: 'p1', component: 'AoProgress',
        label: str(data.label, '总进度'),
        value: Number.isFinite(percent) ? percent : 0,
        tone: toneOf(tone ?? data.tone, 'info'),
      },
      ...(steps.length > 0
        ? [{
          id: 's1', component: 'AoList',
          source: { path: '/steps' }, itemTitlePath: '/title', itemDetailPath: '/detail',
        }]
        : []),
    ],
    content: steps.length > 0
      ? { steps: steps.map((step, index) => ({ title: pick(step, ['title', 'name'], `步骤 ${index + 1}`), detail: pick(step, ['detail', 'description', 'status']) })) }
      : {},
  }
}

function comparison(data: Record<string, unknown>): TemplateResult {
  const left = (data.left ?? {}) as Record<string, unknown>
  const right = (data.right ?? {}) as Record<string, unknown>
  const items = (side: Record<string, unknown>): Record<string, unknown>[] =>
    arrayOf(side.items).map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      return { label: pick(row, ['label', 'name', 'key']), value: str(row.value, '') }
    })
  const columns = [
    { id: 'attr', label: '属性', path: '/label', format: 'text' },
    { id: 'val', label: '值', path: '/value', format: 'text' },
  ]
  return {
    ok: true,
    components: [
      { id: 'root', component: 'Row', children: ['lc', 'rc'] },
      { id: 'lc', component: 'Column', children: ['lt', 'lt1'] },
      { id: 'lt', component: 'Text', text: str(left.title, '左侧'), variant: 'caption' },
      { id: 'lt1', component: 'AoTable', source: { path: '/left_items' }, columns },
      { id: 'rc', component: 'Column', children: ['rt', 'rt1'] },
      { id: 'rt', component: 'Text', text: str(right.title, '右侧'), variant: 'caption' },
      { id: 'rt1', component: 'AoTable', source: { path: '/right_items' }, columns },
    ],
    content: { left_items: items(left), right_items: items(right) },
  }
}

function dagFlow(data: Record<string, unknown>): TemplateResult {
  const nodes = arrayOf(data.nodes)
  if (nodes.length === 0) throw new Error('dag_flow 需要 nodes[]')
  return {
    ok: true,
    components: [{
      id: 'root', component: 'AoDag',
      source: { path: '/nodes' },
      itemIdPath: '/id',
      itemLabelPath: '/label',
      itemStatusPath: '/status',
      itemDependsOnPath: '/depends_on',
    }],
    content: {
      nodes: nodes.map((node, index) => {
        const row = (node ?? {}) as Record<string, unknown>
        return {
          id: pick(row, ['id', 'key'], `n${index + 1}`),
          label: pick(row, ['label', 'title', 'name'], `节点 ${index + 1}`),
          status: pick(row, ['status', 'state']),
          depends_on: arrayOf(row.depends_on ?? row.dependsOn).map(String),
        }
      }),
    },
  }
}

function disclosureList(data: Record<string, unknown>): TemplateResult {
  const items = arrayOf(data.items)
  if (items.length === 0) throw new Error('disclosure_list 需要 items[]')
  const children = items.map((_, index) => `d${index + 1}`)
  const components: Record<string, unknown>[] = [{ id: 'root', component: 'Column', children }]
  const content: Record<string, unknown> = {}
  items.forEach((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>
    const id = children[index] ?? `d${index + 1}`
    components.push({ id: `${id}t`, component: 'Text', text: pick(row, ['title', 'label', 'name'], `条目 ${index + 1}`), variant: 'body' })
    components.push({
      id,
      component: 'AoDisclosure',
      title: pick(row, ['title', 'label', 'name'], `条目 ${index + 1}`),
      children: [`${id}t`],
    })
  })
  return { ok: true, components, content }
}

interface SeriesData {
  x: unknown[]
  series: { name: string; data: unknown[] }[]
  items: { label: string; value: unknown }[]
}

function seriesData(data: Record<string, unknown>): SeriesData {
  const items = arrayOf(data.items).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>
    return { label: pick(row, ['label', 'name', 'key']), value: row.value ?? 0 }
  })
  const x = arrayOf(data.x_axis ?? data.xAxis).map(String)
  const series = arrayOf(data.series).map((entry, index) => {
    const row = (entry ?? {}) as Record<string, unknown>
    return { name: pick(row, ['name', 'label'], `系列 ${index + 1}`), data: arrayOf(row.data) }
  })
  return { x, series, items }
}

function barChart(data: Record<string, unknown>): TemplateResult {
  const { x, series, items } = seriesData(data)
  if (series.length > 0 && x.length > 0) {
    return {
      ok: true,
      components: [{
        id: 'root', component: 'AoBarChart',
        source: { path: '/chart' },
        xAxis: { path: '/x' },
        seriesNamePath: '/name',
        seriesDataPath: '/data',
        ...(data.unit === undefined ? {} : { unit: str(data.unit) }),
      }],
      content: { chart: { x, series }, x, unit: data.unit },
    }
  }
  if (items.length === 0) throw new Error('bar_chart 需要 items[]（单系列）或 x_axis+series（多系列）')
  return {
    ok: true,
    components: [{
      id: 'root', component: 'AoBarChart',
      source: { path: '/items' },
      itemLabelPath: '/label',
      itemValuePath: '/value',
      ...(data.unit === undefined ? {} : { unit: str(data.unit) }),
    }],
    content: { items },
  }
}

function lineChart(data: Record<string, unknown>): TemplateResult {
  const { x, series } = seriesData(data)
  if (x.length === 0 || series.length === 0) throw new Error('line_chart 需要 x_axis[] + series[{name,data}]')
  return {
    ok: true,
    components: [{
      id: 'root', component: 'AoLineChart',
      source: { path: '/chart' },
      xAxis: { path: '/x' },
      seriesNamePath: '/name',
      seriesDataPath: '/data',
      ...(data.unit === undefined ? {} : { unit: str(data.unit) }),
    }],
    content: { chart: { x, series }, x },
  }
}

function pieChart(data: Record<string, unknown>): TemplateResult {
  const { items } = seriesData(data)
  if (items.length === 0) throw new Error('pie_chart 需要 items[]')
  return {
    ok: true,
    components: [{
      id: 'root', component: 'AoPieChart',
      source: { path: '/items' },
      itemLabelPath: '/label',
      itemValuePath: '/value',
      ...(data.unit === undefined ? {} : { unit: str(data.unit) }),
    }],
    content: { items },
  }
}
