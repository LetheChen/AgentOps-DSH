import assert from 'node:assert/strict'
import test from 'node:test'

import { CapabilitySshResolver, LogCollectionError } from '../src/index.ts'

const instance = {
  instanceId: 'maxkb', capabilityId: 'ssh', status: 'enabled' as const,
  config: {
    host: '192.0.2.10', port: 2222, username: 'reader', auth_type: 'password',
    host_key_sha256: 'SHA256:rRUjsuVBpbHwjlYknyX1dwnlpu161cM3GDkmZ1bXxio',
  },
  accessPolicy: {}, credentialConfigured: true, credentialGeneration: 'credential-1',
}

test('resolves non-secret SSH config from capability data', () => {
  const resolver = new CapabilitySshResolver({
    getInstance: () => instance,
    resolveRuntime: () => ({ instanceId: 'maxkb', secret: null }),
  }, 'log_puller')
  assert.deepEqual(resolver.resolveConfig('maxkb'), {
    instanceId: 'maxkb', host: '192.0.2.10', port: 2222, username: 'reader',
    authType: 'password', hostKeySha256: instance.config.host_key_sha256, instanceRevision: 'credential-1',
  })
})

test('reads secret only after frozen generation matches', async () => {
  const resolver = new CapabilitySshResolver({
    getInstance: () => instance,
    resolveRuntime: () => ({ instanceId: 'maxkb', secret: 'p@ss&word' }),
  }, 'log_puller')
  assert.deepEqual(await resolver.readCredential('maxkb', 'credential-1'), { password: 'p@ss&word' })
})

test('rejects host-key pin missing from SSH config', () => {
  const resolver = new CapabilitySshResolver({
    getInstance: () => ({ ...instance, config: { ...instance.config, host_key_sha256: '' } }),
    resolveRuntime: () => ({ instanceId: 'maxkb', secret: null }),
  }, 'log_puller')
  assert.throws(() => resolver.resolveConfig('maxkb'), (error: unknown) => (
    error instanceof LogCollectionError && error.code === 'CAPABILITY_INSTANCE_MISMATCH'
  ))
})

test('rejects changed credential generation', async () => {
  const resolver = new CapabilitySshResolver({
    getInstance: () => ({ ...instance, credentialGeneration: 'credential-2' }),
    resolveRuntime: () => ({ instanceId: 'maxkb', secret: 'secret' }),
  }, 'log_puller')
  await assert.rejects(resolver.readCredential('maxkb', 'credential-1'), /generation changed/)
})
