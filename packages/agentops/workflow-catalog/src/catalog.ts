/**
 * Workflow definition catalogue.
 *
 * YAML files stay the source of truth; this module is the only place that
 * scans, validates, compiles, and writes them. Saving is compare-and-swap on
 * the file digest, so a stale editor cannot silently overwrite a newer
 * definition — that is the CAS the migration plan deferred until a real
 * consumer existed.
 *
 * @module @agentops/dsh-workflow-catalog/catalog
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadWorkflowDefinition } from '@agentops/dsh-contracts'
import type { ValidationIssue, ValidationResult, WorkflowDefinition } from '@agentops/dsh-contracts'
import { compileWorkflow } from '@agentops/dsh-workflow-compiler'
import type { CompileOptions, CompileResult } from '@agentops/dsh-workflow-compiler'

/** One listed workflow, cheap enough to render in a list. */
export interface CatalogEntry {
  readonly workflowId: string
  readonly version: number
  readonly businessId?: string
  readonly nodeCount: number
  /** SHA-256 of the file bytes; the token `save()` compares against. */
  readonly digest: string
}

/** Exact source text and digest for a workflow file, without parsing it. */
export interface WorkflowSource {
  readonly text: string
  readonly digest: string
}

/** A validated workflow definition together with its generated preview. */
export interface CompiledValidationResult {
  readonly ok: true
  readonly value: WorkflowDefinition
  readonly issues: readonly ValidationIssue[]
  readonly compiled: CompileResult
}

/** A rejected workflow candidate with no generated preview. */
export type CompiledValidationFailure = Extract<
  ValidationResult<WorkflowDefinition>,
  { readonly ok: false }
>

/** A workflow that failed to parse, kept visible instead of dropped. */
export interface CatalogIssue {
  readonly file: string
  readonly issues: readonly ValidationIssue[]
}

/** Listing result: valid entries plus every file that could not be read. */
export interface CatalogListing {
  readonly entries: readonly CatalogEntry[]
  readonly issues: readonly CatalogIssue[]
}

/** Raised when a save would overwrite a definition the caller never saw. */
export class CatalogConflictError extends Error {
  /** Digest the caller's edit was based on. */
  readonly expected: string
  /** Digest currently stored on disk. */
  readonly actual: string

