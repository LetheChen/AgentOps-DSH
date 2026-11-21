import assert from 'node:assert/strict'
import test from 'node:test'

import { startSshServer } from '../../capability/tests/support/ssh-test-server.ts'
import { Ssh2LogTransport, hostKeyFingerprint, matchesHostKey } from '../src/transport.ts'
import { LogCollectionError, type SshInstanceConfig } from '../src/types.ts'

const KEY = Buffer.from('ssh-ed25519 host key bytes')
const OTHER = Buffer.from('ssh-ed25519 a different key')

function config(pin: string, port = 22): SshInstanceConfig {
  return {
    instanceId: 'MaxKB', host: '127.0.0.1', port, username: 'u',
    authType: 'password', hostKeySha256: pin, instanceRevision: 'r1',
  }
}

void test('hostKeyFingerprint uses the OpenSSH SHA256 display form without padding', () => {
  const fingerprint = hostKeyFingerprint(KEY)
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(fingerprint.endsWith('='), false)
})

void test('matchesHostKey accepts the pin with or without the SHA256 prefix', () => {
  const fingerprint = hostKeyFingerprint(KEY)
  assert.equal(matchesHostKey(config(fingerprint), KEY), true)
  assert.equal(matchesHostKey(config(fingerprint.replace(/^SHA256:/, '')), KEY), true)
})

void test('matchesHostKey rejects a different key', () => {
  assert.equal(matchesHostKey(config(hostKeyFingerprint(KEY)), OTHER), false)
})

void test('probeHostKey returns the presented fingerprint without authenticating', async () => {
  const server = await startSshServer({ username: 'probe', password: 'unused' })
  try {
    const fingerprint = await new Ssh2LogTransport().probeHostKey(config(server.fingerprint, server.port))
    assert.equal(fingerprint, server.fingerprint)
    assert.deepEqual(server.attempts, [])
  } finally {
    await server.close()
  }
})

void test('probeHostKey rejects a different fingerprint without authenticating', async () => {
  const server = await startSshServer({ username: 'probe', password: 'unused' })
  try {
    await assert.rejects(
      new Ssh2LogTransport().probeHostKey(config('SHA256:' + 'A'.repeat(43), server.port)),
      (error: unknown) => error instanceof LogCollectionError && error.code === 'SSH_HOST_KEY_REJECTED',
    )
    assert.deepEqual(server.attempts, [])
  } finally {
    await server.close()
  }
})
