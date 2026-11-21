import assert from 'node:assert/strict'
import test from 'node:test'

import { startSshServer } from '../../capability/tests/support/ssh-test-server.ts'
import { Ssh2DeploymentTransport } from '../src/transport.ts'
import type { DeploymentSshConfig } from '../src/types.ts'

function config(port: number): DeploymentSshConfig {
  return {
    instanceId: 'ssh-test',
    host: '127.0.0.1',
    port,
    username: 'probe',
    authType: 'password',
    hostKeySha256: 'SHA256:unused',
    instanceRevision: 'test',
  }
}

void test('probeHostKey returns the presented fingerprint without authenticating', async () => {
  const server = await startSshServer({ username: 'probe', password: 'unused' })
  try {
    const fingerprint = await new Ssh2DeploymentTransport().probeHostKey(config(server.port))
    assert.equal(fingerprint, server.fingerprint)
    assert.deepEqual(server.attempts, [])
  } finally {
    await server.close()
  }
})