  /**
   * @param workflowId - the definition being saved.
   * @param expected - digest the caller based its edit on.
   * @param actual - digest currently on disk.
   */
  constructor(workflowId: string, expected: string, actual: string) {
    super(`工作流 ${workflowId} 已被修改：期望 ${expected.slice(0, 12)}，实际 ${actual.slice(0, 12)}`)
    this.name = 'CatalogConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** Raised when an exclusive create finds an existing workflow file. */
export class CatalogCreateConflictError extends Error {
  /** Identity of the workflow file that already exists. */
  readonly workflowId: string

  /** @param workflowId - definition identity already present on disk. */
  constructor(workflowId: string) {
    super(`工作流 ${workflowId} 已存在`)
    this.name = 'CatalogCreateConflictError'
    this.workflowId = workflowId
  }
}

/** Raised when the incoming definition does not parse. */
export class CatalogInvalidError extends Error {
  /** Every problem the parser reported. */
  readonly issues: readonly ValidationIssue[]

  /**
   * @param workflowId - the definition being saved.
   * @param issues - every problem the parser reported.
   */
  constructor(workflowId: string, issues: readonly ValidationIssue[]) {
    super(`工作流 ${workflowId} 无法保存：${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'CatalogInvalidError'
    this.issues = issues
  }
}

/**
 * Digest of one YAML document's bytes.
 * @param text - the exact YAML document text to hash.
 * @returns the SHA-256 digest of the document bytes.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function assertWorkflowId(workflowId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId)) {
    throw new RangeError(`workflowId 只允许字母、数字、下划线与连字符：${JSON.stringify(workflowId)}`)
  }
}

function fileNameOf(workflowId: string): string {
  return `${workflowId}.yaml`
}

/**
 * Read, validate, compile, and atomically save workflow definitions under one
 * directory.
 */
export class WorkflowCatalog {
  readonly #dir: string

  /**
   * @param directory - directory holding `<workflowId>.yaml` files.
   */
  constructor(directory: string) {
    this.#dir = directory
  }

  /** Directory this catalogue owns. */
  get directory(): string {
    return this.#dir
  }

  /**
   * List every definition, keeping unreadable files visible as issues.
   * @returns valid entries sorted by id, plus one issue group per bad file.
   */
  async list(): Promise<CatalogListing> {
    let files: string[]
    try {
      files = (await readdir(this.#dir)).filter(name => name.endsWith('.yaml')).sort()
    } catch (reason) {
      if ((reason as { code?: string }).code === 'ENOENT') return { entries: [], issues: [] }
      throw reason
    }

    const entries: CatalogEntry[] = []
    const issues: CatalogIssue[] = []
    for (const file of files) {
      const text = await readFile(join(this.#dir, file), 'utf8')
      const parsed = loadWorkflowDefinition(text)
      if (!parsed.ok) {
        issues.push({ file, issues: parsed.issues })
        continue
      }
      entries.push({
        workflowId: parsed.value.workflowId,
        version: parsed.value.version,
        ...(parsed.value.businessId === undefined ? {} : { businessId: parsed.value.businessId }),
        nodeCount: parsed.value.nodes.length,
        digest: digestOf(text),
      })
    }
    return { entries, issues }
  }

  /**
   * Read one workflow file without parsing or rewriting it.
   *
   * The editor needs the exact source and digest even while the YAML is
   * temporarily invalid, so a malformed draft can be repaired and saved.
   * @param workflowId - definition identity.
   * @returns exact file text and its SHA-256 digest.
   * @throws {RangeError} when the id is not a legal file stem.
   */
  async readSource(workflowId: string): Promise<WorkflowSource> {
    assertWorkflowId(workflowId)
    const text = await readFile(join(this.#dir, fileNameOf(workflowId)), 'utf8')
    return { text, digest: digestOf(text) }
  }

  /**
   * Read one definition with the exact text it was parsed from.
   * @param workflowId - definition identity.
   * @returns the text, the parsed definition, and the current digest.
   * @throws {CatalogInvalidError} when the file does not parse.
   * @throws {RangeError} when the id is not a legal file stem.
   */
  async read(workflowId: string): Promise<{ text: string; definition: WorkflowDefinition; digest: string }> {
    assertWorkflowId(workflowId)
    const text = await readFile(join(this.#dir, fileNameOf(workflowId)), 'utf8')
    const parsed = loadWorkflowDefinition(text)
    if (!parsed.ok) throw new CatalogInvalidError(workflowId, parsed.issues)
    return { text, definition: parsed.value, digest: digestOf(text) }
  }

  /**
   * Compile one definition, mirroring what the runtime would evaluate.
   * @param workflowId - definition identity.
   * @param options - model hint passed to the compiler.
   * @returns the compiled artifact or structured blockers.
   */
  async compile(workflowId: string, options: CompileOptions = {}): Promise<CompileResult> {
    const { definition } = await this.read(workflowId)
    return this.compileDefinition(definition, options)
  }

  /**
   * Validate one text without touching the directory.
   * @param text - candidate YAML.
   * @returns the parsed definition, or every issue found.
   */
  validate(text: string): ReturnType<typeof loadWorkflowDefinition> {
    return loadWorkflowDefinition(text)
  }

  /**
   * Validate one text and compile the definition it produced.
   *
   * The text is parsed exactly once so the preview always describes the same
   * definition that supplied the validation result.
   * @param text - candidate YAML.
   * @returns the parsed definition and generated preview, or only validation issues.
   */
  validateAndCompile(text: string): CompiledValidationResult | CompiledValidationFailure {
    const parsed = loadWorkflowDefinition(text)
    if (!parsed.ok) return parsed
    return {
      ok: true,
      value: parsed.value,
      issues: parsed.issues,
      compiled: this.compileDefinition(parsed.value),
    }
  }

  /**
   * Compile an already validated definition.
   * @param definition - validated workflow definition.
   * @param options - model hint passed to the compiler.
   * @returns the compiled artifact or structured blockers.
   */
  compileDefinition(definition: WorkflowDefinition, options: CompileOptions = {}): CompileResult {
    return compileWorkflow(definition, options)
  }

  /**
   * Create a new workflow without ever replacing an existing file.
   * @param workflowId - definition identity; must match the file stem.
   * @param text - complete YAML document.
   * @returns the digest written.
   * @throws {CatalogInvalidError} when the text does not parse or names another workflow.
   * @throws {CatalogCreateConflictError} when the target already exists.
   */
  async create(workflowId: string, text: string): Promise<{ digest: string }> {
    assertWorkflowId(workflowId)
    const parsed = loadWorkflowDefinition(text)
    if (!parsed.ok) throw new CatalogInvalidError(workflowId, parsed.issues)
    if (parsed.value.workflowId !== workflowId) {
      throw new CatalogInvalidError(workflowId, [
        { path: 'workflow_id', message: `文件 ${fileNameOf(workflowId)} 内的 workflow_id 是 ${parsed.value.workflowId}` },
      ])
    }

    await mkdir(this.#dir, { recursive: true })
    const target = join(this.#dir, fileNameOf(workflowId))
    try {
      await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
    } catch (reason) {
      if ((reason as { code?: string }).code === 'EEXIST') {
        throw new CatalogCreateConflictError(workflowId)
      }
      throw reason
    }
    return { digest: digestOf(text) }
  }

  /**
   * Write a definition atomically, refusing to overwrite unseen changes.
   *
   * @param workflowId - definition identity; must match the file stem.
   * @param text - complete YAML document.
   * @param expectedDigest - digest the caller based its edit on, or null to create.
   * @returns the digest written.
   * @throws {CatalogInvalidError} when the text does not parse or names another workflow.
   * @throws {CatalogConflictError} when the file changed since `expectedDigest`.
   */
  async save(workflowId: string, text: string, expectedDigest: string | null): Promise<{ digest: string }> {
    assertWorkflowId(workflowId)
    const parsed = loadWorkflowDefinition(text)
    if (!parsed.ok) throw new CatalogInvalidError(workflowId, parsed.issues)
    if (parsed.value.workflowId !== workflowId) {
      throw new CatalogInvalidError(workflowId, [
        { path: 'workflow_id', message: `文件 ${fileNameOf(workflowId)} 内的 workflow_id 是 ${parsed.value.workflowId}` },
      ])
    }

    const target = join(this.#dir, fileNameOf(workflowId))
    const current = await readFile(target, 'utf8').catch((reason: unknown) => {
      if ((reason as { code?: string }).code === 'ENOENT') return null
      throw reason
    })

    if (current === null) {
      if (expectedDigest !== null) throw new CatalogConflictError(workflowId, expectedDigest, '(缺失)')
    } else {
      const actual = digestOf(current)
      if (expectedDigest === null) throw new CatalogConflictError(workflowId, '(新建)', actual)
      if (actual !== expectedDigest) throw new CatalogConflictError(workflowId, expectedDigest, actual)
    }

    await mkdir(this.#dir, { recursive: true })
    const staging = `${target}.${process.pid}.tmp`
    try {
      await writeFile(staging, text, 'utf8')
      await rename(staging, target)
    } catch (reason) {
      await rm(staging, { force: true })
      throw reason
    }
    return { digest: digestOf(text) }
  }

  /**
   * Delete one workflow file without removing its directory.
   * @param workflowId - definition identity.
   * @throws {RangeError} when the id is not a legal file stem.
   * @throws when the target does not exist; `ENOENT` is preserved for the route.
   */
  async remove(workflowId: string): Promise<void> {
    assertWorkflowId(workflowId)
    await rm(join(this.#dir, fileNameOf(workflowId)))
  }
}
