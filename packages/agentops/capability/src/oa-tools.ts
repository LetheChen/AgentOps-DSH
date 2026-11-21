/**
 * Capability-backed Seeyon OA affairs tools.
 *
 * The tools resolve the bound OA instance and its configured identity, then
 * send affairs requests through the shared REST transport. Token acquisition,
 * subject-scoped caching, and 401 renewal stay in the transport and broker; no
 * token, URL, account, or member code is accepted from model arguments.
 *
 * Collaboration affairs only. Official documents (`edoc`) are out of scope and
 * are filtered out even when the vendor route returns them.
 *
 * @module @agentops/dsh-capability/oa-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { CapabilityRuntime } from './types.ts'
import {
  authSubject,
  buildAffairRequest,
  buildFlowDataRequest,
  buildFlowStateRequest,
  filterByScope,
  filterByTime,
  filterCollaboration,
  normalizeAffair,
  readAffairRows,
  readAttachmentMetadata,
  readFormFields,
  readFormState,
  readFlowState,
  readScopes,
  parseOaJson,
  readTimeRange,
  resolveOaSubject,
  type OaAffairBox,
  type OaAffairItem,
  type OaDetailLevel,
} from './oa-affairs.ts'

export {
  authSubject,
  buildAffairRequest,
  buildFlowDataRequest,
  buildFlowStateRequest,
  filterByScope,
  filterByTime,
  filterCollaboration,
  normalizeAffair,
  readAffairRows,
  readAttachmentMetadata,
  readFormFields,
  readFormState,
  readFlowState,
  readScopes,
  parseOaJson,
  readTimeRange,
  resolveOaSubject,
} from './oa-affairs.ts'
export type { OaAffairBox, OaAffairDetail, OaAffairItem, OaAffairSubject, OaDetailLevel } from './oa-affairs.ts'

export const name = 'agentops-oa-tools'

export const inject = ['tools', 'capabilityRuntime', 'capabilityRest']

/** Tools registered by this plugin. */
export const TOOL_NAMES = ['oa_affair_query', 'oa_affair_detail'] as const

/** Preset-scoped OA configuration. */
export interface OaToolsConfig {
  readonly agentPreset: string
  /** Optional fixed instance; omission resolves the only bound instance. */
  readonly instanceId?: string
  readonly only?: readonly string[]
}

interface OaAffairQueryResult {
  readonly ok: boolean
  readonly box: OaAffairBox
  readonly page_no: number
  readonly page_size: number
  readonly scanned_pages: number
  readonly truncated: boolean
  readonly items: OaAffairItem[]
  readonly note: string
}

interface OaAffairDetailResult {
  readonly ok: boolean
  readonly object_id: string
  readonly detail_level: OaDetailLevel
  readonly flow_state?: number
  readonly state_label?: string
  readonly state_caveat?: string
  readonly approve_date?: string
  readonly finished_flag?: string
  readonly form_state?: string
  readonly fields?: Record<string, string>[]
  readonly attachments?: Record<string, string>[]
  readonly note: string
}

function queryFailure(
  box: OaAffairBox,
  pageNo: number,
  pageSize: number,
  note: string,
  scannedPages = 0,
): OaAffairQueryResult {
  return {
    ok: false,
    box,
    page_no: pageNo,
    page_size: pageSize,
    scanned_pages: scannedPages,
    truncated: false,
    items: [],
    note,
  }
}

function detailFailure(objectId: string, level: OaDetailLevel, note: string): OaAffairDetailResult {
  return { ok: false, object_id: objectId, detail_level: level, note }
}

function responseTypeDiagnostic(response: { json: unknown; contentType: string | null; text: string }): string {
  if (response.json !== undefined) return ''
  const media = response.contentType === null ? '' : `（${response.contentType}）`
  const body = response.text.trim() === '' ? '' : `：${response.text.trim()}`
  return `响应不是 JSON${media}${body}`
}

