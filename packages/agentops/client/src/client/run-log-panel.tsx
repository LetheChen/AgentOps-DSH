/**
 * Unified run log: DAG runs, session replay, and generated UI surfaces.
 *
 * @module @agentops/dsh-client/client
 */

import { useMemo, useState, type ReactElement } from 'react'

import { A2uiPanel } from './a2ui-panel.tsx'
import { zh as pageZh } from './page-locales.js'
import { RunHistoryPanel } from './run-history-panel.tsx'
import { zh as runsZh } from './run-history-locales.js'
import { SessionReplayPanel } from './session-replay-panel.tsx'

type RunLogTab = 'runs' | 'replay' | 'surfaces'

interface RunLogPanelProps {
  readonly openCollaboration?: (runId: string) => void
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

const DEFAULT_RUN_LOG_TAB = {
  id: 'runs',
  label: 'runlog.tab.runs',
  description: 'runlog.description.runs',
} as const

const RUN_LOG_TABS: readonly {
  readonly id: RunLogTab
  readonly label: 'runlog.tab.runs' | 'runlog.tab.replay' | 'runlog.tab.surfaces'
  readonly description: 'runlog.description.runs' | 'runlog.description.replay' | 'runlog.description.surfaces'
}[] = [
  DEFAULT_RUN_LOG_TAB,
  { id: 'replay', label: 'runlog.tab.replay', description: 'runlog.description.replay' },
  { id: 'surfaces', label: 'runlog.tab.surfaces', description: 'runlog.description.surfaces' },
]

function translate(dictionary: Readonly<Record<string, string>>): Translate {
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{([^}]+)\}/g, (match, name: string) => String(params[name] ?? match))
  }
}

/** Render the three execution-evidence views behind one navigation entry. */
export function RunLogPanel({ openCollaboration }: RunLogPanelProps): ReactElement {
  const [tab, setTab] = useState<RunLogTab>('runs')
  const runsT = useMemo(() => translate(runsZh), [])
  const pageT = useMemo(() => translate(pageZh), [])
  const activeTab = RUN_LOG_TABS.find(entry => entry.id === tab) ?? DEFAULT_RUN_LOG_TAB

  return (
    <div className="ao-runlog-shell agentops-theme-scope">
      <header className="ao-page-header ao-runlog-header">
        <div className="ao-page-heading">
          <div className="ao-runlog-title-row">
            <h1 className="ao-page-title">{pageT('runlog.title')}</h1>
            <span className="ao-runlog-badge">{pageT('runlog.readonly')}</span>
          </div>
          <p className="ao-page-description">{pageT(activeTab.description)}</p>
        </div>
      </header>
      <nav className="ao-runlog-tabs" role="tablist" aria-label={pageT('runlog.tabsAria')}>
        {RUN_LOG_TABS.map(entry => (
          <button
            key={entry.id}
            id={`runlog-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`runlog-panel-${entry.id}`}
            className={tab === entry.id ? 'active' : ''}
            onClick={() => { setTab(entry.id) }}
          >
            {pageT(entry.label)}
          </button>
        ))}
      </nav>
      <div
        className="ao-runlog-content"
        id={`runlog-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`runlog-tab-${tab}`}
      >
        {tab === 'runs' ? <RunHistoryPanel t={runsT} {...(openCollaboration === undefined ? {} : { openCollaboration })} /> : null}
        {tab === 'replay' ? <SessionReplayPanel t={pageT} embedded /> : null}
        {tab === 'surfaces' ? <A2uiPanel t={pageT} embedded /> : null}
      </div>
    </div>
  )
}
