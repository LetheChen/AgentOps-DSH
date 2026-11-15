/**
 * Pure view-model helpers for the unified task center.
 *
 * Keeping filtering and counts outside React makes the task center's stage
 * cards, dashboard and Gantt view deterministic and testable.
 *
 * @module @agentops/dsh-client/task-center-model
 */

export interface TaskCenterTask {
  taskId: string
  projectId: string
  identifier: string | null
  title: string
  description: string
  status: string
  taskType: string
  riskLevel: string
  version: number
  assigneeName: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface TaskCenterProject {
  project_id: string
  name: string
  type: string
  task_count: number
  local_path?: string | null
  github_url?: string | null
  feishu_doc_token?: string | null
  workspace_id?: string | null
  ownership_state?: 'active' | 'ownership_pending'
}

export type TaskCenterView = 'dashboard' | 'board' | 'list' | 'gantt' | 'nebula' | 'report'

export interface StageDefinition {
  readonly key: string
  readonly label: string
  readonly color: string
}

export const TASK_STAGES: readonly StageDefinition[] = [
  { key: 'idea', label: '灵感', color: '#60A5FA' },
  { key: 'discussing', label: '讨论中', color: '#22D3EE' },
  { key: 'decomposing', label: '拆解中', color: '#F472B6' },
  { key: 'reviewing', label: '评审中', color: '#A78BFA' },
  { key: 'backlog', label: '待办池', color: '#94A3B8' },
  { key: 'in_progress', label: '进行中', color: '#F59E0B' },
  { key: 'validating', label: '验证中', color: '#34D399' },
  { key: 'closed', label: '已关闭', color: '#10B981' },
]

export const STATUS_LABELS: Readonly<Record<string, string>> = {
  idea: '灵感',
  backlog: '待办',
  discussing: '讨论中',
  reviewing: '评审中',
  decomposing: '拆解中',
  in_progress: '进行中',
  validating: '验证中',
  closing: '收尾中',
  closed: '已关闭',
  blocked: '阻塞',
  paused: '暂停',
  failed: '失败',
  canceled: '已取消',
  abandoned: '已归档',
}

export const RISK_LABELS: Readonly<Record<string, string>> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
}

export function filterTaskCenterTasks(
  tasks: readonly TaskCenterTask[],
  options: { search?: string; stage?: string; risk?: string } = {},
): TaskCenterTask[] {
  const search = options.search?.trim().toLocaleLowerCase() ?? ''
  return tasks.filter((task) => {
    if (options.stage !== undefined && options.stage !== '' && task.status !== options.stage) return false
    if (options.risk !== undefined && options.risk !== '' && task.riskLevel !== options.risk) return false
    if (search === '') return true
    return `${task.identifier ?? ''} ${task.title} ${task.description} ${STATUS_LABELS[task.status] ?? task.status}`
      .toLocaleLowerCase()
      .includes(search)
  })
}

export function stageCounts(tasks: readonly TaskCenterTask[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const stage of TASK_STAGES) counts[stage.key] = 0
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  return counts
}

export function riskCounts(tasks: readonly TaskCenterTask[]): Record<string, number> {
  const counts: Record<string, number> = { high: 0, medium: 0, low: 0, unknown: 0 }
  for (const task of tasks) counts[task.riskLevel] = (counts[task.riskLevel] ?? 0) + 1
  return counts
}

export function completionPercent(tasks: readonly TaskCenterTask[]): number {
  if (tasks.length === 0) return 0
  return Math.round((tasks.filter(task => task.status === 'closed').length / tasks.length) * 100)
}

export interface GanttRow {
  readonly task: TaskCenterTask
  readonly start: number
  readonly end: number
}

export function buildGanttRows(tasks: readonly TaskCenterTask[]): { rows: readonly GanttRow[]; min: number; max: number } {
  const rows = tasks.map((task) => {
    const created = Date.parse(task.createdAt)
    const start = Number.isFinite(created) ? created : Date.now()
    const closed = task.closedAt === null ? Number.NaN : Date.parse(task.closedAt)
    const updated = Date.parse(task.updatedAt)
    const end = Number.isFinite(closed) ? closed : Number.isFinite(updated) ? updated : Date.now()
    return { task, start, end: Math.max(start, end) }
  })
  if (rows.length === 0) {
    const now = Date.now()
    return { rows: [], min: now, max: now + 86_400_000 }
  }
  const min = Math.min(...rows.map(row => row.start))
  const max = Math.max(...rows.map(row => row.end), min + 86_400_000)
  return { rows, min, max }
}

export function formatTimestamp(value: string | null): string {
  if (value === null || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}
