/**
 * Import execution with a durable job record.
 *
 * Planning stays read-only; this module is the only place that actually copies
 * content into a space. Every created document is recorded per job, so a bad
 * batch can be rolled back without guessing which documents it produced.
 */

import { createHash } from 'node:crypto'

import type { ImportPlanEntry } from './import-plan.ts'
import type { KnowledgeService } from './service.ts'
import type { IngestionDocumentRecord, IngestionJobRecord, SqliteKnowledgeRepository } from './sqlite.ts'

/** Text read from one importable file, plus the MIME type that was detected. */
export interface ImportReadResult {
  text: string
  mime?: string
}

/** Reads one file's text; may reject to mark that file as failed. */
export type ImportReader = (path: string) => Promise<ImportReadResult>

/** Parser label and progress reporting for one import run. */
export interface RunImportOptions {
  /** Only `import` entries are read; the rest are recorded as skipped. */
  parser?: string
  onProgress?: (done: number, total: number) => void
}

/**
 * Execute a reviewed import plan.
 *
 * Failures are isolated per file: one unreadable file becomes a `failed` row
 * and the job continues. The returned job is the durable record.
 */
export class ImportRunner {
  constructor(
    private readonly service: KnowledgeService,
    private readonly repository: SqliteKnowledgeRepository,
  ) {}

  /**
   * Run the plan's importable entries.
   * @param plan - reviewed entries.
   * @param reader - reads one file's text; may reject.
   * @param options - parser label and progress hook.
   * @returns the finished job record.
   */
  async execute(
    plan: readonly ImportPlanEntry[],
    reader: ImportReader,
    options: RunImportOptions = {},
  ): Promise<IngestionJobRecord> {
    const jobId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const createdAt = new Date().toISOString()
    const toImport = plan.filter(entry => entry.action === 'import')
    const skipped = plan.length - toImport.length

    const job: IngestionJobRecord = {
      id: jobId,
      status: 'running',
      createdAt,
      total: plan.length,
      imported: 0,
      skipped,
      failed: 0,
    }
    this.repository.createIngestionJob(job)

    let done = 0
    for (const entry of plan) {
      if (entry.action !== 'import') {
        this.repository.recordIngestionDocument(jobId, { path: entry.path, action: entry.action })
        done += 1
        options.onProgress?.(done, plan.length)
        continue
      }

      const documentId = `${jobId}:${done}`
      try {
        if (entry.spaceId === undefined) throw new Error('import plan is missing spaceId')
        const read = await reader(entry.path)
        const hash = entry.contentHash ?? createHash('sha256').update(read.text).digest('hex')
        this.service.addDocument({
          id: documentId,
          spaceId: entry.spaceId,
          title: basename(entry.path),
          mime: read.mime ?? 'text/plain',
          text: read.text,
          contentHash: hash,
          parser: options.parser ?? 'import@1',
          now: new Date().toISOString(),
        })
        this.repository.recordIngestionDocument(jobId, { documentId, path: entry.path, action: 'imported' })
        job.imported += 1
      } catch (error) {
        this.repository.recordIngestionDocument(jobId, {
          path: entry.path,
          action: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        job.failed += 1
      }
      done += 1
      options.onProgress?.(done, plan.length)
    }

    job.status = job.failed > 0 ? (job.imported > 0 ? 'partial' : 'failed') : 'completed'
    job.finishedAt = new Date().toISOString()
    this.repository.finishIngestionJob(job)
    return job
  }

  /**
   * Remove every document this job created. Skipped files are untouched.
   * @param jobId - job to roll back.
   * @returns number of documents removed.
   */
  rollback(jobId: string): number {
    const documents = this.repository.listIngestionDocuments(jobId)
    let removed = 0
    for (const doc of documents) {
      if (doc.action !== 'imported' || doc.documentId === undefined) continue
      if (this.service.deleteDocument(doc.documentId)) removed += 1
    }
    const jobs = this.repository.listIngestionJobs()
    const job = jobs.find(item => item.id === jobId)
    if (job !== undefined) {
      this.repository.finishIngestionJob({
        ...job,
        status: 'rolled-back',
        finishedAt: new Date().toISOString(),
      })
    }
    return removed
  }

  /**
   * List the recorded import jobs, newest first.
   * @returns the stored job records.
   */
  listJobs(): IngestionJobRecord[] {
    return this.repository.listIngestionJobs()
  }

  /**
   * List the files one import job touched.
   * @param jobId - the import job id.
   * @returns the per-file records of that job.
   */
  listJobDocuments(jobId: string): IngestionDocumentRecord[] {
    return this.repository.listIngestionDocuments(jobId)
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}
