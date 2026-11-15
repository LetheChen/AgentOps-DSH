/**
 * Workflow ownership: which Agent owns which workflow.
 *
 * Ownership is declared on the Agent alone (`execution: workflow` plus
 * `workflow: <id>`); a workflow file never names its Agent. One home for the
 * fact means a renamed workflow or a reassigned Agent cannot leave two
 * disagreeing declarations behind, and the reverse index this module builds is
 * derived rather than stored.
 *
 * Every inconsistency is reported instead of resolved: a workflow claimed
 * twice, an Agent naming a workflow that does not exist, and a workflow nobody
 * claims. The last one is how a legacy multi-Agent workflow surfaces, so the
 * caller can mark it retired instead of running it with guessed permissions.
 *
 * @module @agentops/dsh-contracts/ownership
 */

import type { AgentDefinition, ValidationIssue } from './types.js'

/** Stable categories on the issues {@link buildWorkflowOwnership} reports. */
export type WorkflowOwnershipIssueKind = 'workflow-not-found' | 'workflow-claimed-twice' | 'workflow-unclaimed'

/** Result of indexing the Agent catalogue by the workflow each Agent owns. */
export interface WorkflowOwnership {
  /** Workflow id to owning Agent id, in Agent-catalogue order. */
  readonly owners: ReadonlyMap<string, string>
  /** Every inconsistency found while building the index. */
  readonly issues: readonly ValidationIssue[]
}

/**
 * Derive the `workflow id -> agent id` index from parsed Agent definitions.
 *
 * The first Agent to claim a workflow keeps it; a later claim is reported and
 * does not overwrite. An Agent whose claimed workflow is not in `workflowIds`
 * contributes no entry, so a typo cannot silently create a phantom owner.
 * @param agents - parsed Agent definitions from the catalogue.
 * @param workflowIds - workflow ids that exist on disk.
 * @returns the derived owners together with every inconsistency.
 */
export function buildWorkflowOwnership(
  agents: readonly AgentDefinition[],
  workflowIds: readonly string[],
): WorkflowOwnership {
  const issues: ValidationIssue[] = []
  const owners = new Map<string, string>()
  const declared = new Set(workflowIds)

  for (const agent of agents) {
    const workflowId = agent.workflow
    if (workflowId === undefined) continue
    if (!declared.has(workflowId)) {
      issues.push({
        path: `agents.${agent.agentId}.workflow`,
        message: `引用的工作流不存在：${workflowId}`,
        kind: 'workflow-not-found',
      })
      continue
    }
    const existing = owners.get(workflowId)
    if (existing !== undefined) {
      issues.push({
        path: `agents.${agent.agentId}.workflow`,
        message: `工作流 ${workflowId} 已被 Agent ${existing} 声明：一条工作流只能有一个所属 Agent`,
        kind: 'workflow-claimed-twice',
      })
      continue
    }
    owners.set(workflowId, agent.agentId)
  }

  for (const workflowId of declared) {
    if (owners.has(workflowId)) continue
    issues.push({
      path: `workflows.${workflowId}`,
      message: `没有任何 Agent 声明该工作流：${workflowId}`,
      kind: 'workflow-unclaimed',
    })
  }

  return { owners, issues }
}
