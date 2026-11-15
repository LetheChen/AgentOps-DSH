/**
 * Right-Sidebar tab type declaration for the generative-UI screen.
 *
 * Stage one of the two-stage registration documented by
 * `@deepseek-ai/dsh-client-ui-sidebar-right`: this file says what the tab IS, the
 * body registers under the same `id` into the keyed `sidebar.right.pane.tab`
 * seat. A page type omits `patterns` — it is opened by kind, not by address.
 */

/**
 * Structural copy of the registry's definition shape.
 *
 * Importing the package's type would pull its sources into this project's
 * `rootDir`; the type is stable enough (id/kind/title/keepMounted) to describe
 * locally, and a mismatch fails at registration time in the browser.
 */
interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly keepMounted?: boolean
  readonly title: (address: string) => string
}

/** Kind passed to `openTab` when something wants the surface screen. */
export const SURFACE_TAB_KIND = 'agentops-surface'

/** Implementation identity: the key the body registers under. */
export const SURFACE_TAB_ID = '@agentops/dsh-client-surface-screen'

/**
 * The screen's tab definition. One page per pane, kept mounted while hidden so a
 * re-open does not refetch and flicker.
 * @returns the right-sidebar tab definition for the screen.
 */
export function surfaceTabDefinition(): SidebarRightTabDefinition {
  return {
    id: SURFACE_TAB_ID,
    kind: SURFACE_TAB_KIND,
    keepMounted: true,
    title: () => '生成式 UI',
  }
}
