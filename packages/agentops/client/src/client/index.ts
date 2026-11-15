/**
 * Browser half: registers the AgentOps panels and their sidebar entries.
 *
 * The sidebar layout lives in {@link AGENTOPS_MENU_ROWS}: the table owns the
 * grouping and the order, and this module binds each entry to its label and
 * icon.
 *
 * @module @agentops/dsh-client/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SlotListSection } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ReactElement } from 'react'

import { KnowledgeIcon, KnowledgePanel } from './knowledge-panel.tsx'
import './styles/all.ts'

import { A2uiPanel, A2uiPanelIcon } from './a2ui-panel.tsx'
import { registerSurfaceScreen } from './surface-screen/register.ts'
import { AgentsIcon, AgentsPanel } from './agents-panel.tsx'
import { createAgentFeedback } from './agent-feedback.tsx'
import { RunHistoryIcon, RunHistoryPanel } from './run-history-panel.tsx'
import { RunLogPanel } from './run-log-panel.tsx'
import {
  SecurityIcon,
  SecurityRolesPanel,
  SecuritySessionsPanel,
  SecurityTokensPanel,
  SecurityUsersPanel,
} from './security-panel.tsx'
import { CollaborationIcon, CollaborationPanel } from './collaboration-panel.tsx'
import { createRerunFeedback } from './collaboration-feedback.tsx'
import {
  COLLAB_NS,
  de as collabDe,
  en as collabEn,
  es as collabEs,
  fr as collabFr,
  ja as collabJa,
  pt as collabPt,
  ru as collabRu,
  zh as collabZh,
} from './collaboration-locales.js'
import { requestCollaborationRun } from './collaboration-target.js'
import { resolveClientConfig } from '../config.js'
import {
  PAGE_NS,
  de as pageDe,
  en as pageEn,
  es as pageEs,
  fr as pageFr,
  ja as pageJa,
  pt as pagePt,
  ru as pageRu,
  zh as pageZh,
} from './page-locales.js'
import { VaultIcon, VaultPanel } from './vault-panel.tsx'
import { SessionReplayIcon, SessionReplayPanel } from './session-replay-panel.tsx'
import { MonitorIcon, MonitorPanel } from './monitor-panel.tsx'
import { TaskCenterIcon, TaskCenterPanel } from './task-center-panel.tsx'
import { InboxIcon, InboxPanel } from './inbox-panel.tsx'
import { StarMapIcon, StarMapPanel } from './starmap-panel.tsx'
import { DashboardIcon, DashboardPanel, GanttIcon, GanttPanel, TaskListIcon, TaskListPanel } from './task-views.tsx'
import { ProjectsIcon, ProjectsPanel } from './projects-panel.tsx'
import { SchedulesIcon, SchedulesPanel } from './schedules-panel.tsx'
import { SkillsIcon, SkillsPanel } from './skills-panel.tsx'
import { WorkflowsIcon, WorkflowsPanel } from './workflows-panel.tsx'
import { AgentOpsIcon, AgentOpsPanel } from './panel.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.js'
import {
  AGENTS_NS,
  de as agentsDe,
  en as agentsEn,
  es as agentsEs,
  fr as agentsFr,
  ja as agentsJa,
  pt as agentsPt,
  ru as agentsRu,
  zh as agentsZh,
} from './agent-locales/index.js'
import {
  RUNS_NS,
  de as runsDe,
  en as runsEn,
  es as runsEs,
  fr as runsFr,
  ja as runsJa,
  pt as runsPt,
  ru as runsRu,
  zh as runsZh,
} from './run-history-locales.js'
import {
  SECURITY_NS,
  de as securityDe,
  en as securityEn,
  es as securityEs,
  fr as securityFr,
  ja as securityJa,
  pt as securityPt,
  ru as securityRu,
  zh as securityZh,
} from './security-locales.js'
import {
  MENU_NS,
  de as menuDe,
  en as menuEn,
  es as menuEs,
  fr as menuFr,
  ja as menuJa,
  pt as menuPt,
  ru as menuRu,
  zh as menuZh,
} from './menu-locales.js'
import {
  TASKS_NS,
  de as tasksDe,
  en as tasksEn,
  es as tasksEs,
  fr as tasksFr,
  ja as tasksJa,
  pt as tasksPt,
  ru as tasksRu,
  zh as tasksZh,
} from './task-locales.js'
import {
  AGENTOPS_MENU_ROWS,
  AGENTOPS_MENU_SECTIONS,
  type AgentOpsMenuIcon,
  type AgentOpsMenuLabel,
} from './menu.js'

const PANEL_ID = 'agentops'
const KNOWLEDGE_PANEL_ID = 'agentops-knowledge'
const WORKFLOWS_PANEL_ID = 'agentops-workflows'
const AGENTS_PANEL_ID = 'agentops-agents'
const SCHEDULES_PANEL_ID = 'agentops-schedules'
const SKILLS_PANEL_ID = 'agentops-skills'
const RUNS_PANEL_ID = 'agentops-runs'
const RUN_LOG_PANEL_ID = 'agentops-run-log'
const SECURITY_USERS_PANEL_ID = 'agentops-security-users'
const SECURITY_ROLES_PANEL_ID = 'agentops-security-roles'
const SECURITY_SESSIONS_PANEL_ID = 'agentops-security-sessions'
const SECURITY_TOKENS_PANEL_ID = 'agentops-security-tokens'
const MONITOR_PANEL_ID = 'agentops-monitor'
const COLLAB_PANEL_ID = 'agentops-collaboration'
const TASK_CENTER_PANEL_ID = 'agentops-task-center'
const INBOX_PANEL_ID = 'agentops-inbox'
const STARMAP_PANEL_ID = 'agentops-starmap'
const DASHBOARD_PANEL_ID = 'agentops-dashboard'
const PROJECTS_PANEL_ID = 'agentops-projects'
const LIST_PANEL_ID = 'agentops-list'
const GANTT_PANEL_ID = 'agentops-gantt'
const VAULT_PANEL_ID = 'agentops-vault'
const REPLAY_PANEL_ID = 'agentops-replay'
const A2UI_PANEL_ID = 'agentops-a2ui'

/** The collaboration panel id in the shape the layout navigation expects. */
const COLLAB_MAIN_PANEL_ID = COLLAB_PANEL_ID as MainPanelId

