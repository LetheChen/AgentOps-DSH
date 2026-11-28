/**
 * Stored generative-UI surfaces.
 *
 * Agents publish A2UI surfaces and image cards through the `present_content`
 * tool; the panel reads the newest board state. Surface validation is
 * structural only (shape and limits) — the renderer runs the full JSON-schema
 * check and degrades visibly on failure. Image bytes are content-addressed and
 * served only after raster-format verification.
 *
 * @module @agentops/dsh-host/surfaces
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-working-directory'

import { isSafeGenerativeUiPreviewUri } from './a2ui-schema/artifact-uri.ts'
import { validateAgentopsA2uiSurface } from './a2ui-schema/validation.ts'
import { buildTemplate, CONTENT_TYPES } from './a2ui-templates.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Catalog identifier a published surface must carry. */
export const A2UI_CATALOG_ID = 'https://agentops.dev/a2ui/catalogs/core/v1'
/** Surface schema version this host accepts. */
export const A2UI_VERSION = 'v1.0'
/** Largest published surface payload, in bytes. */
export const MAX_SURFACE_BYTES = 64 * 1024
/** Largest number of components one surface may carry. */
export const MAX_COMPONENTS = 128
/** Largest image the board accepts into its durable asset store. */
export const MAX_SURFACE_IMAGE_BYTES = 16 * 1024 * 1024

/** Raster formats the board serves with a verified media type. */
export type SurfaceImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Content-addressed image bytes stored for one published surface. */
export interface SurfaceImageAsset {
  readonly digest: string
  readonly mediaType: SurfaceImageMediaType
  readonly bytes: number
  readonly data: Uint8Array
}

/**
 * Components this catalog renders. Anything else would degrade at render time,
 * so it is rejected at publish time with a message the model can act on.
 */
export const KNOWN_COMPONENTS: readonly string[] = [
  'AoSection', 'AoGrid', 'AoGridItem', 'AoMetric', 'AoStatusBadge', 'AoProgress',
  'AoStep', 'AoList', 'AoTable', 'AoTimeline', 'AoBarChart', 'AoLineChart',
  'AoPieChart', 'AoDag', 'AoDisclosure', 'AoIf', 'AoLink', 'AoArtifact',
  'Text', 'Row', 'Column', 'List', 'Card', 'Divider', 'Button', 'Tabs', 'Modal',
  'TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput', 'Image', 'Video', 'AudioPlayer',
]


/** Parse stored JSON without asserting its runtime type. */
function parseJsonValue(text: string): unknown {
  const value: unknown = JSON.parse(text)
  return value
}

/** Per-component contract: required keys, allowed extras, and the enum values we enforce. */
const COMPONENT_RULES: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
  AoSection: { required: ['children'], optional: ['title', 'tone'] },
  AoGrid: { required: ['columns', 'children'], optional: ['gap', 'align'] },
  AoGridItem: { required: ['child', 'span'], optional: [] },
  AoMetric: { required: ['label', 'value'], optional: ['unit', 'tone'] },
  AoStatusBadge: { required: ['text'], optional: ['tone'] },
  AoProgress: { required: ['value'], optional: ['label', 'tone'] },
  AoBarChart: { required: ['source'], optional: ['itemLabelPath', 'itemValuePath', 'itemTonePath', 'xAxis', 'seriesNamePath', 'seriesDataPath', 'unit', 'maxItems'] },
  AoPieChart: { required: ['source', 'itemLabelPath', 'itemValuePath'], optional: ['unit', 'maxItems'] },
  AoLineChart: { required: ['source', 'xAxis', 'seriesNamePath', 'seriesDataPath'], optional: ['unit', 'maxItems'] },
  AoDag: { required: ['source', 'itemIdPath', 'itemLabelPath', 'itemDependsOnPath'], optional: ['itemDetailPath', 'itemStatusPath', 'itemProgressPath', 'maxItems'] },
  AoTable: { required: ['source', 'columns'], optional: ['title', 'maxItems'] },
  AoTimeline: { required: ['source', 'itemTitlePath'], optional: ['itemDetailPath', 'itemTimePath', 'itemStatusPath'] },
  AoList: { required: ['source'], optional: ['itemTitlePath', 'itemDetailPath', 'maxItems'] },
  Text: { required: ['text'], optional: ['variant'] },
  Row: { required: ['children'], optional: ['gap', 'align', 'tone'] },
  Column: { required: ['children'], optional: ['gap', 'align', 'tone'] },
  List: { required: ['children'], optional: ['direction', 'gap'] },
  Card: { required: ['children'], optional: ['title', 'tone'] },
  Image: { required: ['url'], optional: ['description', 'fit', 'variant'] },
  Divider: { required: [], optional: [] },
}

const TONES = ['neutral', 'info', 'positive', 'warning', 'critical']
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/

/**
 * Enforce the per-component contract that the renderer would otherwise discover
 * only by degrading. Errors name the component, the field, and what was received.
 * @param components - surface components, already known to carry ids and names.
 * @returns the first contract violation, or null when every component is valid.
 */
