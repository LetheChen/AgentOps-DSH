import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { ServerConnectionListener } from 'ssh2'

import { Server } from '../../src/ssh2.ts'

/** One accepted credential attempt observed by the test server. */
export interface SshAuthAttempt {
  readonly username: string
  readonly password: string
}

/** A running in-process SSH server that presents a generated host key. */
export interface SshTestServer {
  readonly port: number
  readonly fingerprint: string
  readonly attempts: SshAuthAttempt[]
  close(): Promise<void>
}

/** SSH wire-format string: a 4-byte big-endian length followed by the bytes. */
function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(value.length, 0)
  return Buffer.concat([length, value])
}

/** SSH mpint: minimal two's-complement big-endian bytes inside an SSH string. */
function mpint(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start += 1
  let bytes = value.subarray(start)
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return sshString(bytes)
}

/** OpenSSH fingerprint of one RSA host key, computed from the public key alone. */
export function rsaFingerprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { readonly n?: string; readonly e?: string }
  const modulus = Buffer.from(jwk.n ?? '', 'base64url')
  const exponent = Buffer.from(jwk.e ?? '', 'base64url')
  const blob = Buffer.concat([sshString(Buffer.from('ssh-rsa')), mpint(exponent), mpint(modulus)])
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * Start a real SSH server on a loopback port.
 * @param options - the single username and password the server accepts.
 * @returns the bound port, its host-key fingerprint and the observed attempts.
 */
export async function startSshServer(options: {
  readonly username: string
  readonly password: string
}): Promise<SshTestServer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const attempts: SshAuthAttempt[] = []
  const listener: ServerConnectionListener = (client) => {
    // A client that rejects our host key aborts during key exchange; the
    // server-side error is expected there and must not fail the test process.
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      attempts.push({ username: ctx.username, password: ctx.method === 'password' ? ctx.password : '' })
      if (ctx.method === 'password' && ctx.username === options.username && ctx.password === options.password) {
        ctx.accept()
        return
      }
      ctx.reject()
    })
  }
  const server = new Server({ hostKeys: [hostKey] }, listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('ssh test server has no TCP address')
  return {
    port: address.port,
    fingerprint: rsaFingerprint(publicKey),
    attempts,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
