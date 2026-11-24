import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArtifactBuildConfig, parseDeploymentConfig, resolveCommand } from '../src/config.ts'
import { DeploymentError } from '../src/types.ts'

const deployment = {
  schemaVersion: 1,
  instanceId: 'app-production',
  tenantKey: 'tenant-a',
  ownerDomain: 'operations',
  sshInstanceId: 'ssh-prod',
  access: { presets: ['deploy_operator'], operations: ['plan', 'release', 'status', 'rollback'] },
  artifact: {
    localRoot: 'E:\\deploy\\app',
    bundleRoot: 'docker',
    updateFiles: ['image/app.tar'],
    firstInstallFiles: ['image/app.tar', 'image/mysql.tar', 'image/redis.tar'],
    manifest: 'image/release-manifest.json',
    manifestDigest: 'image/release-manifest.sha256',
  },
  environment: {
    installedEnvFile: '/opt/app/.env',
    firstInstallSecretRef: 'capability-secret:app-prod-env',
    firstInstallEnvFile: '/tmp/app-release/{releaseId}/prod.env',
    remotePermissions: '0600',
    cleanup: 'always',
  },
  remote: {
    workRoot: '/tmp/app-release',
    targetPath: '/opt/app',
    lockPath: '/run/lock/app-release.lock',
    imageName: 'app:latest',
    backupTagPrefix: 'app:backup',
    containerName: 'app',
    composeFile: '/opt/app/docker-compose.yml',
    scriptPath: '/opt/agentops/bin/deploy-image.sh',
    scriptVersion: 'v1',
    scriptSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commandTimeoutMs: 1_800_000,
    sudoMode: 'non-interactive',
    firstInstallCommand: ['sudo', 'deploy.sh', '{targetPath}', '{firstInstallEnvFile}'],
    updateCommand: ['sudo', 'update.sh', '{releaseId}', '{workDir}'],
    rollbackCommand: ['sudo', 'rollback.sh', '{rollbackReleaseId}'],
  },
  migration: { mode: 'always', backupBeforeMigrate: true, backupRetentionDays: 7 },
  health: { timeoutMs: 180_000, checks: [['true'], ['curl', 'http://127.0.0.1:8000/health/ready']] },
}

void test('parses a valid deployment instance and resolves trusted placeholders', () => {
  const parsed = parseDeploymentConfig(deployment, 'app-production')
  assert.equal(parsed.remote.imageName, 'app:latest')
  assert.deepEqual(resolveCommand(parsed.remote.updateCommand, { releaseId: 'r1', workDir: '/tmp/r1' }), ['sudo', 'update.sh', 'r1', '/tmp/r1'])
})

void test('rejects unknown deployment fields and unknown command placeholders', () => {
  assert.throws(
    () => parseDeploymentConfig({ ...deployment, extra: true }, 'app-production'),
    (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_CONFIG_INVALID',
  )
  assert.throws(
    () => parseDeploymentConfig({
      ...deployment,
      remote: { ...deployment.remote, updateCommand: ['sudo', 'update.sh', '{unknown}'] },
    }, 'app-production'),
    (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_CONFIG_INVALID',
  )
})

void test('requires a pinned deployment script identity', () => {
  for (const remote of [
    { ...deployment.remote, scriptPath: undefined },
    { ...deployment.remote, scriptVersion: '' },
    { ...deployment.remote, scriptSha256: '' },
    { ...deployment.remote, scriptSha256: 'A'.repeat(64) },
  ]) {
    assert.throws(
      () => parseDeploymentConfig({ ...deployment, remote }, 'app-production'),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_CONFIG_INVALID',
    )
  }
})

void test('requires explicit runtime identities instead of product defaults', () => {
  for (const remote of [
    { ...deployment.remote, imageName: '' },
    { ...deployment.remote, backupTagPrefix: '' },
    { ...deployment.remote, containerName: '' },
  ]) {
    assert.throws(
      () => parseDeploymentConfig({ ...deployment, remote }, 'app-production'),
      (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_CONFIG_INVALID',
    )
  }
})

void test('parses artifact-build configuration and rejects traversal', () => {
  const parsed = parseArtifactBuildConfig({
    schemaVersion: 1,
    instanceId: 'build-app',
    tenantKey: 'tenant-a',
    ownerDomain: 'operations',
    access: { presets: ['build_operator'] },
    localRoot: 'E:\\deploy\\app',
    cwd: 'docker/build',
    command: ['./build.sh'],
    timeoutMs: 600000,
    outputs: ['docker/image/app.tar'],
    manifest: 'docker/image/release-manifest.json',
    manifestDigest: 'docker/image/release-manifest.sha256',
    imageName: 'app:latest',
  }, 'build-app')
  assert.equal(parsed.cwd, 'docker/build')
  assert.throws(
    () => parseArtifactBuildConfig({
      schemaVersion: 1,
      instanceId: 'build-app',
      tenantKey: 'tenant-a',
      ownerDomain: 'operations',
      access: { presets: ['build_operator'] },
      localRoot: 'E:\\deploy\\app',
      cwd: '../escape',
      command: ['./build.sh'],
      timeoutMs: 600000,
      outputs: ['docker/image/app.tar'],
      manifest: 'docker/image/release-manifest.json',
      manifestDigest: 'docker/image/release-manifest.sha256',
    }, 'build-app'),
    (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_CONFIG_INVALID',
  )
})
