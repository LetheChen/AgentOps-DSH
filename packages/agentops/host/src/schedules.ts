/**
 * Schedules catalog, editable control plane, and workflow trigger runtime.
 *
 * The control plane owns `schedules.yaml`; the runtime evaluates five-field
 * cron expressions in each schedule's IANA time zone and starts the same
 * generic AgentOps session path used by the workflow-run page.
 *
 * @module @agentops/dsh-host/schedules
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load, dump } from 'js-yaml'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

/** One declared schedule and its latest trigger evidence. */
export interface ScheduleSummary {
  id: string
  name: string
  workflowId: string
  cron: string
  timezone: string
  inputs: Record<string, unknown>
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
  lastRunAt: string | null
  lastStatus: 'starting' | 'started' | 'failed' | null
  lastError: string | null
  lastSessionId: string | null
}

/** Editable schedule fields. */
export interface ScheduleInput {
  readonly id: string
  readonly name: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone: string
  readonly inputs: Record<string, unknown>
  readonly enabled: boolean
}

interface RawSchedule {
  id?: unknown
  name?: unknown
  workflow_id?: unknown
  cron?: unknown
  timezone?: unknown
  inputs?: unknown
  enabled?: unknown
  created_at?: unknown
  updated_at?: unknown
  last_run_at?: unknown
  last_status?: unknown
  last_error?: unknown
  last_session_id?: unknown
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WORKFLOW_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * Parse one schedules file.
 * @param file - path to `schedules.yaml`.
 * @returns declared schedules and whether the file was missing.
 */
export function readSchedules(file: string): { file: string; entries: ScheduleSummary[]; missing: boolean } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, entries: [], missing: true }
  }

  const doc = (load(text) ?? {}) as { schedules?: unknown }
  const rows = Array.isArray(doc.schedules) ? doc.schedules : []
  const entries = rows.flatMap((row): ScheduleSummary[] => {
    if (row === null || typeof row !== 'object') return []
    const record = row as RawSchedule
    const id = asString(record.id)
    const cron = asString(record.cron)
    if (id === undefined || cron === undefined) return []
    return [{
      id,
      name: asString(record.name) ?? id,
      workflowId: asString(record.workflow_id) ?? '',
      cron,
      timezone: asString(record.timezone) ?? DEFAULT_TIMEZONE,
      inputs: objectOf(record.inputs),
      enabled: record.enabled === true,
      createdAt: asString(record.created_at) ?? null,
      updatedAt: asString(record.updated_at) ?? null,
      lastRunAt: asString(record.last_run_at) ?? null,
      lastStatus: record.last_status === 'starting' || record.last_status === 'started' || record.last_status === 'failed'
        ? record.last_status
        : null,
      lastError: asString(record.last_error) ?? null,
      lastSessionId: asString(record.last_session_id) ?? null,
    }]
  })
  return { file, entries, missing: false }
}

/**
 * Atomically replace the schedules file.
 * @param file - path to `schedules.yaml`.
 * @param entries - the schedules to persist.
 */
export function writeSchedules(file: string, entries: readonly ScheduleSummary[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const document = {
    schedules: entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      workflow_id: entry.workflowId,
      cron: entry.cron,
      timezone: entry.timezone,
      inputs: entry.inputs,
      enabled: entry.enabled,
      ...(entry.createdAt === null ? {} : { created_at: entry.createdAt }),
      ...(entry.updatedAt === null ? {} : { updated_at: entry.updatedAt }),
      ...(entry.lastRunAt === null ? {} : { last_run_at: entry.lastRunAt }),
      ...(entry.lastStatus === null ? {} : { last_status: entry.lastStatus }),
      ...(entry.lastError === null ? {} : { last_error: entry.lastError }),
      ...(entry.lastSessionId === null ? {} : { last_session_id: entry.lastSessionId }),
    })),
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, dump(document, { noRefs: true, lineWidth: 120 }), 'utf8')
  renameSync(temp, file)
}

/**
 * Validate an editable schedule input.
 * @param input - the schedule fields to check.
 * @returns the validation errors, empty when the input is valid.
 */