export function validateComponentContracts(components: readonly Record<string, unknown>[]): string | null {
  const ids = new Set(components.map(entry => String(entry.id)))
  for (const [index, entry] of components.entries()) {
    const name = String(entry.component)
    const where = `components[${index}]（${String(entry.id)} · ${name}）`
    const rule = COMPONENT_RULES[name]
    if (rule === undefined) continue

    const allowed = new Set(['id', 'component', ...rule.required, ...rule.optional])
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `${where} 不认识的字段 ${key}；可用字段：${[...allowed].join('/')}`
      }
    }
    for (const key of rule.required) {
      if (!(key in entry)) return `${where} 缺少必填字段 ${key}`
    }

    if ('tone' in entry && !TONES.includes(String(entry.tone))) {
      return `${where} tone=${JSON.stringify(entry.tone)} 不合法；只能是 ${TONES.join('/')}`
    }
    if (name === 'Text' && 'variant' in entry && !['caption', 'body'].includes(String(entry.variant))) {
      return `${where} variant=${JSON.stringify(entry.variant)} 不合法；只能是 caption/body`
    }
    if ('source' in entry) {
      const source = entry.source as { path?: unknown } | null
      if (source === null || typeof source !== 'object' || typeof source.path !== 'string' || !source.path.startsWith('/')) {
        return `${where} source 必须是 {path:"/数据键"}，收到 ${JSON.stringify(entry.source)}`
      }
    }
    for (const key of ['itemLabelPath', 'itemValuePath', 'itemTonePath', 'seriesNamePath', 'seriesDataPath',
      'itemIdPath', 'itemDetailPath', 'itemStatusPath', 'itemProgressPath', 'itemDependsOnPath', 'itemTitlePath']) {
      if (key in entry && (typeof entry[key] !== 'string' || !POINTER.test(entry[key]))) {
        return `${where} ${key} 必须是 JSON 指针（以 / 开头），收到 ${JSON.stringify(entry[key])}`
      }
    }
    if (name === 'AoGrid') {
      const columns = entry.columns as { default?: unknown; compact?: unknown } | null
      if (columns === null || typeof columns !== 'object' || Array.isArray(columns)) {
        return `${where} columns 必须是对象 {default:1-3, compact:1-3}，收到 ${JSON.stringify(entry.columns)}`
      }
      for (const key of ['default', 'compact'] as const) {
        const value = columns[key]
        if (value !== undefined && (typeof value !== 'number' || value < 1 || value > 3)) {
          return `${where} columns.${key} 必须是 1-3 的数字，收到 ${JSON.stringify(value)}`
        }
      }
    }
    if ('xAxis' in entry) {
      const axis = entry.xAxis as { path?: unknown } | null
      if (axis === null || typeof axis !== 'object' || typeof axis.path !== 'string' || !axis.path.startsWith('/')) {
        return `${where} xAxis 必须是 {path:"/数据键"}`
      }
    }
    for (const key of ['children', 'child']) {
      if (!(key in entry)) continue
      const refs = Array.isArray(entry[key]) ? entry[key] as unknown[] : [entry[key]]
      if (key === 'children' && !Array.isArray(entry[key])) return `${where} children 必须是数组`
      for (const ref of refs) {
        if (typeof ref !== 'string') return `${where} ${key} 里必须都是字符串 id`
        if (!ids.has(ref)) return `${where} 的 ${key} 引用了不存在的 id：${ref}`
        if (ref === entry.id) return `${where} 不能引用自己`
      }
    }
  }
  return null
}


/**
 * Turn ajv's oneOf noise into something the model can act on.
 *
 * `componentSchema` wraps every component in a `oneOf`, so a rejected shape is
 * reported as "must have required property 'text'" (the Text branch) even when
 * the real problem is `columns: 3` on an AoGrid. This filters the branch noise
 * and names the component, its required fields and its accepted fields.
 * @param errors - the schema errors the validator reported.
 * @param components - the components of the rejected surface.
 * @returns a message naming the component, its required fields, and its accepted fields.
 */
