/**
 * Strict, read-only SFTP transport for log collection.
 *
 * The transfer performs a credential-free host-key probe first, then one SFTP
 * session per file. Every local write goes to a temporary file that is fsynced
 * and atomically renamed, so a failed pull never leaves a half-written log.
 *
 * @module @agentops/dsh-log-collection/transport
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper, Stats } from 'ssh2'

import {
  LogCollectionError,
  type SshCredential,
  type SshInstanceConfig,
} from './types.ts'

/** Previous checkpoint for one remote file. */
export interface PullFilePrevious {
  readonly size: number
  readonly mtimeMs: number
}

/** Outcome of one file transfer. */
export interface PullFileResult {
  /** Total size of the local file after this pull. */
  readonly bytes: number
  /** Offset where content added by this pull begins. */
  readonly deltaStart: number
  /** Offset where content added by this pull ends. */
  readonly deltaEnd: number
  /** Whether the remote file was unchanged since the last pull. */
  readonly skipped: boolean
  /** Remote mtime in milliseconds, stored as the next checkpoint. */
  readonly mtimeMs: number
}

/** One remote file transfer with strict read-only semantics. */
export interface LogSftpTransport {
  /**
   * Read the server host key without authenticating.
   * @param config - resolved SSH configuration.
   * @returns the observed OpenSSH fingerprint.
   */
  probeHostKey(config: SshInstanceConfig): Promise<string>

  /**
   * Expand remote glob patterns into concrete file paths.
   * @param config - resolved SSH configuration.
   * @param credential - decrypted credential.
   * @param patterns - absolute POSIX paths, possibly containing `*` or `?`.
   * @param signal - optional cancellation signal.
   * @returns concrete file paths, sorted, with duplicates removed.
   */
  resolveRemotePaths(
    config: SshInstanceConfig,
    credential: SshCredential,
    patterns: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly string[]>

  /**
   * Download one remote file.
   * @param config - resolved SSH configuration.
   * @param credential - decrypted credential.
   * @param remotePath - concrete remote file.
   * @param localPath - destination file.
   * @param previous - previous checkpoint, when one exists.
   * @param signal - optional cancellation signal.
   * @returns sizes and the byte range added by this pull.
   */
  pullFile(
    config: SshInstanceConfig,
    credential: SshCredential,
    remotePath: string,
    localPath: string,
    previous: PullFilePrevious | undefined,
    signal?: AbortSignal,
  ): Promise<PullFileResult>
}

/** ssh2-backed read-only transport. */
export class Ssh2LogTransport implements LogSftpTransport {
  async probeHostKey(config: SshInstanceConfig): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let verified: string | undefined
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        client.end()
        if (error !== undefined) reject(error)
        else if (verified !== undefined) resolve(verified)
        else reject(new LogCollectionError('SSH_HOST_KEY_REJECTED', 'SSH host key was not observed'))
      }
      client.once('error', (error) => {
        if (verified !== undefined) finish()
        else finish(new LogCollectionError('SSH_HOST_KEY_REJECTED', error.message))
      })
      client.once('ready', () =>{  finish() })
      client.connect(connectConfig(config, (key) => {
        verified = hostKeyFingerprint(key)
        return matchesHostKey(config, key)
      }))
    })
  }

  async resolveRemotePaths(
    config: SshInstanceConfig,
    credential: SshCredential,
    patterns: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    return await this.#withSftp(config, credential, async (sftp) => {
      const found = new Set<string>()
      for (const pattern of patterns) {
        if (signal?.aborted === true) throw new LogCollectionError('SFTP_PULL_FAILED', 'pull canceled')
        const matches = await expandRemotePattern(sftp, pattern)
        if (matches.length === 0) {
          throw new LogCollectionError('SFTP_PULL_FAILED', `远程路径无匹配文件: ${pattern}`)
        }
        for (const match of matches) found.add(match)
      }
      return [...found].sort()
    })
  }

  async pullFile(
    config: SshInstanceConfig,
    credential: SshCredential,
    remotePath: string,
    localPath: string,
    previous: PullFilePrevious | undefined,
    signal?: AbortSignal,
  ): Promise<PullFileResult> {
    await mkdir(dirname(localPath), { recursive: true })
    const temporary = `${localPath}.${process.pid}.${Date.now()}.tmp`
    try {
      const stat = await this.#withSftp(config, credential, async (sftp) => {
        const attributes = await statRemote(sftp, remotePath)
        if (!attributes.isFile()) {
          throw new LogCollectionError('SFTP_PULL_FAILED', `remote path is not a file: ${remotePath}`)
        }
        if (signal?.aborted === true) throw new LogCollectionError('SFTP_PULL_FAILED', 'pull canceled')
        return attributes
      })
      const mtimeMs = Math.trunc((stat.mtime ?? 0) * 1000)
      const size = stat.size ?? 0
      if (previous !== undefined && previous.size === size && previous.mtimeMs === mtimeMs) {
        return { bytes: size, deltaStart: size, deltaEnd: size, skipped: true, mtimeMs }
      }
      // A same-or-growing file contributes only its tail; a new or rotated file
      // contributes in full because there is no previous offset to trust.
      const deltaStart = previous !== undefined && size >= previous.size && mtimeMs >= previous.mtimeMs
        ? previous.size
        : 0
      await this.#withSftp(config, credential, async (sftp) => {
        await pipeline(sftp.createReadStream(remotePath, { flags: 'r' }), createWriteStream(temporary, { flags: 'wx' }))
      })
      // fsync needs a writable handle on Windows; a read-only handle raises EPERM.
      const file = await open(temporary, 'r+')
      try { await file.sync() } finally { await file.close() }
      await rename(temporary, localPath)
      return { bytes: size, deltaStart, deltaEnd: size, skipped: false, mtimeMs }
    } catch (error) {
      await rm(temporary, { force: true })
      if (error instanceof LogCollectionError) throw error
      throw new LogCollectionError('SFTP_PULL_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async #withSftp<T>(
    config: SshInstanceConfig,
    credential: SshCredential,
    run: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const client = new Client()
      let settled = false
      const finish = (error: Error | undefined, value?: T): void => {
        if (settled) return
        settled = true
        client.end()
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }
      client.once('error', (error) =>{  finish(new LogCollectionError('SFTP_PULL_FAILED', error.message)) })
      client.once('ready', () => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            finish(new LogCollectionError('SFTP_PULL_FAILED', error.message))
            return
          }
          void run(sftp)
            .then((value) =>{  finish(undefined, value) })
            .catch((runError: unknown) =>{  finish(runError instanceof LogCollectionError
              ? runError
              : new LogCollectionError('SFTP_PULL_FAILED', runError instanceof Error ? runError.message : String(runError))) })
        })
      })
      client.connect({
        ...connectConfig(config, key => matchesHostKey(config, key)),
        ...credentialConfig(credential, config.authType),
      })
    })
  }
}