export function validateScheduleInput(input: ScheduleInput): string[] {
  const errors: string[] = []
  if (!ID_PATTERN.test(input.id)) errors.push('id 必须是 1-64 位字母、数字、点、下划线或连字符')
  if (input.name.trim() === '') errors.push('name 不能为空')
  if (!WORKFLOW_PATTERN.test(input.workflowId)) errors.push('workflow_id 格式不合法')
  if (!validTimezone(input.timezone)) errors.push('timezone 必须是有效的 IANA 时区')
  errors.push(...validateCron(input.cron).map(error => `cron: ${error}`))
  return errors
}

/**
 * Validate a five-field Vixie cron expression.
 * @param expression - the cron expression to check.
 * @returns the validation errors, empty when the expression is valid.
 */
export function validateCron(expression: string): string[] {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return ['必须是 5 段：minute hour day-of-month month day-of-week']
  const specs = [
    { label: 'minute', min: 0, max: 59 },
    { label: 'hour', min: 0, max: 23 },
    { label: 'day-of-month', min: 1, max: 31 },
    { label: 'month', min: 1, max: 12 },
    { label: 'day-of-week', min: 0, max: 7 },
  ] as const
  const errors: string[] = []
  fields.forEach((field, index) => {
    const spec = specs[index]
    if (spec === undefined) return
    try { parseCronField(field, spec.min, spec.max) }
    catch (error) { errors.push(`${spec.label}: ${messageOf(error)}`) }
  })
  return errors
}

/**
 * Whether a cron expression matches the supplied instant in its time zone.
 * @param expression - the five-field cron expression to evaluate.
 * @param instant - the instant to test.
 * @param timezone - the IANA time zone the expression is evaluated in.
 * @returns true when the expression fires at that instant.
 */
export function matchesCron(expression: string, instant: Date, timezone: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5 || !validTimezone(timezone)) return false
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields
  if (minuteField === undefined || hourField === undefined || dayField === undefined
    || monthField === undefined || weekdayField === undefined) return false
  const minute = parseCronField(minuteField, 0, 59)
  const hour = parseCronField(hourField, 0, 23)
  const day = parseCronField(dayField, 1, 31)
  const month = parseCronField(monthField, 1, 12)
  const weekday = parseCronField(weekdayField, 0, 7)
  const parts = localParts(instant, timezone)
  const dayWildcard = fields[2] === '*'
  const weekdayWildcard = fields[4] === '*'
  const dayMatch = day.has(parts.day)
  const weekdayMatch = weekday.has(parts.weekday === 0 ? 0 : parts.weekday) || (parts.weekday === 0 && weekday.has(7))
  const calendarMatch = dayWildcard || weekdayWildcard
    ? dayMatch && weekdayMatch
    : dayMatch || weekdayMatch
  return minute.has(parts.minute) && hour.has(parts.hour) && month.has(parts.month) && calendarMatch
}

/** Workflow trigger runtime shared by cron ticks and the run-now action. */
export class ScheduleRuntime {
  readonly #file: string
  readonly #workflowDir: string
  readonly #controller: () => Pick<SessionController, 'create' | 'prompt'> | undefined
  readonly #running = new Set<string>()
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(file: string, workflowDir: string, controller: () => Pick<SessionController, 'create' | 'prompt'> | undefined) {
    this.#file = file
    this.#workflowDir = workflowDir
    this.#controller = controller
  }

