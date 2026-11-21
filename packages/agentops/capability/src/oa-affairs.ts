/**
 * Seeyon OA collaboration-affairs request and response rules.
 *
 * This module owns the vendor's route shapes, identity fields, time format, ID
 * precision handling, and response normalization. The model-facing tool composes
 * these rules with the shared REST transport; the transport owns token
 * acquisition and injection.
 *
 * @module @agentops/dsh-capability/oa-affairs
 */

import type { AuthSubject } from './auth.ts'
import { CapabilityError } from './errors.ts'
import type { CapabilityRuntime } from './types.ts'

/** The affairs boxes this connector can address. */
export type OaAffairBox = 'pending' | 'done'

/** The identity fields available on one OA instance. */
export interface OaAffairSubject {
  readonly memberCode: string | null
  readonly memberId: string | null
  readonly loginName: string | null
}

/** One affairs row as reported by OA. */
export type OaAffairItem = {
  readonly id: string
  readonly subject: string
  readonly create_date: string
  readonly app: string
  readonly object_id: string
  readonly state: string
  readonly sub_state: string
  readonly node_name: string
  readonly sender_name: string
  readonly complete_time: string | null
  readonly url_link: string | null
}

/** One page request for an affairs box. */
export interface OaAffairRequest {
  readonly path: string
  readonly query: Readonly<Record<string, string>>
}

/** Detail depth for one affair. */
export type OaDetailLevel = 'state' | 'basic' | 'full'

/** One normalized flow-state answer. */
export interface OaFlowState {
  readonly flow_state: number
  readonly state_label: string
  readonly state_caveat: string
}

/** One form-data answer in addition to the flow state. */
export interface OaFormState {
  readonly approve_date: string | null
  readonly finished_flag: string | null
  readonly form_state: string | null
}

/** One business form field extracted from a flow export. */
export interface OaFormField {
  readonly label: string
  readonly value: string
}

/** Attachment metadata reported by a flow export. */
export interface OaAttachmentMeta {
  readonly file_id: string
  readonly name: string
  readonly suffix: string
}

/** Full detail fields in addition to state and form data. */
export interface OaDetailFields {
  readonly fields: readonly OaFormField[]
  readonly attachments: readonly OaAttachmentMeta[]
}

/** One affair detail result at the requested depth. */
export type OaAffairDetail = OaFlowState & {
  readonly approve_date?: string
  readonly finished_flag?: string
  readonly form_state?: string
} & {
  readonly fields?: readonly OaFormField[]
  readonly attachments?: readonly OaAttachmentMeta[]
}

/** Vendor state codes observed on the flow-state route. */
const FLOW_STATE_LABELS: Readonly<Record<number, string>> = {
  0: '已完成（已归档）',
  1: '待发出',
  3: '审批中',
  4: '审批中',
  5: '已撤销',
  6: '已退回发起人（进行中）',
  7: '已取回（进行中）',
  15: '已终止',
}

const FLOW_STATE_CAVEAT = '状态码 0 只代表已归档，不等于审批通过；15 只代表已终止，不等于被否决'

/**
 * Parse vendor JSON while keeping 64-bit identifiers as strings.
 *
 * Seeyon returns IDs as JSON numbers beyond JavaScript's safe range, so plain
 * JSON.parse silently rounds them and later detail calls address the wrong
 * record. Integer literals wider than the safe range are quoted before parsing.
 * @param raw - response body text.
 * @returns the parsed payload with oversized integers preserved as strings.
 */
