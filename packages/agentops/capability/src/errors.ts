/**
 * Capability-center error type with stable machine-readable codes.
 *
 * @module @agentops/dsh-capability/errors
 */

import type { CapabilityErrorCode } from './types.ts'

/** A capability operation rejected by policy or missing data. */
export class CapabilityError extends Error {
  /**
   * @param code - stable error code returned to the caller.
   * @param message - human-readable detail.
   * @param details - optional structured context without secrets.
   */
  constructor(
    public readonly code: CapabilityErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}
