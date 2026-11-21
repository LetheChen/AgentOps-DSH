/**
 * Built-in capability definitions migrated from the AgentOps control plane.
 *
 * These rows describe product capabilities. Connector instances and secrets
 * remain deployment data and are never seeded here.
 *
 * @module @agentops/dsh-capability/catalog
 */

import type { CapabilityDefinition, CapabilityToolView, CapabilityTransport } from './types.ts'

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
  readonly default?: unknown
}

const f = (
  key: string,
  label: string,
  type: 'string' | 'number' | 'boolean' | 'array' | 'select' = 'string',
  requiredOrOptions: boolean | FieldOptions = true,
): { key: string; type: 'string' | 'number' | 'boolean' | 'array' | 'select'; label: string; required: boolean; placeholder?: string; description?: string; options?: readonly string[]; default?: unknown } => {
  const options = typeof requiredOrOptions === 'boolean' ? { required: requiredOrOptions } : requiredOrOptions
  return {
    key,
    label,
    type,
    required: options.required ?? true,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.options === undefined ? {} : { options: options.options }),
    ...(options.default === undefined ? {} : { default: options.default }),
  }
}

const SEEYON_AUTH_TEMPLATE = JSON.stringify({
  type: 'token-endpoint',
  token_url: '/seeyon/rest/token',
  token_method: 'POST',
  token_params_in: 'json',
  token_params: {
    userName: 'config.username',
    password: 'secret',
    loginName: 'config.login_name',
  },
  token_path: 'id',
  identity_path: 'bindingUser',
  default_ttl_seconds: 900,
  token_invalid_values: ['-1'],
  token_request_headers: { accept: 'application/json' },
  transport: 'header',
  token_name: 'token',
}, null, 2)

