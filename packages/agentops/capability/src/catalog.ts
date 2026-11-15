/**
 * Built-in capability definitions migrated from the AgentOps control plane.
 *
 * These rows describe product capabilities. Connector instances and secrets
 * remain deployment data and are never seeded here.
 *
 * @module @agentops/dsh-capability/catalog
 */

import type { CapabilityDefinition, CapabilityToolView, CapabilityTransport } from './types.ts'

const NO_INSTANCE_FIELD: readonly { key: string; type: 'string'; label: string; required: boolean }[] = []

interface CredentialFieldOptions {
  readonly placeholder?: string
  readonly description?: string
}

const credentialField = (
  label: string,
  options: CredentialFieldOptions = {},
): { key: string; type: 'string'; label: string; required: boolean; placeholder?: string; description?: string } => ({
  key: 'secret',
  type: 'string',
  label,
  required: false,
  ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  ...(options.description === undefined ? {} : { description: options.description }),
})

interface FieldOptions {
  readonly required?: boolean
  readonly placeholder?: string
  readonly description?: string
  readonly options?: readonly string[]
}

const f = (
  key: string,
  label: string,
  type: 'string' | 'number' | 'boolean' | 'array' | 'select' = 'string',
  requiredOrOptions: boolean | FieldOptions = true,
): { key: string; type: 'string' | 'number' | 'boolean' | 'array' | 'select'; label: string; required: boolean; placeholder?: string; description?: string; options?: readonly string[] } => {
  const options = typeof requiredOrOptions === 'boolean' ? { required: requiredOrOptions } : requiredOrOptions
  return {
    key,
    label,
    type,
    required: options.required ?? true,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.options === undefined ? {} : { options: options.options }),
  }
}

