/**
 * Local artifact build and release-manifest producer.
 * @module @agentops/dsh-deployment/build
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { CapabilityStore } from '@agentops/dsh-capability'

import { parseArtifactBuildConfig, resolveContained } from './config.ts'
import type { LocalCommandRunner } from './local-runner.ts'
import { DeploymentError, type ArtifactBuildConfig, type ReleaseArtifactFile, type ReleaseManifest } from './types.ts'

/** Result returned by `artifact_build`. */
export interface ArtifactBuildResult {
  readonly instanceId: string
  readonly releaseId: string
  readonly manifest: ReleaseManifest
  readonly manifestDigest: string
  readonly manifestPath: string
  readonly manifestDigestPath: string
}

/** Build request authenticated by an Agent preset. */
export interface ArtifactBuildRequest {
  readonly agentPreset: string
  readonly instanceId: string
  readonly signal?: AbortSignal
}

/** Build outputs from one configured local root. */
export class ArtifactBuildService {
  readonly #capabilities: CapabilityStore
  readonly #runner: LocalCommandRunner

  /**
   * @param capabilities - capability store owning local build instances.
   * @param runner - trusted local command runner.
   */
  constructor(capabilities: CapabilityStore, runner: LocalCommandRunner) {
    this.#capabilities = capabilities
    this.#runner = runner
  }

  /**
   * Run the configured build, hash outputs, and write the manifest pair.
   * @param request - preset-authorized build instance.
   * @returns release identity and output files.
   */
  async build(request: ArtifactBuildRequest): Promise<ArtifactBuildResult> {
    const runtime = this.#capabilities.resolveRuntime(request.agentPreset, 'artifact-build', request.instanceId)
    const config = parseArtifactBuildConfig(runtime.config, runtime.instanceId)
    if (!config.access.presets.includes(request.agentPreset)) {
      throw new DeploymentError('DEPLOYMENT_ACCESS_DENIED', `preset ${request.agentPreset} is not allowed to build ${config.instanceId}`)
    }
    const cwd = resolveContained(config.localRoot, config.cwd)
    const result = await this.#runner.run(config.command, cwd, config.timeoutMs, request.signal)
    if (result.timedOut) {
      throw new DeploymentError('DEPLOYMENT_TIMEOUT', `build command timed out after ${config.timeoutMs}ms`, {
        action: 'Inspect the build command and retry after it can finish within the configured timeout.',
      })
    }
    if (result.exitCode !== 0) {
      throw new DeploymentError('DEPLOYMENT_BUILD_FAILED', `build command exited ${result.exitCode ?? result.signal ?? 'unknown'}: ${result.stderr.trim()}`, {
        action: 'Fix the build command before producing a release.',
      })
    }
    const git = await this.#gitIdentity(config, request.signal)
    const releaseId = buildReleaseId(git.sha)
    const files: ReleaseArtifactFile[] = []
    for (const relative of config.outputs) {
      const path = resolveContained(config.localRoot, relative)
      const info = await stat(path).catch((error: unknown) => {
        throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `build output ${relative} is missing`, {
          cause: error,
          action: 'Make the configured build command produce every declared output.',
        })
      })
      if (!info.isFile()) throw new DeploymentError('DEPLOYMENT_ARTIFACT_INVALID', `build output ${relative} is not a file`)
      files.push({ path: relative, bytes: info.size, sha256: await sha256File(path) })
    }
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      releaseId,
      gitSha: git.sha,
      dirty: git.dirty,
      builtAt: new Date().toISOString(),
      builder: 'agentops-dsh',
      imageName: config.imageName,
      artifactFiles: files,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const digest = createHash('sha256').update(manifestBytes).digest('hex')
    const manifestPath = resolveContained(config.localRoot, config.manifest)
    const digestPath = resolveContained(config.localRoot, config.manifestDigest)
    await mkdir(dirname(manifestPath), { recursive: true })
    await mkdir(dirname(digestPath), { recursive: true })
    await writeFile(manifestPath, manifestBytes)
    await writeFile(digestPath, `${digest}  release-manifest.json\n`, 'utf8')
    return { instanceId: config.instanceId, releaseId, manifest, manifestDigest: digest, manifestPath, manifestDigestPath: digestPath }
  }

  async #gitIdentity(config: ArtifactBuildConfig, signal: AbortSignal | undefined): Promise<{ sha: string | null; dirty: boolean | null }> {
    try {
      const sha = await this.#runner.run(['git', 'rev-parse', 'HEAD'], config.localRoot, 15_000, signal)
      if (sha.exitCode !== 0) return { sha: null, dirty: null }
      const status = await this.#runner.run(['git', 'status', '--porcelain'], config.localRoot, 15_000, signal)
      return {
        sha: sha.stdout.trim() || null,
        dirty: status.exitCode === 0 ? status.stdout.trim().length > 0 : null,
      }
    } catch {
      // Git is optional for artifact production; absence is recorded as unknown.
      return { sha: null, dirty: null }
    }
  }
}

/**
 * Hash one file.
 * @param path - file path to hash.
 * @returns hexadecimal SHA-256 digest.
 */
export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function buildReleaseId(gitSha: string | null): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = gitSha?.slice(0, 8) ?? randomUUID().replaceAll('-', '').slice(0, 8)
  return `build-${stamp}-${suffix}`
}