/**
 * Expand one absolute POSIX pattern through SFTP.
 * @param sftp - open SFTP session.
 * @param pattern - absolute path, possibly containing `*` or `?`.
 * @returns matching file paths.
 */
async function expandRemotePattern(sftp: SFTPWrapper, pattern: string): Promise<string[]> {
  const trimmed = pattern.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return []
  const parent = slash === 0 ? '/' : trimmed.slice(0, slash)
  const name = trimmed.slice(slash + 1)
  if (!/[*?]/.test(name)) {
    try {
      await statRemote(sftp, trimmed)
      return [trimmed]
    } catch {
      return []
    }
  }
  const regex = globToRegExp(name)
  let entries: { filename: string; isFile?: boolean }[]
  try {
    entries = await readdirRemote(sftp, parent)
  } catch {
    return []
  }
  return entries
    .filter(entry => !entry.filename.startsWith('.') && regex.test(entry.filename))
    .map(entry => `${parent === '/' ? '' : parent}/${entry.filename}`)
    .sort()
}

/** Translate a single path segment glob into a regular expression. */
function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (const char of pattern) {
    if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

function statRemote(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attributes) => {
      if (error === undefined) resolve(attributes)
      else reject(error)
    })
  })
}

function readdirRemote(sftp: SFTPWrapper, path: string): Promise<{ filename: string; isFile?: boolean }[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error === undefined) resolve(entries)
      else reject(error)
    })
  })
}

function connectConfig(config: SshInstanceConfig, hostVerifier: (key: Buffer) => boolean): ConnectConfig {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 15_000,
    keepaliveInterval: 5_000,
    keepaliveCountMax: 2,
    hostVerifier,
  }
}

function credentialConfig(credential: SshCredential, authType: 'password' | 'key'): ConnectConfig {
  if (authType === 'key') {
    if (credential.privateKey === undefined) throw new LogCollectionError('SSH_AUTH_FAILED', 'private key credential is missing')
    return {
      privateKey: credential.privateKey,
      ...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }),
    }
  }
  if (credential.password === undefined) throw new LogCollectionError('SSH_AUTH_FAILED', 'password credential is missing')
  return { password: credential.password }
}

function normalizeFingerprint(value: string): string {
  return value.replace(/^SHA256:/, '').replace(/=+$/, '')
}

/**
 * Whether one presented host key matches the pinned fingerprint.
 *
 * Both sides are normalized, so a pin stored with or without the `SHA256:`
 * prefix matches identically. The probe and the file transfer share this
 * comparison; duplicating it once let the transfer side compare a prefixed
 * string with a bare one and reject every host.
 * @param config - instance configuration carrying the pin.
 * @param key - raw host key from the handshake.
 * @returns whether the key is the pinned one.
 */
export function matchesHostKey(config: SshInstanceConfig, key: Buffer): boolean {
  return normalizeFingerprint(hostKeyFingerprint(key)) === normalizeFingerprint(config.hostKeySha256)
}

/**
 * Format a raw host key as OpenSSH displays it.
 * @param key - raw host key bytes.
 * @returns `SHA256:<base64 without padding>`.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}
