import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LayoutError, WorkspaceLayout, type LayoutRequest } from '../src/index.ts'
import { resolveLayout } from '../src/layout.ts'

let root: string
let layout: WorkspaceLayout
let extraRoots: string[]
let linkPaths: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentops-workspace-layout-'))
  extraRoots = []
  linkPaths = []
  layout = new WorkspaceLayout(new Context())
})

afterEach(async () => {
  for (const path of linkPaths.toReversed()) {
    try {
      if ((await lstat(path)).isSymbolicLink()) await unlink(path)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
  }
  await Promise.all([root, ...extraRoots].map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  extraRoots.push(directory)
  return directory
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function linkPermissionDenied(error: unknown): boolean {
  return isErrno(error, 'EPERM') || isErrno(error, 'EACCES')
}

async function createLink(
  target: string,
  link: string,
  type: 'file' | 'junction',
  context: { skip: () => void },
): Promise<boolean> {
  try {
    await symlink(target, link, type)
    linkPaths.push(link)
    return true
  } catch (error) {
    if (linkPermissionDenied(error)) {
      context.skip()
      return false
    }
    throw error
  }
}

async function failureOf(request: LayoutRequest): Promise<LayoutError> {
  try {
    await layout.resolve(request)
  } catch (error) {
    if (error instanceof LayoutError) return error
    throw error
  }
  throw new Error('expected the layout request to fail')
}

function agentRequest(overrides: Partial<LayoutRequest> = {}): LayoutRequest {
  return {
    sessionCwd: root,
    businessId: 'acme',
    scope: { kind: 'agent', agentId: 'writer' },
    artifact: 'report.md',
    ...overrides,
  }
}

describe('WorkspaceLayout locations', () => {
  it('creates the agent directory and returns canonical absolute paths', async () => {
    const result = await layout.resolve(agentRequest())

    const canonicalRoot = await realpath(root)
    expect(result.dir).toBe(join(canonicalRoot, 'acme', 'agents', 'writer'))
    expect(result.file).toBe(join(result.dir, 'report.md'))
    expect((await stat(result.dir)).isDirectory()).toBe(true)
  })

  it('creates a workflow run directory', async () => {
    const result = await layout.resolve({
      sessionCwd: root,
      businessId: 'acme',
      scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1' },
      artifact: 'summary.json',
    })

    const canonicalRoot = await realpath(root)
    expect(result.dir).toBe(join(canonicalRoot, 'acme', 'workflows', 'release', 'run-1'))
    expect(result.file).toBe(join(result.dir, 'summary.json'))
    expect((await stat(result.dir)).isDirectory()).toBe(true)
  })

  it('creates a workflow node directory', async () => {
    const result = await layout.resolve({
      sessionCwd: root,
      businessId: 'acme',
      scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1', nodeId: 'build' },
      artifact: 'logs/build.txt',
    })

    const canonicalRoot = await realpath(root)
    expect(result.dir).toBe(join(canonicalRoot, 'acme', 'workflows', 'release', 'run-1', 'nodes', 'build'))
    expect(result.file).toBe(join(result.dir, 'logs', 'build.txt'))
  })

  it('keeps a nested artifact path under the resolved directory', async () => {
    const result = await layout.resolve(agentRequest({ artifact: 'reports/2026/final.md' }))

    expect(result.file).toBe(join(result.dir, 'reports', '2026', 'final.md'))
  })
})

describe('WorkspaceLayout validation', () => {
  it.each([
    '',
    '/etc/passwd',
    '\\server\\share\\report.md',
    'C:\\reports\\final.md',
    '../escape.md',
    'reports/../../escape.md',
    'bad\0name.md',
  ])('rejects unsafe artifact %j', async (artifact) => {
    const error = await failureOf(agentRequest({ artifact }))
    expect(error).toMatchObject({ code: 'ARTIFACT_PATH_REJECTED', value: artifact })
  })

  it('rejects a bad artifact before touching the filesystem', async () => {
    const error = await failureOf(agentRequest({
      sessionCwd: join(root, 'missing'),
      artifact: '../escape.md',
    }))
    expect(error.code).toBe('ARTIFACT_PATH_REJECTED')
  })

  it.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'bad\0',
    'bad\nid',
    'trailing.',
    'trailing ',
    'bad:name',
    'bad<name',
    'bad>name',
    'bad"name',
    'bad|name',
    'bad?name',
    'bad*name',
  ])('rejects unsafe business id %j', async (businessId) => {
    const error = await failureOf(agentRequest({ businessId }))
    expect(error).toMatchObject({ code: 'BUSINESS_ID_REJECTED', value: businessId })
  })

  it('rejects a bad business id before touching the filesystem', async () => {
    const error = await failureOf(agentRequest({
      sessionCwd: join(root, 'missing'),
      businessId: '../escape',
    }))
    expect(error.code).toBe('BUSINESS_ID_REJECTED')
  })

  it.each([
    [{ kind: 'agent', agentId: '../writer' }, 'agentId', '../writer'],
    [{ kind: 'workflow', workflowId: 'a/b', runId: 'run-1' }, 'workflowId', 'a/b'],
    [{ kind: 'workflow', workflowId: 'release', runId: 'bad\0' }, 'runId', 'bad\0'],
    [{ kind: 'workflow', workflowId: 'release', runId: 'run-1', nodeId: 'trailing.' }, 'nodeId', 'trailing.'],
  ] as const)('rejects unsafe scope id in %j', async (scope, field, value) => {
    const error = await failureOf(agentRequest({ scope }))
    expect(error).toMatchObject({ code: 'SCOPE_ID_REJECTED', field, value })
  })

  it('rejects a relative session cwd', async () => {
    const error = await failureOf(agentRequest({ sessionCwd: 'relative-workspace' }))
    expect(error).toMatchObject({ code: 'SESSION_CWD_REJECTED', value: 'relative-workspace' })
  })

  it('rejects a missing session cwd', async () => {
    const missing = join(root, 'missing')
    const error = await failureOf(agentRequest({ sessionCwd: missing }))
    expect(error).toMatchObject({ code: 'SESSION_CWD_REJECTED', value: missing })
  })

  it('rejects a session cwd that is not a directory', async () => {
    const file = join(root, 'workspace.txt')
    await writeFile(file, 'not a directory', 'utf8')
    const error = await failureOf(agentRequest({ sessionCwd: file }))
    expect(error).toMatchObject({ code: 'SESSION_CWD_REJECTED', value: file })
  })
})
describe('WorkspaceLayout containment', () => {
  it('rejects a business directory junction that resolves outside the workspace', async (context) => {
    const outside = await temporaryDirectory('agentops-workspace-layout-outside-')
    if (!(await createLink(outside, join(root, 'acme'), 'junction', context))) return

    const error = await failureOf(agentRequest())

    expect(error).toMatchObject({ code: 'ESCAPES_WORKSPACE' })
  })

  it('rejects an artifact file symlink that resolves outside the workspace', async (context) => {
    const outside = await temporaryDirectory('agentops-workspace-layout-outside-')
    const outsideFile = join(outside, 'report.md')
    await writeFile(outsideFile, 'outside', 'utf8')
    const directory = join(root, 'acme', 'agents', 'writer')
    await mkdir(directory, { recursive: true })
    if (!(await createLink(outsideFile, join(directory, 'report.md'), 'file', context))) return

    const error = await failureOf(agentRequest())

    expect(error).toMatchObject({ code: 'ESCAPES_WORKSPACE' })
  })

  it('rejects a nested artifact parent junction that resolves outside the workspace', async (context) => {
    const outside = await temporaryDirectory('agentops-workspace-layout-outside-')
    const directory = join(root, 'acme', 'agents', 'writer')
    await mkdir(directory, { recursive: true })
    if (!(await createLink(outside, join(directory, 'logs'), 'junction', context))) return

    const error = await failureOf(agentRequest({ artifact: 'logs/build.txt' }))

    expect(error).toMatchObject({ code: 'ESCAPES_WORKSPACE' })
  })

  it('propagates unexpected filesystem errors unchanged', async () => {
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' })
    const fileSystem = {
      stat,
      lstat: async () => { throw denied },
      mkdir: async () => undefined,
      realpath,
    }

    await expect(resolveLayout(agentRequest(), fileSystem)).rejects.toBe(denied)
  })
})

describe('WorkspaceLayout scope and execution policy', () => {
  it('creates a workflow run root without an artifact', async () => {
    const scopeRequest = {
      sessionCwd: root,
      businessId: 'acme',
      scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1' },
    } as const

    const result = await layout.resolveScope(scopeRequest)

    const canonicalRoot = await realpath(root)
    expect(result).toEqual({ dir: join(canonicalRoot, 'acme', 'workflows', 'release', 'run-1') })
    expect((await stat(result.dir)).isDirectory()).toBe(true)
  })

  it('narrows an execution policy to the resolved scope root', async () => {
    const scopeRequest = {
      sessionCwd: root,
      businessId: 'acme',
      scope: { kind: 'workflow', workflowId: 'release', runId: 'run-1' },
    } as const
    const baselinePolicy = {
      mode: 'workspace-write',
      workspaceRoot: root,
      sessionId: SessionId('sess-workspace-policy'),
    } as const

    const result = await layout.resolvePolicy({ scopeRequest, baselinePolicy })

    expect(result.cwd).toBe(result.policy.workspaceRoot)
    expect(result.policy).toMatchObject({
      mode: 'workspace-write',
      sessionId: 'sess-workspace-policy',
    })
  })

  it('removes deployment extra writable roots from an explicit execution policy', async () => {
    const scopeRequest = {
      sessionCwd: root,
      businessId: 'acme',
      scope: { kind: 'agent', agentId: 'writer' },
    } as const
    const baselinePolicy = {
      mode: 'workspace-write',
      workspaceRoot: root,
      additionalWritableRoots: [join(root, 'shared')],
    } as const

    const { policy } = await layout.resolvePolicy({ scopeRequest, baselinePolicy })

    expect(policy).not.toHaveProperty('additionalWritableRoots')
  })
})