/** Sidebar glyph component rendered for a menu entry. */
type PanelIcon = (props: { readonly size?: number }) => ReactElement

export const inject = ['slots', 'layout', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
    'agentops-client: workflow dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(RUNS_NS, {
      zh: runsZh,
      en: runsEn,
      ja: runsJa,
      es: runsEs,
      fr: runsFr,
      de: runsDe,
      ru: runsRu,
      pt: runsPt,
    }),
    'agentops-client: run history dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(COLLAB_NS, {
      zh: collabZh,
      en: collabEn,
      ja: collabJa,
      es: collabEs,
      fr: collabFr,
      de: collabDe,
      ru: collabRu,
      pt: collabPt,
    }),
    'agentops-client: collaboration dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(AGENTS_NS, {
      zh: agentsZh,
      en: agentsEn,
      ja: agentsJa,
      es: agentsEs,
      fr: agentsFr,
      de: agentsDe,
      ru: agentsRu,
      pt: agentsPt,
    }),
    'agentops-client: agent management dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(SECURITY_NS, {
      zh: securityZh,
      en: securityEn,
      ja: securityJa,
      es: securityEs,
      fr: securityFr,
      de: securityDe,
      ru: securityRu,
      pt: securityPt,
    }),
    'agentops-client: security dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(MENU_NS, {
      zh: menuZh,
      en: menuEn,
      ja: menuJa,
      es: menuEs,
      fr: menuFr,
      de: menuDe,
      ru: menuRu,
      pt: menuPt,
    }),
    'agentops-client: menu dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(TASKS_NS, {
      zh: tasksZh,
      en: tasksEn,
      ja: tasksJa,
      es: tasksEs,
      fr: tasksFr,
      de: tasksDe,
      ru: tasksRu,
      pt: tasksPt,
    }),
    'agentops-client: task management dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(PAGE_NS, {
      zh: pageZh,
      en: pageEn,
      ja: pageJa,
      es: pageEs,
      fr: pageFr,
      de: pageDe,
      ru: pageRu,
      pt: pagePt,
    }),
    'agentops-client: page dictionaries',
  )
  const workflowT = ctx.locale.bind(NS)
  const runsT = ctx.locale.bind(RUNS_NS)
  const collabT = ctx.locale.bind(COLLAB_NS)
  const agentsT = ctx.locale.bind(AGENTS_NS)
  const securityT = ctx.locale.bind(SECURITY_NS)
  const menuT = ctx.locale.bind(MENU_NS)
  const tasksT = ctx.locale.bind(TASKS_NS)
  const rerunFeedback = createRerunFeedback()
  rerunFeedback.register(ctx)
  const agentFeedback = createAgentFeedback()
  agentFeedback.register(ctx)
  const clientConfig = resolveClientConfig(
    (globalThis as { __DSH_AGENTOPS_CLIENT_CONFIG__?: unknown })
      .__DSH_AGENTOPS_CLIENT_CONFIG__,
  )
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, AgentOpsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: KNOWLEDGE_PANEL_ID,
  }, KnowledgePanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKFLOWS_PANEL_ID,
    locale: NS,
    inject: () => ({
      publishSuccess: agentFeedback.publishSuccess,
      publishFailure: agentFeedback.publishFailure,
    }),
  }, WorkflowsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: AGENTS_PANEL_ID,
    locale: AGENTS_NS,
    inject: () => ({
      publishSuccess: agentFeedback.publishSuccess,
      publishFailure: agentFeedback.publishFailure,
    }),
  }, AgentsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SKILLS_PANEL_ID,
  }, SkillsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SCHEDULES_PANEL_ID,
  }, SchedulesPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: RUN_LOG_PANEL_ID,
    inject: () => ({
      openCollaboration: (runId: string) => {
        requestCollaborationRun(runId)
        ctx.layout.selectPanel(COLLAB_MAIN_PANEL_ID)
      },
    }),
  }, RunLogPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: RUNS_PANEL_ID,
    locale: RUNS_NS,
    inject: () => ({
      // The run history and the collaboration panel are two views of the same
      // runs; the handoff parks the run id for the collaboration panel.
      openCollaboration: (runId: string) => {
        requestCollaborationRun(runId)
        ctx.layout.selectPanel(COLLAB_MAIN_PANEL_ID)
      },
    }),
  }, RunHistoryPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SECURITY_USERS_PANEL_ID,
    locale: SECURITY_NS,
  }, SecurityUsersPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SECURITY_ROLES_PANEL_ID,
    locale: SECURITY_NS,
  }, SecurityRolesPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SECURITY_SESSIONS_PANEL_ID,
    locale: SECURITY_NS,
  }, SecuritySessionsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SECURITY_TOKENS_PANEL_ID,
    locale: SECURITY_NS,
  }, SecurityTokensPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: MONITOR_PANEL_ID,
  }, MonitorPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: COLLAB_PANEL_ID,
    locale: COLLAB_NS,
    inject: () => {
      const initialRunId = new URLSearchParams(window.location.search).get('runId') ?? undefined
      return {
        pollIntervalMs: clientConfig.collaborationPollIntervalMs,
        publishRerunNotice: rerunFeedback.publish,
        ...(initialRunId === undefined ? {} : { initialRunId }),
      }
    },
  }, CollaborationPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: TASK_CENTER_PANEL_ID,
  }, TaskCenterPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: INBOX_PANEL_ID,
  }, InboxPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: STARMAP_PANEL_ID,
  }, StarMapPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: DASHBOARD_PANEL_ID,
  }, DashboardPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: LIST_PANEL_ID,
  }, TaskListPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: GANTT_PANEL_ID,
  }, GanttPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PROJECTS_PANEL_ID,
  }, ProjectsPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: VAULT_PANEL_ID,
    locale: PAGE_NS,
  }, VaultPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: REPLAY_PANEL_ID,
    locale: PAGE_NS,
  }, SessionReplayPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: A2UI_PANEL_ID,
    locale: PAGE_NS,
  }, A2uiPanel))

  const icons: Record<AgentOpsMenuIcon, PanelIcon> = {
    knowledge: KnowledgeIcon,
    collaboration: CollaborationIcon,
    workflows: WorkflowsIcon,
    agents: AgentsIcon,
    runs: RunHistoryIcon,
    taskBoard: AgentOpsIcon,
    taskInbox: InboxIcon,
    starmap: StarMapIcon,
    dashboard: DashboardIcon,
    list: TaskListIcon,
    gantt: GanttIcon,
    projects: ProjectsIcon,
    taskReport: TaskCenterIcon,
    monitor: MonitorIcon,
    users: AgentsIcon,
    roles: SecurityIcon,
    sessions: RunHistoryIcon,
    tokens: VaultIcon,
    sessionReplay: SessionReplayIcon,
    a2ui: A2uiPanelIcon,
    schedules: SchedulesIcon,
    skills: SkillsIcon,
    vault: VaultIcon,
    capability: AgentOpsIcon,
  }
  const resolveLabel = (label: AgentOpsMenuLabel): string => {
    switch (label.namespace) {
      case 'agentopsMenu': return menuT(label.key)
      case 'agentopsTasks': return tasksT(label.key)
      case 'agentopsAgents': return agentsT(label.key)
      case 'agentopsWorkflows': return workflowT(label.key)
      case 'agentopsCollaboration': return collabT(label.key)
      case 'agentopsRuns': return runsT(label.key)
      case 'agentopsSecurity': return securityT(label.key)
    }
  }
  const sections = new Map<string, SlotListSection>(AGENTOPS_MENU_SECTIONS.map(section => [
    section.id,
    {
      id: section.id,
      order: section.order,
      label: () => resolveLabel(section.label),
      defaultOpen: section.defaultOpen,
    },
  ]))

  for (const row of AGENTOPS_MENU_ROWS) {
    let section: SlotListSection | undefined
    if (row.section !== undefined) {
      const declared = sections.get(row.section)
      if (declared === undefined) {
        throw new Error(`agentops-client: menu entry "${row.id}" names unknown section "${row.section}"`)
      }
      section = declared
    }
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: row.id,
      order: row.order,
      label: () => resolveLabel(row.label),
      ...(section === undefined ? {} : { section }),
    }, icons[row.icon]))
  }

  // Right-sidebar generative-UI screen: optional, so it is gated on its own
  // services rather than added to this plugin's `inject` (a missing sidebar must
  // not stop every panel from mounting).
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], () => { registerSurfaceScreen(ctx) })
}
