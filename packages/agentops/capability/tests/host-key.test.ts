import assert from 'node:assert/strict'
import test from 'node:test'

import { probeSshHostKey } from '../src/probe.ts'
import { startSshServer } from './support/ssh-test-server.ts'

void test('probeSshHostKey returns the OpenSSH fingerprint of the presented host key', async () => {
  const server = await startSshServer({ username: 'probe', password: 'unused' })
  try {
    const probe = await probeSshHostKey('127.0.0.1', server.port)
    assert.equal(probe.hostKeySha256, server.fingerprint)
    assert.match(probe.hostKeySha256, /^SHA256:[A-Za-z0-9+/]{43}$/)
    assert.equal(probe.elapsedMs >= 0, true)

    const again = await probeSshHostKey('127.0.0.1', server.port)
    assert.equal(again.hostKeySha256, server.fingerprint)
  } finally {
    await server.close()
  }
})

void test('probeSshHostKey stops before authentication', async () => {
  const server = await startSshServer({ username: 'probe', password: 'unused' })
  try {
    await probeSshHostKey('127.0.0.1', server.port)
    assert.deepEqual(server.attempts, [])
  } finally {
    await server.close()
  }
})

void test('probeSshHostKey rejects invalid targets before connecting', async () => {
  await assert.rejects(probeSshHostKey('   ', 22), /缺少 host/)
  await assert.rejects(probeSshHostKey('127.0.0.1', 0), /端口无效/)
  await assert.rejects(probeSshHostKey('127.0.0.1', 70_000), /端口无效/)
})

void test('probeSshHostKey surfaces an unreachable target as a rejection', async () => {
  await assert.rejects(probeSshHostKey('127.0.0.1', 1, 1500))
})
