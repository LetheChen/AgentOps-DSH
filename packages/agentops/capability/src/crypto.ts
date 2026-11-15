/**
 * Credential sealing for the capability control plane.
 *
 * Each capability database owns its sealed ciphertext. The AES-256-GCM payload
 * and AAD binding reuse the existing vault implementation so key handling and
 * tamper detection stay consistent across AgentOps domains.
 *
 * @module @agentops/dsh-capability/crypto
 */

import { loadMasterKey, openSecret, sealSecret, type MasterKey } from '@agentops/dsh-vault/src/crypto.ts'

/** AAD for one capability instance credential. */
export function capabilitySecretAad(instanceId: string): string {
  return `capability:${instanceId}:credential`
}

/** Load the AgentOps master key used by capability credentials. */
export function loadCapabilityMasterKey(): MasterKey {
  return loadMasterKey()
}

/** Seal one capability credential without exposing the plaintext to SQLite. */
export function sealCapabilitySecret(key: MasterKey, instanceId: string, plaintext: string): string {
  return sealSecret(key.key, plaintext, capabilitySecretAad(instanceId))
}

/** Open one capability credential, surfacing ciphertext corruption to the caller. */
export function openCapabilitySecret(key: MasterKey, instanceId: string, sealed: string): string {
  return openSecret(key.key, sealed, capabilitySecretAad(instanceId))
}