export function describeSchemaFailure(
  errors: readonly { path: string; message: string; keyword: string }[],
  components: readonly Record<string, unknown>[],
): string {
  const first = errors[0]
  const path = first?.path ?? ''
  const match = /^\/components\/(\d+)/.exec(path)
  const index = match === null ? Number.NaN : Number(match[1])
  const component = Number.isNaN(index) ? undefined : components[index]
  const name = component !== undefined && typeof component.component === 'string' ? component.component : undefined

  const rule = name === undefined ? undefined : COMPONENT_RULES[name]
  const accepted = new Set<string>(['id', 'component', ...(rule?.required ?? []), ...(rule?.optional ?? [])])

  // A `required` error from an unrelated oneOf branch (e.g. Text's `text`) says
  // nothing about the component the model actually sent, so drop it.
  const useful = errors
    .filter(error => error.keyword !== 'oneOf' && error.keyword !== 'anyOf')
    // Branch discriminators ("component must equal AoGrid") repeat per branch and
    // carry no information once the component is known.
    .filter(error => !(rule !== undefined && error.message.includes('must be equal to constant')))
    .filter((error) => {
      const requiredName = /required property '([^']+)'/.exec(error.message)?.[1]
      if (requiredName !== undefined && rule !== undefined) return accepted.has(requiredName)
      const field = error.path.split('/').slice(3)[0]
      if (field === undefined || field === '') return rule === undefined
      return rule === undefined || accepted.has(field)
    })
  const chosen = useful.length > 0
    ? useful
    : errors.filter(error => error.keyword !== 'oneOf' && error.keyword !== 'anyOf')
  const seen = new Set<string>()
  const detail = chosen
    .filter((error) => {
      const key = `${error.path}|${error.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)
    .map(error => `${error.path === '' ? 'surface' : error.path} ${error.message}`)
    .join('；')
  const fields = rule === undefined
    ? ''
    : `。${name} 必填：${rule.required.join(' + ') || '（无）'}；可用字段：${['id', 'component', ...rule.required, ...rule.optional].join(' / ')}`

  // Shape mistakes that the schema can only report indirectly.
  const shape = (() => {
    if (name === 'AoGrid' && component !== undefined && typeof component.columns !== 'object') {
      return '。AoGrid.columns 必须是对象：{default:1-3, compact:1-3}'
    }
    if (name === 'AoTable') {
      if (!('columns' in (component ?? {}))) return '。AoTable 还需要 columns 数组：{id,label,path,format?}'
      return '。AoTable 的 columns[i] 需要 id/label/path，format 只能是 text/number/percent/datetime/duration/status/tone'
    }
    if (name === 'AoDag' && component !== undefined && 'itemTitlePath' in component) {
      return '。AoDag 用 itemLabelPath，不是 itemTitlePath'
    }
    return ''
  })()

  return `schema 不通过${name === undefined ? '' : `（${name}）`}：${detail}${fields}${shape}`
}

/** One published surface as stored on disk. */
export interface StoredSurface {
  id: number
  viewId: string
  sessionId: string | null
  title: string
  surface: unknown
  content: unknown
  createdAt: string
  /** Zero-based board position; lower values render first. */
  order: number
}

/**
 * Validate the surface envelope without interpreting component props.
 * @param input - the surface envelope published by an agent.
 * @returns the accepted envelope, or the reason it was rejected.
 */
export function validateSurfaceEnvelope(input: unknown): { ok: true; surface: Record<string, unknown> } | { ok: false; reason: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'surface 必须是对象' }
  }
  const surface = input as Record<string, unknown>
  if (surface.version !== A2UI_VERSION) return { ok: false, reason: `version 必须是 ${A2UI_VERSION}` }
  if (surface.catalogId !== A2UI_CATALOG_ID) return { ok: false, reason: `catalogId 必须是 ${A2UI_CATALOG_ID}` }
  if (!Array.isArray(surface.components)) return { ok: false, reason: 'components 必须是数组' }
  if (surface.components.length > MAX_COMPONENTS) {
    return { ok: false, reason: `components 超过 ${MAX_COMPONENTS} 个` }
  }
  // Every component needs a string `id` and a string `component` name. Agents
  // routinely emit `type` or omit the name; storing that produces a surface that
  // only ever renders as a degradation card, so it is rejected here instead.
  for (const [index, entry] of surface.components.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `components[${index}] 必须是对象` }
    }
    const component = entry as Record<string, unknown>
    if (typeof component.id !== 'string' || component.id.length === 0) {
      return { ok: false, reason: `components[${index}].id 必须是非空字符串` }
    }
    if (typeof component.component !== 'string' || component.component.length === 0) {
      return { ok: false, reason: `components[${index}].component 必须是组件名（如 AoMetric），收到 ${JSON.stringify(component.component ?? component.type ?? null)}` }
    }
    if (!KNOWN_COMPONENTS.includes(component.component)) {
      return {
        ok: false,
        reason: `components[${index}].component 不认识：${component.component}；可用：AoMetric/AoProgress/AoSection/AoGrid/AoBarChart/AoPieChart/AoLineChart/AoDag/AoTable/Text 等`,
      }
    }
    if ('props' in component) {
      return {
        ok: false,
        reason: `components[${index}] 用了 props 包裹；属性必须平铺在组件对象上，例如 {id, component:'AoMetric', label:'x', value:'1'}`,
      }
    }
  }
  // The renderer validates with the generated JSON Schema; publishing runs the
  // same schema so a surface is never stored in a shape that only degrades later.
  const checked = validateAgentopsA2uiSurface(surface)
  if (!checked.valid) {
    return { ok: false, reason: describeSchemaFailure(checked.errors, surface.components as Record<string, unknown>[]) }
  }
  const bytes = Buffer.byteLength(JSON.stringify(surface), 'utf8')
  if (bytes > MAX_SURFACE_BYTES) return { ok: false, reason: `surface 超过 ${MAX_SURFACE_BYTES} 字节` }
  return { ok: true, surface }
}

/**
 * Identify the raster format from bytes before the Host serves or stores them.
 * @param data - encoded image bytes to inspect.
 * @returns the verified raster media type, or undefined for unsupported content.
 */
export function detectSurfaceImageMediaType(data: Uint8Array): SurfaceImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12) {
    const riff = String.fromCharCode(...data.subarray(0, 4))
    const webp = String.fromCharCode(...data.subarray(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return undefined
}

/**
 * Stable browser URL for one content-addressed surface image.
 * @param digest - lowercase SHA-256 content digest.
 * @returns the authenticated image route carrying that digest.
 */
export function surfaceImageUrl(digest: string): string {
  return `/api/agentops/surfaces/asset?digest=${digest}`
}

type ScreenshotSource =
  | { readonly kind: 'attachment'; readonly attachment: ImageAttachmentRef }
  | { readonly kind: 'path'; readonly path: string }

function screenshotPathIn(text: string): string | undefined {
  const match = /^Saved (?:a )?screenshot(?: of [^.\n]+)? to (.+?)\.?$/m.exec(text)
  let path = match?.[1]?.trim()
  if (path === undefined || path === '') return undefined
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1)
  }
  return path
}

function latestScreenshotSource(events: readonly SessionEvent[]): ScreenshotSource | undefined {
  const callNames = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') callNames.set(String(event.data.callId), event.data.name)
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result') continue
    const name = callNames.get(String(event.data.message.toolCallId))
    if (name === undefined || !/screenshot/i.test(name)) continue
    let path: string | undefined
    for (const block of event.data.message.content) {
      if (block.type === 'image') return { kind: 'attachment', attachment: block.attachment }
      if (block.type === 'text') path ??= screenshotPathIn(block.text)
    }
    if (path !== undefined) return { kind: 'path', path }
  }
  return undefined
}

/** SQLite storage for published surfaces, one card per view id. */
export class SurfaceStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS surfaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        view_id TEXT NOT NULL DEFAULT 'main',
        session_id TEXT,
        title TEXT NOT NULL,
        surface_json TEXT NOT NULL,
        content_json TEXT,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS surface_images (
        digest TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    // Old databases predate view_id; the board aggregates by it. Migrate before
    // creating the index that depends on the column.
    const columns = this.#db.prepare('PRAGMA table_info(surfaces)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'view_id')) {
      this.#db.exec("ALTER TABLE surfaces ADD COLUMN view_id TEXT NOT NULL DEFAULT 'main'")
    }
    // Old databases predate sort_order. Seed it from id, which is the order the
    // board used before this column existed.
    if (!columns.some(column => column.name === 'sort_order')) {
      this.#db.exec('ALTER TABLE surfaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      this.#db.exec('UPDATE surfaces SET sort_order = id')
    }
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS surfaces_created ON surfaces(created_at DESC);
      CREATE INDEX IF NOT EXISTS surfaces_view ON surfaces(view_id);
    `)
    // One card per view: rows written before view_id existed all share 'main',
    // so collapse them to the newest one instead of showing a pile of pages.
    this.#db.exec('DELETE FROM surfaces WHERE id NOT IN (SELECT MAX(id) FROM surfaces GROUP BY view_id)')
  }

  /** Close the database handle. */
  close(): void {
    this.#db.close()
  }

  /**
   * Store one verified raster image under its SHA-256 digest.
   * @param data - encoded PNG, JPEG, WebP, or GIF bytes.
   * @param mediaType - media type detected from those exact bytes.
   * @param now - deterministic timestamp for tests.
   * @returns the content-addressed image identity.
   */
  putImage(data: Uint8Array, mediaType: SurfaceImageMediaType, now = new Date().toISOString()): SurfaceImageAsset {
    if (data.byteLength === 0) throw new Error('surface image is empty')
    if (data.byteLength > MAX_SURFACE_IMAGE_BYTES) {
      throw new Error(`surface image exceeds ${MAX_SURFACE_IMAGE_BYTES} bytes`)
    }
    const detected = detectSurfaceImageMediaType(data)
    if (detected !== mediaType) throw new Error('surface image media type does not match its bytes')
    const digest = createHash('sha256').update(data).digest('hex')
    this.#db.prepare(
      'INSERT OR IGNORE INTO surface_images (digest, media_type, bytes, data, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(digest, mediaType, data.byteLength, data, now)
    return { digest, mediaType, bytes: data.byteLength, data }
  }

  /**
   * Read one published surface image by digest.
   * @param digest - lowercase SHA-256 content digest.
   * @returns the stored image, or null when the digest is malformed or absent.
   */
  image(digest: string): SurfaceImageAsset | null {
    if (!/^[a-f0-9]{64}$/.test(digest)) return null
    const row = this.#db.prepare(
      'SELECT digest, media_type, bytes, data FROM surface_images WHERE digest = ?',
    ).get(digest) as { digest: string; media_type: SurfaceImageMediaType; bytes: number; data: Uint8Array } | undefined
    if (row === undefined) return null
    return { digest: row.digest, mediaType: row.media_type, bytes: row.bytes, data: row.data }
  }

  /** Delete images no remaining card references. */
  #pruneImages(): void {
    const rows = this.#db.prepare('SELECT surface_json FROM surfaces').all() as { surface_json: string }[]
    const referenced = new Set<string>()
    const pattern = /\/api\/agentops\/surfaces\/asset\?digest=([a-f0-9]{64})/g
    for (const row of rows) {
      for (const match of row.surface_json.matchAll(pattern)) {
        const digest = match[1]
        if (digest !== undefined) referenced.add(digest)
      }
    }
    const assets = this.#db.prepare('SELECT digest FROM surface_images').all() as { digest: string }[]
    for (const asset of assets) {
      if (!referenced.has(asset.digest)) {
        this.#db.prepare('DELETE FROM surface_images WHERE digest = ?').run(asset.digest)
      }
    }
  }

  /**
   * Publish one surface, replacing the card of the same view id.
   * @param surface - the A2UI surface document.
   * @param options - the card title, view id, content, session id, and timestamp.
   * @returns the id of the stored surface row.
   */
  put(
    surface: Record<string, unknown>,
    options: { title: string; viewId?: string; content?: unknown; sessionId?: string; now?: string },
  ): number {
    const now = options.now ?? new Date().toISOString()
    const viewId = options.viewId?.trim() || 'main'
    // One row per view: publishing the same id replaces the card in place,
    // which is how the board keeps a stable set of cards instead of a feed.
    // A replacement keeps its board position; a new card appends.
    const existing = this.#db.prepare('SELECT sort_order FROM surfaces WHERE view_id = ?').get(viewId) as
      | { sort_order: number }
      | undefined
    const maxRow = this.#db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM surfaces').get() as {
      value: number
    }
    const nextOrder = existing?.sort_order ?? maxRow.value + 1
    this.#db.prepare('DELETE FROM surfaces WHERE view_id = ?').run(viewId)
    const result = this.#db.prepare(
      'INSERT INTO surfaces (view_id, session_id, title, surface_json, content_json, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      viewId,
      options.sessionId ?? null,
      options.title,
      JSON.stringify(surface),
      options.content === undefined ? null : JSON.stringify(options.content),
      now,
      nextOrder,
    )
    this.#pruneImages()
    return Number(result.lastInsertRowid)
  }

  /**
   * Current board in its persisted display order, first card first.
   * @returns the current board, one entry per view id.
   */
  views(): StoredSurface[] {
    return this.list(500).reverse()
  }

  /**
   * Replace the whole board order with the given first-to-last sequence.
   * @param viewIds - every card view id in its new position order.
   * @returns whether the sequence is exactly a permutation of the current board.
   */
  reorder(viewIds: readonly string[]): boolean {
    const current = this.views()
    if (current.length !== viewIds.length) return false
    const currentIds = new Set(current.map(row => row.viewId))
    if (viewIds.some(viewId => !currentIds.has(viewId))) return false
    if (new Set(viewIds).size !== viewIds.length) return false
    const update = this.#db.prepare('UPDATE surfaces SET sort_order = ? WHERE view_id = ?')
    viewIds.forEach((viewId, order) => update.run(order, viewId))
    return true
  }

  /**
   * Ids whose stored components cannot render (missing a component name).
   * @returns the ids of surfaces whose components cannot render.
   */
  invalidIds(): number[] {
    return this.list(500)
      .filter((row) => {
        const surface = row.surface as { components?: unknown } | null
        const components = Array.isArray(surface?.components) ? surface.components : []
        return components.length === 0
          || components.some(entry => typeof (entry as { component?: unknown } | null)?.component !== 'string')
      })
      .map(row => row.id)
  }

  /**
   * Delete one card by its view id.
   * @param viewId - the view whose card is deleted.
   * @returns whether a card was deleted.
   */
  removeView(viewId: string): boolean {
    const result = this.#db.prepare('DELETE FROM surfaces WHERE view_id = ?').run(viewId)
    this.#pruneImages()
    return Number(result.changes) > 0
  }

  /**
   * Delete every card on the board.
   * @returns the number of deleted cards.
   */
  clear(): number {
    const result = this.#db.prepare('DELETE FROM surfaces').run()
    this.#pruneImages()
    return Number(result.changes)
  }

  /**
   * Delete one stored surface; returns whether a row was removed.
   * @param id - the stored surface to delete.
   * @returns whether a surface was deleted.
   */
  remove(id: number): boolean {
    const result = this.#db.prepare('DELETE FROM surfaces WHERE id = ?').run(id)
    this.#pruneImages()
    return Number(result.changes) > 0
  }

  /**
   * The most recently published surface, or null when the board is empty.
   * @returns the newest surface, or null when the board is empty.
   */
  latest(): StoredSurface | null {
    return this.list(1)[0] ?? null
  }

  /**
   * The newest stored surfaces, newest first.
   * @param limit - how many surfaces to return.
   * @returns the stored surfaces, newest first.
   */
  list(limit = 20): StoredSurface[] {
    const rows = this.#db.prepare(
      'SELECT id, view_id, session_id, title, surface_json, content_json, created_at, sort_order FROM surfaces ORDER BY sort_order DESC, id DESC LIMIT ?',
    ).all(limit) as {
      id: number
      view_id: string
      session_id: string | null
      title: string
      surface_json: string
      content_json: string | null
      created_at: string
      sort_order: number
    }[]
    return rows.map(row => ({
      id: row.id,
      viewId: row.view_id,
      sessionId: row.session_id,
      title: row.title,
      surface: parseJsonValue(row.surface_json),
      content: row.content_json === null ? null : parseJsonValue(row.content_json),
      createdAt: row.created_at,
      order: row.sort_order,
    }))
  }
}