/** The ten first-party capabilities shown by the P0 capability center. */
export const BUILTIN_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    capabilityId: 'oa',
    name: '致远 OA',
    category: 'business',
    provider: 'seeyon',
    description: '致远 OA 审批、事项与表单接口。',
    transports: ['rest'],
    configSchema: [f('base_url', 'OA 地址'), f('username', '服务账号'), credentialField('OA 密码')],
    riskLevel: 'medium',
    authorizationCapabilityId: 'oa',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'feishu-docs',
    name: '飞书文档',
    category: 'collaboration',
    provider: 'feishu',
    description: '读写飞书云文档、电子表格与云空间文件。',
    transports: ['rest', 'oauth', 'mcp'],
    configSchema: [f('app_id', 'App ID'), f('app_secret', 'App Secret'), f('base_url', 'API 地址', 'string', false)],
    riskLevel: 'medium',
    authorizationCapabilityId: 'feishu-docs',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'feishu-bot',
    name: '飞书机器人',
    category: 'message',
    provider: 'feishu',
    description: '通过飞书机器人 Webhook 发送消息。',
    transports: ['webhook', 'rest'],
    configSchema: [
      f('webhook_host', 'Webhook 主机', 'string', {
        placeholder: 'open.feishu.cn',
        description: '只填主机名，不要带 https:// 或路径；完整 Webhook URL 填在下方加密凭证。',
      }),
      f('timeout_seconds', '超时时间（秒）', 'number', { required: false, description: '默认 10 秒，范围 1–30。' }),
      credentialField('Webhook URL', {
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxx',
        description: '完整 Webhook URL（含 token），加密保存，不会回显。',
      }),
    ],
    riskLevel: 'low',
    authorizationCapabilityId: 'feishu-bot',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'wecom',
    name: '企业微信',
    category: 'message',
    provider: 'wecom',
    description: '企业微信群机器人通知。',
    transports: ['webhook', 'rest'],
    configSchema: [
      f('webhook_host', 'Webhook 主机', 'string', {
        placeholder: 'qyapi.weixin.qq.com',
        description: '只填主机名，不要带 https:// 或路径；完整 Webhook URL 填在下方加密凭证。',
      }),
      f('mentions', '默认提醒成员', 'array', { required: false, placeholder: 'user1, user2' }),
      f('timeout_seconds', '超时时间（秒）', 'number', { required: false, description: '默认 10 秒，范围 1–30。' }),
      credentialField('Webhook URL', {
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx',
        description: '完整 Webhook URL（含 key），加密保存，不会回显。',
      }),
    ],
    riskLevel: 'low',
    authorizationCapabilityId: 'wecom',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'tianyancha',
    name: '天眼查',
    category: 'data',
    provider: 'tianyancha',
    description: '通过 MCP 或 REST 获取企业、股权与风险数据。',
    transports: ['mcp', 'rest'],
    configSchema: [f('api_base', 'API 地址'), credentialField('API Token')],
    riskLevel: 'medium',
    authorizationCapabilityId: 'tianyancha',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'github',
    name: 'GitHub',
    category: 'developer',
    provider: 'github',
    description: '通过 OAuth、REST 或 GitHub CLI 访问仓库、Issue 与 PR。',
    transports: ['oauth', 'cli', 'rest'],
    configSchema: [f('base_url', 'GitHub 地址', 'string', false), f('repository_allowlist', '允许仓库', 'array', false), credentialField('PAT')],
    riskLevel: 'medium',
    authorizationCapabilityId: 'github',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'browser',
    name: '浏览器能力',
    category: 'tool',
    provider: 'browser',
    description: '项目内置受管浏览器工具：Playwright + 系统 Chrome，固定动作 open/title/screenshot。',
    transports: ['skill', 'cli', 'mcp'],
    configSchema: [f('allowed_hosts', '允许访问主机', 'array'), f('headless', '无头模式', 'boolean', false), f('chrome_path', 'Chrome 路径', 'string', false)],
    riskLevel: 'high',
    authorizationCapabilityId: 'browser',
    supportsInstances: true,
    credentialRequired: false,
  },
  {
    capabilityId: 'database',
    name: '数据库',
    category: 'infrastructure',
    provider: 'database',
    description: '数据库查询、表结构与受控写操作。',
    transports: ['cli', 'rest'],
    configSchema: [
      f('engine', '引擎', 'select', { options: ['mysql', 'postgres', 'sqlite'] }),
      f('host', '主机'),
      f('port', '端口', 'number'),
      f('database', '数据库'),
      f('schema', 'Schema', 'string', false),
      f('username', '用户名'),
      f('auth_type', '认证方式', 'select', { required: false, options: ['password', 'private_key'] }),
      credentialField('数据库密码'),
    ],
    riskLevel: 'high',
    authorizationCapabilityId: 'database',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'ssh',
    name: 'SSH 服务器',
    category: 'infrastructure',
    provider: 'ssh',
    description: '通过受管 SSH 连接执行远程命令。',
    transports: ['cli'],
    configSchema: [f('host', '主机'), f('port', '端口', 'number', { required: false, placeholder: '22', description: '留空按 22 处理。' }), f('username', '用户名'), f('auth_type', '认证方式', 'select', { required: false, options: ['password', 'private_key'] }), f('private_key_path', '私钥路径', 'string', false), f('host_key_sha256', 'Host Key SHA256', 'string', false), credentialField('密码或私钥口令')],
    riskLevel: 'high',
    authorizationCapabilityId: 'ssh',
    supportsInstances: true,
    credentialRequired: true,
  },
  {
    capabilityId: 'log-collection',
    name: '日志采集',
    category: 'observability',
    provider: 'agentops',
    description: '采集本地或远程日志；远程采集复用 SSH 服务器，不单独创建日志采集实例。',
    transports: ['cli'],
    configSchema: NO_INSTANCE_FIELD,
    riskLevel: 'medium',
    authorizationCapabilityId: 'ssh',
    supportsInstances: false,
    credentialRequired: false,
  },
]

const METADATA_NOTE = '仅登记接口元数据；完成 MCP / CLI / REST / Webhook 桥接后才能运行'

