/**
 * Parsers for the business-domain registry and the Actor surface whitelist.
 *
 * Both files are durable deployment assets: a domain YAML under
 * `agentops/domains` carries the defaults an Agent inherits, and an Actor
 * profile under `agentops/actors` carries the surface views that Actor may
 * publish. The parsers run at the file boundary, so an invalid file is
 * reported instead of silently degrading into an empty registry.
 *
 * @module @agentops/dsh-contracts/catalog
 */

import { YAMLException, load } from 'js-yaml'

import type {
  ActorSurfaceField,
  ActorSurfaceView,
  ActorVisualProfile,
  AgentPermissions,
  DomainDefinition,
  ValidationIssue,
  ValidationResult,
} from './types.js'

const FIELD_TYPES: readonly string[] = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'enum']
const PHASES: readonly string[] = ['started', 'partial', 'final', 'superseded']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse one business-domain definition.
 *
 * A domain supplies defaults, not constraints: an Agent still declares its own
 * harness, model, and permissions. A missing `domain` id is fatal because the
 * registry would have no key; every other field falls back to the legacy
 * default and records an issue.
 * @param input - parsed YAML, an API body, or a database row.
 * @returns the definition, or every issue found.
 */
export function parseDomainDefinition(input: unknown): ValidationResult<DomainDefinition> {
  const issues: ValidationIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: '业务域定义必须是对象' }] }

  const domain = readString(input.domain)?.trim()
  if (domain === undefined || domain === '') {
    issues.push({ path: 'domain', message: '缺少 domain' })
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(domain)) {
    issues.push({ path: 'domain', message: 'domain 只能包含字母、数字、下划线或连字符' })
  }

  const displayName = readString(input.display_name) ?? readString(input.displayName)
  if (input.display_name !== undefined && displayName === undefined) {
    issues.push({ path: 'display_name', message: 'display_name 必须是字符串' })
  }

  const description = readString(input.description)
  if (input.description !== undefined && description === undefined) {
    issues.push({ path: 'description', message: 'description 必须是字符串' })
  }

  const rawPermissions = input.default_permissions ?? input.defaultPermissions
  if (rawPermissions !== undefined && !isRecord(rawPermissions)) {
    issues.push({ path: 'default_permissions', message: 'default_permissions 必须是对象' })
  }
  const permissions = isRecord(rawPermissions) ? rawPermissions : {}
  const allowedRaw = permissions.allowed_tools ?? permissions.allowedTools
  const deniedRaw = permissions.denied_tools ?? permissions.deniedTools
  const allowedTools = allowedRaw === undefined ? [] : readStringArray(allowedRaw)
  const deniedTools = deniedRaw === undefined ? [] : readStringArray(deniedRaw)
  if (allowedTools === undefined) issues.push({ path: 'default_permissions.allowed_tools', message: 'allowed_tools 必须是字符串数组' })
  if (deniedTools === undefined) issues.push({ path: 'default_permissions.denied_tools', message: 'denied_tools 必须是字符串数组' })

  const knowledgeRaw = input.default_knowledge_bases ?? input.defaultKnowledgeBases
  const knowledgeBases = knowledgeRaw === undefined ? [] : readStringArray(knowledgeRaw)
  if (knowledgeBases === undefined) {
    issues.push({ path: 'default_knowledge_bases', message: 'default_knowledge_bases 必须是字符串数组' })
  }

  const costRaw = input.cost_limit_per_run ?? input.costLimitPerRun
  const costLimitPerRun = costRaw === undefined ? 1 : readNumber(costRaw)
  if (costLimitPerRun !== undefined && costLimitPerRun < 0) {
    issues.push({ path: 'cost_limit_per_run', message: 'cost_limit_per_run 必须是非负数' })
  }

  const fatal = issues.filter(issue => issue.path === 'domain')
  if (fatal.length > 0) return { ok: false, issues }

  const defaultPermissions: AgentPermissions = {
    allowedTools: allowedTools ?? [],
    deniedTools: deniedTools ?? [],
  }

  return {
    ok: true,
    value: {
      domain: domain as string,
      displayName: displayName ?? domain as string,
      description: description ?? '',
      defaultPermissions,
      defaultKnowledgeBases: knowledgeBases ?? [],
      costLimitPerRun: costLimitPerRun ?? 1,
    },
    issues,
  }
}

/**
 * Parse YAML text into a business-domain definition.
 * @param text - the file contents.
 * @returns the definition, or every issue found.
 */
export function loadDomainDefinition(text: string): ValidationResult<DomainDefinition> {
  let input: unknown
  try {
    input = load(text)
  } catch (reason) {
    if (reason instanceof YAMLException) {
      return {
        ok: false,
        issues: [{
          path: '',
          message: reason.reason,
          kind: 'yaml',
          line: reason.mark.line + 1,
          column: reason.mark.column + 1,
        }],
      }
    }
    throw reason
  }
  return parseDomainDefinition(input)
}

/**
 * Parse one Actor surface field constraint.
 * @param raw - the field object from the profile.
 * @param path - field path used in issues.
 * @returns the field constraint, or null when it cannot be used.
 */