/**
 * Register the read routes. Writes happen only through the tool.
 * @param ctx - Cordis context.
 * @param store - the surface store to read from.
 */
export function registerSurfaceRoutes(ctx: Context, store: SurfaceStore): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') ?? '20') || 20, 1), 100)
      return Promise.resolve(json({ surfaces: store.list(limit) }))
    },
  }), 'agentops-system: /api/agentops/surfaces')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/remove',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json().catch(() => ({})) as { viewId?: unknown }
      const viewId = typeof body.viewId === 'string' ? body.viewId : ''
      if (viewId === '') return json({ ok: false, reason: '缺少 viewId' }, 400)
      return json({ ok: store.removeView(viewId) })
    },
  }), 'agentops-system: /api/agentops/surfaces/remove')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/reorder',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json().catch(() => ({})) as { viewIds?: unknown }
      if (!Array.isArray(body.viewIds) || body.viewIds.some(item => typeof item !== 'string')) {
        return json({ ok: false, reason: '需要 viewIds 数组' }, 400)
      }
      return json({ ok: store.reorder(body.viewIds as string[]) })
    },
  }), 'agentops-system: /api/agentops/surfaces/reorder')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/clear',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json().catch(() => ({})) as { confirm?: unknown }
      if (body.confirm !== true) return json({ ok: false, reason: '需要 confirm:true 才能清空看板' }, 400)
      return json({ ok: true, removed: store.clear() })
    },
  }), 'agentops-system: /api/agentops/surfaces/clear')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/views',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ views: store.views() })),
  }), 'agentops-system: /api/agentops/surfaces/views')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/asset',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const digest = new URL(request.url).searchParams.get('digest') ?? ''
      const asset = store.image(digest)
      if (asset === null) {
        return Promise.resolve(new Response('Not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }))
      }
      return Promise.resolve(new Response(new Blob([new Uint8Array(asset.data)], { type: asset.mediaType }), {
        headers: {
          'content-type': asset.mediaType,
          'content-length': String(asset.bytes),
          'cache-control': 'private, max-age=31536000, immutable',
          'content-security-policy': "default-src 'none'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
        },
      }))
    },
  }), 'agentops-system: /api/agentops/surfaces/asset')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/surfaces/latest',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ surface: store.latest() })),
  }), 'agentops-system: /api/agentops/surfaces/latest')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}


