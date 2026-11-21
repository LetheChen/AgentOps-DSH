/**
 * Deterministic release planning, image backup, upload, health verification, and rollback.
 * @module @agentops/dsh-deployment/service
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'

import type { CapabilityStore } from '@agentops/dsh-capability'

import { parseDeploymentConfig, resolveCommand, resolveContained, assertDeploymentAccess } from './config.ts'
import { sha256File } from './build.ts'
import { quoteArg } from './transport.ts'
import type { DeploymentTransport } from './transport.ts'
import type { DeploymentStore } from './store.ts'
import {
  DeploymentError,
  type DeploymentInstanceConfig,
  type DeploymentSshConfig,
  type DeploymentSshCredential,
  type DeploymentStatus as DeploymentStatusResult,
  type ArtifactFileLocation,
  type ReleaseArtifactFile,
  type ReleaseManifest,
  type VerifiedArtifact,
} from './types.ts'

/** Deployment operation mode selected by the tool caller. */
export type DeploymentMode = 'update' | 'first_install'

/** Authenticated request accepted by the deployment service. */
export interface DeploymentRequest {
  readonly agentPreset: string
  readonly instanceId: string
  readonly mode?: DeploymentMode
  readonly releaseId?: string
  readonly signal?: AbortSignal
}

/** Result from a read-only deployment plan. */
export interface DeploymentPlanResult {
  readonly instanceId: string
  readonly mode: DeploymentMode
  readonly manifest: ReleaseManifest
  readonly manifestDigest: string
  readonly steps: readonly string[]
}

/** Result from one release or rollback. */
export interface DeploymentActionResult {
  readonly instanceId: string
  readonly releaseUid: string
  readonly releaseId: string
  readonly state: string
  readonly manifest: ReleaseManifest
  readonly backupTag: string | null
  readonly backupImageId: string | null
  readonly imageId: string | null
  readonly steps: readonly string[]
}

/** One resolved deployment request. */
interface ResolvedDeployment {
  readonly config: DeploymentInstanceConfig
  readonly sshConfig: DeploymentSshConfig
  readonly credential: DeploymentSshCredential
}

/**
 * Whether a parsed release manifest carries the identity and file list the deployer needs.
 *
 * @param value - the parsed JSON value.
 * @returns whether the value is a usable release manifest.
 */
function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ReleaseManifest>
  if (candidate.schemaVersion !== 1) return false
  if (typeof candidate.releaseId !== 'string') return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.releaseId)) return false
  const files = candidate.artifactFiles
  if (!Array.isArray(files)) return false
  return files.every((file: unknown) => {
    if (typeof file !== 'object' || file === null) return false
    const entry = file as Partial<ReleaseArtifactFile>
    return typeof entry.path === 'string'
      && typeof entry.bytes === 'number'
      && typeof entry.sha256 === 'string'
  })
}

/** Coordinates artifact verification, SSH preflight, release execution, and durable release evidence. */
export class DeploymentService {
  readonly #journal: DeploymentStore
  readonly #capabilities: CapabilityStore
  readonly #transport: DeploymentTransport

  /**
   * @param journal - durable release journal.
   * @param capabilities - capability instance store.
   * @param transport - SSH transport.
   */
  constructor(journal: DeploymentStore, capabilities: CapabilityStore, transport: DeploymentTransport) {
    this.#journal = journal
    this.#capabilities = capabilities
    this.#transport = transport
  }

  /**
   * Verify local artifacts and remote prerequisites without mutating the host.
   * @param request - preset-authorized deployment request.
   * @returns the planned release evidence.
   */
  async plan(request: DeploymentRequest): Promise<DeploymentPlanResult> {
    const mode = request.mode ?? 'update'
    const resolved = await this.#resolve(request, 'plan')
    const artifact = await this.#verifyArtifact(resolved.config, mode)
    await this.#verifyReleaseScript(resolved, request.signal)
    await this.#preflight(resolved, request.signal)
    return {
      instanceId: resolved.config.instanceId,
      mode,
      manifest: artifact.manifest,
      manifestDigest: artifact.manifestDigest,
      steps: ['artifact-verified', 'ssh-verified', 'remote-script-verified', 'remote-preflight-passed'],
    }
  }

