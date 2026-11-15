import assert from 'node:assert/strict'
import test from 'node:test'

import { probeCapabilityInstance } from '../src/probe.ts'
import type { CapabilityRuntime } from '../src/types.ts'
import { startSshServer } from './support/ssh-test-server.ts'

/** Runtime fixture for one SSH capability instance. */
function sshRuntime(config: Readonly<Record<string, unknown>>, secret: string | null): CapabilityRuntime {
  return {
    agentPreset: 'log_puller',
    capabilityId: 'ssh',
    instanceId: 'ssh_test',
    name: 'SSH test',
    config,
    accessPolicy: {},
    secret,
  }
}

void test('an SSH probe authenticates with a password containing shell metacharacters', async () => {
  const password = 'WUke#ef3vcDJ&T%K^2(1)'
  const server = await startSshServer({ username: 'root', password })
  try {
    const result = await probeCapabilityInstance(
      sshRuntime({ host: '127.0.0.1', port: server.port, username: 'root' }, password),
    )
    assert.equal(result.ok, true, result.detail)
    assert.equal(server.attempts.at(-1)?.password, password)
  } finally {
    await server.close()
  }
})

void test('an SSH probe verifies a configured host-key fingerprint', async () => {
  const server = await startSshServer({ username: 'root', password: 'pw' })
  try {
    const accepted = await probeCapabilityInstance(sshRuntime({
      host: '127.0.0.1', port: server.port, username: 'root', host_key_sha256: server.fingerprint,
    }, 'pw'))
    assert.equal(accepted.ok, true, accepted.detail)
    assert.match(accepted.detail, /主机指纹已校验/)

    const rejected = await probeCapabilityInstance(sshRuntime({
      host: '127.0.0.1', port: server.port, username: 'root', host_key_sha256: 'SHA256:' + 'A'.repeat(43),
    }, 'pw'))
    assert.equal(rejected.ok, false)
    assert.match(rejected.detail, /主机指纹不匹配/)
    assert.equal(rejected.detail.includes(server.fingerprint), true)
    assert.equal(rejected.detail.includes('A'.repeat(43)), true)
  } finally {
    await server.close()
  }
})

void test('an SSH probe records an unpinned fingerprint without blocking the login', async () => {
  const server = await startSshServer({ username: 'root', password: 'pw' })
  try {
    const result = await probeCapabilityInstance(
      sshRuntime({ host: '127.0.0.1', port: server.port, username: 'root' }, 'pw'),
    )
    assert.equal(result.ok, true, result.detail)
    assert.match(result.detail, /未配置主机指纹/)
    assert.equal(result.detail.includes(server.fingerprint), true)
  } finally {
    await server.close()
  }
})

void test('an SSH probe reports a rejected credential as an unusable password', async () => {
  const server = await startSshServer({ username: 'root', password: 'right' })
  try {
    const result = await probeCapabilityInstance(
      sshRuntime({ host: '127.0.0.1', port: server.port, username: 'root' }, 'wrong'),
    )
    assert.equal(result.ok, false)
    assert.match(result.detail, /用户名或凭证不正确/)
  } finally {
    await server.close()
  }
})

void test('an SSH probe reports a missing credential without connecting', async () => {
  const result = await probeCapabilityInstance(
    sshRuntime({ host: '127.0.0.1', port: 1, username: 'root' }, null),
    2000,
  )
  assert.equal(result.ok, false)
  assert.match(result.detail, /缺少凭证/)
})
