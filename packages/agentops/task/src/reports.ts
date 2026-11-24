/**
 * Report rendering and export.
 *
 * Rendering is pure: `renderReport` turns one row into bytes for `md`, `html`
 * or `json`. Export adds the file mechanics the design requires: a path built
 * only from validated ids, a temp file in the destination directory, a backup of
 * any previous file, a SHA-256 read back from disk, and one history row per
 * successful write. A failed history insert restores the previous file.
 *
 * @module @agentops/dsh-task/reports
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type { DatabaseSync } from 'node:sqlite'

/** Supported export formats. */
export type ExportFormat = 'md' | 'html' | 'json'

/** One report plus the task fields its export needs. */
export interface ReportExportInput {
  readonly reportId: string
  readonly taskId: string
  readonly identifier: string | null
  readonly title: string
  readonly status: string
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly content: string
  readonly artifactIds: readonly string[] | null
  readonly acceptanceSelfCheck: Record<string, unknown> | null
  readonly version: number
  readonly submittedAt: string
  readonly exportedAt: string
}

/** One rendered file. */
export interface RenderedReport {
  readonly format: ExportFormat
  readonly extension: string
  readonly contentType: string
  readonly bytes: Buffer
}

/** Result of writing or verifying one export. */
export interface ExportResult {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly exportedAt: string
  readonly verified: boolean
  readonly matches: boolean
}

const FORMATS: Readonly<Record<ExportFormat, { extension: string; contentType: string }>> = {
  md: { extension: 'md', contentType: 'text/markdown; charset=utf-8' },
  html: { extension: 'html', contentType: 'text/html; charset=utf-8' },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8' },
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/**
 * Escape text for HTML output.
 * @param text - raw text.
 * @returns the escaped text.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render one report.
 * @param format - output format.
 * @param input - report and task fields.
 * @returns the rendered bytes and metadata.
 */
export function renderReport(format: ExportFormat, input: ReportExportInput): RenderedReport {
  const meta = FORMATS[format]
  const artifactList = input.artifactIds === null || input.artifactIds.length === 0
    ? '- none'
    : input.artifactIds.map(id => `- ${id}`).join('\n')
  const selfCheck = input.acceptanceSelfCheck === null
    ? '- none'
    : Object.entries(input.acceptanceSelfCheck).map(([key, value]) => `- ${key}: ${String(value)}`).join('\n')

  if (format === 'md') {
    const text = [
      `# ${input.title}`,
      '',
      `- Task: ${input.identifier ?? input.taskId}`,
      `- Report: ${input.reportId}`,
      `- Status: ${input.status}`,
      `- Agent: ${input.agentId ?? 'unknown'}`,
      `- Submitted: ${input.submittedAt}`,
      `- Version: ${input.version}`,
      '',
      '## Report',
      '',
      input.content,
      '',
      '## Artifacts',
      '',
      artifactList,
      '',
      '## Acceptance self-check',
      '',
      selfCheck,
      '',
    ].join('\n')
    return { format, extension: meta.extension, contentType: meta.contentType, bytes: Buffer.from(text, 'utf8') }
  }

  if (format === 'json') {
    const payload = {
      report_id: input.reportId,
      task_id: input.taskId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      agent_id: input.agentId,
      session_id: input.sessionId,
      content: input.content,
      artifact_ids: input.artifactIds ?? [],
      acceptance_self_check: input.acceptanceSelfCheck,
      version: input.version,
      submitted_at: input.submittedAt,
      exported_at: input.exportedAt,
    }
    return {
      format,
      extension: meta.extension,
      contentType: meta.contentType,
      bytes: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    }
  }

  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    '<style>body{font:14px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}'
      + 'pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:6px}'
      + 'dt{font-weight:600}dd{margin:0 0 .4rem}</style>',
    '</head><body>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    '<dl>',
    `<dt>Task</dt><dd>${escapeHtml(input.identifier ?? input.taskId)}</dd>`,
    `<dt>Report</dt><dd>${escapeHtml(input.reportId)}</dd>`,
    `<dt>Status</dt><dd>${escapeHtml(input.status)}</dd>`,
    `<dt>Agent</dt><dd>${escapeHtml(input.agentId ?? 'unknown')}</dd>`,
    `<dt>Submitted</dt><dd>${escapeHtml(input.submittedAt)}</dd>`,
    '</dl>',
    `<h2>Report</h2><pre>${escapeHtml(input.content)}</pre>`,
    `<h2>Artifacts</h2><pre>${escapeHtml(artifactList)}</pre>`,
    `<h2>Acceptance self-check</h2><pre>${escapeHtml(selfCheck)}</pre>`,
    '</body></html>',
    '',
  ].join('\n')
  return { format, extension: meta.extension, contentType: meta.contentType, bytes: Buffer.from(html, 'utf8') }
}

