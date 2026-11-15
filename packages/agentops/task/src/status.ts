/**
 * Task lifecycle, ported from the legacy `task/status.py` table.
 *
 * Same 14 statuses, same transitions, same `requires_user` flags and the same
 * terminal set — the migration must not silently add or drop an edge. The
 * parity check in `scripts/parity-status.ts` compares this table against the
 * Python definition.
 */

export const TASK_STATUSES = [
  'idea', 'backlog', 'discussing', 'reviewing', 'closed',
  'decomposing', 'in_progress', 'validating', 'closing',
  'paused', 'blocked', 'failed', 'canceled', 'abandoned',
] as const

/** One lifecycle status of a task. */
export type TaskStatus = typeof TASK_STATUSES[number]

/** One allowed status change and the action that triggers it. */
export interface Transition {
  from: TaskStatus
  to: TaskStatus
  action: string
  requiresUser: boolean
}

const t = (
  from: TaskStatus,
  to: TaskStatus,
  action: string,
  requiresUser = false,
): Transition => ({ from, to, action, requiresUser })

/** Every allowed status change. */
export const TRANSITIONS: readonly Transition[] = [
  // 正向主线（立项 → 讨论 → 拆解 → 评审 → 待办 → 执行）
  t('idea', 'discussing', '用户审核立项', true),
  t('discussing', 'discussing', '多轮讨论'),
  t('discussing', 'decomposing', '方案讨论完成，自动拆解'),
  t('decomposing', 'reviewing', '拆分完成，提交评审'),
  t('reviewing', 'backlog', '评审通过，入待办池'),
  t('backlog', 'in_progress', '调度 agent 执行'),
  t('in_progress', 'in_progress', '并行子任务调度'),
  t('backlog', 'validating', '子任务全部完成，父任务收尾'),
  t('in_progress', 'validating', 'agent 执行完成'),
  t('validating', 'closing', '验收通过', true),
  t('closing', 'closed', '关闭（硬约束满足）'),

  // 评审打回
  t('reviewing', 'discussing', '评审打回：方案有问题', true),
  t('reviewing', 'decomposing', '评审打回：拆分不当', true),

  // 验收回退
  t('validating', 'in_progress', 'local 执行偏差', true),
  t('validating', 'decomposing', 'partial 拆解错', true),
  t('validating', 'discussing', 'global 方案错', true),

  // 关闭前回退
  t('closing', 'validating', '关闭前退回重验', true),
  t('closing', 'in_progress', '关闭前退回执行', true),
  t('closing', 'decomposing', '关闭前退回分解', true),
  t('closing', 'discussing', '关闭前退回方案', true),

  // 待办池退回
  t('backlog', 'discussing', '退回讨论', true),
  t('backlog', 'idea', '退回灵感重新讨论', true),

  // 外部阻塞
  t('in_progress', 'blocked', '外部阻塞'),
  t('validating', 'blocked', '外部阻塞'),
  t('blocked', 'in_progress', '阻塞解除恢复'),

  // 可恢复暂停
  t('in_progress', 'paused', '用户暂停', true),
  t('validating', 'paused', '用户暂停', true),
  t('paused', 'in_progress', '用户恢复', true),

  // 异常态
  t('in_progress', 'failed', 'agent 崩溃/超时'),
  t('failed', 'in_progress', '修复后重试'),

  // 强制终态
  t('idea', 'canceled', '用户取消', true),
  t('backlog', 'canceled', '用户取消', true),
  t('discussing', 'canceled', '用户取消', true),
  t('reviewing', 'canceled', '用户取消', true),
  t('decomposing', 'canceled', '用户取消', true),
  t('in_progress', 'canceled', '用户取消', true),
  t('validating', 'canceled', '用户取消', true),
  t('closing', 'canceled', '用户取消', true),
  t('paused', 'canceled', '用户取消', true),
  t('blocked', 'canceled', '用户取消', true),
  t('failed', 'canceled', '用户取消', true),

  // 自动归档
  t('idea', 'abandoned', '30天无活动自动归档'),
  t('backlog', 'abandoned', '30天无活动自动归档'),
  t('discussing', 'abandoned', '30天无活动自动归档'),
  t('reviewing', 'abandoned', '30天无活动自动归档'),
  t('decomposing', 'abandoned', '30天无活动自动归档'),
  t('in_progress', 'abandoned', '30天无活动自动归档'),
  t('validating', 'abandoned', '30天无活动自动归档'),
  t('closing', 'abandoned', '30天无活动自动归档'),
  t('paused', 'abandoned', '30天无活动自动归档'),
  t('blocked', 'abandoned', '30天无活动自动归档'),
  t('failed', 'abandoned', '30天无活动自动归档'),
]

/** Statuses a task never leaves. */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['closed', 'canceled', 'abandoned'])
/** Statuses a task may be paused from. */
export const PAUSABLE: ReadonlySet<TaskStatus> = new Set(['in_progress', 'validating'])

/**
 * Whether a transition is allowed. Terminal sources never transition.
 * @param from - current status.
 * @param to - requested status.
 * @returns whether the status change is allowed.
 */
export function canTransition(from: string, to: string): boolean {
  if (!isStatus(from) || !isStatus(to)) return false
  if (TERMINAL.has(from)) return false
  return TRANSITIONS.some(rule => rule.from === from && rule.to === to)
}

/**
 * Allowed targets for a status, for rendering actions.
 * @param from - current status.
 * @returns target, action and the user-approval requirement.
 */
export function allowedTransitions(from: string): { to: TaskStatus; action: string; requiresUser: boolean }[] {
  if (!isStatus(from) || TERMINAL.has(from)) return []
  return TRANSITIONS
    .filter(rule => rule.from === from)
    .map(rule => ({ to: rule.to, action: rule.action, requiresUser: rule.requiresUser }))
}

/**
 * Whether a status ends the task lifecycle.
 * @param status - the status to test.
 * @returns true when the status is terminal.
 */
export function isTerminal(status: string): boolean {
  return isStatus(status) && TERMINAL.has(status)
}

/**
 * Whether a value is one of the known task statuses.
 * @param value - the value to test.
 * @returns true when the value is a known task status.
 */
export function isStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

/**
 * Risk level → review gate: low auto, medium notify, high manual.
 * @param riskLevel - the risk level of the task.
 * @returns the review gate: `auto`, `notify`, or `manual`.
 */
export function resolveReviewGate(riskLevel: string): 'auto' | 'notify' | 'manual' {
  return riskLevel === 'low' ? 'auto' : riskLevel === 'high' ? 'manual' : 'notify'
}

/**
 * Complexity → decomposition strategy: simple none, medium single, complex recursive.
 * @param complexity - the complexity of the task.
 * @returns the decomposition strategy: `none`, `single`, or `recursive`.
 */
export function resolveDecomposeStrategy(complexity: string): 'none' | 'single' | 'recursive' {
  return complexity === 'simple' ? 'none' : complexity === 'complex' ? 'recursive' : 'single'
}