/** The ten first-party capabilities shown by the P0 capability center. */
export const BUILTIN_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    capabilityId: 'oa',
    name: '致远 OA',
    category: 'business',
    provider: 'seeyon',
    description: '致远 OA 审批、事项与表单接口。',
    transports: ['rest'],
    configSchema: [
      f('base_url', 'OA 地址', 'string', { placeholder: 'https://oa.example.com' }),
      f('username', 'REST 服务账号'),
      f('login_name', '绑定登录名', 'string', { required: false, description: '用于换取绑定该用户的 token。' }),
      f('member_code', '人员编码', 'string', { required: false, description: '待办/已办路由使用的 OA 人员编码。' }),
      f('member_id', '成员 ID', 'string', { required: false, description: '仅待办路由可在没有人员编码时使用。' }),
      f('auth', '认证配置 JSON', 'string', { description: '必填。声明 token 获取、身份绑定、失效值与传输方式。', default: SEEYON_AUTH_TEMPLATE }),
      credentialField('OA 密码'),
    ],
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
    configSchema: [
      f('app_id', 'App ID'),
      f('base_url', 'API 地址', 'string', {
        required: false,
        placeholder: 'https://open.feishu.cn',
        description: '仅支持 https://open.feishu.cn 或 https://open.larksuite.com；留空使用飞书。',
      }),
      credentialField('App Secret', {
        description: '飞书开放平台企业自建应用的 App Secret；加密保存。',
      }),
    ],
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
    provider: 'dsh-browser-use',
    description: 'DSH 原生浏览器能力：Chrome DevTools MCP provider，按 Agent/Session 隔离浏览器状态。',
    transports: ['mcp'],
    configSchema: [],
    riskLevel: 'high',
    authorizationCapabilityId: 'browser',
    supportsInstances: false,
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
    capabilityId: 'artifact-build',
    name: 'Artifact Build',
    category: 'automation',
    provider: 'agentops',
    description: 'Local artifact build instances that write release manifests without production SSH credentials.',
    transports: ['cli'],
    configSchema: [],
    riskLevel: 'medium',
    authorizationCapabilityId: 'artifact-build',
    supportsInstances: true,
    credentialRequired: false,
  },
  {
    capabilityId: 'deployment',
    name: 'Production Deployment',
    category: 'automation',
    provider: 'agentops',
    description: 'SSH-backed production release instances with a durable journal, image backup, health checks, and rollback evidence.',
    transports: ['cli'],
    configSchema: [],
    riskLevel: 'high',
    authorizationCapabilityId: 'deployment',
    supportsInstances: true,
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
    capabilityId: 'ssh', capabilityTransport: 'cli', authorizationCapabilityId: 'ssh',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-log', handlerFunction: 'log_query',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: '当前 DSH 仓库尚未提供 log_query handler，接口保留为待接线。', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'log_collection_cli', displayName: '日志采集 CLI', description: '本地与远程日志采集接口声明。',
    capabilityId: 'ssh', capabilityTransport: 'cli', authorizationCapabilityId: 'ssh',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'cli',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'oa_rest', displayName: '致远 OA 事项查询', description: '通过能力实例的 token 认证查询协同待办与已办事项。',
    capabilityId: 'oa', capabilityTransport: 'rest', authorizationCapabilityId: 'oa',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-capability/oa-tools', handlerFunction: 'oa_affair_query',
    allowedDomains: ['oa_query', 'smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'oa_affair_detail', displayName: '致远 OA 事项详情', description: '按 object_id 查询流程状态、审批完成时间和业务表单字段。',
    capabilityId: 'oa', capabilityTransport: 'rest', authorizationCapabilityId: 'oa',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-capability/oa-tools', handlerFunction: 'oa_affair_detail',
    allowedDomains: ['oa_query', 'smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'browser_use_chrome_devtools_mcp', displayName: 'DSH 原生浏览器', description: '由 DSH browser-use 的 Chrome DevTools MCP provider 按 Agent/Session 动态注册。',
    capabilityId: 'browser', capabilityTransport: 'mcp', authorizationCapabilityId: 'browser',
    requiresCapabilityInstance: false, handlerModule: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp', handlerFunction: 'mcp',
    allowedDomains: [], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true,
    runtimeNote: '实际模型工具名为 mcp__chrome-devtools-mcp__*；浏览器实例按 Agent/Session 隔离。',
    declarationKind: 'runtime_tool',
  },
  {
    toolId: 'feishu_docs_rest', displayName: '飞书文档 REST', description: '飞书云文档、电子表格、云空间与知识库 REST 接口声明。',
    capabilityId: 'feishu-docs', capabilityTransport: 'rest', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: 'metadata', handlerFunction: 'rest',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: false, runtimeNote: METADATA_NOTE, declarationKind: 'interface',
  },
  {
    toolId: 'feishu_docs_list', displayName: '飞书云文档目录', description: '列出能力实例绑定的飞书云空间目录，可递归返回子文件夹与文档 token。',
    capabilityId: 'feishu-docs', capabilityTransport: 'rest', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-capability/feishu-tools', handlerFunction: 'feishu_docs_list',
    allowedDomains: ['oa_query'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'feishu_docs_read', displayName: '飞书云文档读取', description: '按 token、docx URL 或 wiki URL 读取飞书云文档正文。',
    capabilityId: 'feishu-docs', capabilityTransport: 'rest', authorizationCapabilityId: 'feishu-docs',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-capability/feishu-tools', handlerFunction: 'feishu_docs_read',
    allowedDomains: ['oa_query'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
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
  {
    toolId: 'artifact_build', displayName: 'Artifact Build', description: 'Build a local release artifact and write its release manifest.',
    capabilityId: 'artifact-build', capabilityTransport: 'cli', authorizationCapabilityId: 'artifact-build',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-deployment', handlerFunction: 'artifact_build',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'deployment_plan', displayName: 'Deployment Plan', description: 'Verify a deployment instance and artifact without mutating production.',
    capabilityId: 'deployment', capabilityTransport: 'cli', authorizationCapabilityId: 'deployment',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-deployment', handlerFunction: 'deployment_plan',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'deployment_release', displayName: 'Deployment Release', description: 'Back up the current image, upload a verified artifact, execute the release, and check health.',
    capabilityId: 'deployment', capabilityTransport: 'cli', authorizationCapabilityId: 'deployment',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-deployment', handlerFunction: 'deployment_release',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'deployment_status', displayName: 'Deployment Status', description: 'Read the durable deployment journal and live image id.',
    capabilityId: 'deployment', capabilityTransport: 'cli', authorizationCapabilityId: 'deployment',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-deployment', handlerFunction: 'deployment_status',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
  {
    toolId: 'deployment_rollback', displayName: 'Deployment Rollback', description: 'Roll back a recorded healthy application image without restoring the database.',
    capabilityId: 'deployment', capabilityTransport: 'cli', authorizationCapabilityId: 'deployment',
    requiresCapabilityInstance: true, handlerModule: '@agentops/dsh-deployment', handlerFunction: 'deployment_rollback',
    allowedDomains: ['smart_ops'], allowedAgents: [], deniedAgents: [],
    runtimeAvailable: true, runtimeNote: '', declarationKind: 'runtime_tool',
  },
]

/**
 * List tool declarations, optionally for one capability.
 * @param capabilityId - capability id to filter by; omit for every capability.
 * @returns the matching tool declarations sorted by capability id and tool id.
 */
export function listCapabilityTools(capabilityId?: string): CapabilityToolView[] {
  return [...BUILTIN_CAPABILITY_TOOLS]
    .filter(item => capabilityId === undefined || item.capabilityId === capabilityId)
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId) || left.toolId.localeCompare(right.toolId))
}

/**
 * A catalogue row with its transports typed as capability transports.
 * @param transport - transport the capability must support.
 * @returns the capabilities that offer that transport.
 */
export function capabilitiesByTransport(transport: CapabilityTransport): readonly CapabilityDefinition[] {
  return BUILTIN_CAPABILITIES.filter(item => item.transports.includes(transport))
}