/** Joined report and task row used by the loader. */
interface ReportJoinRow {
  report_id: string
  task_id: string
  agent_id: string | null
  session_id: string | null
  content: string
  artifact_ids: string | null
  acceptance_self_check: string | null
  status: string
  version: number
  submitted_at: string
  task_title: string
  task_identifier: string | null
}

/**
 * Load one report and its task for export.
 * @param db - open handle.
 * @param taskId - owning task.
 * @param reportId - report to export.
 * @returns the export input, or undefined when the report does not belong to the task.
 */
export function loadReportForExport(db: DatabaseSync, taskId: string, reportId: string): ReportExportInput | undefined {
  const row = db
    .prepare(
      `SELECT r.*, t.title AS task_title, t.identifier AS task_identifier
       FROM task_reports r JOIN tasks t ON t.task_id = r.task_id
       WHERE r.report_id = ? AND r.task_id = ?`,
    )
    .get(reportId, taskId) as ReportJoinRow | undefined
  if (row === undefined) return undefined
  return {
    reportId: row.report_id,
    taskId: row.task_id,
    identifier: row.task_identifier,
    title: row.task_title,
    status: row.status,
    agentId: row.agent_id,
    sessionId: row.session_id,
    content: row.content,
    artifactIds: row.artifact_ids === null ? null : (JSON.parse(row.artifact_ids) as string[]),
    acceptanceSelfCheck: row.acceptance_self_check === null
      ? null
      : (JSON.parse(row.acceptance_self_check) as Record<string, unknown>),
    version: row.version,
    submittedAt: row.submitted_at,
    exportedAt: new Date().toISOString(),
  }
}

/**
 * Build the export path, rejecting ids that could escape the export root.
 * @param rootDir - workspace root.
 * @param taskId - task id.
 * @param reportId - report id.
 * @param extension - file extension.
 * @returns the absolute path.
 */
export function exportPath(rootDir: string, taskId: string, reportId: string, extension: string): string {
  if (!SAFE_ID.test(taskId) || !SAFE_ID.test(reportId) || !SAFE_ID.test(extension)) {
    throw new Error(`unsafe export id: ${JSON.stringify({ taskId, reportId, extension })}`)
  }
  const root = resolve(rootDir, 'task_exports')
  const target = resolve(root, taskId, `${reportId}.${extension}`)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('export path escapes task_exports')
  return target
}

/** One Markdown report document written into the workspace. */
export interface ReportDocument {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly artifactId: string
  readonly exportedAt: string
}

/**
 * Write one report as a Markdown document and register it as a task artifact.
 *
 * The document is the deliverable: it lives under `<rootDir>/reports/<taskId>/`
 * and is recorded in `task_artifacts` plus the export history. No download route
 * is involved, which is what the RPC-mounted surface needs.
 * @param db - open handle.
 * @param options - workspace root, task and report identity.
 * @returns the written document metadata.
 */
