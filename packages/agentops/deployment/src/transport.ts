/**
 * SSH2 transport for deployment artifact upload and remote commands.
 * @module @agentops/dsh-deployment/transport
 */

import { createHash } from 'node:crypto'

import { probeSshHostKey } from '@agentops/dsh-capability'
import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper } from 'ssh2'

import { DeploymentError, type DeploymentSshConfig, type DeploymentSshCredential, type RemoteCommandResult } from './types.ts'

/** Remote operation interface used by the deployment service and tests. */
export interface DeploymentTransport {
  /**
   * Observe the host key without authenticating.
   * @param config - resolved SSH coordinates and pinned fingerprint.
   * @returns observed OpenSSH fingerprint.
   */
  probeHostKey(config: DeploymentSshConfig): Promise<string>

  /**
   * Upload one local file to an existing remote directory.
   * @param config - SSH coordinates.
   * @param credential - decrypted credential.
   * @param localPath - local file path.
   * @param remotePath - absolute remote file path.
   * @param signal - cancellation.
   */
  upload(
    config: DeploymentSshConfig,
    credential: DeploymentSshCredential,
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<void>

  /**
   * Execute one argv with POSIX quoting.
   * @param config - SSH coordinates.
   * @param credential - decrypted credential.
   * @param argv - executable and literal arguments.
   * @param timeoutMs - remote command deadline.
   * @param signal - cancellation.
   * @returns independent exit, signal, output, and timeout facts.
   */
  execute(
    config: DeploymentSshConfig,
    credential: DeploymentSshCredential,
    argv: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteCommandResult>
}

/** SSH2-backed deployment transport. */
export class Ssh2DeploymentTransport implements DeploymentTransport {
  async probeHostKey(config: DeploymentSshConfig): Promise<string> {
    try {
      return (await probeSshHostKey(config.host, config.port)).hostKeySha256
    } catch (error) {
      throw new DeploymentError('DEPLOYMENT_SSH_HOST_KEY_REJECTED', error instanceof Error ? error.message : String(error), {
        cause: error,
        action: 'Verify the SSH host key pin and server identity.',
      })
    }
  }

  async upload(
    config: DeploymentSshConfig,
    credential: DeploymentSshCredential,
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#withSftp(config, credential, signal, async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error === undefined || error === null) resolve()
          else reject(new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `upload failed: ${error.message}`, {
            cause: error,
            action: 'Verify the remote directory and retry the release.',
          }))
        })
      })
    })
  }

  async execute(
    config: DeploymentSshConfig,
    credential: DeploymentSshCredential,
    argv: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteCommandResult> {
    const command = quoteArgv(argv)
    return new Promise((resolve, reject) => {
      const client = new Client()
      let started = false
      let settled = false
      let timedOut = false
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        timedOut = true
        client.end()
      }, timeoutMs)
      const finish = (result: RemoteCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.end()
        resolve(result)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.end()
        reject(error)
      }
      if (signal?.aborted === true) {
        fail(new DeploymentError('DEPLOYMENT_TIMEOUT', 'remote command cancelled before start'))
        return
      }
      signal?.addEventListener('abort', () => {
        client.end()
      }, { once: true })
      client.once('error', (error) => {
        if (started) {
          finish({ exitCode: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
        } else {
          fail(new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', error.message, {
            cause: error,
            action: 'Verify SSH credentials, host key, and network reachability.',
          }))
        }
      })
      client.once('ready', () => {
        client.exec(command, (error, stream) => {
          if (error !== undefined) {
            fail(new DeploymentError('DEPLOYMENT_REMOTE_COMMAND_FAILED', error.message, { cause: error }))
            return
          }
          started = true
          stream.on('data', (chunk: Buffer | string) => { stdout += chunk.toString() })
          stream.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString() })
          stream.once('close', (code: number | null, signalName: string | undefined) => {
            finish({ exitCode: code, signal: signalName ?? null, stdout, stderr, timedOut })
          })
        })
      })
      client.connect({
        ...baseConnectConfig(config),
        ...credentialConfig(credential, config.authType),
        hostVerifier: (key: Buffer) => matchesHostKey(config, key),
      })
    })
  }

  async #withSftp<T>(
    config: DeploymentSshConfig,
    credential: DeploymentSshCredential,
    signal: AbortSignal | undefined,
    operation: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const finish = (error: Error | undefined, value?: T): void => {
        if (settled) return
        settled = true
        client.end()
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }
      if (signal?.aborted === true) {
        finish(new DeploymentError('DEPLOYMENT_TIMEOUT', 'upload cancelled before start'))
        return
      }
      signal?.addEventListener('abort', () => {
        finish(new DeploymentError('DEPLOYMENT_TIMEOUT', 'upload cancelled'))
      }, { once: true })
      client.once('error', (error) => {
        finish(new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', error.message, { cause: error }))
      })
      client.once('ready', () => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            finish(new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', error.message, { cause: error }))
            return
          }
          void operation(sftp).then((value) => {
            finish(undefined, value)
          }).catch((operationError: unknown) => {
            finish(operationError instanceof Error ? operationError : new Error(String(operationError)))
          })
        })
      })
      client.connect({
        ...baseConnectConfig(config),
        ...credentialConfig(credential, config.authType),
        hostVerifier: (key: Buffer) => matchesHostKey(config, key),
      })
    })
  }
}

/**
 * Quote one POSIX shell argument.
 * @param arg - argument to quote.
 * @returns a single-quoted shell argument.
 */
export function quoteArg(arg: string): string {
  if (arg.includes('\0')) throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', 'remote argument contains NUL')
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/**
 * Quote an argv as one safe POSIX command string.
 * @param argv - command arguments to quote.
 * @returns the space-separated quoted command.
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', 'remote command is empty')
  return argv.map(quoteArg).join(' ')
}

/**
 * Format a host key as OpenSSH displays it.
 * @param key - presented SSH host key.
 * @returns the OpenSSH SHA-256 fingerprint.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * Whether a presented host key matches the pinned fingerprint.
 * @param config - deployment SSH coordinates and pinned fingerprint.
 * @param key - presented SSH host key.
 * @returns whether the fingerprints match.
 */
export function matchesHostKey(config: DeploymentSshConfig, key: Buffer): boolean {
  return normalizeFingerprint(hostKeyFingerprint(key)) === normalizeFingerprint(config.hostKeySha256)
}

function baseConnectConfig(config: DeploymentSshConfig): ConnectConfig {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 15_000,
    keepaliveInterval: 5_000,
    keepaliveCountMax: 2,
  }
}

function credentialConfig(credential: DeploymentSshCredential, authType: 'password' | 'key'): ConnectConfig {
  if (authType === 'key') {
    if (credential.privateKey === undefined) {
      throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', 'private key credential is missing')
    }
    return {
      privateKey: credential.privateKey,
      ...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }),
    }
  }
  if (credential.password === undefined) throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', 'password credential is missing')
  return { password: credential.password }
}

function normalizeFingerprint(value: string): string {
  return value.replace(/^SHA256:/, '').replace(/=+$/, '')
}
