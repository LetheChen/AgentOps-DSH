import assert from 'node:assert/strict'
import test from 'node:test'

import { hostKeyFingerprint, matchesHostKey } from '../src/transport.ts'
import type { SshInstanceConfig } from '../src/types.ts'

const KEY = Buffer.from('ssh-ed25519 host key bytes')
const OTHER = Buffer.from('ssh-ed25519 a different key')

function config(pin: string): SshInstanceConfig {
  return {
    instanceId: 'MaxKB', host: 'h', port: 22, username: 'u',
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
