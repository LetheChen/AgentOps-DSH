import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { CapabilityStore } from '@agentops/dsh-capability'
import type { MasterKey } from '../../vault/src/crypto.ts'

import { DeploymentStore } from '../src/store.ts'
import { DeploymentService } from '../src/service.ts'
import type { DeploymentTransport } from '../src/transport.ts'
import { DeploymentError, type DeploymentSshConfig, type DeploymentSshCredential, type RemoteCommandResult } from '../src/types.ts'

const KEY: MasterKey = { key: Buffer.alloc(32, 7), source: 'env' }

class FakeTransport implements DeploymentTransport {
  image = 'sha256:1111111111111111111111111111111111111111'
  releaseOutcome: number | null = 0
  scriptHash = 'a'.repeat(64)
  readonly uploaded = new Map<string, string>()
  readonly tags: string[] = []

  async probeHostKey(): Promise<string> { return 'SHA256:pin' }

  async upload(_config: DeploymentSshConfig, _credential: DeploymentSshCredential, localPath: string, remotePath: string): Promise<void> {
    this.uploaded.set(remotePath, localPath)
  }

  async execute(
    _config: DeploymentSshConfig,
    _credential: DeploymentSshCredential,
    rawArgv: readonly string[],
  ): Promise<RemoteCommandResult> {
    const argv = rawArgv[0] === 'sudo' && rawArgv[1] === '-n' ? rawArgv.slice(2) : rawArgv
    if (argv[0] === 'docker' && argv[1] === 'inspect') return ok(this.image)
    if (argv[0] === 'docker' && argv[1] === 'tag') {
      this.tags.push(argv[3] ?? '')
      return ok('')
    }
    if (argv[0] === 'sha256sum' && argv[1] === '/opt/agentops/bin/deploy-image.sh') return ok(`${this.scriptHash}  ${argv[1]}`)
    if (argv[0] === 'sha256sum') {
      const local = this.uploaded.get(argv[1] ?? '')
      if (local === undefined) return { exitCode: 1, signal: null, stdout: '', stderr: 'not uploaded', timedOut: false }
      return ok(`${createHash('sha256').update(await readFile(local)).digest('hex')}  ${argv[1] ?? ''}`)
    }
    if (argv[0] === 'echo') {
      if (this.releaseOutcome === null) return { exitCode: null, signal: null, stdout: '', stderr: 'connection lost', timedOut: false }
      if (this.releaseOutcome !== 0) return { exitCode: this.releaseOutcome, signal: null, stdout: '', stderr: 'failed', timedOut: false }
      this.image = 'sha256:2222222222222222222222222222222222222222'
      return ok('')
    }
    return ok('')
  }
}

function ok(stdout: string): RemoteCommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false }
}

