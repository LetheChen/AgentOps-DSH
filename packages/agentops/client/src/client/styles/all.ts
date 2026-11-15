/**
 * Inject every AgentOps stylesheet once, at module load.
 *
 * Per-panel injection with cleanup used to fight itself: the incoming panel
 * added its <style> and the departing panel's cleanup removed a tag with the
 * same id, leaving tables/pills unstyled on some pages. One permanent injection
 * removes that race entirely.
 */

import base from './base.css?inline'
import surface from './surface.css?inline'
import theme from './theme.css?inline'
import knowledge from './knowledge.css?inline'
import workflows from './workflows.css?inline'
import agents from './agents.css?inline'
import schedules from './schedules.css?inline'
import a2ui from './a2ui.css?inline'
import a2uiFix from './a2ui-fix.css?inline'
import monitor from './monitor.css?inline'
import runHistory from './run-history.css?inline'
import collaboration from './collaboration.css?inline'
import security from './security.css?inline'
import starmap from './starmap.css?inline'
import taskCenter from './task-center.css?inline'
import memoryNebula from './memory-nebula.css?inline'
import pageShell from './page-shell.css?inline'
import pages from './pages.css?inline'
import runLog from './run-log.css?inline'

const SHEETS: Record<string, string> = {
  'agentops/base': base,
  'agentops/surface': surface,
  'agentops/theme': theme,
  'agentops/knowledge': knowledge,
  'agentops/workflows': workflows,
  'agentops/agents': agents,
  'agentops/schedules': schedules,
  'agentops/a2ui': a2ui,
  'agentops/a2ui-fix': a2uiFix,
  'agentops/monitor': monitor,
  'agentops/run-history': runHistory,
  'agentops/collaboration': collaboration,
  'agentops/security': security,
  'agentops/starmap': starmap,
  'agentops/task-center': taskCenter,
  'agentops/memory-nebula': memoryNebula,
  'agentops/page-shell': pageShell,
  'agentops/pages': pages,
  'agentops/run-log': runLog,
}

/**
 * Resolve the palette for our panels: follow the host theme only.
 *
 * DSH owns appearance (dark / light / system); AgentOps does not add a fourth
 * switch, so there is nothing to store and no 'warm' variant to select.
 */
export type AgentOpsTheme = 'dark' | 'light' | 'auto'

/**
 * The palette a value resolves to right now (`auto` follows the host).
 * @returns the active palette name.
 */
export function resolveTheme(): 'dark' | 'light' {
  const host = document.documentElement.dataset.dsThemeSource
  return host === 'light' ? 'light' : 'dark'
}

/**
 * Stamp the resolved palette onto every panel root (including future ones).
 * @param themeValue - the requested palette; `auto` follows the host.
 */
export function applyAgentOpsTheme(themeValue: AgentOpsTheme = 'auto'): void {
  if (typeof document === 'undefined') return
  const resolved = themeValue === 'auto' ? resolveTheme() : themeValue
  for (const element of document.querySelectorAll<HTMLElement>('.agentops-surface, .agentops-theme-scope')) {
    if (element.dataset.theme !== resolved) element.dataset.theme = resolved
  }
}

if (typeof document !== 'undefined') {
  for (const [id, css] of Object.entries(SHEETS)) {
    if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) continue
    const tag = document.createElement('style')
    tag.dataset.plugin = 'agentops'
    tag.dataset.pluginCss = id
    tag.textContent = css
    document.head.appendChild(tag)
  }

  applyAgentOpsTheme('auto')
  // Panels mount on demand, so watch for new roots instead of polling.
  new MutationObserver(() => { applyAgentOpsTheme() }).observe(document.body, { childList: true, subtree: true })
  // The host switches theme by flipping `data-ds-theme-source` on <html>.
  new MutationObserver(() => { applyAgentOpsTheme('auto') }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-ds-theme-source'],
  })
}
