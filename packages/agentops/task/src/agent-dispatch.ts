/**
 * Deterministic Agent capability dispatch.
 *
 * Agent permissions live in DSH presets and tool policies, never in a project
 * × Agent ACL. The dispatcher only matches task shape against declared global
 * capabilities and records the reason.
 *
 * @module @agentops/dsh-task/agent-dispatch
 */

import type { TaskRecord } from './service.ts'
import { TaskServiceError } from './service.ts'

/** Global capability declaration for one DSH Agent preset. */
export interface AgentCapability {
  readonly agentPreset: string
  readonly taskTypes: readonly TaskRecord['taskType'][]
  readonly riskLevels: readonly ('low' | 'medium' | 'high')[]
  readonly description: string
}

/** Deployment capability catalog. Keep this narrow and explicit. */
export const DEFAULT_AGENT_CAPABILITIES: readonly AgentCapability[] = [
  {
    agentPreset: 'coding_agent',
    taskTypes: ['code', 'hybrid'],
    riskLevels: ['low', 'medium'],
    description: 'low/medium-risk coding execution inside the authorized workspace',
  },
  {
    agentPreset: 'quality_inspector',
    taskTypes: ['code', 'hybrid'],
    riskLevels: ['high'],
    description: 'high-risk code review or controlled execution',
  },
  {
    agentPreset: 'task_planner',
    taskTypes: ['design', 'hybrid'],
    riskLevels: ['low', 'medium', 'high'],
    description: 'design and hybrid planning/decomposition',
  },
  {
    agentPreset: 'smart_analysis',
    taskTypes: ['knowledge'],
    riskLevels: ['low', 'medium', 'high'],
    description: 'knowledge analysis and documentation work',
  },
]

/** Result of a deterministic dispatch decision. */
export interface AgentDispatchDecision {
  readonly agentPreset: string
  readonly reason: string
  readonly candidates: readonly string[]
}

/**
 * Match one admitted task to a capable preset.
 * @param task - admitted task.
 * @param capabilities - optional deployment capability catalog.
 * @returns the selected preset and dispatch reason.
 */
export function selectAgentForTask(
  task: Pick<TaskRecord, 'taskType' | 'riskLevel'>,
  capabilities: readonly AgentCapability[] = DEFAULT_AGENT_CAPABILITIES,
): AgentDispatchDecision {
  const candidates = capabilities
    .filter(capability => capability.taskTypes.includes(task.taskType))
    .filter(capability => capability.riskLevels.includes(task.riskLevel as 'medium'))
    .map(capability => capability.agentPreset)
  const selected = candidates[0]
  if (selected === undefined) {
    throw new TaskServiceError('no_capable_agent', `no declared agent can execute ${task.taskType}/${task.riskLevel} tasks`, {
      taskType: task.taskType,
      riskLevel: task.riskLevel,
    }, 409)
  }
  return {
    agentPreset: selected,
    reason: `task_type=${task.taskType},risk=${task.riskLevel},order=${candidates.indexOf(selected)}`,
    candidates,
  }
}

/**
 * Validate an explicit preset override against the capability catalog.
 * @param agentPreset - requested preset.
 * @param task - admitted task.
 * @param capabilities - optional capability catalog.
 */
export function assertAgentPresetCapable(
  agentPreset: string,
  task: Pick<TaskRecord, 'taskType' | 'riskLevel'>,
  capabilities: readonly AgentCapability[] = DEFAULT_AGENT_CAPABILITIES,
): void {
  const capability = capabilities.find(item => item.agentPreset === agentPreset)
  if (capability === undefined
    || !capability.taskTypes.includes(task.taskType)
    || !capability.riskLevels.includes(task.riskLevel as 'medium')) {
    throw new TaskServiceError('no_capable_agent', `agent preset ${agentPreset} cannot execute ${task.taskType}/${task.riskLevel} tasks`, {
      agentPreset,
      taskType: task.taskType,
      riskLevel: task.riskLevel,
    }, 409)
  }
}
