import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isRelativeArtifactPath } from '@agentops/dsh-contracts'
import type {
  Layout,
  LayoutErrorCode,
  LayoutPolicy,
  LayoutPolicyRequest,
  LayoutRequest,
  LayoutScope,
  LayoutScopeField,
  LayoutScopeRequest,
} from './types.ts'

interface LayoutErrorDetails {
  readonly field?: LayoutScopeField
  readonly value?: string
}

interface LayoutFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  mkdir(path: string): Promise<void>
  realpath(path: string): Promise<string>
}

const nodeFileSystem: LayoutFileSystem = {
  stat: async path => stat(path),
  lstat: async path => lstat(path),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  realpath: async path => realpath(path),
}

/** A failed workspace layout validation with a stable failure code. */
export class LayoutError extends Error {
  /** Stable code identifying why the layout request was rejected. */
  readonly code: LayoutErrorCode
  /** The rejected scope field, when the failure names one. */
  readonly field: LayoutScopeField | undefined
  /** The rejected value, when the failure names one. */
  readonly value: string | undefined

  constructor(code: LayoutErrorCode, message: string, details: LayoutErrorDetails = {}) {
    super(message)
    this.name = 'LayoutError'
    this.code = code
    this.field = details.field
    this.value = details.value
  }
}

const UNSAFE_COMPONENT = /[<>:"/\\|?*\u0000-\u001F\u007F]/

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function validateArtifact(artifact: string): void {
  if (!isRelativeArtifactPath(artifact)) {
    throw new LayoutError('ARTIFACT_PATH_REJECTED', `Artifact path must stay relative to its layout: ${JSON.stringify(artifact)}`, { value: artifact })
  }
}

function validateBusinessId(businessId: string): void {
  if (businessId === '' || businessId === '.' || businessId === '..' || UNSAFE_COMPONENT.test(businessId) || /[. ]$/.test(businessId)) {
    throw new LayoutError('BUSINESS_ID_REJECTED', `Business id must be one safe path component: ${JSON.stringify(businessId)}`, { value: businessId })
  }
}

function validateScopeField(field: LayoutScopeField, value: string): void {
  if (value === '' || value === '.' || value === '..' || UNSAFE_COMPONENT.test(value) || /[. ]$/.test(value)) {
    throw new LayoutError('SCOPE_ID_REJECTED', `${field} must be one safe path component: ${JSON.stringify(value)}`, { field, value })
  }
}

function validateScope(scope: LayoutRequest['scope']): void {
  if (scope.kind === 'agent') {
    validateScopeField('agentId', scope.agentId)
    return
  }
  validateScopeField('workflowId', scope.workflowId)
  validateScopeField('runId', scope.runId)
  if (scope.nodeId !== undefined) validateScopeField('nodeId', scope.nodeId)
}

async function canonicalSessionCwd(sessionCwd: string, fileSystem: LayoutFileSystem): Promise<string> {
  const reject = (): LayoutError => new LayoutError(
    'SESSION_CWD_REJECTED',
    `Session cwd must be an existing absolute directory: ${JSON.stringify(sessionCwd)}`,
    { value: sessionCwd },
  )
  if (!isAbsolute(sessionCwd)) throw reject()
  let directory: Awaited<ReturnType<LayoutFileSystem['stat']>>
  try {
    directory = await fileSystem.stat(sessionCwd)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) throw reject()
    throw error
  }
  if (!directory.isDirectory()) throw reject()
  try {
    return await fileSystem.realpath(sessionCwd)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) throw reject()
    throw error
  }
}

