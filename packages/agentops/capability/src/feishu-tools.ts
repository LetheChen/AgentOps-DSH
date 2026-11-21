/**
 * Capability-backed Feishu cloud-document tools.
 *
 * The tools resolve the Feishu docs instance bound to the executing Agent and
 * use the sealed App Secret to mint a tenant token. No credential, API host or
 * instance id is accepted from model arguments.
 *
 * @module @agentops/dsh-capability/feishu-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { asRecord } from './auth.ts'
import type { RestResponse } from './rest.ts'
import type { CapabilityRuntime } from './types.ts'
import { resolveFeishuDocsBaseUrl } from './validation.ts'

export const name = 'agentops-feishu-docs-tools'

export const inject = ['tools', 'capabilityRuntime', 'capabilityRest']

/** Tools registered by this plugin. */
export const TOOL_NAMES = ['feishu_docs_list', 'feishu_docs_read'] as const

/** Preset-scoped Feishu docs configuration. */
export interface FeishuDocsToolsConfig {
  /** Preset owning these tools; omission fails the registration. */
  readonly agentPreset?: string
  /** Optional fixed instance; omission resolves the only bound instance. */
  readonly instanceId?: string
  readonly only?: readonly string[]
}

/** Feishu tool configuration after the preset binding is resolved. */
interface ResolvedFeishuDocsToolsConfig extends Omit<FeishuDocsToolsConfig, 'agentPreset'> {
  readonly agentPreset: string
}

const FEISHU_AUTH = {
  type: 'token-endpoint',
  token_url: '/open-apis/auth/v3/tenant_access_token/internal',
  token_method: 'POST',
  token_params_in: 'json',
  token_params: {
    app_id: 'config.app_id',
    app_secret: { source: 'secret', in: 'json' },
  },
  token_path: 'tenant_access_token',
  expires_in_path: 'expire',
  default_ttl_seconds: 7200,
  transport: 'bearer',
  token_name: 'Authorization',
  token_invalid_values: [],
  token_request_headers: {
    accept: 'application/json',
    'content-type': 'application/json; charset=utf-8',
  },
} as const

interface FeishuFile {
  readonly [key: string]: string | null
  readonly token: string
  readonly type: string
  readonly name: string
  readonly url: string | null
  readonly modifiedTime: string | null
  readonly ownerId: string | null
}

interface FeishuListedFile extends FeishuFile {
  readonly path: string
}

interface FeishuListResult {
  readonly ok: boolean
  readonly root_token: string
  readonly items: FeishuListedFile[]
  readonly total: number
  readonly truncated: boolean
  readonly note: string
}

interface FeishuReadResult {
  readonly ok: boolean
  readonly token: string
  readonly title: string
  readonly content: string
  readonly truncated: boolean
  readonly note: string
}