/** `content_type` value that publishes one image card through `present_content`. */
const IMAGE_CONTENT_TYPE = 'image'

/**
 * Decode a nested JSON object emitted as a JSON-encoded string by a model tool call.
 * Objects and other values pass through unchanged; invalid JSON remains unchanged
 * so the owning validator reports the original value.
 * @param value - model-supplied JSON argument.
 * @returns the decoded value when it is valid JSON text, otherwise the original value.
 */
function decodeJsonArgument(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/**
 * The publishing tool. Agents call it to hand the panel a rendered surface.
 * @param ctx - Agent-scoped context carrying optional attachment and filesystem services.
 * @param store - surface storage.
 * @returns the `present_content` tool definition.
 */
export function createPresentContentTool(ctx: Context, store: SurfaceStore): ToolDefinition {
  return defineTool({
    name: 'present_content',
    description:
      'Publish ONE CARD to the AgentOps 生成式 UI board (right sidebar). The board keeps a stable set of cards: '
      + 'reuse the same viewId to update a card in place, use a new viewId to add another card. '
      + 'Call this when the answer has 3+ numbers, grouped data, a trend, or a process state. '
      + 'Surface shape: {version:"v1.0", catalogId:"https://agentops.dev/a2ui/catalogs/core/v1", components:[...]}. '
      + 'Exactly one component must have id "root" and reference the rest. '
      + 'Components: AoSection{children}, AoGrid{columns:{default,compact},children}, AoMetric{label,value,unit?,tone?}, '
      + 'AoProgress{value,label?}, AoStatusBadge{text}, AoBarChart/AoPieChart{source:{path},itemLabelPath,itemValuePath,unit?}, '
      + 'AoLineChart{source,xAxis:{path},seriesNamePath,seriesDataPath}, AoDag{source,itemIdPath,itemLabelPath,itemDependsOnPath}, '
      + 'AoTable{source,columns:[{id,label,path,format?}]}, Text{text}. '
      + 'Properties are FLAT on the component object — never wrap them in "props". '
      + 'Charts read data from `content` via JSON pointers: content:{bar:[{label,value}]} + source:{path:"/bar"} + itemLabelPath:"/label". '
      + 'tone is one of neutral/info/positive/warning/critical. See the generative-ui skill for examples. '
      + 'For screenshots and standalone images, use content_type:"image" with data:{source,caption?}; source defaults to latest-screenshot. '
      + 'Pass data, surface, and content as objects, not JSON-encoded strings.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title shown above the surface.' },
      content_type: {
        type: 'string',
        description: `Template channel (preferred): ${CONTENT_TYPES.join(' / ')} / image. Supply data in the shape that template expects; image data is {source?,caption?}.`,
      },
      data: { type: 'json', description: 'Template data object; used with content_type. Pass an object, not a JSON string.' },
      viewId: { type: 'string', description: 'Card id on the board. Publishing the same id replaces that card in place; omit for \'main\'.' },
      surface: { type: 'json', description: 'A2UI v1 surface object (escape hatch). Pass an object, not a JSON string.' },
      content: { type: 'json', description: 'Data-model object the components bind to via source paths. Pass an object, not a JSON string.' },
      sessionId: { type: 'string', description: 'Optional owning session id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'boolean', required: true },
          id: { type: 'integer', required: true },
          components: { type: 'integer', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:  value.stored
          ? `已发布会话面板 surface（#${String(value.id)}，${String(value.components)} 个组件）`
          : `surface 未发布：${value.reason ?? '校验失败'}`,
      }],
    },
    async execute(args, exec) {
      const data = decodeJsonArgument(args.data)
      const surface = decodeJsonArgument(args.surface)
      const content = decodeJsonArgument(args.content)
      if (args.content_type === IMAGE_CONTENT_TYPE) {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return { stored: false, id: 0, components: 0, reason: 'content_type:"image" 需要 data:{source?,caption?}' }
        }
        const values = data as Record<string, unknown>
        const sourceValue = values.source
        const captionValue = values.caption
        if (sourceValue !== undefined && typeof sourceValue !== 'string') {
          return { stored: false, id: 0, components: 0, reason: 'image.source 必须是字符串' }
        }
        if (captionValue !== undefined && typeof captionValue !== 'string') {
          return { stored: false, id: 0, components: 0, reason: 'image.caption 必须是字符串' }
        }
        const source = (sourceValue?.trim() || 'latest-screenshot')
        const resolved = await resolveImageSource(ctx, store, source, exec)
        if (!resolved.ok) return { stored: false, id: 0, components: 0, reason: resolved.reason }
        const caption = captionValue?.trim() || ''
        const components: Record<string, unknown>[] = [
          {
            id: 'root',
            component: 'Column',
            align: 'stretch',
            children: caption === '' ? ['image'] : ['image', 'caption'],
          },
          {
            id: 'image',
            component: 'Image',
            url: resolved.url,
            description: caption || args.title,
            fit: 'contain',
            variant: 'largeFeature',
          },
        ]
        if (caption !== '') components.push({ id: 'caption', component: 'Text', text: caption, variant: 'caption' })
        const checked = validateSurfaceEnvelope({ version: A2UI_VERSION, catalogId: A2UI_CATALOG_ID, components })
        if (!checked.ok) return { stored: false, id: 0, components: 0, reason: checked.reason }
        const id = store.put(checked.surface, {
          title: args.title,
          viewId: args.viewId?.trim() || 'image',
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        })
        return { stored: true, id, components: components.length }
      }
      // Template channel: the model supplies a content type and its data, and the
      // surface is generated here — it cannot get component shapes wrong.
      if (args.content_type !== undefined) {
        if (data === undefined) {
          return Promise.resolve({ stored: false, id: 0, components: 0, reason: 'content_type 需要同时提供 data' })
        }
        const built = buildTemplate(args.content_type, data)
        if (!built.ok) return Promise.resolve({ stored: false, id: 0, components: 0, reason: built.reason })
        const checked = validateSurfaceEnvelope({ version: A2UI_VERSION, catalogId: A2UI_CATALOG_ID, components: built.components })
        if (!checked.ok) return Promise.resolve({ stored: false, id: 0, components: 0, reason: checked.reason })
        const id = store.put(checked.surface, {
          title: args.title,
          content: built.content,
          ...(args.viewId === undefined ? {} : { viewId: args.viewId }),
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        })
        return Promise.resolve({ stored: true, id, components: built.components.length })
      }
      if (surface === undefined) {
        return Promise.resolve({ stored: false, id: 0, components: 0, reason: `需要 surface（自由 A2UI）或 content_type + data；可用模板：${CONTENT_TYPES.join(' / ')} / image` })
      }
      const checked = validateSurfaceEnvelope(surface)
      if (!checked.ok) {
        return Promise.resolve({ stored: false, id: 0, components: 0, reason: checked.reason })
      }
      const id = store.put(checked.surface, {
        title: args.title,
        ...(args.viewId === undefined ? {} : { viewId: args.viewId }),
        ...(content === undefined ? {} : { content }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      })
      const components = Array.isArray(checked.surface.components) ? checked.surface.components.length : 0
      return Promise.resolve({ stored: true, id, components })
    },
  })
}