function createQueryTool(ctx: Context, config: OaToolsConfig): ToolDefinition {
  return defineTool({
    name: 'oa_affair_query',
    description: '查询当前登录用户本人的待办或已办协同事项。'
      + '查询对象由 OA 实例绑定的身份决定，不接受人员编码入参；只查协同事项，不含公文。'
      + '返回事项标题、发起时间、状态、节点、发起人与单据编号；OA 不返回总数。',
    parameters: {
      box: {
        type: 'string',
        description: '事项盒：pending 待办（默认）/ done 已办。',
      },
      time_range: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'string', description: '区间起点，闭。' },
          end: { type: 'string', description: '区间终点，闭。' },
        },
        description: '按发起时间过滤，闭区间，ISO 日期时间。',
      },
      biz_scope: {
        type: 'array',
        description: '业务范围关键词，按标题与业务类型过滤，例如 差旅报销。',
      },
      page_no: { type: 'number', description: '起始页码，从 1 开始。' },
      page_size: { type: 'number', description: '每页条数，默认 20，最大 100。' },
      max_pages: { type: 'number', description: '最多扫描页数，默认 10，最大 50。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          box: { type: 'string', required: true },
          page_no: { type: 'integer', required: true },
          page_size: { type: 'integer', required: true },
          scanned_pages: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.box}：${value.items.length} 条。${value.note}`
          + (value.items.length === 0
            ? ''
            : ` 首条 ${JSON.stringify(value.items[0])}`),
      }],
    },
    async execute(args) {
      let runtime: CapabilityRuntime
      try {
        runtime = ctx.capabilityRuntime.resolve(config.agentPreset, 'oa', config.instanceId)
      } catch (error) {
        return queryFailure('pending', 1, 0, error instanceof Error ? error.message : String(error))
      }
      const box: OaAffairBox = args.box === 'done' ? 'done' : 'pending'
      const pageNo = typeof args.page_no === 'number' && args.page_no > 0 ? Math.floor(args.page_no) : 1
      const pageSize = typeof args.page_size === 'number' && args.page_size > 0
        ? Math.min(Math.floor(args.page_size), 100)
        : 20
      const maxPages = typeof args.max_pages === 'number' && args.max_pages > 0
        ? Math.min(Math.floor(args.max_pages), 50)
        : 10
      try {
        const timeRange = readTimeRange(args.time_range)
        const scopes = readScopes(args.biz_scope)
        const subject = resolveOaSubject(runtime)
        const target = buildAffairRequest(box, subject)
        const tokenSubject = authSubject(subject)
        const rows: Record<string, unknown>[] = []
        let scannedPages = 0
        let truncated = false
        for (let offset = 0; offset < maxPages; offset += 1) {
          const currentPage = pageNo + offset
          const response = await ctx.capabilityRest.transport.request(runtime, {
            method: 'GET',
            path: target.path,
            query: {
              ...target.query,
              pageNo: String(currentPage),
              pageSize: String(pageSize),
            },
            subject: tokenSubject,
            timeoutMs: 30_000,
          })
          scannedPages = offset + 1
          if (!response.ok) {
            const diagnostic = response.text.trim() === '' ? '' : `：${response.text.trim()}`
            return queryFailure(box, pageNo, pageSize, `OA 事项接口返回 ${response.status}${diagnostic}`, scannedPages)
          }
          const parsedResponse = response.json === undefined ? parseOaJson(response.rawText) : response.json
          if (parsedResponse === undefined || parsedResponse === null) {
            return queryFailure(box, pageNo, pageSize, responseTypeDiagnostic(response), scannedPages)
          }
          const pageRows = readAffairRows(parsedResponse)
          rows.push(...pageRows.map(row => ({ ...row })))
          if (pageRows.length < pageSize) break
          if (offset === maxPages - 1) truncated = true
        }
        const items = filterByScope(
          filterByTime(
            filterCollaboration(rows.map(normalizeAffair)),
            timeRange.start,
            timeRange.end,
          ),
          scopes,
        ).slice().sort((left, right) => right.create_date.localeCompare(left.create_date))
        const noteParts = ['OA 不返回总数；已按绑定身份和协同事项过滤。']
        if (truncated) noteParts.push(`已达到最多 ${maxPages} 页的扫描上限，结果可能不完整。`)
        if (items.length === 0) noteParts.push('本次未查到符合条件的事项。')
        return {
          ok: true,
          box,
          page_no: pageNo,
          page_size: pageSize,
          scanned_pages: scannedPages,
          truncated,
          items: items.map(item => ({ ...item })),
          note: noteParts.join(''),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return queryFailure(box, pageNo, pageSize, message)
      }
    },
  })
}

function createDetailTool(ctx: Context, config: OaToolsConfig): ToolDefinition {
  return defineTool({
    name: 'oa_affair_detail',
    description: '查询单条协同事项的流程状态、审批完成时间和业务表单字段。'
      + 'object_id 必须来自 oa_affair_query 的单据编号；查询身份仍由 OA 实例锁定。'
      + 'full 会读取业务表单，成本高于状态查询。',
    parameters: {
      object_id: { type: 'string', description: '事项单据编号，来自 oa_affair_query 的 object_id。' },
      detail_level: {
        type: 'string',
        description: 'detail_level：state 仅流程状态（默认最快）/ basic 加审批完成时间 / full 加业务表单字段和附件元信息。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          object_id: { type: 'string', required: true },
          detail_level: { type: 'string', required: true },
          flow_state: { type: 'integer' },
          state_label: { type: 'string' },
          state_caveat: { type: 'string' },
          approve_date: { type: 'string' },
          finished_flag: { type: 'string' },
          form_state: { type: 'string' },
          fields: { type: 'array', items: { type: 'json' } },
          attachments: { type: 'array', items: { type: 'json' } },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `单据 ${value.object_id}：${value.ok ? value.state_label ?? value.detail_level : value.note}`,
      }],
    },
    async execute(args) {
      let runtime: CapabilityRuntime
      try {
        runtime = ctx.capabilityRuntime.resolve(config.agentPreset, 'oa', config.instanceId)
      } catch (error) {
        const objectId = typeof args.object_id === 'string' ? args.object_id.trim() : ''
        return detailFailure(objectId, 'state', error instanceof Error ? error.message : String(error))
      }
      const objectId = typeof args.object_id === 'string' ? args.object_id.trim() : ''
      const level: OaDetailLevel = args.detail_level === 'basic' || args.detail_level === 'full'
        ? args.detail_level
        : 'state'
      try {
        const subject = resolveOaSubject(runtime)
        const tokenSubject = authSubject(subject)
        const stateResponse = await ctx.capabilityRest.transport.request(runtime, {
          method: 'GET',
          path: buildFlowStateRequest(objectId),
          subject: tokenSubject,
          timeoutMs: 30_000,
        })
        if (!stateResponse.ok) {
          return detailFailure(objectId, level, `OA flow/state 返回 ${stateResponse.status}${responseTypeDiagnostic(stateResponse)}`)
        }
        const state = readFlowState(stateResponse.text)
        const result: OaAffairDetailResult = { ...state, ok: true, object_id: objectId, detail_level: level, note: '' }
        if (level === 'state') {
          return { ...result, note: '已返回流程状态；basic 增加审批完成时间，full 增加业务表单字段。' }
        }
        const formResponse = await ctx.capabilityRest.transport.request(runtime, {
          method: 'GET',
          path: '/seeyon/rest/form/getformdata/' + encodeURIComponent(objectId),
          subject: tokenSubject,
          timeoutMs: 30_000,
        })
        if (formResponse.ok && formResponse.json !== undefined) {
          const form = readFormState(formResponse.json)
          if (form !== undefined) Object.assign(result, form)
        }
        if (level === 'basic') {
          return { ...result, note: '已返回流程状态与表单完成时间；full 可读取业务表单字段和附件元信息。' }
        }
        const flowRequest = buildFlowDataRequest(objectId)
        const flowResponse = await ctx.capabilityRest.transport.request(runtime, {
          method: 'GET',
          path: flowRequest.path,
          query: flowRequest.query,
          subject: tokenSubject,
          timeoutMs: 60_000,
        })
        if (!flowResponse.ok || flowResponse.json === undefined) {
          return {
            ...result,
            note: `OA flow/data 返回 ${flowResponse.status}${responseTypeDiagnostic(flowResponse)}`,
          }
        }
        return {
          ...result,
          fields: readFormFields(flowResponse.json).map(field => ({ label: field.label, value: field.value })),
          attachments: readAttachmentMetadata(flowResponse.json).map(entry => ({
            file_id: entry.file_id,
            name: entry.name,
            suffix: entry.suffix,
          })),
          note: '已返回流程状态、表单完成时间、业务表单字段与附件元信息；附件文件内容未下载。',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return detailFailure(objectId, level, message)
      }
    },
  })
}

/**
 * Register the OA affairs tools for one preset.
 * @param ctx - Agent-scoped context.
 * @param config - preset binding and optional fixed instance.
 */
export function apply(ctx: Context, config: OaToolsConfig): void {
  const agentPreset = config.agentPreset.trim()
  if (agentPreset === '') {
    throw new Error('@agentops/dsh-capability/oa-tools requires config.agentPreset; add it to the preset plugin row')
  }
  const allow = config.only === undefined ? undefined : new Set(config.only)
  const tools = [createQueryTool(ctx, { ...config, agentPreset }), createDetailTool(ctx, { ...config, agentPreset })]
  for (const tool of tools) {
    if (allow !== undefined && !allow.has(tool.name)) continue
    ctx.tools.register(tool)
  }
}
