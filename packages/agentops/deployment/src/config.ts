/**
 * Strict deployment and artifact-build configuration parsing.
 * @module @agentops/dsh-deployment/config
 */

import { isAbsolute, normalize, resolve } from 'node:path'

import {
  DeploymentError,
  type ArtifactBuildConfig,
  type DeploymentAccessConfig,
  type DeploymentArtifactConfig,
  type DeploymentEnvironmentConfig,
  type DeploymentHealthConfig,
  type DeploymentInstanceConfig,
  type DeploymentMigrationConfig,
  type DeploymentOperation,
  type DeploymentRemoteConfig,
} from './types.ts'

const TENANT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const OPERATIONS = new Set<DeploymentOperation>(['plan', 'release', 'status', 'rollback'])
const COMMAND_PLACEHOLDERS = new Set([
  'workDir', 'targetPath', 'releaseId', 'rollbackReleaseId', 'firstInstallEnvFile',
])
const DEPLOYMENT_KEYS = new Set([
  'schemaVersion', 'instanceId', 'tenantKey', 'ownerDomain', 'sshInstanceId', 'access',
  'artifact', 'environment', 'remote', 'migration', 'health',
])
const BUILD_KEYS = new Set([
  'schemaVersion', 'instanceId', 'tenantKey', 'ownerDomain', 'access', 'localRoot', 'cwd',
  'command', 'timeoutMs', 'outputs', 'manifest', 'manifestDigest', 'imageName',
])

/**
 * Parse one deployment instance config.
 * @param value - raw capability instance config.
 * @param instanceId - runtime instance identity.
 * @returns the validated configuration.
 */
export function parseDeploymentConfig(value: Readonly<Record<string, unknown>>, instanceId: string): DeploymentInstanceConfig {
  rejectUnknown(value, DEPLOYMENT_KEYS, 'deployment')
  requireEqual(integer(value.schemaVersion), 1, 'schemaVersion')
  requireEqual(text(value.instanceId), instanceId, 'instanceId')
  const tenantKey = tenant(value.tenantKey)
  const ownerDomain = text(value.ownerDomain)
  if (ownerDomain === '') invalid('ownerDomain is required')
  const sshInstanceId = text(value.sshInstanceId)
  if (sshInstanceId === '') invalid('sshInstanceId is required')
  return {
    schemaVersion: 1,
    instanceId,
    tenantKey,
    ownerDomain,
    sshInstanceId,
    access: parseAccess(value.access),
    artifact: parseArtifact(value.artifact),
    environment: parseEnvironment(value.environment),
    remote: parseRemote(value.remote),
    migration: parseMigration(value.migration),
    health: parseHealth(value.health),
  }
}

/**
 * Parse one local artifact-build instance config.
 * @param value - raw capability instance config.
 * @param instanceId - runtime instance identity.
 * @returns the validated configuration.
 */
export function parseArtifactBuildConfig(value: Readonly<Record<string, unknown>>, instanceId: string): ArtifactBuildConfig {
  rejectUnknown(value, BUILD_KEYS, 'artifact-build')
  requireEqual(integer(value.schemaVersion), 1, 'schemaVersion')
  requireEqual(text(value.instanceId), instanceId, 'instanceId')
  const tenantKey = tenant(value.tenantKey)
  const ownerDomain = text(value.ownerDomain)
  if (ownerDomain === '') invalid('ownerDomain is required')
  const localRoot = localPath(value.localRoot, 'localRoot')
  const cwd = relativeDirectory(value.cwd, 'cwd')
  const command = commandArray(value.command, 'command', new Set())
  const timeoutMs = positiveInteger(value.timeoutMs, 'timeoutMs')
  const outputs = stringArray(value.outputs, 'outputs').map(item => relativePath(item, 'outputs'))
  const manifest = relativePath(value.manifest, 'manifest')
  const manifestDigest = relativePath(value.manifestDigest, 'manifestDigest')
  if (outputs.length === 0) invalid('outputs must contain at least one file')
  if (outputs.includes(manifest) || outputs.includes(manifestDigest)) {
    invalid('outputs must not include the manifest or digest sidecar')
  }
  const access = object(value.access, 'access')
  const presets = stringArray(access.presets, 'access.presets')
  if (presets.length === 0) invalid('access.presets must contain at least one preset')
  const imageName = value.imageName === undefined || value.imageName === null || value.imageName === ''
    ? null
    : text(value.imageName)
  return {
    schemaVersion: 1,
    instanceId,
    tenantKey,
    ownerDomain,
    access: { presets },
    localRoot,
    cwd,
    command,
    timeoutMs,
    outputs,
    manifest,
    manifestDigest,
    imageName,
  }
}

/**
 * Resolve a relative artifact path beneath an absolute root.
 * @param root - absolute local root.
 * @param relative - validated relative path.
 * @returns absolute path proven to remain below root.
 */
