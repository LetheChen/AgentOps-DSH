/** `agentopsTasks` dictionaries for the task management menu group. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by the task management group. */
export const TASKS_NS = 'agentopsTasks'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.label': '任务管理',
  'panel.taskCenter': '任务中心',
  'panel.taskInbox': '收件箱',
  'panel.starmap': '任务星图',
  'panel.taskReport': '任务报告',
  'panel.dashboard': '任务仪表盘',
  'panel.list': '任务列表',
  'panel.gantt': '任务甘特图',
  'panel.projects': '项目管理',
} as const

/** Task-menu namespace key union. */
export type TaskMenuKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task management menu copy. */
    agentopsTasks: TaskMenuKey
  }
}

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'section.label': 'Task management',
  'panel.taskCenter': 'Task center',
  'panel.taskInbox': 'Inbox',
  'panel.starmap': 'Star map',
  'panel.taskReport': 'Task report',
  'panel.dashboard': 'Dashboard',
  'panel.list': 'Task list',
  'panel.gantt': 'Gantt',
  'panel.projects': 'Projects',
} satisfies Record<TaskMenuKey, string>

/** Japanese dictionary, checked complete against the Chinese key set. */
export const ja = {
  'section.label': 'タスク管理',
  'panel.taskCenter': 'タスクセンター',
  'panel.taskInbox': '受信箱',
  'panel.starmap': 'スターマップ',
  'panel.taskReport': 'タスクレポート',
  'panel.dashboard': 'ダッシュボード',
  'panel.list': 'タスク一覧',
  'panel.gantt': 'ガント',
  'panel.projects': 'プロジェクト',
} satisfies Record<TaskMenuKey, string>

/** Spanish dictionary, checked complete against the Chinese key set. */
export const es = {
  'section.label': 'Gestión de tareas',
  'panel.taskCenter': 'Centro de tareas',
  'panel.taskInbox': 'Bandeja',
  'panel.starmap': 'Mapa estelar',
  'panel.taskReport': 'Informe de tareas',
  'panel.dashboard': 'Panel',
  'panel.list': 'Lista de tareas',
  'panel.gantt': 'Gantt',
  'panel.projects': 'Proyectos',
} satisfies Record<TaskMenuKey, string>

/** French dictionary, checked complete against the Chinese key set. */
export const fr = {
  'section.label': 'Gestion des tâches',
  'panel.taskCenter': 'Centre des tâches',
  'panel.taskInbox': 'Boîte de réception',
  'panel.starmap': 'Carte stellaire',
  'panel.taskReport': 'Rapport de tâche',
  'panel.dashboard': 'Tableau de bord',
  'panel.list': 'Liste des tâches',
  'panel.gantt': 'Gantt',
  'panel.projects': 'Projets',
} satisfies Record<TaskMenuKey, string>

/** German dictionary, checked complete against the Chinese key set. */
export const de = {
  'section.label': 'Aufgabenverwaltung',
  'panel.taskCenter': 'Aufgabenzentrum',
  'panel.taskInbox': 'Posteingang',
  'panel.starmap': 'Sternenkarte',
  'panel.taskReport': 'Aufgabenbericht',
  'panel.dashboard': 'Übersicht',
  'panel.list': 'Aufgabenliste',
  'panel.gantt': 'Gantt',
  'panel.projects': 'Projekte',
} satisfies Record<TaskMenuKey, string>

/** Russian dictionary, checked complete against the Chinese key set. */
export const ru = {
  'section.label': 'Управление задачами',
  'panel.taskCenter': 'Центр задач',
  'panel.taskInbox': 'Входящие',
  'panel.starmap': 'Звёздная карта',
  'panel.taskReport': 'Отчёт по задаче',
  'panel.dashboard': 'Панель',
  'panel.list': 'Список задач',
  'panel.gantt': 'Гант',
  'panel.projects': 'Проекты',
} satisfies Record<TaskMenuKey, string>

/** Portuguese dictionary, checked complete against the Chinese key set. */
export const pt = {
  'section.label': 'Gestão de tarefas',
  'panel.taskCenter': 'Centro de tarefas',
  'panel.taskInbox': 'Caixa de entrada',
  'panel.starmap': 'Mapa estelar',
  'panel.taskReport': 'Relatório de tarefas',
  'panel.dashboard': 'Painel',
  'panel.list': 'Lista de tarefas',
  'panel.gantt': 'Gantt',
  'panel.projects': 'Projetos',
} satisfies Record<TaskMenuKey, string>