  /** Start the 30-second cron scanner. */
  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.tick() }, 30_000)
    void this.tick()
  }

  /** Stop the cron scanner. */
  dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /**
   * Evaluate every enabled schedule for the current minute.
   * @param now - the instant schedules are evaluated against.
   */
  async tick(now = new Date()): Promise<void> {
    const { entries } = readSchedules(this.#file)
    for (const entry of entries) {
      if (!entry.enabled || !matchesCron(entry.cron, now, entry.timezone) || ranInMinute(entry.lastRunAt, now)) continue
      if (this.#running.has(entry.id)) continue
      this.#running.add(entry.id)
      try { await this.#trigger(entry.id, 'schedule', now) }
      finally { this.#running.delete(entry.id) }
    }
  }

  /**
   * Trigger one schedule immediately, regardless of enabled state.
   * @param id - the schedule to trigger.
   * @param now - the instant recorded as the run time.
   * @returns the id of the session the trigger started.
   */
  async runNow(id: string, now = new Date()): Promise<{ sessionId: string }> {
    if (this.#running.has(id)) throw new Error(`schedule ${id} is already running`)
    const entry = readSchedules(this.#file).entries.find(item => item.id === id)
    if (entry === undefined) throw new Error(`schedule ${id} not found`)
    this.#running.add(id)
    try { return await this.#trigger(id, 'manual', now) }
    finally { this.#running.delete(id) }
  }

  async #trigger(id: string, origin: 'schedule' | 'manual', now: Date): Promise<{ sessionId: string }> {
    const state = readSchedules(this.#file)
    const entry = state.entries.find(item => item.id === id)
    if (entry === undefined) throw new Error(`schedule ${id} not found`)
    if (!workflowExists(this.#workflowDir, entry.workflowId)) {
      this.#record(id, { lastRunAt: now.toISOString(), lastStatus: 'failed', lastError: `workflow ${entry.workflowId} 不存在`, lastSessionId: null })
      throw new Error(`workflow ${entry.workflowId} 不存在`)
    }
    const controller = this.#controller()
    if (controller === undefined) {
      this.#record(id, { lastRunAt: now.toISOString(), lastStatus: 'failed', lastError: 'sessionController 不可用', lastSessionId: null })
      throw new Error('sessionController 不可用')
    }
    this.#record(id, { lastRunAt: now.toISOString(), lastStatus: 'starting', lastError: null, lastSessionId: null })
    let sessionId = ''
    try {
      const created = await controller.create({ agentPreset: 'agentops' })
      sessionId = created.sessionId
      const request: SessionPromptRequest = {
        requestId: brandString<SessionRequestId>(randomUUID()),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: triggerPrompt(entry, origin) }],
        clientTimeZone: entry.timezone,
      }
      await controller.prompt(request, new AbortController().signal)
      this.#record(id, { lastRunAt: now.toISOString(), lastStatus: 'started', lastError: null, lastSessionId: sessionId })
      return { sessionId }
    } catch (error) {
      this.#record(id, {
        lastRunAt: now.toISOString(), lastStatus: 'failed', lastError: messageOf(error),
        lastSessionId: sessionId === '' ? null : sessionId,
      })
      throw error
    }
  }

  #record(id: string, patch: Pick<ScheduleSummary, 'lastRunAt' | 'lastStatus' | 'lastError' | 'lastSessionId'>): void {
    const state = readSchedules(this.#file)
    const entries = state.entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry)
    writeSchedules(this.#file, entries)
  }
}

/**
 * Register schedule read/write/run routes.
 * @param ctx - the plugin context owning the connection.
 * @param file - path to `schedules.yaml`.
 * @param runtime - the trigger runtime, when run-now is available.
 */
export function registerSchedulesRoute(ctx: Context, file: string, runtime?: ScheduleRuntime): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/schedules',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: scheduleMutationHandler(file),
  }), 'agentops-system: /api/agentops/schedules')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/schedules/delete',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: scheduleDeleteHandler(file),
  }), 'agentops-system: /api/agentops/schedules/delete')

  if (runtime !== undefined) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/agentops/schedules/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: scheduleRunHandler(file, runtime),
    }), 'agentops-system: /api/agentops/schedules/run')
  }
}

function scheduleMutationHandler(file: string) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(200, readSchedules(file))
    try {
      const body = await readBody(request)
      const state = readSchedules(file)
      const id = stringField(body, 'id')
      const input: ScheduleInput = {
        id,
        name: stringField(body, 'name'),
        workflowId: stringField(body, 'workflow_id'),
        cron: stringField(body, 'cron'),
        timezone: stringField(body, 'timezone'),
        inputs: objectOf(body.inputs),
        enabled: body.enabled !== false,
      }
      const errors = validateScheduleInput(input)
      if (errors.length > 0) return json(400, { error: { code: 'schedule_invalid', message: errors.join('；'), details: { errors } } })
      const existing = state.entries.find(entry => entry.id === id)
      if (body.action === 'create' && existing !== undefined) {
        return json(409, { error: { code: 'schedule_conflict', message: `schedule ${id} already exists` } })
      }
      if (body.action !== 'create' && existing === undefined) {
        return json(404, { error: { code: 'schedule_not_found', message: `schedule ${id} not found` } })
      }
      const now = new Date().toISOString()
      const entry: ScheduleSummary = {
        ...input,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastRunAt: existing?.lastRunAt ?? null,
        lastStatus: existing?.lastStatus ?? null,
        lastError: existing?.lastError ?? null,
        lastSessionId: existing?.lastSessionId ?? null,
      }
      const entries = existing === undefined
        ? [...state.entries, entry]
        : state.entries.map(item => item.id === id ? entry : item)
      writeSchedules(file, entries)
      return json(200, { schedule: entry, entries })
    } catch (error) {
      return json(400, { error: { code: 'schedule_invalid', message: messageOf(error), details: {} } })
    }
  }
}