interface DocTarget {
  readonly kind: 'docx' | 'wiki' | 'sheet' | 'file' | 'bitable' | 'mindnote'
  readonly token: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function runtimeWithFeishuAuth(runtime: CapabilityRuntime): CapabilityRuntime {
  return {
    ...runtime,
    config: {
      ...runtime.config,
      base_url: resolveFeishuDocsBaseUrl(runtime.config.base_url),
      auth: FEISHU_AUTH,
    },
  }
}

function responseFailure(response: RestResponse): string {
  const body = asRecord(response.json)
  const message = body === null ? '' : text(body.msg) || text(body.message)
  const code = body === null || typeof body.code !== 'number' ? '' : `code=${body.code}: `
  return `飞书接口 HTTP ${response.status}${message === '' ? '' : `：${code}${message}`}`
}

async function requestData(
  ctx: Context,
  runtime: CapabilityRuntime,
  path: string,
  query: Readonly<Record<string, string | number | undefined>>,
): Promise<Record<string, unknown>> {
  const response = await ctx.capabilityRest.transport.request(runtimeWithFeishuAuth(runtime), {
    method: 'GET',
    path,
    query,
    timeoutMs: 30_000,
  })
  if (!response.ok) throw new Error(responseFailure(response))
  const body = asRecord(response.json)
  if (body === null) throw new Error('飞书接口返回了非 JSON 对象')
  const code = typeof body.code === 'number' ? body.code : undefined
  if (code !== undefined && code !== 0) {
    const message = text(body.msg) || text(body.message) || '未知错误'
    throw new Error(`飞书接口错误 code=${code}: ${message}`)
  }
  const data = asRecord(body.data)
  return data ?? body
}

function readFile(value: unknown): FeishuFile | null {
  const record = asRecord(value)
  if (record === null) return null
  const token = text(record.token)
  const name = text(record.name)
  if (token === '' || name === '') return null
  return {
    token,
    type: text(record.type) || 'unknown',
    name,
    url: text(record.url) || null,
    modifiedTime: text(record.modified_time) || null,
    ownerId: text(record.owner_id) || null,
  }
}

async function listPage(
  ctx: Context,
  runtime: CapabilityRuntime,
  folderToken: string,
  pageToken: string,
): Promise<{ files: FeishuFile[]; nextPageToken: string | null }> {
  const data = await requestData(ctx, runtime, '/open-apis/drive/v1/files', {
    folder_token: folderToken === '' ? undefined : folderToken,
    page_size: 200,
    page_token: pageToken === '' ? undefined : pageToken,
  })
  if (!Array.isArray(data.files)) throw new Error('飞书云空间响应缺少 files 数组')
  const files: FeishuFile[] = []
  for (const value of data.files) {
    const file = readFile(value)
    if (file !== null) files.push(file)
  }
  return { files, nextPageToken: text(data.next_page_token) || null }
}

function parseFolderToken(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  const match = /\/folder\/([A-Za-z0-9_-]+)/.exec(raw)
  return match?.[1] ?? raw
}

function parseDocTarget(value: unknown): DocTarget {
  const raw = text(value)
  if (raw === '') throw new Error('缺少文档 token 或 URL')
  const match = /\/(docx|docs|wiki|sheets|file|bitable|mindnote)\/([A-Za-z0-9_-]+)/.exec(raw)
  if (match !== null) {
    const kind = match[1] === 'docs' ? 'docx' : match[1]
    if (kind === 'docx' || kind === 'wiki' || kind === 'sheet' || kind === 'file' || kind === 'bitable' || kind === 'mindnote') {
      return { kind, token: match[2] ?? '' }
    }
  }
  if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return { kind: 'docx', token: raw }
  throw new Error('无法解析文档 token 或 URL')
}

function failureList(rootToken: string | null, note: string): FeishuListResult {
  return { ok: false, root_token: rootToken ?? '', items: [], total: 0, truncated: false, note }
}

function failureRead(note: string): FeishuReadResult {
  return { ok: false, token: '', title: '', content: '', truncated: false, note }
}

function renderList(value: FeishuListResult): string {
  if (!value.ok) return `飞书云空间读取失败：${value.note}`
  const lines = [`飞书云空间：${value.total} 项${value.truncated ? '（已截断）' : ''}`]
  for (const item of value.items) {
    const suffix = item.url === null ? '' : ` — ${item.url}`
    lines.push(`- [${item.type}] ${item.path}${suffix}`)
  }
  if (value.note !== '') lines.push('', value.note)
  return lines.join('\n')
}

function renderRead(value: FeishuReadResult): string {
  if (!value.ok) return `飞书文档读取失败：${value.note}`
  const heading = value.title === '' ? '' : `# ${value.title}\n\n`
  return `${heading}${value.content}${value.truncated ? '\n\n（内容已截断）' : ''}`
}

async function listFiles(
  ctx: Context,
  runtime: CapabilityRuntime,
  rootToken: string,
  recursive: boolean,
  maxItems: number,
): Promise<FeishuListResult> {
  const items: FeishuListedFile[] = []
  const queue: Array<{ token: string; path: string; depth: number }> = [{ token: rootToken, path: '', depth: 0 }]
  const visited = new Set<string>()
  let truncated = false
  while (queue.length > 0 && items.length < maxItems) {
    const folder = queue.shift()
    if (folder === undefined) break
    const marker = folder.token === '' ? ':root' : folder.token
    if (visited.has(marker)) continue
    visited.add(marker)
    let pageToken = ''
    let pages = 0
    while (pages < 50 && items.length < maxItems) {
      const page = await listPage(ctx, runtime, folder.token, pageToken)
      pages += 1
      for (const file of page.files) {
        if (items.length >= maxItems) {
          truncated = true
          break
        }
        const path = folder.path === '' ? file.name : `${folder.path}/${file.name}`
        items.push({ ...file, path })
        if (recursive && file.type === 'folder' && folder.depth < 10) {
          queue.push({ token: file.token, path, depth: folder.depth + 1 })
        }
      }
      pageToken = page.nextPageToken ?? ''
      if (pageToken === '') break
      if (pages === 50) truncated = true
    }
    if (items.length >= maxItems) truncated = true
  }
  return {
    ok: true,
    root_token: rootToken,
    items,
    total: items.length,
    truncated,
    note: truncated ? `已达到 ${maxItems} 项上限或分页上限；可缩小目录后继续读取。` : '',
  }
}

async function readDocument(
  ctx: Context,
  runtime: CapabilityRuntime,
  input: unknown,
  maxChars: number,
): Promise<FeishuReadResult> {
  let target = parseDocTarget(input)
  let title = ''
  if (target.kind === 'wiki') {
    const nodeData = await requestData(ctx, runtime, '/open-apis/wiki/v2/spaces/get_node', { token: target.token })
    const node = asRecord(nodeData.node) ?? nodeData
    const objType = text(node.obj_type)
    if (objType !== 'docx') throw new Error(`知识库节点类型 ${objType || 'unknown'} 不是云文档`)
    target = { kind: 'docx', token: text(node.obj_token) }
    title = text(node.title)
  }
  if (target.kind !== 'docx') throw new Error(`当前只支持读取飞书云文档 docx，收到 ${target.kind}`)
  if (target.token === '') throw new Error('知识库节点缺少文档 token')
  const data = await requestData(ctx, runtime, '/open-apis/docs/v1/content', {
    doc_token: target.token,
    doc_type: 'docx',
    content_type: 'markdown',
  })
  const content = rawText(data.content)
  const truncated = content.length > maxChars
  return {
    ok: true,
    token: target.token,
    title,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    note: '',
  }
}

function createListTool(ctx: Context, config: ResolvedFeishuDocsToolsConfig): ToolDefinition {
  return defineTool({
    name: 'feishu_docs_list',
    description: 'List Feishu cloud-drive folders and documents through the Feishu docs instance bound to this Agent. '
      + 'Use recursive=true to walk subfolders. Returns tokens, paths, types and URLs; use a document token with feishu_docs_read.',
    parameters: {
      folder_token: { type: 'string', description: '目录 token 或飞书 /folder/ URL；省略时从云空间根目录开始。' },
      recursive: { type: 'boolean', description: '是否递归进入子文件夹，默认 true。' },
      max_items: { type: 'number', description: '最多返回多少项，默认 200，最大 1000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          root_token: { type: 'string', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value as FeishuListResult) }],
    },
    async execute(args) {
      let runtime: CapabilityRuntime
      try {
        runtime = ctx.capabilityRuntime.resolve(config.agentPreset, 'feishu-docs', config.instanceId)
      } catch (error) {
        return failureList(null, error instanceof Error ? error.message : String(error))
      }
      const folderToken = parseFolderToken(args.folder_token)
      const recursive = args.recursive !== false
      const maxItems = typeof args.max_items === 'number' && Number.isFinite(args.max_items)
        ? Math.min(Math.max(Math.floor(args.max_items), 1), 1000)
        : 200
      try {
        return await listFiles(ctx, runtime, folderToken, recursive, maxItems)
      } catch (error) {
        return failureList(folderToken === '' ? null : folderToken, error instanceof Error ? error.message : String(error))
      }
    },
  })
}

function createReadTool(ctx: Context, config: ResolvedFeishuDocsToolsConfig): ToolDefinition {
  return defineTool({
    name: 'feishu_docs_read',
    description: 'Read a Feishu cloud document as Markdown through the Feishu docs instance bound to this Agent. '
      + 'Accepts a docx token, /docx/ URL, or /wiki/ URL. Use feishu_docs_list first when you need to find a token.',
    parameters: {
      document: { type: 'string', required: true, description: '文档 token、/docx/ URL 或 /wiki/ URL。' },
      max_chars: { type: 'number', description: '最多返回多少字符，默认 50000，最大 200000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          token: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRead(value as FeishuReadResult) }],
    },
    async execute(args) {
      let runtime: CapabilityRuntime
      try {
        runtime = ctx.capabilityRuntime.resolve(config.agentPreset, 'feishu-docs', config.instanceId)
      } catch (error) {
        return failureRead(error instanceof Error ? error.message : String(error))
      }
      const maxChars = typeof args.max_chars === 'number' && Number.isFinite(args.max_chars)
        ? Math.min(Math.max(Math.floor(args.max_chars), 1), 200_000)
        : 50_000
      try {
        return await readDocument(ctx, runtime, args.document, maxChars)
      } catch (error) {
        return failureRead(error instanceof Error ? error.message : String(error))
      }
    },
  })
}

/**
 * Register Feishu cloud-document tools for one preset.
 * @param ctx - Agent-scoped context carrying tool and capability services.
 * @param config - preset binding and optional fixed instance.
 */
export function apply(ctx: Context, config: FeishuDocsToolsConfig): void {
  const agentPreset = config.agentPreset?.trim() ?? ''
  if (agentPreset === '') {
    throw new Error('@agentops/dsh-capability/feishu-tools requires config.agentPreset; add it to the preset plugin row')
  }
  const allow = config.only === undefined ? undefined : new Set(config.only)
  for (const tool of [createListTool(ctx, { ...config, agentPreset }), createReadTool(ctx, { ...config, agentPreset })]) {
    if (allow !== undefined && !allow.has(tool.name)) continue
    ctx.tools.register(tool)
  }
}