export function exportReportDocument(
  db: DatabaseSync,
  options: { rootDir: string; taskId: string; reportId: string },
): ReportDocument {
  const input = loadReportForExport(db, options.taskId, options.reportId)
  if (input === undefined) throw new Error('report_not_found')
  const rendered = renderReport('md', input)
  const directory = join(options.rootDir, 'reports', options.taskId)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${options.reportId}.md`)
  const tempPath = `${path}.tmp-${process.pid}`
  writeFileSync(tempPath, rendered.bytes)
  renameSync(tempPath, path)
  const sha256 = createHash('sha256').update(rendered.bytes).digest('hex')
  const artifactId = `art_${sha256.slice(0, 12)}`
  try {
    db.prepare(
      `INSERT OR REPLACE INTO task_artifacts(artifact_id, task_id, type, path, content_hash, description, version, created_at)
       VALUES (?, ?, 'report', ?, ?, ?, 0, ?)`,
    ).run(artifactId, options.taskId, path, sha256, `报告文档 ${options.reportId}`, input.exportedAt)
    db.prepare(
      `INSERT INTO task_report_exports(export_id, report_id, task_id, format, path, sha256, size_bytes, exported_at)
       VALUES (?, ?, ?, 'md', ?, ?, ?, ?)`,
    ).run(
      `exp_${sha256.slice(0, 12)}_${Date.now().toString(36)}`,
      options.reportId,
      options.taskId,
      path,
      sha256,
      rendered.bytes.byteLength,
      input.exportedAt,
    )
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return { path, sha256, sizeBytes: rendered.bytes.byteLength, artifactId, exportedAt: input.exportedAt }
}

/**
 * Read a Markdown report document.
 * @param path - document path.
 * @returns the document text, or undefined when the file is gone.
 */
export function readReportDocument(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Write one export with a temp file, backup, digest read-back and history row.
 * @param db - open handle.
 * @param options - root directory, report identity and format.
 * @returns the written file metadata.
 */
export function writeExport(
  db: DatabaseSync,
  options: { rootDir: string; taskId: string; reportId: string; format: ExportFormat },
): ExportResult {
  const input = loadReportForExport(db, options.taskId, options.reportId)
  if (input === undefined) throw new Error('report_not_found')
  const rendered = renderReport(options.format, input)
  const path = exportPath(options.rootDir, options.taskId, options.reportId, rendered.extension)
  mkdirSync(join(path, '..'), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}`
  writeFileSync(tempPath, rendered.bytes)
  const backupPath = existsSync(path) ? `${path}.bak-${process.pid}` : undefined
  if (backupPath !== undefined) copyFileSync(path, backupPath)
  try {
    renameSync(tempPath, path)
    const disk = readFileSync(path)
    const sha256 = createHash('sha256').update(disk).digest('hex')
    db.prepare(
      `INSERT INTO task_report_exports(export_id, report_id, task_id, format, path, sha256, size_bytes, exported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `exp_${sha256.slice(0, 12)}_${Date.now().toString(36)}`,
      options.reportId,
      options.taskId,
      options.format,
      path,
      sha256,
      disk.byteLength,
      input.exportedAt,
    )
    if (backupPath !== undefined) rmSync(backupPath, { force: true })
    return { path, sha256, sizeBytes: disk.byteLength, exportedAt: input.exportedAt, verified: false, matches: true }
  } catch (error) {
    rmSync(tempPath, { force: true })
    if (backupPath !== undefined && existsSync(backupPath)) {
      renameSync(backupPath, path)
    } else {
      rmSync(path, { force: true })
    }
    throw error
  }
}

/**
 * Verify an existing export against its newest history row without writing.
 * @param db - open handle.
 * @param taskId - task id.
 * @param reportId - report id.
 * @returns existence and digest comparison.
 */
export function verifyExport(
  db: DatabaseSync,
  taskId: string,
  reportId: string,
): { exists: boolean; matches: boolean; path: string | null; sha256: string | null } {
  const row = db
    .prepare(
      `SELECT path, sha256 FROM task_report_exports
       WHERE task_id = ? AND report_id = ? ORDER BY exported_at DESC LIMIT 1`,
    )
    .get(taskId, reportId) as { path: string; sha256: string } | undefined
  if (row === undefined) return { exists: false, matches: false, path: null, sha256: null }
  if (!existsSync(row.path)) return { exists: false, matches: false, path: row.path, sha256: row.sha256 }
  const actual = createHash('sha256').update(readFileSync(row.path)).digest('hex')
  return { exists: true, matches: actual === row.sha256, path: row.path, sha256: actual }
}

/**
 * List export history for one report.
 * @param db - open handle.
 * @param taskId - task id.
 * @param reportId - report id.
 * @returns history rows newest first, with on-disk status.
 */
export function listExports(db: DatabaseSync, taskId: string, reportId: string): unknown[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_report_exports
       WHERE task_id = ? AND report_id = ? ORDER BY exported_at DESC`,
    )
    .all(taskId, reportId) as { path: string; sha256: string }[]
  return rows.map((row) => {
    const exists = existsSync(row.path)
    const matches = exists
      && createHash('sha256').update(readFileSync(row.path)).digest('hex') === row.sha256
    return { ...row, exists, matches, size_on_disk: exists ? statSync(row.path).size : null }
  })
}
