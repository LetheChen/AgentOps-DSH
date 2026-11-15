import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LogCollectionError,
  LogCollectionStore,
  PullLogsService,
  hostKeyFingerprint,
  type LogSftpTransport,
  type SshCapabilityResolver,
  type SshCredential,
  type SshInstanceConfig,
} from '../src/index.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-log-pull-'))
  const db = new DatabaseSync(':memory:')
  const store = new LogCollectionStore(db, { localRoot: root })
  const task = store.create({
    tenantKey: 'tenant-a', taskId: 'oa_approval', name: 'OA audit', ownerDomain: 'smart_approval',
    sshInstanceId: 'maxkb', remotePaths: ['/opt/AI_Agent_Platform/logs/app/oa_audit.log'],
    localMaxDays: 7, actor: 'owner',
  })
  store.grantAccess('tenant-a', task.taskId, 'log_puller', { canPull: true, canQuery: false }, 'owner')
  return { root, db, store, task }
}

const config: SshInstanceConfig = {
  instanceId: 'maxkb', host: 'example', port: 2222, username: 'reader', authType: 'password',
  hostKeySha256: 'SHA256:rRUjsuVBpbHwjlYknyX1dwnlpu161cM3GDkmZ1bXxio', instanceRevision: 'credential-1',
}

test('probes host key before reading credential and writes the file', async () => {
  const { root, db, store } = fixture()
  const events: string[] = []
  const resolver: SshCapabilityResolver = {
    resolveConfig: () => config,
    readCredential: async () => { events.push('credential'); return { password: 'secret' } },
  }
  const transport: LogSftpTransport = {
    probeHostKey: async () => { events.push('probe'); return config.hostKeySha256 },
    resolveRemotePaths: async (_config: SshInstanceConfig, _credential: SshCredential, patterns: readonly string[]) => patterns,
    pullFile: async (_config: SshInstanceConfig, _credential: SshCredential, _remote: string, local: string) => {
      writeFileSync(local, 'line-1\n')
      return { bytes: 7, deltaStart: 0, deltaEnd: 7, skipped: false, mtimeMs: 1 }
    },
  }
  try {
    const result = await new PullLogsService(store, resolver, transport).pull({
      tenantKey: 'tenant-a', agentPreset: 'log_puller', logTaskId: 'oa_approval',
    })
    assert.deepEqual(events, ['probe', 'credential'])
    assert.equal(result.files[0]?.bytes, 7)
    assert.ok(result.files[0]?.localPath.endsWith(join('tenant-a', 'oa_approval', 'oa_audit.log')))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects missing pinned host key before credential access', async () => {
  const { root, db, store } = fixture()
  let credentialReads = 0
  const resolver: SshCapabilityResolver = {
    resolveConfig: () => ({ ...config, hostKeySha256: '' }),
    readCredential: async () => { credentialReads += 1; return { password: 'secret' } },
  }
  const transport: LogSftpTransport = {
    probeHostKey: async () => { throw new Error('must not probe') },
    resolveRemotePaths: async () => [],
    pullFile: async () => ({ bytes: 0, deltaStart: 0, deltaEnd: 0, skipped: false, mtimeMs: 0 }),
  }
  try {
    await assert.rejects(
      new PullLogsService(store, resolver, transport).pull({ tenantKey: 'tenant-a', agentPreset: 'log_puller', logTaskId: 'oa_approval' }),
      (error: unknown) => error instanceof LogCollectionError && error.code === 'SSH_HOST_KEY_REJECTED',
    )
    assert.equal(credentialReads, 0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a preset without pull ACL', async () => {
  const { root, db, store } = fixture()
  try {
    await assert.rejects(
      new PullLogsService(
        store,
        { resolveConfig: () => config, readCredential: async () => ({ password: 'secret' }) },
        {
          probeHostKey: async () => config.hostKeySha256,
          resolveRemotePaths: async () => [],
          pullFile: async () => ({ bytes: 0, deltaStart: 0, deltaEnd: 0, skipped: true, mtimeMs: 0 }),
        },
      ).pull({ tenantKey: 'tenant-a', agentPreset: 'log_analyst', logTaskId: 'oa_approval' }),
      (error: unknown) => error instanceof LogCollectionError && error.code === 'LOG_TASK_ACCESS_DENIED',
    )
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('formats ssh host key fingerprints without padding', () => {
  assert.match(hostKeyFingerprint(Buffer.from('host-key')), /^SHA256:[A-Za-z0-9+/]+$/)
})
test('records per-file delta ranges and skips an unchanged remote file', async () => {
  const { root, db, store } = fixture()
  const resolver: SshCapabilityResolver = {
    resolveConfig: () => config,
    readCredential: async () => ({ password: 'secret' }),
  }
  let calls = 0
  const transport: LogSftpTransport = {
    probeHostKey: async () => config.hostKeySha256,
    resolveRemotePaths: async (_c, _cred, patterns) => patterns,
    pullFile: async (_c, _cred, _remote, local) => {
      calls += 1
      if (calls === 1) {
        writeFileSync(local, 'line-1\\nline-2\\n')
        return { bytes: 14, deltaStart: 0, deltaEnd: 14, skipped: false, mtimeMs: 1000 }
      }
      return { bytes: 14, deltaStart: 14, deltaEnd: 14, skipped: true, mtimeMs: 1000 }
    },
  }
  try {
    const service = new PullLogsService(store, resolver, transport)
    const first = await service.pull({ tenantKey: 'tenant-a', agentPreset: 'log_puller', logTaskId: 'oa_approval' })
    assert.equal(first.files[0]?.deltaStart, 0)
    assert.equal(first.files[0]?.deltaEnd, 14)
    assert.equal(first.files[0]?.skipped, false)

    const second = await service.pull({ tenantKey: 'tenant-a', agentPreset: 'log_puller', logTaskId: 'oa_approval' })
    assert.equal(second.files[0]?.skipped, true)
    assert.equal(second.files[0]?.deltaStart, 14)
    assert.equal(second.files[0]?.deltaEnd, 14)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