  /**
   * Claim the release lease, back up the current image, upload artifacts, execute the release command, and verify health.
   * @param request - preset-authorized deployment request.
   * @returns the persisted release evidence.
   */
  async release(request: DeploymentRequest): Promise<DeploymentActionResult> {
    const mode = request.mode ?? 'update'
    const resolved = await this.#resolve(request, 'release')
    if (resolved.config.migration.mode !== 'always') {
      throw new DeploymentError('DEPLOYMENT_UNSUPPORTED', `migration mode ${resolved.config.migration.mode} is not implemented in this slice`, {
        action: 'Start with migration.mode=always; add an explicit migration contract before enabling another mode.',
      })
    }
    const artifact = await this.#verifyArtifact(resolved.config, mode)
    await this.#verifyReleaseScript(resolved, request.signal)
    const claimed = this.#journal.claim({
      instanceId: resolved.config.instanceId,
      tenantKey: resolved.config.tenantKey,
      releaseId: artifact.manifest.releaseId,
      ownerPreset: request.agentPreset,
    })
    const workDir = posix.join(resolved.config.remote.workRoot, artifact.manifest.releaseId)
    try {
      this.#journal.recordStep(claimed.releaseUid, {
        name: 'artifact-verified', status: 'passed', at: new Date().toISOString(), detail: artifact.manifest.releaseId,
      }, { state: 'uploading', manifest: artifact.manifest, manifestDigest: artifact.manifestDigest })
      await this.#ensureRemoteDirectory(resolved, workDir, request.signal)
      for (const file of artifact.files) {
        await this.#ensureRemoteDirectory(resolved, posix.dirname(file.remotePath), request.signal)
        await this.#transport.upload(resolved.sshConfig, resolved.credential, file.localPath, file.remotePath, request.signal)
        const remote = await this.#run(resolved, ['sha256sum', file.remotePath], request.signal)
        if (remote.exitCode !== 0 || remote.stdout.trim().split(/\s+/)[0] !== file.sha256) {
          throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `remote artifact hash mismatch: ${file.relativePath}`, {
            action: 'Re-upload the artifact and retry after verifying the release manifest.',
          })
        }
      }
      this.#journal.recordStep(claimed.releaseUid, {
        name: 'artifacts-uploaded', status: 'passed', at: new Date().toISOString(),
      })
      const backup = await this.#backupCurrentImage(resolved, request.signal)
      if (backup !== null) {
        this.#journal.recordStep(claimed.releaseUid, {
          name: 'current-image-backed-up', status: 'passed', at: new Date().toISOString(), detail: backup.tag,
        }, { backupTag: backup.tag, backupImageId: backup.imageId })
      } else {
        this.#journal.recordStep(claimed.releaseUid, {
          name: 'current-image-backed-up', status: 'passed', at: new Date().toISOString(), detail: 'no current container image',
        })
      }
      this.#journal.recordStep(claimed.releaseUid, { name: 'release-command-start', status: 'passed', at: new Date().toISOString() })
      const command = resolveCommand(
        mode === 'first_install' ? resolved.config.remote.firstInstallCommand : resolved.config.remote.updateCommand,
        this.#commandValues(resolved.config, artifact.manifest.releaseId, workDir),
      )
      const release = await this.#run(resolved, command, request.signal, resolved.config.remote.commandTimeoutMs)
      if (release.timedOut) throw new DeploymentError('DEPLOYMENT_TIMEOUT', 'release command timed out', { action: 'Inspect the remote deployment state before retrying.' })
      if (release.exitCode === null) throw new DeploymentError('DEPLOYMENT_REMOTE_AMBIGUOUS', 'release command ended without an exit code', { action: 'Inspect deployment_status before any retry.' })
      if (release.exitCode !== 0) throw new DeploymentError('DEPLOYMENT_REMOTE_COMMAND_FAILED', `release command exited ${release.exitCode}: ${release.stderr.trim()}`, { action: 'Inspect the release journal and remote logs; do not blindly retry.' })
      this.#journal.recordStep(claimed.releaseUid, { name: 'release-command-complete', status: 'passed', at: new Date().toISOString() })
      const imageId = await this.#currentImageId(resolved, request.signal)
      this.#journal.recordStep(claimed.releaseUid, { name: 'health-check-start', status: 'passed', at: new Date().toISOString() }, { state: 'health_checking', imageId })
      await this.#health(resolved, request.signal)
      this.#journal.recordStep(claimed.releaseUid, { name: 'health-check-passed', status: 'passed', at: new Date().toISOString() })
      this.#journal.settle(claimed.releaseUid, 'healthy')
      const persisted = this.#journal.get(claimed.releaseUid)
      return {
        instanceId: resolved.config.instanceId,
        releaseUid: persisted.releaseUid,
        releaseId: persisted.releaseId,
        state: persisted.state,
        manifest: artifact.manifest,
        backupTag: persisted.backupTag,
        backupImageId: persisted.backupImageId,
        imageId: persisted.imageId,
        steps: persisted.steps.map(step => step.name),
      }
    } catch (error) {
      const deploymentError = error instanceof DeploymentError ? error : new DeploymentError('DEPLOYMENT_REMOTE_AMBIGUOUS', error instanceof Error ? error.message : String(error), { cause: error })
      if (deploymentError.code === 'DEPLOYMENT_REMOTE_AMBIGUOUS' || deploymentError.code === 'DEPLOYMENT_TIMEOUT') {
        this.#journal.holdUnknown(claimed.releaseUid, 'release-command', deploymentError.message)
      } else {
        this.#journal.settle(claimed.releaseUid, 'failed', { code: deploymentError.code, message: deploymentError.message })
      }
      throw deploymentError
    }
  }

  /**
   * Return journal state and the live current image id when reachable.
   * @param request - preset-authorized deployment request.
   * @returns durable status plus live image identity when available.
   */
  async status(request: DeploymentRequest): Promise<DeploymentStatusResult & { readonly liveImageId: string | null }> {
    const resolved = await this.#resolve({ ...request, mode: 'update' }, 'status')
    const stored = this.#journal.status(resolved.config.instanceId)
    let liveImageId: string | null = null
    try {
      liveImageId = await this.#currentImageId(resolved, request.signal)
    } catch {
      // Status remains useful when the target is unreachable; the durable journal is the fallback.
    }
    return { ...stored, liveImageId }
  }

  /**
   * Roll back one recorded healthy application image.
   * @param request - preset-authorized rollback request.
   * @returns persisted rollback evidence.
   */
  async rollback(request: DeploymentRequest): Promise<DeploymentActionResult> {
    if (request.releaseId === undefined || request.releaseId.trim() === '') {
      throw new DeploymentError('DEPLOYMENT_RELEASE_NOT_ROLLBACKABLE', 'releaseId is required for rollback')
    }
    const resolved = await this.#resolve(request, 'rollback')
    const target = this.#journal.findByReleaseId(resolved.config.instanceId, request.releaseId)
    if (target === null || target.state !== 'healthy' || target.backupImageId === null || target.manifest === null) {
      throw new DeploymentError('DEPLOYMENT_RELEASE_NOT_ROLLBACKABLE', `release ${request.releaseId} is not a healthy rollback point`)
    }
    await this.#verifyReleaseScript(resolved, request.signal)
    const claimed = this.#journal.claim({
      instanceId: resolved.config.instanceId,
      tenantKey: resolved.config.tenantKey,
      releaseId: `rollback-${target.releaseId}`,
      ownerPreset: request.agentPreset,
    })
    try {
      this.#journal.recordStep(claimed.releaseUid, { name: 'rollback-target-verified', status: 'passed', at: new Date().toISOString(), detail: target.backupTag ?? target.backupImageId })
      const command = resolveCommand(resolved.config.remote.rollbackCommand, {
        ...this.#commandValues(resolved.config, target.releaseId, target.releaseId),
        rollbackReleaseId: target.releaseId,
      })
      const result = await this.#run(resolved, command, request.signal, resolved.config.remote.commandTimeoutMs)
      if (result.exitCode === null) throw new DeploymentError('DEPLOYMENT_REMOTE_AMBIGUOUS', 'rollback command ended without an exit code')
      if (result.exitCode !== 0) throw new DeploymentError('DEPLOYMENT_REMOTE_COMMAND_FAILED', `rollback command exited ${result.exitCode}: ${result.stderr.trim()}`)
      await this.#health(resolved, request.signal)
      this.#journal.recordStep(claimed.releaseUid, { name: 'health-check-passed', status: 'passed', at: new Date().toISOString() })
      this.#journal.settle(claimed.releaseUid, 'rolled_back')
      const persisted = this.#journal.get(claimed.releaseUid)
      return {
        instanceId: resolved.config.instanceId,
        releaseUid: persisted.releaseUid,
        releaseId: persisted.releaseId,
        state: persisted.state,
        manifest: target.manifest,
        backupTag: persisted.backupTag,
        backupImageId: persisted.backupImageId,
        imageId: persisted.imageId,
        steps: persisted.steps.map(step => step.name),
      }
    } catch (error) {
      const deploymentError = error instanceof DeploymentError ? error : new DeploymentError('DEPLOYMENT_REMOTE_AMBIGUOUS', error instanceof Error ? error.message : String(error), { cause: error })
      if (deploymentError.code === 'DEPLOYMENT_REMOTE_AMBIGUOUS' || deploymentError.code === 'DEPLOYMENT_TIMEOUT') {
        this.#journal.holdUnknown(claimed.releaseUid, 'rollback-command', deploymentError.message)
      } else {
        this.#journal.settle(claimed.releaseUid, 'failed', { code: deploymentError.code, message: deploymentError.message })
      }
      throw deploymentError
    }
  }

  async #resolve(request: DeploymentRequest, operation: 'plan' | 'release' | 'status' | 'rollback'): Promise<ResolvedDeployment> {
    const runtime = this.#capabilities.resolveRuntime(request.agentPreset, 'deployment', request.instanceId)
    const config = parseDeploymentConfig(runtime.config, runtime.instanceId)
    assertDeploymentAccess(request.agentPreset, config.access, operation)
    const sshView = this.#capabilities.getInstance(config.sshInstanceId)
    if (sshView === null || sshView.capabilityId !== 'ssh' || sshView.status !== 'enabled') {
      throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', `SSH instance ${config.sshInstanceId} is unavailable`)
    }
    if (!sshView.credentialConfigured) throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', `SSH instance ${config.sshInstanceId} has no credential`)
    const host = text(sshView.config.host)
    const username = text(sshView.config.username)
    const port = number(sshView.config.port)
    const hostKeySha256 = text(sshView.config.host_key_sha256)
    if (host === '' || username === '' || port === null || hostKeySha256 === '') {
      throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', `SSH instance ${config.sshInstanceId} is incompletely configured`)
    }
    const sshConfig: DeploymentSshConfig = {
      instanceId: config.sshInstanceId,
      host,
      port,
      username,
      authType: sshView.config.auth_type === 'private_key' ? 'key' : 'password',
      hostKeySha256,
      instanceRevision: sshView.credentialGeneration,
    }
    const observed = await this.#transport.probeHostKey(sshConfig)
    if (observed.replace(/^SHA256:/, '').replace(/=+$/, '') !== hostKeySha256.replace(/^SHA256:/, '').replace(/=+$/, '')) {
      throw new DeploymentError('DEPLOYMENT_SSH_HOST_KEY_REJECTED', `SSH host key for ${config.sshInstanceId} does not match the pin`)
    }
    const sshRuntime = this.#capabilities.resolveRuntime(request.agentPreset, 'ssh', config.sshInstanceId)
    if (sshRuntime.secret === null) throw new DeploymentError('DEPLOYMENT_SSH_AUTH_FAILED', `credential missing for ${config.sshInstanceId}`)
    const credential: DeploymentSshCredential = sshConfig.authType === 'key'
      ? { privateKey: sshRuntime.secret }
      : { password: sshRuntime.secret }
    return { config, sshConfig, credential }
  }

  async #verifyArtifact(config: DeploymentInstanceConfig, mode: DeploymentMode): Promise<VerifiedArtifact> {
    const manifestPath = resolveContained(config.artifact.localRoot, config.artifact.manifest)
    const digestPath = resolveContained(config.artifact.localRoot, config.artifact.manifestDigest)
    const bytes = await readFile(manifestPath).catch((error: unknown) => {
      throw new DeploymentError('DEPLOYMENT_MANIFEST_INVALID', `release manifest is missing: ${config.artifact.manifest}`, { cause: error })
    })
    const digestText = await readFile(digestPath, 'utf8').catch((error: unknown) => {
      throw new DeploymentError('DEPLOYMENT_MANIFEST_INVALID', `release manifest digest is missing: ${config.artifact.manifestDigest}`, { cause: error })
    })
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (!digestText.trim().startsWith(digest)) {
      throw new DeploymentError('DEPLOYMENT_MANIFEST_INVALID', 'release manifest digest does not match its sidecar')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      throw new DeploymentError('DEPLOYMENT_MANIFEST_INVALID', 'release manifest is not valid JSON', { cause: error })
    }
    if (!isReleaseManifest(parsed)) {
      throw new DeploymentError('DEPLOYMENT_MANIFEST_INVALID', 'release manifest has an invalid identity or file list')
    }
    const manifest = parsed
    const required = mode === 'first_install' ? config.artifact.firstInstallFiles : config.artifact.updateFiles
    const declared = new Map(manifest.artifactFiles.map(file => [file.path, file]))
    const files: ArtifactFileLocation[] = []
    for (const relative of required) {
      const entry = declared.get(relative)
      if (entry === undefined) throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `manifest does not declare required file ${relative}`)
      const localPath = resolveContained(config.artifact.localRoot, relative)
      const info = await stat(localPath).catch((error: unknown) => {
        throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `required artifact is missing: ${relative}`, { cause: error })
      })
      const sha256 = await sha256File(localPath)
      if (!info.isFile() || info.size !== entry.bytes || sha256 !== entry.sha256) {
        throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `artifact hash or size mismatch: ${relative}`)
      }
      const remotePath = posix.join(config.remote.workRoot, manifest.releaseId, config.artifact.bundleRoot, relative)
      files.push({ relativePath: relative, localPath, remotePath, sha256, bytes: entry.bytes })
    }
    return { manifest, manifestDigest: digest, files }
  }

  async #verifyReleaseScript(resolved: ResolvedDeployment, signal: AbortSignal | undefined): Promise<void> {
    const { scriptPath, scriptSha256: expected, scriptVersion } = resolved.config.remote
    const result = await this.#run(resolved, ['sudo', '-n', 'sha256sum', scriptPath], signal)
    const actual = result.stdout.trim().split(/\s+/)[0] ?? ''
    if (result.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(actual) || actual !== expected) {
      throw new DeploymentError('DEPLOYMENT_SCRIPT_MISMATCH', `deployment script ${scriptVersion} hash mismatch: expected ${expected}, got ${actual || 'unavailable'}`, { action: 'Install the reviewed deployment script version and update the instance digest together.' })
    }
  }

  async #preflight(resolved: ResolvedDeployment, signal: AbortSignal | undefined): Promise<void> {
    const lockDir = posix.dirname(resolved.config.remote.lockPath)
    const checks: readonly (readonly string[])[] = [
      ['sudo', '-n', 'true'],
      this.#docker(resolved, ['compose', 'version']),
      ['curl', '--version'],
      ['mkdir', '-p', lockDir],
      ['sh', '-lc', `test -w ${quoteArg(lockDir)}`],
      ['df', '-Pk', posix.dirname(resolved.config.remote.targetPath)],
    ]
    for (const command of checks) await this.#expectSuccess(resolved, command, signal)
  }

  async #health(resolved: ResolvedDeployment, signal: AbortSignal | undefined): Promise<void> {
    for (const check of resolved.config.health.checks) {
      await this.#expectSuccess(resolved, check, signal, resolved.config.health.timeoutMs)
    }
    const imageId = await this.#currentImageId(resolved, signal)
    if (imageId === null) throw new DeploymentError('DEPLOYMENT_REMOTE_COMMAND_FAILED', `container ${resolved.config.remote.containerName} has no image id`)
  }

  async #expectSuccess(
    resolved: ResolvedDeployment,
    command: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs = resolved.config.remote.commandTimeoutMs,
  ): Promise<void> {
    const result = await this.#run(resolved, command, signal, timeoutMs)
    if (result.timedOut) throw new DeploymentError('DEPLOYMENT_TIMEOUT', `remote command timed out: ${command[0] ?? ''}`)
    if (result.exitCode !== 0) throw new DeploymentError('DEPLOYMENT_REMOTE_COMMAND_FAILED', `remote command failed (${result.exitCode ?? result.signal ?? 'unknown'}): ${result.stderr.trim()}`)
  }

  async #run(
    resolved: ResolvedDeployment,
    command: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs = resolved.config.remote.commandTimeoutMs,
  ) {
    return await this.#transport.execute(resolved.sshConfig, resolved.credential, command, timeoutMs, signal)
  }

  async #ensureRemoteDirectory(resolved: ResolvedDeployment, path: string, signal: AbortSignal | undefined): Promise<void> {
    await this.#expectSuccess(resolved, ['mkdir', '-p', path], signal)
  }

  async #currentImageId(resolved: ResolvedDeployment, signal: AbortSignal | undefined): Promise<string | null> {
    const result = await this.#run(resolved, this.#docker(resolved, ['inspect', '--format', '{{.Image}}', resolved.config.remote.containerName]), signal)
    if (result.exitCode !== 0) return null
    return result.stdout.trim() || null
  }

  async #backupCurrentImage(
    resolved: ResolvedDeployment,
    signal: AbortSignal | undefined,
  ): Promise<{ tag: string; imageId: string } | null> {
    const imageId = await this.#currentImageId(resolved, signal)
    if (imageId === null) return null
    const raw = new Date().toISOString()
    const stamp = raw.slice(0, 10).replaceAll('-', '') + '-' + raw.slice(11, 19).replaceAll(':', '')
    const short = imageId.replace(/^sha256:/, '').slice(0, 8)
    const tag = `${resolved.config.remote.backupTagPrefix}-${stamp}-${short}`
    await this.#expectSuccess(resolved, this.#docker(resolved, ['tag', imageId, tag]), signal)
    return { tag, imageId }
  }

  #docker(_resolved: ResolvedDeployment, args: readonly string[]): string[] {
    return ['sudo', '-n', 'docker', ...args]
  }

  #commandValues(config: DeploymentInstanceConfig, releaseId: string, workDir: string): Record<string, string> {
    return {
      workDir,
      targetPath: config.remote.targetPath,
      releaseId,
      firstInstallEnvFile: config.environment.firstInstallEnvFile ?? config.environment.installedEnvFile,
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null
}