type ImageSourceResolution =
  | { readonly ok: true; readonly url: string; readonly mediaType: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: string }

async function readStoredImagePath(
  ctx: Context,
  store: SurfaceStore,
  source: string,
  exec: ToolExecution,
): Promise<ImageSourceResolution> {
  const fs = ctx.get('fs')
  if (fs === undefined) return { ok: false, reason: '当前部署没有文件系统服务，无法读取图片路径' }
  const agent = exec.agent
  const workingDirectory = ctx.get('workingDirectory')
  const cwd = agent === undefined
    ? undefined
    : workingDirectory?.get(agent.session) ?? agent.session.header.cwd
  try {
    const target = await fs.resolve(source, {
      ...(cwd === undefined ? {} : { cwd }),
      signal: exec.signal,
    })
    const info = await fs.stat(target, exec.signal)
    if (info?.type !== 'file') return { ok: false, reason: `图片文件不存在：${source}` }
    const data = await fs.readBytes(target, exec.signal, MAX_SURFACE_IMAGE_BYTES)
    return storeImageBytes(store, data)
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : `读取图片失败：${source}` }
  }
}

function storeImageBytes(store: SurfaceStore, data: Uint8Array): ImageSourceResolution {
  const mediaType = detectSurfaceImageMediaType(data)
  if (mediaType === undefined) {
    return { ok: false, reason: '图片必须是 PNG、JPEG、WebP 或 GIF；不接受 SVG、数据 URL 或其他格式' }
  }
  try {
    const asset = store.putImage(data, mediaType)
    return { ok: true, url: surfaceImageUrl(asset.digest), mediaType: asset.mediaType, bytes: asset.bytes }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : '图片存储失败' }
  }
}