export function parseOaJson(raw: string): unknown {
  const isBoundary = (ch: string): boolean => ch === '' || ch === ' ' || ch === ',' || ch === ':' || ch === '[' || ch === ']' || ch === '}' || ch === '\n'
  const quoted = raw.replace(/-?\d{16,}/gu, (value, offset: number) => {
    if (!isBoundary(raw.charAt(offset - 1)) || !isBoundary(raw.charAt(offset + value.length))) return value
    return `"${value}"`
  })
  try {
    return JSON.parse(quoted) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  if (typeof value === 'string' && value !== '') {
    const dateTime = value.includes('T') ? value : value.replace(' ', 'T')
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(dateTime) ? `${dateTime}T00:00:00` : dateTime
    const zoned = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`
    const parsed = Date.parse(zoned)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function formatTimestamp(value: unknown): string {
  const ms = timestamp(value)
  if (ms === null) return typeof value === 'string' ? value : ''
  const local = new Date(ms + 8 * 60 * 60 * 1000)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} `
    + `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
}

function appName(value: unknown): string {
  const raw = text(value)
  if (raw === '1') return 'collaboration'
  if (raw === '4') return 'edoc'
  return raw
}

/**
 * Resolve the identity configured on one OA instance.
 *
 * The token binding and the queried person are separate facts. Login identity
 * is eligible for a token request but is never treated as a member code.
 * @param runtime - resolved OA instance.
 * @returns configured identity fields.
 */
export function resolveOaSubject(runtime: CapabilityRuntime): OaAffairSubject {
  const subject: OaAffairSubject = {
    memberCode: text(runtime.config['member_code']) || null,
    memberId: text(runtime.config['member_id']) || text(runtime.config['memberId']) || null,
    loginName: text(runtime.config['login_name']) || text(runtime.config['loginName']) || null,
  }
  if (subject.memberCode === null && subject.memberId === null && subject.loginName === null) {
    throw new CapabilityError(
      'CAPABILITY_IDENTITY_UNBOUND',
      `instance ${runtime.instanceId} needs member_code, member_id, or login_name`,
    )
  }
  return subject
}

/**
 * Convert configured OA identity fields to token parameter subject fields.
 * @param subject - configured OA identity.
 * @returns non-empty subject values keyed for `subject.<name>` sources.
 */
export function authSubject(subject: OaAffairSubject): AuthSubject {
  return {
    ...(subject.memberCode === null ? {} : { memberCode: subject.memberCode }),
    ...(subject.memberId === null ? {} : { memberId: subject.memberId }),
    ...(subject.loginName === null ? {} : { loginName: subject.loginName }),
  }
}

/**
 * Build the path and query of one affairs box.
 * @param box - the affairs box to address.
 * @param subject - the member identity of the instance.
 * @returns the request path and query.
 */
export function buildAffairRequest(box: OaAffairBox, subject: OaAffairSubject): OaAffairRequest {
  if (subject.memberCode !== null) {
    return {
      path: `/seeyon/rest/affairs/${box}/code/${encodeURIComponent(subject.memberCode)}`,
      query: {},
    }
  }
  if (box === 'pending' && subject.memberId !== null) {
    return { path: '/seeyon/rest/affairs/pending', query: { memberId: subject.memberId, apps: '1' } }
  }
  throw new CapabilityError(
    'CAPABILITY_IDENTITY_UNBOUND',
    `the ${box} box needs member_code; member_id is only supported by the pending route`,
  )
}

/**
 * Read the rows of an affairs response.
 *
 * Seeyon answers with a row array and may wrap it in a page object. A `null`
 * body means an invalid ticket and must not be reported as an empty result.
 * @param payload - parsed response body.
 * @returns the affairs rows.
 */
export function readAffairRows(payload: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
  }
  const record = asRecord(payload)
  if (record === null) {
    throw new CapabilityError('CAPABILITY_RESPONSE_INVALID', 'OA affairs response is not a JSON array or object')
  }
  for (const key of ['data', 'dataList', 'result', 'records']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
    }
    if (value === null) {
      throw new CapabilityError('CAPABILITY_RESPONSE_INVALID', `OA affairs response ${key} is null`)
    }
    const nested = asRecord(value)
    if (nested !== null) {
      const inner = nested['data']
      if (Array.isArray(inner)) {
        return inner.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
      }
    }
  }
  throw new CapabilityError('CAPABILITY_RESPONSE_INVALID', 'OA affairs response carries no row array')
}

/**
 * Normalize one affairs row into the tool's stable shape.
 * @param row - one raw affairs row.
 * @returns the normalized row.
 */
export function normalizeAffair(row: Readonly<Record<string, unknown>>): OaAffairItem {
  const extra = asRecord(row['extraMap'])
  const link = row['URLLINK'] ?? row['urlLink'] ?? extra?.['urllink'] ?? extra?.['URLLINK']
  return {
    id: text(row['id']),
    subject: text(row['subject'] ?? row['title']),
    create_date: formatTimestamp(row['createDate'] ?? row['create_date']),
    app: appName(row['appEnumStr'] ?? row['app']),
    object_id: text(row['objectId'] ?? row['object_id'] ?? row['affairId']),
    state: text(row['state'] ?? row['summaryState'] ?? row['status']),
    sub_state: text(row['subState'] ?? row['sub_state']),
    node_name: text(row['nodeName']),
    sender_name: text(row['senderName']),
    complete_time: row['completeTime'] === undefined || row['completeTime'] === null
      ? null
      : formatTimestamp(row['completeTime']),
    url_link: link === undefined || link === null || text(link) === '' ? null : text(link),
  }
}

/**
 * Build the flow-state request for one affair.
 * @param objectId - the affair's objectId from the affairs list.
 * @returns the state route path.
 */
export function buildFlowStateRequest(objectId: string): string {
  const id = objectId.trim()
  if (id === '') {
    throw new CapabilityError('CAPABILITY_IDENTITY_UNBOUND', 'detail needs an objectId from oa_affair_query')
  }
  return `/seeyon/rest/flow/state/${encodeURIComponent(id)}`
}

/**
 * Read a plain-text integer flow state.
 * @param raw - the raw state response body.
 * @returns the normalized state.
 */
export function readFlowState(raw: string): OaFlowState {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) {
    throw new CapabilityError(
      'CAPABILITY_RESPONSE_INVALID',
      `OA flow/state returned a non-integer body: ${raw.trim().slice(0, 80)}`,
    )
  }
  return {
    flow_state: parsed,
    state_label: FLOW_STATE_LABELS[parsed] ?? `未知状态码 ${parsed}`,
    state_caveat: FLOW_STATE_CAVEAT,
  }
}

/**
 * Read optional form completion facts.
 * @param payload - parsed getformdata response body.
 * @returns normalized form state, or undefined when the body is not an object.
 */
export function readFormState(payload: unknown): OaFormState | undefined {
  const record = asRecord(payload)
  if (record === null) return undefined
  const rowData = asRecord(record['RowData']) ?? record
  const approve = rowData['approve_date'] ?? rowData['ApproveDate']
  const finished = rowData['finishedflag'] ?? rowData['FinishedFlag']
  const state = rowData['state'] ?? rowData['State']
  return {
    approve_date: approve === undefined || approve === null ? null : formatTimestamp(approve),
    finished_flag: finished === undefined || finished === null ? null : text(finished),
    form_state: state === undefined || state === null ? null : text(state),
  }
}

function truncateValue(value: unknown, limit = 300): string {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) || asRecord(value) !== null
      ? JSON.stringify(value)
      : text(value)
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
}

/**
 * Extract business fields labeled by `displayName` from a flow export.
 * @param payload - parsed flow/data response body.
 * @param limit - maximum fields returned.
 * @returns one entry per unique display label.
 */
export function readFormFields(payload: unknown, limit = 60): readonly OaFormField[] {
  const found: { label: string; value: unknown }[] = []
  const walk = (node: unknown): void => {
    if (found.length >= limit * 3) return
    const record = asRecord(node)
    if (record !== null) {
      const label = record['displayName']
      if (typeof label === 'string' && label.trim() !== '' && 'value' in record) {
        found.push({ label: label.trim(), value: record['value'] })
      }
      for (const value of Object.values(record)) walk(value)
      return
    }
    if (Array.isArray(node)) {
      for (const value of node) walk(value)
    }
  }
  walk(payload)
  const fields: OaFormField[] = []
  const seen = new Set<string>()
  for (const entry of found) {
    if (seen.has(entry.label)) continue
    seen.add(entry.label)
    fields.push({ label: entry.label, value: truncateValue(entry.value) })
    if (fields.length >= limit) break
  }
  return fields
}

/**
 * Read attachment metadata without downloading files.
 * @param payload - parsed flow/data response body.
 * @returns attachment ids and names.
 */
export function readAttachmentMetadata(payload: unknown): readonly OaAttachmentMeta[] {
  const record = asRecord(payload)
  const entries = record === null ? [] : record['attachmentList']
  if (!Array.isArray(entries)) return []
  const attachments: OaAttachmentMeta[] = []
  for (const entry of entries) {
    const item = asRecord(entry)
    if (item === null) continue
    const fileId = text(item['id'] ?? item['file_url']).trim()
    const name = text(item['name'] ?? item['fileName'] ?? item['filename'] ?? 'unknown').trim()
    if (fileId === '') continue
    const suffix = text(item['filesuffix']).toLowerCase().replace(/^\./, '')
      || (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '')
    attachments.push({ file_id: fileId, name: name === '' ? 'unknown' : name, suffix })
  }
  return attachments
}

/**
 * Build the flow-export request carrying business form fields.
 * @param objectId - the affair's objectId.
 * @returns the export route path and query.
 */
export function buildFlowDataRequest(objectId: string): OaAffairRequest {
  return {
    path: `/seeyon/rest/flow/data/${encodeURIComponent(objectId.trim())}`,
    query: { exportType: '0', exportFormat: 'json' },
  }
}

/**
 * Read the optional time range argument.
 * @param value - raw argument value.
 * @returns the start and end bounds that are present.
 */
export function readTimeRange(value: unknown): { start?: string; end?: string } {
  const record = asRecord(value)
  if (record === null) return {}
  const start = record['start']
  const end = record['end']
  return {
    ...(typeof start === 'string' ? { start } : {}),
    ...(typeof end === 'string' ? { end } : {}),
  }
}

/**
 * Read the optional business scope argument.
 * @param value - raw argument value.
 * @returns the scope keywords, or undefined when none were given.
 */
export function readScopes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const scopes = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  return scopes.length === 0 ? undefined : scopes
}

function dateBound(value: string, end: boolean): number {
  const trimmed = value.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  const normalized = dateOnly
    ? `${trimmed}T${end ? '23:59:59.999' : '00:00:00'}+08:00`
    : /(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)
      ? trimmed
      : `${trimmed.replace(' ', 'T')}+08:00`
  const parsed = Date.parse(normalized)
  if (Number.isNaN(parsed)) {
    throw new CapabilityError('CAPABILITY_CONFIG_INVALID', `time_range value is not a valid date: ${value}`)
  }
  return parsed
}

/**
 * Filter affairs by their creation time.
 * @param items - normalized affairs.
 * @param start - inclusive start boundary.
 * @param end - inclusive end boundary.
 * @returns matching affairs.
 */
export function filterByTime(
  items: readonly OaAffairItem[],
  start?: string,
  end?: string,
): readonly OaAffairItem[] {
  if (start === undefined && end === undefined) return items
  const lower = start === undefined ? Number.NEGATIVE_INFINITY : dateBound(start, false)
  const upper = end === undefined ? Number.POSITIVE_INFINITY : dateBound(end, true)
  return items.filter((item) => {
    const stamp = timestamp(item.create_date)
    return stamp === null ? true : stamp >= lower && stamp <= upper
  })
}

/**
 * Filter affairs by title or application keyword.
 * @param items - normalized affairs.
 * @param scopes - keywords that must match at least once.
 * @returns matching affairs.
 */
export function filterByScope(
  items: readonly OaAffairItem[],
  scopes: readonly string[] | undefined,
): readonly OaAffairItem[] {
  if (scopes === undefined || scopes.length === 0) return items
  return items.filter(item => scopes.some(scope =>
    item.subject.includes(scope) || item.app.includes(scope)))
}

/**
 * Keep collaboration affairs and rows whose application cannot be classified.
 * @param items - normalized affairs.
 * @returns collaboration-only affairs.
 */
export function filterCollaboration(items: readonly OaAffairItem[]): readonly OaAffairItem[] {
  return items.filter(item => item.app === '' || item.app === 'collaboration')
}
