import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import { CapabilityStore } from '@agentops/dsh-capability'
import type { MasterKey } from '../../vault/src/crypto.ts'

import { ArtifactBuildService } from '../src/build.ts'
import type { LocalCommandRunner } from '../src/local-runner.ts'
import type { RemoteCommandResult } from '../src/types.ts'

const KEY: MasterKey = { key: Buffer.alloc(32, 7), source: 'env' }

class FakeBuildRunner implements LocalCommandRunner {
  constructor(private readonly root: string) {}

  async run(argv: readonly string[]): Promise<RemoteCommandResult> {
    if (argv[0] === 'git') return { exitCode: 0, signal: null, stdout: argv[1] === 'rev-parse' ? 'abcdef123456\n' : '', stderr: '', timedOut: false }
    await mkdir(join(this.root, 'docker', 'image'), { recursive: true })
    await writeFile(join(this.root, 'docker', 'image', 'app.tar'), 'built-image')
    return { exitCode: 0, signal: null, stdout: 'built', stderr: '', timedOut: false }
  }
}

void test('writes a release manifest and sidecar digest after a successful build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-'))
  const capabilities = new CapabilityStore(':memory:', KEY)
  try {
    capabilities.saveInstance({
      instanceId: 'build-app', capabilityId: 'artifact-build', name: 'APP build',
      config: {
        schemaVersion: 1, instanceId: 'build-app', tenantKey: 'tenant-a', ownerDomain: 'operations',
        access: { presets: ['build_operator'] }, localRoot: root, cwd: '.', command: ['./build.sh'],
        timeoutMs: 10000, outputs: ['docker/image/app.tar'], manifest: 'docker/image/release-manifest.json',
        manifestDigest: 'docker/image/release-manifest.sha256', imageName: 'app:latest',
      },
    })
    capabilities.replaceBindings('build_operator', [{ capabilityId: 'artifact-build', instanceId: 'build-app', enabled: true }])
    const service = new ArtifactBuildService(capabilities, new FakeBuildRunner(root))
    const result = await service.build({ agentPreset: 'build_operator', instanceId: 'build-app' })
    assert.equal(result.manifest.gitSha, 'abcdef123456')
    assert.equal(result.manifest.artifactFiles[0]?.path, 'docker/image/app.tar')
    assert.equal(result.manifest.artifactFiles[0]?.sha256, createHash('sha256').update(await readFile(join(root, 'docker', 'image', 'app.tar'))).digest('hex'))
    const manifest = JSON.parse(await readFile(join(root, 'docker', 'image', 'release-manifest.json'), 'utf8')) as { releaseId: string }
    assert.equal(manifest.releaseId, result.releaseId)
    assert.match(await readFile(join(root, 'docker', 'image', 'release-manifest.sha256'), 'utf8'), /^[a-f0-9]{64}/)
  } finally {
    capabilities.close()
    await rm(root, { recursive: true, force: true })
  }
})