/** Static tool declarations migrated from the AgentOps control plane. */
export const BUILTIN_CAPABILITY_TOOLS: readonly CapabilityToolView[] = [
  {
    toolId: 'sql_query', displayName: 'SQL 查询', description: '对已授权数据源执行单条只读 SELECT，校验表白名单并自动限制返回行数。',
    capabilityId: 'database', capabilityTransport: 'cli', authorizationCapabilityId: 'database',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-db', handlerFunction: 'sql_query',
    allowedDomains: ['smart_ops', 'smart_query'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'describe_database', displayName: '数据库结构', description: '读取已授权数据源的表和字段结构，避免模型凭记忆猜字段。',
    capabilityId: 'database', capabilityTransport: 'cli', authorizationCapabilityId: 'database',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-db', handlerFunction: 'describe_database',
    allowedDomains: ['smart_ops', 'smart_query'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'database_rest', displayName: '数据库 REST', description: '数据库查询与结构读取的 REST 接口声明。',
    capabilityId: 'database', capabilityTransport: 'rest', authorizationCapabilityId: 'database',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'log_query', displayName: '日志查询', description: '扫描本地或远程日志源，提取错误、时间和级别。',
    capabilityId: 'log-collection', capabilityTransport: 'cli', authorizationCapabilityId: 'ssh',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-log', handlerFunction: 'log_query',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 log_query handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'log_collection_cli', displayName: '日志采集 CLI', description: '本地与远程日志采集接口声明。',
    capabilityId: 'log-collection', capabilityTransport: 'cli', authorizationCapabilityId: 'ssh',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'cli',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'browser_open', displayName: '打开网页', description: '受管浏览器打开页面，并遵守实例 allowed_hosts 访问边界。',
    capabilityId: 'browser', capabilityTransport: 'cli', authorizationCapabilityId: 'browser',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-browser', handlerFunction: 'browser_open',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 browser_open handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'browser_title', displayName: '读取页面标题', description: '读取当前受管浏览器页面的标题。',
    capabilityId: 'browser', capabilityTransport: 'cli', authorizationCapabilityId: 'browser',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-browser', handlerFunction: 'browser_title',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 browser_title handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'browser_screenshot', displayName: '页面截图', description: '对当前受管浏览器页面截图，供验收或留证。',
    capabilityId: 'browser', capabilityTransport: 'cli', authorizationCapabilityId: 'browser',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-browser', handlerFunction: 'browser_screenshot',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 browser_screenshot handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'browser_mcp', displayName: '浏览器控制 MCP', description: '浏览器自动化 MCP Server 接口声明。',
    capabilityId: 'browser', capabilityTransport: 'mcp', authorizationCapabilityId: 'browser',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'mcp',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'oa_rest', displayName: '致远 OA REST', description: '致远 OA 审批、事项与表单 REST 接口声明。',
    capabilityId: 'oa', capabilityTransport: 'rest', authorizationCapabilityId: 'oa',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_docs_rest', displayName: '飞书文档 REST', description: '飞书云文档、电子表格、云空间与知识库 REST 接口声明。',
    capabilityId: 'feishu-docs', capabilityTransport: 'rest', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_docs_oauth', displayName: '飞书应用授权', description: '飞书应用 tenant_access_token / OAuth 凭证声明。',
    capabilityId: 'feishu-docs', capabilityTransport: 'oauth', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'oauth',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_docs_mcp', displayName: '飞书文档 MCP', description: '飞书文档 MCP Server 接入声明；当前未桥接到运行时。',
    capabilityId: 'feishu-docs', capabilityTransport: 'mcp', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'mcp',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_cli', displayName: '飞书 CLI', description: '飞书文档与云空间 CLI 工具声明；当前由 Skill / CLI 承接。',
    capabilityId: 'feishu-docs', capabilityTransport: 'cli', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'cli',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_bot_rest', displayName: '飞书机器人 REST', description: '飞书开放平台机器人消息 REST 接口声明。',
    capabilityId: 'feishu-bot', capabilityTransport: 'rest', authorizationCapabilityId: 'feishu-bot',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'tianyancha_mcp', displayName: '天眼查 MCP', description: '企业、股权与风险数据 MCP 接口声明。',
    capabilityId: 'tianyancha', capabilityTransport: 'mcp', authorizationCapabilityId: 'tianyancha',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'mcp',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'github_oauth', displayName: 'GitHub OAuth / PAT', description: 'GitHub OAuth 或 Personal Access Token 授权声明。',
    capabilityId: 'github', capabilityTransport: 'oauth', authorizationCapabilityId: 'github',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'oauth',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'github_rest', displayName: 'GitHub REST', description: 'GitHub REST API 接口声明。',
    capabilityId: 'github', capabilityTransport: 'rest', authorizationCapabilityId: 'github',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'wecom_notify', displayName: '企业微信通知', description: '向企业微信群机器人推送文本或 Markdown 告警。',
    capabilityId: 'wecom', capabilityTransport: 'webhook', authorizationCapabilityId: 'wecom',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-host', handlerFunction: 'wecom_notify',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 wecom_notify handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'wecom_webhook', displayName: '企业微信 Webhook', description: '企业微信群机器人 Webhook 接口声明。',
    capabilityId: 'wecom', capabilityTransport: 'webhook', authorizationCapabilityId: 'wecom',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'webhook',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
]

/** List tool declarations, optionally for one capability. */
export function listCapabilityTools(capabilityId?: string): CapabilityToolView[] {
  return [...BUILTIN_CAPABILITY_TOOLS]
    .filter(item => capabilityId === undefined || item.capabilityId === capabilityId)
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId) || left.toolId.localeCompare(right.toolId))
}

/** A catalogue row with its transports typed as capability transports. */
export function capabilitiesByTransport(transport: CapabilityTransport): readonly CapabilityDefinition[] {
  return BUILTIN_CAPABILITIES.filter(item => item.transports.includes(transport))
}
