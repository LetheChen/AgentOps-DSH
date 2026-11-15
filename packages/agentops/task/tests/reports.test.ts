/**
 * Report export tests: rendering, path safety, atomic write with history and
 * the three export routes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TaskHttpApi } from '../src/http.ts'
import { exportPath, renderReport, verifyExport, writeExport } from '../src/reports.ts'
import type { ReportExportInput } from '../src/reports.ts'
import { createTaskSchema } from '../src/schema.ts'
import { TaskService } from '../src/service.ts'
import { createAdmittedTask } from './admission-fixture.ts'

const NOW = '2026-11-07T00:00:00Z'

const INPUT: ReportExportInput = {
  reportId: 'rep_1',
  taskId: 'task_1',
  identifier: 'T-1',
  title: '修复导出按钮',
  status: 'submitted',
  agentId: 'coding_agent',
  sessionId: 'sess_1',
  content: '已修复 <script>alert(1)</script>',
  artifactIds: ['art_1'],
  acceptanceSelfCheck: { passed: true },
  version: 0,
  submittedAt: NOW,
  exportedAt: NOW,
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'task-reports-'))
}

function seeded(): { db: DatabaseSync; service: TaskService; taskId: string; reportId: string; root: string } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  service.createProject({ name: '订单后台', projectId: 'p1' })
  const task = createAdmittedTask(service, { projectId: 'p1', title: '修复导出按钮', status: 'in_progress' })
  const report = service.submitReport({
    taskId: task.taskId,
    content: '已修复 <script>alert(1)</script>',
    ifVersion: service.getTask(task.taskId).task.version,
    actor: { type: 'agent', name: 'coding_agent' },
  })
  return { db, service, taskId: task.taskId, reportId: report.reportId, root: workspace() }
}

void test('渲染：md 含正文，html 转义标签，json 字段稳定', () => {
  const md = renderReport('md', INPUT)
  assert.match(md.bytes.toString('utf8'), /# 修复导出按钮/)
  assert.match(md.bytes.toString('utf8'), /art_1/)
  const html = renderReport('html', INPUT)
  const text = html.bytes.toString('utf8')
  assert.ok(!text.includes('<script>'))
  assert.match(text, /&lt;script&gt;/)
  const json = JSON.parse(renderReport('json', INPUT).bytes.toString('utf8')) as Record<string, unknown>
  assert.equal(json.report_id, 'rep_1')
  assert.deepEqual(json.artifact_ids, ['art_1'])
})

void test('导出路径拒绝穿越与不安全 id', () => {
  const root = workspace()
  assert.throws(() => exportPath(root, '..', 'rep_1', 'md'), /unsafe export id/)
  assert.throws(() => exportPath(root, 'task_1', 'a/b', 'md'), /unsafe export id/)
  assert.equal(exportPath(root, 'task_1', 'rep_1', 'md'), join(root, 'task_exports', 'task_1', 'rep_1.md'))
  rmSync(root, { recursive: true, force: true })
})

void test('写出：文件、摘要、历史；重复导出累积历史；篡改后校验失败', () => {
  const { db, taskId, reportId, root } = seeded()
  const first = writeExport(db, { rootDir: root, taskId, reportId, format: 'md' })
  assert.ok(existsSync(first.path))
  assert.equal(readFileSync(first.path).byteLength, first.sizeBytes)
  assert.equal(verifyExport(db, taskId, reportId).matches, true)

  const second = writeExport(db, { rootDir: root, taskId, reportId, format: 'md' })
  assert.equal(second.path, first.path)
  const history = db.prepare('SELECT COUNT(*) AS n FROM task_report_exports').get() as { n: number }
  assert.equal(history.n, 2)

  writeFileSync(first.path, 'tampered')
  assert.equal(verifyExport(db, taskId, reportId).matches, false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

void test('路由：导出、校验与历史；未配置导出目录返回 503', () => {
  const h = seeded()
  const api = new TaskHttpApi(h.service, h.db, { exportRootDir: h.root })
  const call = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) =>
    api.handle({ method, path, body, query, actor: { type: 'user', name: 'pm' } })

  const exported = call('POST', `/api/agentops/tasks/${h.taskId}/reports/${h.reportId}/export`, {
    format: 'md',
    if_version: 0,
  })
  assert.equal(exported.status, 200)
  const result = (exported.body as { export: { path: string; sha256: string } }).export
  assert.ok(existsSync(result.path))

  const document = call('GET', `/api/agentops/tasks/${h.taskId}/reports/${h.reportId}/export`)
  assert.equal(document.status, 200)
  const payload = (document.body as { export: { content: string; matches: boolean } }).export
  assert.match(payload.content, /# 修复导出按钮/)
  assert.equal(payload.matches, true)

  const artifacts = h.db.prepare("SELECT COUNT(*) AS n FROM task_artifacts WHERE type = 'report'").get() as { n: number }
  assert.equal(artifacts.n, 1)

  const history = call('GET', `/api/agentops/tasks/${h.taskId}/reports/${h.reportId}/exports`)
  assert.equal((history.body as { exports: unknown[] }).exports.length, 1)

  const noExporter = new TaskHttpApi(h.service, h.db)
  const unavailable = noExporter.handle({
    method: 'POST',
    path: `/api/agentops/tasks/${h.taskId}/reports/${h.reportId}/export`,
    body: { format: 'md' },
    query: {},
    actor: { type: 'user', name: 'pm' },
  })
  assert.equal(unavailable.status, 503)
  assert.equal((unavailable.body as { error: { code: string } }).error.code, 'exporter_unavailable')

  h.db.close()
  rmSync(h.root, { recursive: true, force: true })
})
