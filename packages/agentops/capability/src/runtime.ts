/**
 * Preset-scoped runtime helper for capability-bound tools.
 *
 * The same repository that answers the page resolves the instance. A handler
 * must never accept an instance id or secret from model arguments.
 *
 * @module @agentops/dsh-capability/runtime
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { CapabilityStore } from './store.ts'
import type { CapabilityRuntime } from './types.ts'

/**
 * Open the production capability store at its deployment path.
 * @returns the store backed by the deployed capabilities database.
 */
export function openCapabilityRuntimeStore(): CapabilityStore {
  return new CapabilityStore(dshHomePath('agentops', 'capabilities.db'))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityRuntime: CapabilityRuntimeService
  }
}

/** Root-owned runtime repository shared with preset-scoped tools. */
export class CapabilityRuntimeService extends Service {
  /** The root store shared with control-plane routes. */
  readonly store: CapabilityStore

  /**
   * Publish one capability store to every preset scope in this host.
   * @param ctx - root context owning the service.
   * @param store - the same store the control-plane routes write through.
   */
  constructor(ctx: Context, store: CapabilityStore) {
    super(ctx, 'capabilityRuntime')
    this.store = store
  }

  /**
   * Resolve one preset's configured binding state and enabled capability instances.
   * @param agentPreset - preset bound to the executing Agent.
   * @param capabilityId - capability family requested by the tool.
   * @returns configured state plus enabled runtime instances.
   */
  resolveSet(agentPreset: string, capabilityId: string): CapabilityToolResolution {
    return {
      configured: this.store.hasBindings(agentPreset),
      runtimes: this.store.listRuntimes(agentPreset, capabilityId),
    }
  }

  /**
   * Resolve one authorized runtime instance.
   * @param agentPreset - preset bound to the executing Agent.
   * @param capabilityId - capability family requested by the tool.
   * @param requestedInstanceId - optional explicit instance id or alias.
   * @returns the authorized instance and its opened credential.
   */
  resolve(agentPreset: string, capabilityId: string, requestedInstanceId?: string): CapabilityRuntime {
    return this.store.resolveRuntime(agentPreset, capabilityId, requestedInstanceId)
  }
}

/**
 * List every enabled runtime instance authorized to one preset.
 * @param agentPreset - authenticated preset id.
 * @param capabilityId - capability family to list.
 * @param store - injected store for tests.
 * @returns every resolved instance, or an empty list when none are bound.
 */
export function resolveCapabilitiesForTool(
  agentPreset: string,
  capabilityId: string,
  store?: CapabilityStore,
): CapabilityRuntime[] {
  return resolveCapabilitySetForTool(agentPreset, capabilityId, store).runtimes
}

/** Binding state and enabled instances resolved for one preset and capability. */
export interface CapabilityToolResolution {
  /** True when this preset was configured in the center; false preserves legacy fallback. */
  readonly configured: boolean
  /** Enabled bound instances for this capability. Empty while configured means deny. */
  readonly runtimes: CapabilityRuntime[]
}

/**
 * Resolve a capability-bound tool snapshot and distinguish "not configured" from "configured empty".
 * @param agentPreset - authenticated preset id.
 * @param capabilityId - capability family to list.
 * @param store - injected store for tests.
 * @returns the configured state plus enabled runtime instances.
 */
export function resolveCapabilitySetForTool(
  agentPreset: string,
  capabilityId: string,
  store?: CapabilityStore,
): CapabilityToolResolution {
  const owned = store === undefined
  const subject = store ?? openCapabilityRuntimeStore()
  try {
    return {
      configured: subject.hasBindings(agentPreset),
      runtimes: subject.listRuntimes(agentPreset, capabilityId),
    }
  } finally {
    if (owned) subject.close()
  }
}

/**
 * Resolve one runtime instance for a preset, closing the temporary store.
 * @param agentPreset - authenticated preset id.
 * @param capabilityId - capability the handler implements.
 * @param requestedInstanceId - optional user/model alias checked against bindings.
 * @param store - injected store for tests.
 * @returns the authorized runtime data.
 */
export function resolveCapabilityForTool(
  agentPreset: string,
  capabilityId: string,
  requestedInstanceId?: string,
  store?: CapabilityStore,
): CapabilityRuntime {
  const owned = store === undefined
  const subject = store ?? openCapabilityRuntimeStore()
  try {
    return subject.resolveRuntime(agentPreset, capabilityId, requestedInstanceId)
  } finally {
    if (owned) subject.close()
  }
}