export function resolveContained(root: string, relative: string): string {
  const canonicalRoot = resolve(root)
  const target = resolve(canonicalRoot, normalize(relative.replaceAll('\\', '/')))
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}\\`) && !target.startsWith(`${canonicalRoot}/`)) {
    throw new DeploymentError('DEPLOYMENT_LOCAL_ROOT_INVALID', `artifact path ${relative} escapes local root`)
  }
  return target
}

/**
 * Validate a preset against an instance access policy.
 * @param preset - authenticated Agent preset.
 * @param access - configured preset and operation grants.
 * @param operation - requested operation.
 */
export function assertDeploymentAccess(preset: string, access: DeploymentAccessConfig, operation: DeploymentOperation): void {
  if (!access.presets.includes(preset)) {
    throw new DeploymentError('DEPLOYMENT_ACCESS_DENIED', `preset ${preset} is not allowed to use this deployment instance`)
  }
  if (!access.operations.includes(operation)) {
    throw new DeploymentError('DEPLOYMENT_ACCESS_DENIED', `preset ${preset} cannot ${operation} this deployment instance`)
  }
}

/**
 * Replace only the documented command placeholders.
 * @param template - one configured argv template.
 * @param values - trusted placeholder values.
 * @returns a fully resolved argv.
 */
export function resolveCommand(template: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return template.map(item => item.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) invalid(`unknown command placeholder {${name}}`)
    return value
  }))
}

function parseAccess(value: unknown): DeploymentAccessConfig {
  const access = object(value, 'access')
  const presets = stringArray(access.presets, 'access.presets')
  if (presets.length === 0) invalid('access.presets must contain at least one preset')
  const operations = stringArray(access.operations, 'access.operations') as DeploymentOperation[]
  if (operations.length === 0) invalid('access.operations must contain at least one operation')
  for (const operation of operations) {
    if (!OPERATIONS.has(operation)) invalid(`unsupported operation ${operation}`)
  }
  return { presets, operations }
}

function parseArtifact(value: unknown): DeploymentArtifactConfig {
  const artifact = object(value, 'artifact')
  return {
    localRoot: localPath(artifact.localRoot, 'artifact.localRoot'),
    bundleRoot: relativePath(artifact.bundleRoot, 'artifact.bundleRoot'),
    updateFiles: relativePaths(artifact.updateFiles, 'artifact.updateFiles'),
    firstInstallFiles: relativePaths(artifact.firstInstallFiles, 'artifact.firstInstallFiles'),
    manifest: relativePath(artifact.manifest, 'artifact.manifest'),
    manifestDigest: relativePath(artifact.manifestDigest, 'artifact.manifestDigest'),
  }
}

function parseEnvironment(value: unknown): DeploymentEnvironmentConfig {
  const environment = object(value, 'environment')
  const remotePermissions = text(environment.remotePermissions)
  if (remotePermissions !== '0600') invalid('environment.remotePermissions must be 0600')
  const cleanup = text(environment.cleanup)
  if (cleanup !== 'always') invalid('environment.cleanup must be always')
  const firstInstallSecretRef = optionalText(environment.firstInstallSecretRef)
  const firstInstallEnvFile = environment.firstInstallEnvFile === undefined
    ? undefined
    : remotePath(environment.firstInstallEnvFile, 'environment.firstInstallEnvFile')
  return {
    installedEnvFile: remotePath(environment.installedEnvFile, 'environment.installedEnvFile'),
    ...firstInstallSecretRef === undefined ? {} : { firstInstallSecretRef },
    ...firstInstallEnvFile === undefined ? {} : { firstInstallEnvFile },
    remotePermissions: '0600',
    cleanup: 'always',
  }
}

function parseRemote(value: unknown): DeploymentRemoteConfig {
  const remote = object(value, 'remote')
  const sudoMode = text(remote.sudoMode)
  if (sudoMode !== 'non-interactive') invalid('remote.sudoMode must be non-interactive')
  const scriptVersion = text(remote.scriptVersion)
  if (scriptVersion === '') invalid('remote.scriptVersion must not be empty')
  const imageName = text(remote.imageName)
  if (imageName === '') invalid('remote.imageName must not be empty')
  const containerName = text(remote.containerName)
  if (containerName === '') invalid('remote.containerName must not be empty')
  return {
    workRoot: remotePath(remote.workRoot, 'remote.workRoot'),
    targetPath: remotePath(remote.targetPath, 'remote.targetPath'),
    lockPath: remotePath(remote.lockPath, 'remote.lockPath'),
    imageName,
    backupTagPrefix: tagPrefix(remote.backupTagPrefix),
    containerName,
    composeFile: remotePath(remote.composeFile, 'remote.composeFile'),
    scriptPath: remotePath(remote.scriptPath, 'remote.scriptPath'),
    scriptVersion,
    scriptSha256: digest(remote.scriptSha256),
    commandTimeoutMs: positiveInteger(remote.commandTimeoutMs, 'remote.commandTimeoutMs'),
    sudoMode: 'non-interactive',
    firstInstallCommand: commandArray(remote.firstInstallCommand, 'remote.firstInstallCommand', COMMAND_PLACEHOLDERS),
    updateCommand: commandArray(remote.updateCommand, 'remote.updateCommand', COMMAND_PLACEHOLDERS),
    rollbackCommand: commandArray(remote.rollbackCommand, 'remote.rollbackCommand', COMMAND_PLACEHOLDERS),
  }
}

function parseMigration(value: unknown): DeploymentMigrationConfig {
  const migration = object(value, 'migration')
  const mode = text(migration.mode)
  if (mode !== 'always' && mode !== 'on-change' && mode !== 'explicit-only') invalid('invalid migration.mode')
  const backupBeforeMigrate = boolean(migration.backupBeforeMigrate, 'migration.backupBeforeMigrate')
  const backupRetentionDays = nonNegativeInteger(migration.backupRetentionDays, 'migration.backupRetentionDays')
  return { mode, backupBeforeMigrate, backupRetentionDays }
}

function parseHealth(value: unknown): DeploymentHealthConfig {
  const health = object(value, 'health')
  const checks = array(health.checks, 'health.checks').map((item, index) =>
    commandArray(item, `health.checks[${index}]`, new Set()))
  if (checks.length === 0) invalid('health.checks must contain at least one command')
  return { timeoutMs: positiveInteger(health.timeoutMs, 'health.timeoutMs'), checks }
}

function commandArray(value: unknown, field: string, placeholders: ReadonlySet<string>): readonly string[] {
  const result = stringArray(value, field)
  if (result.length === 0) invalid(`${field} must contain at least one argument`)
  for (const item of result) {
    if (item.includes('\0') || item.length === 0) invalid(`${field} contains an empty or NUL argument`)
    for (const match of item.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
      const name = match[1]
      if (name === undefined || !placeholders.has(name)) invalid(`${field} contains unknown placeholder {${name ?? ''}}`)
    }
  }
  return result
}

function relativePaths(value: unknown, field: string): readonly string[] {
  const result = stringArray(value, field).map(item => relativePath(item, field))
  if (result.length === 0) invalid(`${field} must contain at least one file`)
  if (new Set(result).size !== result.length) invalid(`${field} contains duplicate files`)
  return result
}

function relativeDirectory(value: unknown, field: string): string {
  const raw = text(value)
  if (raw === '.') return '.'
  return relativePath(raw, field)
}

function relativePath(value: unknown, field: string): string {
  const raw = text(value).replaceAll('\\', '/').replace(/^\.\//, '')
  if (raw === '' || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) {
    invalid(`${field} must be a relative non-empty path`)
  }
  const parts = raw.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) invalid(`${field} must not contain . or ..`)
  return parts.join('/')
}

function localPath(value: unknown, field: string): string {
  const raw = text(value)
  if (raw === '' || raw.includes('\0') || !isAbsolute(raw)) invalid(`${field} must be an absolute path`)
  return resolve(raw)
}

function remotePath(value: unknown, field: string): string {
  const raw = text(value)
  if (!raw.startsWith('/') || raw.endsWith('/') || raw.includes('\0') || raw.split('/').includes('..')) {
    invalid(`${field} must be an absolute POSIX path`)
  }
  return raw
}

function digest(value: unknown): string {
  const parsed = text(value)
  if (!/^[a-f0-9]{64}$/.test(parsed)) invalid('remote.scriptSha256 must be a lowercase SHA-256 hex digest')
  return parsed
}

function tagPrefix(value: unknown): string {
  const raw = text(value)
  if (raw === '') invalid('remote.backupTagPrefix must not be empty')
  if (!/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/.test(raw)) invalid('remote.backupTagPrefix must be a Docker tag prefix')
  return raw
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`)
  return value
}

function stringArray(value: unknown, field: string): string[] {
  const result = array(value, field).map(item => text(item))
  if (result.some(item => item === '')) invalid(`${field} contains an empty value`)
  return result
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value)
  if (parsed === null || parsed <= 0) invalid(`${field} must be a positive integer`)
  return parsed
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = integer(value)
  if (parsed === null || parsed < 0) invalid(`${field} must be a non-negative integer`)
  return parsed
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`)
  return value
}

function tenant(value: unknown): string {
  const parsed = text(value).toLowerCase()
  if (!TENANT.test(parsed)) invalid('tenantKey is invalid')
  return parsed
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const parsed = text(value)
  if (parsed === '') invalid('optional string must not be empty when present')
  return parsed
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requireEqual<T>(actual: T | null, expected: T, field: string): void {
  if (actual !== expected) invalid(`${field} must be ${String(expected)}`)
}

function rejectUnknown(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, kind: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${kind} contains unknown field ${key}`)
  }
}

function invalid(message: string): never {
  throw new DeploymentError('DEPLOYMENT_CONFIG_INVALID', message, {
    action: 'Correct the deployment instance configuration and retry.',
  })
}