async function resolveImageSource(
  ctx: Context,
  store: SurfaceStore,
  source: string,
  exec: ToolExecution,
): Promise<ImageSourceResolution> {
  if (source === 'latest-screenshot') {
    if (exec.agent === undefined) return { ok: false, reason: 'latest-screenshot 只能在 Agent 会话内使用' }
    const query = ctx.get('sessionQuery')
    if (query === undefined) return { ok: false, reason: '当前部署没有会话查询服务，无法定位截图' }
    let screenshot: ScreenshotSource | undefined
    try {
      using observation = await query.observeSession(exec.agent.session.id, {
        projectionMode: 'none',
        signal: exec.signal,
      })
      screenshot = latestScreenshotSource(observation.events)
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : '读取会话截图记录失败' }
    }
    if (screenshot === undefined) return { ok: false, reason: '当前会话还没有浏览器或桌面截图结果' }
    if (screenshot.kind === 'path') return readStoredImagePath(ctx, store, screenshot.path, exec)
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { ok: false, reason: '当前部署没有附件存储，无法读取截图' }
    try {
      const stored = await attachments.readImage(screenshot.attachment, exec.signal)
      return storeImageBytes(store, stored.data)
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : '读取截图附件失败' }
    }
  }

  if (isSafeGenerativeUiPreviewUri(source)) {
    return { ok: true, url: source, mediaType: 'external', bytes: 0 }
  }
  if (/^(?:https?|data|blob|file|artifact):/i.test(source)) {
    return { ok: false, reason: '图片来源必须是无凭据的 HTTP(S) URL、面板图片 URL，或当前工作区中的图片路径' }
  }

  return readStoredImagePath(ctx, store, source, exec)
}

