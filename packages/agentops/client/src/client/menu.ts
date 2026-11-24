/**
 * AgentOps sidebar structure: the groups shown in the client sidebar and the
 * entries inside them.
 *
 * The table is the single source of the AgentOps menu layout. Each entry
 * names the dictionary namespace and key behind its label and the glyph it
 * renders, so a missing label or icon is a compile error rather than a
 * mislabelled row.
 *
 * @module @agentops/dsh-client/client
 */

import type { AgentKey } from './agent-locales/index.js'
import type { CollaborationKey } from './collaboration-locales.js'
import type { WorkflowKey } from './locales.js'
import type { MenuKey } from './menu-locales.js'
import type { RunHistoryKey } from './run-history-locales.js'
import type { SecurityKey } from './security-locales.js'
import type { TaskMenuKey } from './task-locales.js'

/** The dictionary entry behind a sidebar label. */
export type AgentOpsMenuLabel =
  | { readonly namespace: 'agentopsMenu'; readonly key: MenuKey }
  | { readonly namespace: 'agentopsTasks'; readonly key: TaskMenuKey }
  | { readonly namespace: 'agentopsAgents'; readonly key: AgentKey }
  | { readonly namespace: 'agentopsWorkflows'; readonly key: WorkflowKey }
  | { readonly namespace: 'agentopsCollaboration'; readonly key: CollaborationKey }
  | { readonly namespace: 'agentopsRuns'; readonly key: RunHistoryKey }
  | { readonly namespace: 'agentopsSecurity'; readonly key: SecurityKey }

/** The glyph a sidebar entry renders. */
export type AgentOpsMenuIcon =
  | 'knowledge'
  | 'collaboration'
  | 'workflows'
  | 'agents'
  | 'runs'
  | 'taskBoard'
  | 'taskReport'
  | 'taskInbox'
  | 'starmap'
  | 'dashboard'
  | 'list'
  | 'gantt'
  | 'projects'
  | 'monitor'
  | 'users'
  | 'roles'
  | 'sessions'
  | 'tokens'
  | 'sessionReplay'
  | 'a2ui'
  | 'schedules'
  | 'skills'
  | 'vault'
  | 'capability'

/** A collapsible group of sidebar entries. */
export interface AgentOpsMenuSection {
  /** Stable section id; entries sharing it render in one group. */
  readonly id: string
  /** Ascending position of the group among the top-level sidebar rows. */
  readonly order: number
  /** Whether the group starts expanded. */
  readonly defaultOpen: boolean
  /** The dictionary entry behind the group title. */
  readonly label: AgentOpsMenuLabel
}

/** One sidebar entry. */
export interface AgentOpsMenuRow {
  /** Panel id shared by the sidebar entry and the main panel it opens. */
  readonly id: string
  /** Ascending position among the entries of the owning section. */
  readonly order: number
  /** Owning section id, or undefined for a top-level entry. */
  readonly section: string | undefined
  /** The dictionary entry behind the entry label. */
  readonly label: AgentOpsMenuLabel
  /** The glyph the entry renders. */
  readonly icon: AgentOpsMenuIcon
}

/** Section holding the agent lifecycle surfaces: collaboration, workflows, and agents. */
export const AGENT_MANAGEMENT_SECTION_ID = 'agent-management'

/** Section holding the task surfaces: task board and task report. */
export const TASK_MANAGEMENT_SECTION_ID = 'task-management'

/** Section holding the read-only security administration surfaces. */
export const SECURITY_MANAGEMENT_SECTION_ID = 'security-management'

/** Section holding runtime observability surfaces. */
export const OBSERVABILITY_SECTION_ID = 'observability'

/** Section holding the capability surfaces: connector instances and schedules. */
export const CAPABILITY_CENTER_SECTION_ID = 'capability-center'