function parseSurfaceField(raw: unknown, path: string): { field?: ActorSurfaceField; issues: readonly ValidationIssue[] } {
  if (!isRecord(raw)) return { issues: [{ path, message: '字段约束必须是对象' }] }
  const issues: ValidationIssue[] = []
  const type = readString(raw.type)
  if (type === undefined || !FIELD_TYPES.includes(type)) {
    issues.push({ path: `${path}.type`, message: `字段类型必须是 ${FIELD_TYPES.join(' / ')} 之一` })
    return { issues }
  }

  const maxLength = readNumber(raw.max_length)
  if (raw.max_length !== undefined && maxLength === undefined) {
    issues.push({ path: `${path}.max_length`, message: 'max_length 必须是数字' })
  }
  const min = readNumber(raw.min)
  if (raw.min !== undefined && min === undefined) issues.push({ path: `${path}.min`, message: 'min 必须是数字' })
  const max = readNumber(raw.max)
  if (raw.max !== undefined && max === undefined) issues.push({ path: `${path}.max`, message: 'max 必须是数字' })

  const enumRaw = raw.values ?? raw.enum_values
  const enumValues = enumRaw === undefined ? undefined : readStringArray(enumRaw)
  if (enumRaw !== undefined && enumValues === undefined) {
    issues.push({ path: `${path}.values`, message: 'values 必须是字符串数组' })
  }
  if (type === 'enum' && (enumValues === undefined || enumValues.length === 0)) {
    issues.push({ path: `${path}.values`, message: 'enum 字段必须声明 values' })
  }

  return {
    issues,
    field: {
      type,
      required: raw.required === true,
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(enumValues === undefined ? {} : { enumValues }),
    },
  }
}

/**
 * Parse one Actor surface view.
 * @param raw - the view object from the profile.
 * @param path - view path used in issues.
 * @returns the view, or null when it cannot be used.
 */
function parseSurfaceView(raw: unknown, path: string): { view?: ActorSurfaceView; issues: readonly ValidationIssue[] } {
  if (!isRecord(raw)) return { issues: [{ path, message: '视图必须是对象' }] }
  const issues: ValidationIssue[] = []

  const viewId = readString(raw.view_id)?.trim()
  if (viewId === undefined || viewId === '') {
    issues.push({ path: `${path}.view_id`, message: '缺少 view_id' })
  }

  const outputContract = readString(raw.output_contract) ?? ''
  const description = readString(raw.description) ?? ''

  const phasesRaw = raw.required_phases
  const requiredPhases = phasesRaw === undefined ? [] : readStringArray(phasesRaw)
  if (phasesRaw !== undefined && requiredPhases === undefined) {
    issues.push({ path: `${path}.required_phases`, message: 'required_phases 必须是字符串数组' })
  }
  for (const phase of requiredPhases ?? []) {
    if (!PHASES.includes(phase)) {
      issues.push({ path: `${path}.required_phases`, message: `未知 phase：${phase}` })
    }
  }

  const fields: Record<string, ActorSurfaceField> = {}
  const rawFields = raw.fields
  if (rawFields !== undefined && !isRecord(rawFields)) {
    issues.push({ path: `${path}.fields`, message: 'fields 必须是对象' })
  }
  for (const [name, value] of Object.entries(isRecord(rawFields) ? rawFields : {})) {
    const parsed = parseSurfaceField(value, `${path}.fields.${name}`)
    issues.push(...parsed.issues)
    if (parsed.field !== undefined) fields[name] = parsed.field
  }

  if (issues.some(issue => issue.path === `${path}.view_id`)) return { issues }
  return {
    issues,
    view: {
      viewId: viewId as string,
      outputContract,
      description,
      requiredPhases: requiredPhases ?? [],
      fields,
    },
  }
}

/**
 * Parse one Actor visual profile.
 *
 * The profile is the whitelist of surface views an Actor may publish. An
 * Actor id and every view id are required: a profile without them could not
 * be matched to a publish request.
 * @param input - parsed JSON, an API body, or a database row.
 * @returns the profile, or every issue found.
 */
export function parseActorVisualProfile(input: unknown): ValidationResult<ActorVisualProfile> {
  const issues: ValidationIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'Actor Profile 必须是对象' }] }

  const actorId = readString(input.actor_id)?.trim()
  if (actorId === undefined || actorId === '') {
    issues.push({ path: 'actor_id', message: '缺少 actor_id' })
  }

  const description = readString(input.description) ?? ''

  const viewsRaw = input.allowed_surface_views
  if (viewsRaw !== undefined && !Array.isArray(viewsRaw)) {
    issues.push({ path: 'allowed_surface_views', message: 'allowed_surface_views 必须是数组' })
  }
  const views: ActorSurfaceView[] = []
  for (const [index, raw] of (Array.isArray(viewsRaw) ? viewsRaw : []).entries()) {
    const parsed = parseSurfaceView(raw, `allowed_surface_views[${index}]`)
    issues.push(...parsed.issues)
    if (parsed.view !== undefined) views.push(parsed.view)
  }

  if (issues.some(issue => issue.path === 'actor_id')) return { ok: false, issues }

  return {
    ok: true,
    value: {
      actorId: actorId as string,
      description,
      allowedSurfaceViews: views,
    },
    issues,
  }
}

/**
 * Parse JSON text into an Actor visual profile.
 * @param text - the file contents.
 * @returns the profile, or every issue found.
 */
export function loadActorVisualProfile(text: string): ValidationResult<ActorVisualProfile> {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (reason) {
    return {
      ok: false,
      issues: [{ path: '', message: reason instanceof Error ? reason.message : 'JSON 解析失败', kind: 'json' }],
    }
  }
  return parseActorVisualProfile(input)
}