/**
 * Board cleanup for the manager: remove one card by view id, or clear the board.
 * Requires an explicit `confirm` so a stray tool call cannot wipe the board, and
 * reports how many cards were removed.
 * @param store - surface storage.
 * @returns the `board_cleanup` tool definition.
 */
export function createBoardCleanupTool(store: SurfaceStore): ToolDefinition {
  return defineTool({
    name: 'board_cleanup',
    description:
      'Remove cards from the AgentOps 生成式 UI board. Pass viewId to remove one card, '
      + 'or all:true to clear the board. Requires confirm:true; returns the number removed.',
    parameters: {
      viewId: { type: 'string', description: 'Card id to remove (the view_id shown on the board).' },
      all: { type: 'boolean', description: 'Clear every card on the board.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; guards against accidental deletion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          removed: { type: 'integer', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:  value.ok ? `已删除 ${String(value.removed)} 张卡片` : `未删除：${value.reason ?? '未知原因'}`,
      }],
    },
    execute(args) {
      if (!args.confirm) return Promise.resolve({ ok: false, removed: 0, reason: '需要 confirm:true' })
      if (args.all === true) return Promise.resolve({ ok: true, removed: store.clear() })
      if (args.viewId === undefined || args.viewId === '') {
        return Promise.resolve({ ok: false, removed: 0, reason: '需要 viewId 或 all:true' })
      }
      return Promise.resolve({ ok: true, removed: store.removeView(args.viewId) ? 1 : 0 })
    },
  })
}
