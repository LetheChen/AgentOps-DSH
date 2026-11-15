/**
 * Secret sealing for the credential vault.
 *
 * Layout: AES-256-GCM, payload `nonce(12) | tag(16) | ciphertext`, prefixed with
 * `v1.` and base64-encoded. The Additional Authenticated Data binds a ciphertext
 * to its record (`<kind>:<id>:password`), so copying a sealed value onto another
 * row fails to open instead of silently working.
 *
 * Key location: `AGENTOPS_CRED_KEY` (base64, 32 bytes) when set; otherwise a key
 * file at `$DSH_HOME/agentops/cred.key`, created on first use with 0600. The key
 * file next to the database is the weak case — it protects against a copied DB
 * file, not against an attacker with read access to the whole home directory.
 * That tradeoff is deliberate: the alternative (no key anywhere) is worse, and
 * the DSH credential service remains available for deployments that prefer it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The vault's master key and where it came from. */
export interface MasterKey {
  readonly key: Buffer
  readonly source: 'env' | 'file'
  /** Key file path when `source === 'file'`. */
  readonly path?: string
}

/**
 * Default key file location.
 * @returns the path of the key file used when no environment key is set.
 */
export function resolveKeyPath(): string {
  const explicit = process.env.AGENTOPS_CRED_KEY_FILE?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return dshHomePath('agentops', 'cred.key')
}

/**
 * Load the master key, creating the key file on first use.
 * @throws when an environment key exists but is not 32 bytes.
 * @returns the master key, creating the key file on first use.
 */
export function loadMasterKey(): MasterKey {
  const fromEnv = process.env.AGENTOPS_CRED_KEY?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== 32) throw new Error('AGENTOPS_CRED_KEY 必须是 base64 编码的 32 字节密钥')
    return { key, source: 'env' }
  }
  const path = resolveKeyPath()
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const generated = randomBytes(32)
    writeFileSync(path, generated.toString('base64'), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows ignores POSIX modes; the file still stays out of the repo.
    }
  }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  if (key.length !== 32) throw new Error(`密钥文件损坏：${path}`)
  return { key, source: 'file', path }
}

/**
 * AAD that binds a sealed secret to one connection's password field.
 * @param kind - the connection kind the secret belongs to.
 * @param id - the connection id the secret belongs to.
 * @returns the additional authenticated data that binds a ciphertext to one record.
 */
export function secretAad(kind: string, id: string): string {
  return `${kind}:${id}:password`
}

/**
 * Seal one secret.
 * @param key - master key.
 * @param plaintext - secret value.
 * @param aad - binding context (see {@link secretAad}).
 * @returns the sealed secret, prefixed with its payload version.
 */
export function sealSecret(key: Buffer, plaintext: string, aad: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${Buffer.concat([nonce, tag, ciphertext]).toString('base64')}`
}

/**
 * Open one sealed secret.
 * @throws when the payload is corrupt or the AAD does not match.
 * @param key - master key.
 * @param sealed - the sealed secret.
 * @param aad - binding context (see {@link secretAad}).
 * @returns the decrypted secret.
 */
export function openSecret(key: Buffer, sealed: string, aad: string): string {
  if (!sealed.startsWith('v1.')) throw new Error('未知的密文版本')
  const payload = Buffer.from(sealed.slice(3), 'base64')
  if (payload.length <= 28) throw new Error('密文长度不合法')
  const nonce = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
