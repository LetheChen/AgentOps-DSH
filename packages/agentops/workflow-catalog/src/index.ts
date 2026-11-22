/**
 * The `workflowCatalog` service: workflow definitions under one directory.
 *
 * Consumers inject `ctx.workflowCatalog`. The definition text stays in YAML on
 * disk; this service is the only writer, and every write is compare-and-swap
 * on the file digest.
 *
 * @module @agentops/dsh-workflow-catalog
 */

import { Context, Service } from '@deepseek-ai/cordis'

import {
  WorkflowCatalog,
  CatalogConflictError,
  CatalogCreateConflictError,
  CatalogInvalidError,
  digestOf,
} from './catalog.js'
import type {
  CatalogEntry,
  CatalogIssue,
  CatalogListing,
  CompiledValidationFailure,
  CompiledValidationResult,
  WorkflowSource,
} from './catalog.js'
import type { ValidationResult, WorkflowDefinition } from '@agentops/dsh-contracts'
import type { CompileOptions, CompileResult } from '@agentops/dsh-workflow-compiler'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowCatalog: WorkflowCatalogService
  }
}

/** Deployment configuration for the catalogue. */
export interface WorkflowCatalogConfig {
  /** Directory holding `<workflowId>.yaml` files. */
  readonly directory: string
}

/**
 * Build the catalogue for one service instance.
 *
 * The service is reached through Cordis' proxy, so `this` inside a method is the
 * proxy rather than the instance: private fields and private methods would throw
 * "did not declare it". State therefore lives in a public property that the
 * proxy forwards, and the catalogue object is rebuilt per call.
 * @param service - the service instance or its proxy.
 * @returns a catalogue bound to the configured directory.
 */
function catalogOf(service: WorkflowCatalogService): WorkflowCatalog {
  return new WorkflowCatalog(service.directory)
}

/** Workflow definitions: list, read, validate, compile, and save. */
export class WorkflowCatalogService extends Service {
  /** Directory holding `<workflowId>.yaml` files. */
  readonly directory: string

  /**
   * @param ctx - Cordis context.
   * @param config - directory holding the definition files.
   */
  constructor(ctx: Context, config: WorkflowCatalogConfig) {
    super(ctx, 'workflowCatalog')
    if (typeof config.directory !== 'string' || config.directory.trim() === '') {
      throw new TypeError('workflowCatalog 需要非空的 directory 配置')
    }
    this.directory = config.directory
  }

  /**
   * List every stored definition.
   * @returns every valid definition plus one issue group per unreadable file.
   */
  list(): Promise<CatalogListing> {
    return catalogOf(this).list()
  }

  /**
   * Read one definition's raw source.
   * @param workflowId - definition identity.
   * @returns exact file text and its SHA-256 digest, even when YAML is invalid.
   */
  readSource(workflowId: string): Promise<WorkflowSource> {
    return catalogOf(this).readSource(workflowId)
  }

  /**
   * Read one definition with its parsed form.
   * @param workflowId - definition identity.
   * @returns text, parsed definition, and digest.
   */
  read(workflowId: string): Promise<{ text: string; definition: WorkflowDefinition; digest: string }> {
    return catalogOf(this).read(workflowId)
  }

  /**
   * Compile one stored definition.
   * @param workflowId - definition identity.
   * @param options - model hint for the compiler.
   * @returns the compiled artifact or structured blockers.
   */
  compile(workflowId: string, options: CompileOptions = {}): Promise<CompileResult> {
    return catalogOf(this).compile(workflowId, options)
  }

  /**
   * Validate candidate YAML without storing it.
   * @param text - candidate YAML.
   * @returns the parsed definition, or every issue found.
   */
  validate(text: string): ValidationResult<WorkflowDefinition> {
    return catalogOf(this).validate(text)
  }

  /**
   * Validate candidate YAML and compile it when it is valid.
   * @param text - candidate YAML.
   * @returns the parsed definition and generated preview, or only validation issues.
   */
  validateAndCompile(text: string): CompiledValidationResult | CompiledValidationFailure {
    return catalogOf(this).validateAndCompile(text)
  }

  /**
   * Store a new definition, refusing to overwrite an existing one.
   * @param workflowId - definition identity.
   * @param text - complete YAML document.
   * @returns the digest written.
   */
  create(workflowId: string, text: string): Promise<{ digest: string }> {
    return catalogOf(this).create(workflowId, text)
  }

  /**
   * Compile an already parsed definition.
   * @param definition - validated workflow definition.
   * @param options - model hint for the compiler.
   * @returns the compiled artifact or structured blockers.
   */
  compileDefinition(definition: WorkflowDefinition, options: CompileOptions = {}): CompileResult {
    return catalogOf(this).compileDefinition(definition, options)
  }

  /**
   * Overwrite a definition, refusing a stale edit.
   * @param workflowId - definition identity.
   * @param text - complete YAML document.
   * @param expectedDigest - digest the edit was based on, or null to create.
   * @returns the digest written.
   */
  save(workflowId: string, text: string, expectedDigest: string | null): Promise<{ digest: string }> {
    return catalogOf(this).save(workflowId, text, expectedDigest)
  }

  /**
   * Delete one stored definition.
   * @param workflowId - definition identity.
   */
  remove(workflowId: string): Promise<void> {
    return catalogOf(this).remove(workflowId)
  }
}

export {
  WorkflowCatalog,
  CatalogConflictError,
  CatalogCreateConflictError,
  CatalogInvalidError,
  digestOf,
}
export type {
  CatalogEntry,
  CatalogIssue,
  CatalogListing,
  CompiledValidationFailure,
  CompiledValidationResult,
  WorkflowSource,
}
export default WorkflowCatalogService