/** The AgentOps sidebar groups, in sidebar order. */
export const AGENTOPS_MENU_SECTIONS: readonly AgentOpsMenuSection[] = [
  {
    id: AGENT_MANAGEMENT_SECTION_ID,
    order: 50,
    defaultOpen: true,
    label: { namespace: 'agentopsAgents', key: 'section.agentManagement' },
  },
  {
    id: CAPABILITY_CENTER_SECTION_ID,
    order: 52.5,
    defaultOpen: true,
    label: { namespace: 'agentopsMenu', key: 'section.capabilityCenter' },
  },
  {
    id: TASK_MANAGEMENT_SECTION_ID,
    order: 53,
    defaultOpen: true,
    label: { namespace: 'agentopsTasks', key: 'section.label' },
  },
  {
    id: OBSERVABILITY_SECTION_ID,
    order: 57.5,
    defaultOpen: true,
    label: { namespace: 'agentopsMenu', key: 'section.observability' },
  },
  {
    id: SECURITY_MANAGEMENT_SECTION_ID,
    order: 59,
    defaultOpen: false,
    label: { namespace: 'agentopsSecurity', key: 'menu.section' },
  },
]

/** The AgentOps sidebar entries, in sidebar order. */
export const AGENTOPS_MENU_ROWS: readonly AgentOpsMenuRow[] = [
  {
    id: 'agentops-knowledge',
    order: 51,
    section: undefined,
    label: { namespace: 'agentopsMenu', key: 'panel.knowledge' },
    icon: 'knowledge',
  },
  {
    id: 'agentops-collaboration',
    order: 52,
    section: AGENT_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsCollaboration', key: 'sidebar.label' },
    icon: 'collaboration',
  },
  {
    id: 'agentops-workflows',
    order: 53,
    section: AGENT_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsWorkflows', key: 'sidebar.label' },
    icon: 'workflows',
  },
  {
    id: 'agentops-agents',
    order: 54,
    section: AGENT_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsAgents', key: 'sidebar.label' },
    icon: 'agents',
  },
  {
    id: 'agentops-run-log',
    order: 57.6,
    section: OBSERVABILITY_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.runLog' },
    icon: 'runs',
  },
  {
    id: 'agentops-capability-audit',
    order: 57.7,
    section: OBSERVABILITY_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.capabilityAudit' },
    icon: 'list',
  },
  {
    id: 'agentops-task-center',
    order: 48,
    section: TASK_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsTasks', key: 'panel.taskCenter' },
    icon: 'taskBoard',
  },
  {
    id: 'agentops-projects',
    order: 49,
    section: TASK_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsTasks', key: 'panel.projects' },
    icon: 'projects',
  },
  {
    id: 'agentops-inbox',
    order: 50,
    section: TASK_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsTasks', key: 'panel.taskInbox' },
    icon: 'taskInbox',
  },
  {
    id: 'agentops-monitor',
    order: 57.5,
    section: OBSERVABILITY_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.monitor' },
    icon: 'monitor',
  },
  {
    id: 'agentops-security-users',
    order: 59.1,
    section: SECURITY_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsSecurity', key: 'menu.users' },
    icon: 'users',
  },
  {
    id: 'agentops-security-roles',
    order: 59.2,
    section: SECURITY_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsSecurity', key: 'menu.roles' },
    icon: 'roles',
  },
  {
    id: 'agentops-security-sessions',
    order: 59.3,
    section: SECURITY_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsSecurity', key: 'menu.sessions' },
    icon: 'sessions',
  },
  {
    id: 'agentops-security-tokens',
    order: 59.4,
    section: SECURITY_MANAGEMENT_SECTION_ID,
    label: { namespace: 'agentopsSecurity', key: 'menu.tokens' },
    icon: 'tokens',
  },
  {
    id: 'agentops-capability',
    order: 52.6,
    section: CAPABILITY_CENTER_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.capabilityConnectors' },
    icon: 'capability',
  },
  {
    id: 'agentops-logs',
    order: 52.65,
    section: CAPABILITY_CENTER_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.logs' },
    icon: 'capability',
  },
  {
    id: 'agentops-deployments',
    order: 52.66,
    section: CAPABILITY_CENTER_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.deployments' },
    icon: 'capability',
  },
  {
    id: 'agentops-skills',
    order: 52.62,
    section: CAPABILITY_CENTER_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.skills' },
    icon: 'skills',
  },
  {
    id: 'agentops-schedules',
    order: 52.7,
    section: CAPABILITY_CENTER_SECTION_ID,
    label: { namespace: 'agentopsMenu', key: 'panel.schedules' },
    icon: 'schedules',
  },
]