async function fixture(): Promise<{
  dir: string
  capabilities: CapabilityStore
  journal: DatabaseSync
  store: DeploymentStore
  service: DeploymentService
  transport: FakeTransport
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-deployment-'))
  const artifactDir = join(dir, 'docker')
  await mkdir(join(artifactDir, 'image'), { recursive: true })
  const artifact = Buffer.from('new-image-bytes')
  await writeFile(join(artifactDir, 'image', 'app.tar'), artifact)
  const manifest = {
    schemaVersion: 1,
    releaseId: 'build-1',
    gitSha: null,
    dirty: null,
    builtAt: '2026-11-19T00:00:00.000Z',
    builder: 'test',
    imageName: 'app:latest',
    artifactFiles: [{ path: 'image/app.tar', bytes: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') }],
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(artifactDir, 'image', 'release-manifest.json'), manifestText)
  await writeFile(join(artifactDir, 'image', 'release-manifest.sha256'), `${createHash('sha256').update(manifestText).digest('hex')}  release-manifest.json\n`)
  const capabilities = new CapabilityStore(':memory:', KEY)
  capabilities.saveInstance({ instanceId: 'ssh-prod', capabilityId: 'ssh', name: 'Production SSH', config: { host: 'prod.example', port: 22, username: 'deploy', auth_type: 'password', host_key_sha256: 'SHA256:pin' }, secret: 'pw' })
  capabilities.saveInstance({
    instanceId: 'app-production',
    capabilityId: 'deployment',
    name: 'APP Production',
    config: {
      schemaVersion: 1,
      instanceId: 'app-production',
      tenantKey: 'tenant-a',
      ownerDomain: 'operations',
      sshInstanceId: 'ssh-prod',
      access: { presets: ['deploy_operator'], operations: ['plan', 'release', 'status', 'rollback'] },
      artifact: { localRoot: artifactDir, bundleRoot: 'docker', updateFiles: ['image/app.tar'], firstInstallFiles: ['image/app.tar', 'image/mysql.tar', 'image/redis.tar'], manifest: 'image/release-manifest.json', manifestDigest: 'image/release-manifest.sha256' },
      environment: { installedEnvFile: '/opt/app/.env', firstInstallSecretRef: 'capability-secret:env', firstInstallEnvFile: '/tmp/app/prod.env', remotePermissions: '0600', cleanup: 'always' },
      remote: { workRoot: '/tmp/app-release', targetPath: '/opt/app', lockPath: '/run/lock/app-release.lock', imageName: 'app:latest', backupTagPrefix: 'app:backup', containerName: 'app', composeFile: '/opt/app/docker-compose.yml', scriptPath: '/opt/agentops/bin/deploy-image.sh', scriptVersion: 'v1', scriptSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', commandTimeoutMs: 1000, sudoMode: 'non-interactive', firstInstallCommand: ['echo', '{releaseId}'], updateCommand: ['echo', '{releaseId}'], rollbackCommand: ['echo', '{rollbackReleaseId}'] },
      migration: { mode: 'always', backupBeforeMigrate: true, backupRetentionDays: 7 },
      health: { timeoutMs: 1000, checks: [['true']] },
    },
  })
  capabilities.replaceBindings('deploy_operator', [
    { capabilityId: 'deployment', instanceId: 'app-production', enabled: true },
    { capabilityId: 'ssh', instanceId: 'ssh-prod', enabled: true },
  ])
  const journal = new DatabaseSync(':memory:')
  const store = new DeploymentStore(journal)
  const transport = new FakeTransport()
  return { dir, capabilities, journal, store, service: new DeploymentService(store, capabilities, transport), transport }
}

void test('releases only after the current image id is backed up and artifact hashes match', async () => {
  const h = await fixture()
  try {
    const result = await h.service.release({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' })
    assert.equal(result.state, 'healthy')
    assert.equal(result.imageId, 'sha256:2222222222222222222222222222222222222222')
    assert.equal(result.steps.at(-1), 'health-check-passed')
    assert.match(result.backupTag ?? '', /^app:backup-\d{8}-\d{6}-[a-f0-9]{8}$/)
    assert.equal(h.transport.tags.length, 1)
    const status = await h.service.status({ agentPreset: 'deploy_operator', instanceId: 'app-production' })
    assert.equal(status.current?.state, 'healthy')
    assert.equal(status.liveImageId, 'sha256:2222222222222222222222222222222222222222')
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('first-install plan refuses a manifest missing mysql and redis artifacts', async () => {
  const h = await fixture()
  try {
    await assert.rejects(
      h.service.plan({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'first_install' }),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_ARTIFACT_INVALID',
    )
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('unknown remote outcome keeps the release lease held', async () => {
  const h = await fixture()
  try {
    h.transport.releaseOutcome = null
    await assert.rejects(
      h.service.release({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' }),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_REMOTE_AMBIGUOUS',
    )
    const status = await h.service.status({ agentPreset: 'deploy_operator', instanceId: 'app-production' })
    assert.equal(status.current?.state, 'unknown_hold')
    assert.equal(h.store.lease('app-production')?.state, 'unknown_hold')
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('refuses to release when the shared deployment script hash differs from the instance', async () => {
  const h = await fixture()
  try {
    h.transport.scriptHash = 'b'.repeat(64)
    await assert.rejects(
      h.service.release({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' }),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_SCRIPT_MISMATCH',
    )
    assert.equal(h.store.status('app-production').current, null)
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('plan records the remote script verification step', async () => {
  const h = await fixture()
  try {
    const result = await h.service.plan({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' })
    assert.deepEqual(result.steps, ['artifact-verified', 'ssh-verified', 'remote-script-verified', 'remote-preflight-passed'])
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('rolls back a recorded healthy release and records completed health', async () => {
  const h = await fixture()
  try {
    const released = await h.service.release({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' })
    h.transport.releaseOutcome = 0
    const rolledBack = await h.service.rollback({ agentPreset: 'deploy_operator', instanceId: 'app-production', releaseId: released.releaseId })
    assert.equal(rolledBack.state, 'rolled_back')
    assert.equal(rolledBack.releaseId, `rollback-${released.releaseId}`)
    assert.equal(rolledBack.manifest?.releaseId, released.releaseId)
    assert.equal(rolledBack.steps.at(-1), 'health-check-passed')
    const status = await h.service.status({ agentPreset: 'deploy_operator', instanceId: 'app-production' })
    assert.equal(status.current?.state, 'rolled_back')
    assert.equal(status.previousHealthy?.releaseId, released.releaseId)
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})

void test('refuses rollback when the shared deployment script changes after a healthy release', async () => {
  const h = await fixture()
  try {
    const released = await h.service.release({ agentPreset: 'deploy_operator', instanceId: 'app-production', mode: 'update' })
    h.transport.scriptHash = 'b'.repeat(64)
    await assert.rejects(
      h.service.rollback({ agentPreset: 'deploy_operator', instanceId: 'app-production', releaseId: released.releaseId }),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_SCRIPT_MISMATCH',
    )
    const status = h.store.status('app-production')
    assert.equal(status.current?.state, 'healthy')
    assert.equal(h.store.lease('app-production'), null)
  } finally {
    h.journal.close()
    h.capabilities.close()
    await rm(h.dir, { recursive: true, force: true })
  }
})