function scheduleDeleteHandler(file: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request)
      const id = stringField(body, 'id')
      const state = readSchedules(file)
      const entries = state.entries.filter(entry => entry.id !== id)
      if (entries.length === state.entries.length) return json(404, { error: { code: 'schedule_not_found', message: `schedule ${id} not found`, details: {} } })
      writeSchedules(file, entries)
      return json(200, { ok: true, entries })
    } catch (error) {
      return json(400, { error: { code: 'schedule_delete_failed', message: messageOf(error), details: {} } })
    }
  }
}

function scheduleRunHandler(file: string, runtime: ScheduleRuntime) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request)
      const result = await runtime.runNow(stringField(body, 'id'))
      return json(200, { ok: true, ...result, schedules: readSchedules(file).entries })
    } catch (error) {
      return json(400, {
        error: { code: 'schedule_run_failed', message: messageOf(error), details: {} },
        schedules: readSchedules(file).entries,
      })
    }
  }
}

function triggerPrompt(entry: ScheduleSummary, origin: 'schedule' | 'manual'): string {
  return [
    `请用 dag_run 工具运行 AgentOps 工作流 ${entry.workflowId}。`,
    `触发来源：${origin === 'manual' ? '用户手动立即运行' : `定时计划 ${entry.id} (${entry.cron} ${entry.timezone})`}`,
    '运行输入（JSON）：',
    JSON.stringify(entry.inputs),
    '执行完成后，把每个节点的状态与产物摘要写回本会话。',
  ].join('\n')
}

function workflowExists(directory: string, workflowId: string): boolean {
  if (!existsSync(directory)) return false
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    try {
      const doc = load(readFileSync(join(directory, name), 'utf8')) as { workflow_id?: unknown; id?: unknown } | undefined
      const id = typeof doc?.workflow_id === 'string' ? doc.workflow_id : typeof doc?.id === 'string' ? doc.id : undefined
      if (id === workflowId) return true
    } catch {
      // Invalid workflow files are ignored here; dag_validate remains the authoritative check.
    }
  }
  return false
}

function parseCronField(raw: string, min: number, max: number): Set<number> {
  if (raw.trim() === '') throw new Error('空字段')
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const [range, stepText] = part.split('/')
    if (range === undefined || range === '' || (stepText !== undefined && !/^\d+$/.test(stepText))) throw new Error(`非法字段 ${part}`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1) throw new Error(`步长必须大于 0：${part}`)
    let start: number
    let end: number
    if (range === '*') {
      start = min
      end = max
    } else if (range.includes('-')) {
      const [left, right] = range.split('-')
      if (left === undefined || right === undefined || !/^\d+$/.test(left) || !/^\d+$/.test(right)) throw new Error(`非法范围 ${range}`)
      start = Number(left)
      end = Number(right)
    } else {
      if (!/^\d+$/.test(range)) throw new Error(`非法值 ${range}`)
      start = Number(range)
      end = stepText === undefined ? start : max
    }
    if (start < min || end > max || start > end) throw new Error(`值超出范围 ${min}-${max}: ${part}`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

function localParts(instant: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')) % 24,
    day: Number(get('day')),
    month: Number(get('month')),
    weekday: weekdays[get('weekday')] ?? 0,
  }
}

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() ; return true }
  catch { return false }
}

function ranInMinute(lastRunAt: string | null, now: Date): boolean {
  if (lastRunAt === null) return false
  const last = Date.parse(lastRunAt)
  return Number.isFinite(last) && Math.floor(last / 60_000) === Math.floor(now.getTime() / 60_000)
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = await request.json() } catch { throw new Error('请求体不是合法 JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象')
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} 必填`)
  return value.trim()
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
