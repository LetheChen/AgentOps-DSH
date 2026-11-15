/**
 * Capability-center browser plugin.
 *
 * A standalone AgentOps surface: one sidebar entry and one main panel over the
 * capability RPC bridge. It does not modify the shared AgentOps client plugin,
 * so the panel can be enabled per profile.
 *
 * @module @agentops/dsh-ui-capability/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CapabilityPanel } from './panel.tsx'
import { LogCollectionTab } from './log-collection-panel.tsx'
import { CapabilityAuditPanel } from './audit-panel.tsx'
import './style.css'

/** Panel id shared by the sidebar and main slots. */
export const CAPABILITY_PANEL_ID = 'agentops-capability'
const MAIN_PANEL_ID = CAPABILITY_PANEL_ID as MainPanelId

/** Independent second-level panel for the log collection task registry. */
const LOG_PANEL_ID = 'agentops-logs' as MainPanelId

/** Independent operations panel for capability control-plane audit records. */
const AUDIT_PANEL_ID = 'agentops-capability-audit' as MainPanelId

/** Required services: placement, panel rendering, and the Agent-preset roster. */
export const inject = ['slots', 'layout', 'remote', 'remote.agentPresets']

/** The only Remote member this panel consumes, declared locally. */
interface AgentPresetRemoteContext {
  readonly remote: {
    readonly agentPresets: {
      readonly list: () => Promise<
        | { readonly ok: true; readonly value: { readonly presets: readonly CapabilityAgentPreset[] } }
        | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
      >
    }
  }
}

/** Browser-safe roster row delivered to the panel. */
export interface CapabilityAgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly isDefault: boolean
  readonly broken?: string
}

/** Roster lookup used by the main panel. */
export type CapabilityAgentPresetReader = () => Promise<readonly CapabilityAgentPreset[]>

/**
 * Register the capability sidebar entry and main panel.
 *
 * Labels are fixed Chinese product names for this internal AgentOps surface; the
 * rest of the copy comes from the package's Chinese dictionary imported by the
 * panel. Keeping the shell independent avoids a second locale registration path.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const remote = (ctx as ClientContext & AgentPresetRemoteContext).remote
  const readPresets: CapabilityAgentPresetReader = async () => {
    const result = await remote.agentPresets.list()
    if (!result.ok) {
      if (result.error.code === 'gateway/invocation-unavailable') return []
      throw new Error(result.error.message)
    }
    return result.value.presets
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: MAIN_PANEL_ID,
    inject: () => ({ readPresets }),
  }, CapabilityPanel))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: LOG_PANEL_ID,
    inject: () => ({}),
  }, LogCollectionTab))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: AUDIT_PANEL_ID,
    inject: () => ({}),
  }, CapabilityAuditPanel))
}
