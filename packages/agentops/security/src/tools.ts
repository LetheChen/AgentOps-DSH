/**
 * Guarded write tools for the security domain.
 *
 * Every tool here changes access, so each one requires an explicit intent field
 * (`reason` or `confirm`) and writes an audit event in the same transaction. A
 * token's plaintext is returned exactly once; only its hash is stored.
 *
 * @module @agentops/dsh-security/tools
 */

import { randomBytes, randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveSecurityDbPath, DEFAULT_CONFIG } from './dsh.ts'
import type { SecurityPluginConfig } from './dsh.ts'
import { SecurityStore } from './store.ts'
import type { UserStatus } from './types.ts'

export const name = 'agentops-security-tools'

export const inject = ['tools']

/** `only` 过滤器：undefined = 全注册；空数组 = 全禁；未知名字一律抛错（防拼错后静默失效）。 */
function onlyRegistrar(
  ctx: Context,
  only: readonly string[] | undefined,
  known: readonly string[],
): (definition: Parameters<Context['tools']['register']>[0]) => void {
  if (only !== undefined) {
    for (const name of only) {
      if (!known.includes(name)) {
        throw new Error(`only 含本插件不注册的工具 "${name}"；已知：${known.join(', ')}`)
      }
    }
  }
  const allow = only === undefined ? undefined : new Set(only)
  return (definition) => {
    if (allow === undefined || allow.has(definition.name)) ctx.tools.register(definition)
  }
}

/** 本插件会注册的工具名（`only` 的合法取值）。 */
export const TOOL_NAMES = ['security_user_create', 'security_user_set_status', 'security_role_assign', 'security_token_issue'] as const

/** Configuration of the security tools plugin. */
export interface SecurityToolsConfig extends SecurityPluginConfig {
  /** Injected store, used by tests so the caller owns the handle. */
  store?: SecurityStore
}

const ACTOR = 'agent'
const STATUSES: UserStatus[] = ['active', 'disabled']

/**
 * Register the four guarded tools.
 * @param ctx - Agent-scoped context carrying the tool registry.
 * @param config - database location.
 */
export function apply(ctx: Context, config: SecurityToolsConfig = DEFAULT_CONFIG): void {
  const dbPath = resolveSecurityDbPath(config)
  let store: SecurityStore | null = config.store ?? null
  const open = (): SecurityStore => (store ??= new SecurityStore(dbPath))
  const reg = onlyRegistrar(ctx, (config as { only?: readonly string[] }).only, TOOL_NAMES)

  reg(defineTool({
    name: 'security_user_create',
    description:
      'Create a user in the AgentOps security database. Requires a reason; the reason and actor are '
      + 'recorded in the audit trail. This grants no permissions by itself — assign a role separately.',
    parameters: {
      name: { type: 'string', required: true },
      email: { type: 'string' },
      reason: { type: 'string', required: true, description: 'Why this user is being created.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Created user ${value.id} (v${value.version}).` : `Refused: ${value.error}`,
      }],
    },
    execute(args) {
      try {
        const id = `u_${randomUUID().slice(0, 8)}`
        const user = open().createUser({
          id,
          name: args.name,
          ...(args.email === undefined ? {} : { email: args.email }),
          actor: ACTOR,
        })
        open().recordAudit({ actor: ACTOR, action: 'user.create.reason', target: id, detail: { reason: args.reason } })
        return Promise.resolve({ ok: true, id: user.id, version: user.version })
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  reg(defineTool({
    name: 'security_user_set_status',
    description:
      'Enable or disable a user. Disabling revokes access, so it requires confirm=true and the version you '
      + 'read first; a stale version is rejected instead of overwriting a concurrent change.',
    parameters: {
      userId: { type: 'string', required: true },
      status: { type: 'string', required: true, description: 'active | disabled.' },
      expectedVersion: { type: 'integer', required: true },
      confirm: { type: 'boolean', required: true, description: 'Must be true; a human asked for this.' },
      reason: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          version: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `User is now ${value.status} (v${value.version}).` : `Refused: ${value.error}`,
      }],
    },
    execute(args) {
      if (!args.confirm) {
        return Promise.resolve({ ok: false, error: '需要 confirm=true：改状态属于权限变更' })
      }
      if (!STATUSES.includes(args.status as UserStatus)) {
        return Promise.resolve({ ok: false, error: `非法状态：${args.status}` })
      }
      try {
        const user = open().setUserStatus({
          id: args.userId,
          status: args.status as UserStatus,
          actor: ACTOR,
          expectedVersion: args.expectedVersion,
        })
        if (args.reason !== undefined) {
          open().recordAudit({ actor: ACTOR, action: 'user.status.reason', target: user.id, detail: { reason: args.reason } })
        }
        return Promise.resolve({ ok: true, status: user.status, version: user.version })
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  reg(defineTool({
    name: 'security_role_assign',
    description:
      'Grant a role to a user. Requires a justification, which is audited. Granting a role that the user '
      + 'already has is a no-op rather than an error.',
    parameters: {
      userId: { type: 'string', required: true },
      roleId: { type: 'string', required: true },
      justification: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          permissions: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Role granted. Effective permissions: ${(value.permissions ?? []).join(', ') || '(none)'}` : `Refused: ${value.error}`,
      }],
    },
    execute(args) {
      try {
        const db = open()
        if (db.getRole(args.roleId) === null) return Promise.resolve({ ok: false, error: `角色不存在：${args.roleId}` })
        if (db.getUser(args.userId) === null) return Promise.resolve({ ok: false, error: `用户不存在：${args.userId}` })
        db.assignRole({ userId: args.userId, roleId: args.roleId, grantedBy: ACTOR })
        db.recordAudit({
          actor: ACTOR, action: 'role.assign.reason', target: `${args.userId}:${args.roleId}`,
          detail: { justification: args.justification },
        })
        return Promise.resolve({ ok: true, permissions: db.permissionsOf(args.userId) })
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  reg(defineTool({
    name: 'security_token_issue',
    description:
      'Issue a personal access token. The plaintext is returned ONCE and never stored; only a hash and a '
      + 'short prefix are kept. Requires confirm=true and a reason. Never print the token into a shared log.',
    parameters: {
      userId: { type: 'string', required: true },
      name: { type: 'string', required: true },
      reason: { type: 'string', required: true },
      confirm: { type: 'boolean', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          token: { type: 'string' },
          id: { type: 'string' },
          prefix: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Token ${value.id} issued (prefix ${value.prefix}). Show it to the user now; it cannot be read again.`
          : `Refused: ${value.error}`,
      }],
    },
    execute(args) {
      if (!args.confirm) {
        return Promise.resolve({ ok: false, error: '需要 confirm=true：签发 Token 属于高危操作' })
      }
      try {
        const db = open()
        if (db.getUser(args.userId) === null) {
          return Promise.resolve({ ok: false, error: `用户不存在：${args.userId}` })
        }
        const secret = `aops_${randomBytes(24).toString('hex')}`
        const id = `tok_${randomUUID().slice(0, 8)}`
        const token = db.createToken({ id, userId: args.userId, name: args.name, secret, actor: ACTOR })
        db.recordAudit({ actor: ACTOR, action: 'token.create.reason', target: id, detail: { reason: args.reason } })
        return Promise.resolve({ ok: true, token: secret, id: token.id, prefix: token.prefix })
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
