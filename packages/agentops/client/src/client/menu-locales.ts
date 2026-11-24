/** `agentopsMenu` dictionaries for the AgentOps sidebar sections and entries. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by the AgentOps sidebar menu. */
export const MENU_NS = 'agentopsMenu'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.systemSettings': '系统设置',
  'section.capabilityCenter': '能力中心',
  'section.observability': '运行监控',
  'panel.capabilityConnectors': '能力与连接器',
  'panel.logs': '日志采集',
  'panel.deployments': '业务部署',
  'panel.skills': 'Skill 管理',
  'panel.runLog': '运行日志',
  'panel.capabilityAudit': '控制面审计',
  'panel.knowledge': '知识库管理',
  'panel.monitor': '监控中心',
  'panel.sessionReplay': '会话回放',
  'panel.a2ui': '生成式 UI',
  'panel.schedules': '定时计划',
  'panel.vault': '凭证管理',
} as const

/** Menu namespace key union. */
export type MenuKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AgentOps sidebar menu copy. */
    agentopsMenu: MenuKey
  }
}

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'section.systemSettings': 'System settings',
  'section.capabilityCenter': 'Capabilities',
  'section.observability': 'Operations',
  'panel.capabilityConnectors': 'Capabilities & connectors',
  'panel.logs': 'Log collection',
  'panel.deployments': 'Business deployment',
  'panel.skills': 'Skills',
  'panel.runLog': 'Run log',
  'panel.capabilityAudit': 'Control plane audit',
  'panel.knowledge': 'Knowledge management',
  'panel.monitor': 'Monitoring',
  'panel.sessionReplay': 'Session replay',
  'panel.a2ui': 'Generative UI',
  'panel.schedules': 'Schedules',
  'panel.vault': 'Credentials',
} satisfies Record<MenuKey, string>

/** Japanese dictionary, checked complete against the Chinese key set. */
export const ja = {
  'section.systemSettings': 'システム設定',
  'section.capabilityCenter': '機能センター',
  'section.observability': '実行監視',
  'panel.capabilityConnectors': '機能とコネクタ',
  'panel.logs': 'ログ収集',
  'panel.deployments': 'ビジネスデプロイ',
  'panel.skills': 'スキル管理',
  'panel.runLog': '実行ログ',
  'panel.capabilityAudit': 'コントロールプレーン監査',
  'panel.knowledge': 'ナレッジ管理',
  'panel.monitor': '監視センター',
  'panel.sessionReplay': 'セッションリプレイ',
  'panel.a2ui': '生成型 UI',
  'panel.schedules': 'スケジュール',
  'panel.vault': '認証情報',
} satisfies Record<MenuKey, string>

/** Spanish dictionary, checked complete against the Chinese key set. */
export const es = {
  'section.systemSettings': 'Ajustes del sistema',
  'section.capabilityCenter': 'Centro de capacidades',
  'section.observability': 'Supervisión',
  'panel.capabilityConnectors': 'Capacidades y conectores',
  'panel.logs': 'Recolección de logs',
  'panel.deployments': 'Despliegue de negocio',
  'panel.skills': 'Habilidades',
  'panel.runLog': 'Registro de ejecución',
  'panel.capabilityAudit': 'Auditoría del plano de control',
  'panel.knowledge': 'Gestión de la base de conocimiento',
  'panel.monitor': 'Centro de supervisión',
  'panel.sessionReplay': 'Reproducción de sesión',
  'panel.a2ui': 'UI generativa',
  'panel.schedules': 'Programaciones',
  'panel.vault': 'Credenciales',
} satisfies Record<MenuKey, string>

/** French dictionary, checked complete against the Chinese key set. */
export const fr = {
  'section.systemSettings': 'Paramètres système',
  'section.capabilityCenter': 'Centre de capacités',
  'section.observability': 'Supervision',
  'panel.capabilityConnectors': 'Capacités et connecteurs',
  'panel.logs': 'Collecte de logs',
  'panel.deployments': 'Déploiement métier',
  'panel.skills': 'Compétences',
  'panel.runLog': 'Journal d’exécution',
  'panel.capabilityAudit': 'Audit du plan de contrôle',
  'panel.knowledge': 'Gestion de la base de connaissances',
  'panel.monitor': 'Centre de supervision',
  'panel.sessionReplay': 'Relecture de session',
  'panel.a2ui': 'UI générative',
  'panel.schedules': 'Planifications',
  'panel.vault': 'Identifiants',
} satisfies Record<MenuKey, string>

/** German dictionary, checked complete against the Chinese key set. */
export const de = {
  'section.systemSettings': 'Systemeinstellungen',
  'section.capabilityCenter': 'Fähigkeitszentrum',
  'section.observability': 'Laufzeitüberwachung',
  'panel.capabilityConnectors': 'Fähigkeiten & Konnektoren',
  'panel.logs': 'Protokollerfassung',
  'panel.deployments': 'Geschäftsbereitstellung',
  'panel.skills': 'Fähigkeiten',
  'panel.runLog': 'Ausführungsprotokoll',
  'panel.capabilityAudit': 'Steuerungsebenen-Audit',
  'panel.knowledge': 'Wissensmanagement',
  'panel.monitor': 'Überwachungszentrale',
  'panel.sessionReplay': 'Sitzungswiedergabe',
  'panel.a2ui': 'Generative UI',
  'panel.schedules': 'Zeitpläne',
  'panel.vault': 'Anmeldedaten',
} satisfies Record<MenuKey, string>

/** Russian dictionary, checked complete against the Chinese key set. */
export const ru = {
  'section.systemSettings': 'Системные настройки',
  'section.capabilityCenter': 'Центр возможностей',
  'section.observability': 'Мониторинг',
  'panel.capabilityConnectors': 'Возможности и коннекторы',
  'panel.logs': 'Сбор журналов',
  'panel.deployments': 'Развёртывание бизнеса',
  'panel.skills': 'Навыки',
  'panel.runLog': 'Журнал выполнения',
  'panel.capabilityAudit': 'Аудит плоскости управления',
  'panel.knowledge': 'Управление базой знаний',
  'panel.monitor': 'Центр мониторинга',
  'panel.sessionReplay': 'Воспроизведение сессий',
  'panel.a2ui': 'Генеративный UI',
  'panel.schedules': 'Расписания',
  'panel.vault': 'Учётные данные',
} satisfies Record<MenuKey, string>

/** Portuguese dictionary, checked complete against the Chinese key set. */
export const pt = {
  'section.systemSettings': 'Configurações do sistema',
  'section.capabilityCenter': 'Central de capacidades',
  'section.observability': 'Operações',
  'panel.capabilityConnectors': 'Capacidades e conectores',
  'panel.logs': 'Coleta de logs',
  'panel.deployments': 'Implantação de negócio',
  'panel.skills': 'Habilidades',
  'panel.runLog': 'Registro de execução',
  'panel.capabilityAudit': 'Auditoria do plano de controle',
  'panel.knowledge': 'Gestão da base de conhecimento',
  'panel.monitor': 'Central de monitoramento',
  'panel.sessionReplay': 'Reprodução de sessão',
  'panel.a2ui': 'UI generativa',
  'panel.schedules': 'Agendamentos',
  'panel.vault': 'Credenciais',
} satisfies Record<MenuKey, string>
