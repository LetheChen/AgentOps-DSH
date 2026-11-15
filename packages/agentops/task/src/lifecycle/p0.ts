/**
 * P0 lifecycle: the five statuses and nine edges the original system used
 * before the fourteen-status V1 table existed.
 *
 * P0 is a row-level lifecycle mode in this migration (`tasks.lifecycle_mode`),
 * not a deployment switch: a task created in P0 keeps P0 states for its whole
 * life. The table below is the authority for that mode; `status.ts` is the
 * authority for V1. Both are asserted by the contract snapshot.
 *
 * @module @agentops/dsh-task/lifecycle/p0
 */

/** The five statuses a P0 task may hold. */
export const P0_STATUSES = ['idea', 'backlog', 'discussing', 'reviewing', 'closed'] as const

/** One P0 lifecycle status. */
export type P0Status = typeof P0_STATUSES[number]

/** One allowed P0 status change and the action that triggers it. */
export interface P0Transition {
  from: P0Status
  to: P0Status
  action: string
  requiresUser: boolean
}

const t = (from: P0Status, to: P0Status, action: string, requiresUser = false): P0Transition => ({
  from,
  to,
  action,
  requiresUser,
})

/** Every allowed P0 status change: 9 edges. */
export const P0_TRANSITIONS: readonly P0Transition[] = [
  t('idea', 'backlog', '立项'),
  t('backlog', 'discussing', '触发方案讨论'),
  t('discussing', 'reviewing', '提交方案评审'),
  t('reviewing', 'closed', '评审通过，关闭任务', true),
  t('reviewing', 'backlog', '退回立项', true),
  t('reviewing', 'discussing', '退回讨论', true),
  t('idea', 'closed', '废弃灵感', true),
  t('backlog', 'closed', '取消待办', true),
  t('discussing', 'closed', '取消讨论', true),
]

/** P0 statuses a task never leaves. */
export const P0_TERMINAL: ReadonlySet<P0Status> = new Set(['closed'])

/** P0 statuses a task may be paused from; P0 has no paused state. */
export const P0_PAUSABLE: ReadonlySet<P0Status> = new Set()

/**
 * Whether a value is one of the five P0 statuses.
 * @param value - the value to test.
 * @returns true when the value is a P0 status.
 */
export function isP0Status(value: string): value is P0Status {
  return (P0_STATUSES as readonly string[]).includes(value)
}

/**
 * Whether a P0 transition is allowed.
 * @param from - current status.
 * @param to - requested status.
 * @returns whether the status change is allowed under P0.
 */
export function canP0Transition(from: string, to: string): boolean {
  if (!isP0Status(from) || !isP0Status(to)) return false
  if (P0_TERMINAL.has(from)) return false
  return P0_TRANSITIONS.some(rule => rule.from === from && rule.to === to)
}

/**
 * Allowed P0 targets for a status, for rendering actions.
 * @param from - current status.
 * @returns target, action and the user-approval requirement.
 */
export function allowedP0Transitions(from: string): P0Transition[] {
  if (!isP0Status(from) || P0_TERMINAL.has(from)) return []
  return P0_TRANSITIONS.filter(rule => rule.from === from).map(rule => ({ ...rule }))
}

/**
 * Whether a P0 status ends the task lifecycle.
 * @param status - the status to test.
 * @returns true when the status is terminal under P0.
 */
export function isP0Terminal(status: string): boolean {
  return isP0Status(status) && P0_TERMINAL.has(status)
}
