/**
 * Wire the surface screen into the right sidebar.
 *
 * Registration follows the package's documented two stages: the type into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab` seat.
 * A small poller opens the tab when a surface newer than the last seen one
 * arrives, so publishing from a conversation is enough to make it appear.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { SURFACE_TAB_ID, SURFACE_TAB_KIND, surfaceTabDefinition } from './definition.ts'
import { SurfaceScreen } from './ScreenBody.tsx'

/** The slice of the right-sidebar controller this module uses. */
interface SidebarRightLike {
  openTab(kind: string, options?: unknown): void
}

/** The slice of the tab registry this module uses. */
interface TabRegistryLike {
  register(definition: ReturnType<typeof surfaceTabDefinition>): () => void
}

interface SlotsLike {
  inject(name: string, factory: () => unknown): unknown
  register(options: { name: string; key: string }, component: unknown): unknown
}

/** The sidebar opener installed by `registerSurfaceScreen`. */
let openPane: (() => boolean) | null = null

/**
 * Ask the right sidebar to show the generative-UI screen. Returns false when the
 * sidebar is unavailable (no session on screen yet).
 * @returns true when the screen was opened.
 */
export function openSurfaceScreen(): boolean {
  return openPane === null ? false : openPane()
}

/**
 * Register the tab type, its body, and the auto-open poller.
 * @param ctx - client context carrying `slots`, `sidebarRightTabs` and `sidebarRight`.
 */
export function registerSurfaceScreen(ctx: ClientContext): void {
  const tabs = ctx.get('sidebarRightTabs') as TabRegistryLike | undefined
  const right = ctx.get('sidebarRight') as SidebarRightLike | undefined
  const slots = ctx.get('slots') as SlotsLike | undefined
  if (tabs === undefined || slots === undefined) return

  ctx.effect(() => tabs.register(surfaceTabDefinition()), 'agentops: surface tab type')

  slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: SURFACE_TAB_ID,
  }, SurfaceScreen))

  if (right === undefined) return

  openPane = () => {
    try {
      right.openTab(SURFACE_TAB_KIND)
      return true
    } catch {
      // No session on screen: the sidebar refuses; the caller explains why.
      return false
    }
  }

  // Open on new content. Sessions are required by `openTab`; a throw simply means
  // "no session on screen yet", which is not an error worth surfacing.
  ctx.effect(() => {
    let lastSeen = -1
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch('/api/agentops/surfaces/latest', { credentials: 'include' })
        if (!response.ok) return
        const data = await response.json() as { surface: { id: number } | null }
        const id = data.surface?.id ?? -1
        if (id <= lastSeen) return
        lastSeen = id
        if (id < 0) return
        try {
          right.openTab(SURFACE_TAB_KIND)
        } catch {
          // No session on screen: the next tick after entering one will open it.
        }
      } catch {
        // Network hiccup: keep polling.
      }
    }
    const timer = setInterval(() => { void tick() }, 4000)
    return () => { clearInterval(timer) }
  }, 'agentops: surface screen auto-open')
}