function isWithin(base: string, target: string): boolean {
  const path = relative(base, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function escapesWorkspace(path: string): LayoutError {
  return new LayoutError('ESCAPES_WORKSPACE', `Path resolves outside the session workspace: ${JSON.stringify(path)}`, { value: path })
}

function assertWithinWorkspace(base: string, target: string, reportedPath = target): void {
  if (!isWithin(base, target)) throw escapesWorkspace(reportedPath)
}

/**
 * Reject a path whose nearest existing ancestor resolves outside the workspace.
 * A dangling symlink in the path is rejected because its write target cannot be
 * proved to remain inside.
 */
async function assertPathWithinWorkspace(base: string, path: string, fileSystem: LayoutFileSystem): Promise<void> {
  let current = path
  while (true) {
    let entry: Awaited<ReturnType<LayoutFileSystem['lstat']>>
    try {
      entry = await fileSystem.lstat(current)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      const parent = dirname(current)
      /* v8 ignore next -- the canonical session cwd exists, so traversal reaches it first */
      if (parent === current) throw escapesWorkspace(path)
      current = parent
      continue
    }

    let resolved: string
    try {
      resolved = await fileSystem.realpath(current)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      if (entry.isSymbolicLink()) throw escapesWorkspace(path)
      const parent = dirname(current)
      /* v8 ignore next -- the canonical session cwd exists, so traversal reaches it first */
      if (parent === current) throw escapesWorkspace(path)
      current = parent
      continue
    }

    assertWithinWorkspace(base, resolved, path)
    return
  }
}

/**
 * Resolve and create one AgentOps scope directory under the requested workspace.
 * @param request - selected workspace, business id, and AgentOps scope.
 * @param fileSystem - filesystem operations used for validation and creation.
 * @returns the canonical absolute scope directory.
 * @throws {LayoutError} when an input or resolved path violates the layout.
 */
export async function resolveScope(
  request: LayoutScopeRequest,
  fileSystem: LayoutFileSystem = nodeFileSystem,
): Promise<LayoutScope> {
  validateBusinessId(request.businessId)
  validateScope(request.scope)

  const base = await canonicalSessionCwd(request.sessionCwd, fileSystem)
  const relativeDirectory = request.scope.kind === 'agent'
    ? [request.businessId, 'agents', request.scope.agentId]
    : [
      request.businessId,
      'workflows',
      request.scope.workflowId,
      request.scope.runId,
      ...(request.scope.nodeId === undefined ? [] : ['nodes', request.scope.nodeId]),
    ]
  const candidate = join(base, ...relativeDirectory)
  assertWithinWorkspace(base, candidate)
  await assertPathWithinWorkspace(base, candidate, fileSystem)
  await fileSystem.mkdir(candidate)
  const dir = await fileSystem.realpath(candidate)
  assertWithinWorkspace(base, dir)
  return { dir }
}

/**
 * Resolve and create one artifact directory under the requested workspace.
 * @param request - selected workspace, AgentOps scope, and relative artifact.
 * @param fileSystem - filesystem operations used for validation and creation.
 * @returns canonical absolute directory and the artifact path within it.
 * @throws {LayoutError} when an input or resolved path violates the layout.
 */
export async function resolveLayout(
  request: LayoutRequest,
  fileSystem: LayoutFileSystem = nodeFileSystem,
): Promise<Layout> {
  validateArtifact(request.artifact)
  const { dir } = await resolveScope(request, fileSystem)

  const file = join(dir, request.artifact)
  assertWithinWorkspace(dir, file)
  await assertPathWithinWorkspace(dir, file, fileSystem)
  return { dir, file }
}

/**
 * Resolve one explicit execution policy narrowed to a scope directory.
 * Deployment extra writable roots are intentionally omitted so the policy
 * cannot grant writes outside the AgentOps scope.
 * @param request - scope inputs and the deployment policy to narrow.
 * @param fileSystem - filesystem operations used for scope resolution.
 * @returns the canonical scope directory and explicit execution policy.
 */
export async function resolvePolicy(
  request: LayoutPolicyRequest,
  fileSystem: LayoutFileSystem = nodeFileSystem,
): Promise<LayoutPolicy> {
  const { dir } = await resolveScope(request.scopeRequest, fileSystem)
  const sessionId = request.baselinePolicy.sessionId
  return {
    cwd: dir,
    policy: {
      mode: request.baselinePolicy.mode,
      workspaceRoot: dir,
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  }
}
