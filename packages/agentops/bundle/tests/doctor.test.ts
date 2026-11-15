import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { backupDatabases } from '../src/backup.ts'
import { doctor } from '../src/doctor.ts'

test('doctor：健康库通过完整性检查并报告表数', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-doctor-'))
  try {
    const data = join(root, 'data')
    mkdirSync(data, { recursive: true })
    const db = new DatabaseSync(join(data, 'tasks.db'))
    db.exec('CREATE TABLE tasks(id TEXT); CREATE TABLE events(id TEXT);')
    db.close()
    backupDatabases(data, join(data, 'backups', 'b1'), ['tasks.db'])

    const report = doctor(data)
    const tasks = report.databases.find(check => check.name === 'tasks.db')!
    assert.equal(tasks.integrity, 'ok')
    assert.equal(tasks.tables, 2)
    assert.ok(tasks.bytes !== null && tasks.bytes > 0)
    assert.equal(report.backups.count, 1)
    assert.deepEqual(report.problems, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor：损坏文件报告 unreadable/corrupt 并计入问题', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-doctor-bad-'))
  try {
    const data = join(root, 'data')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'knowledge.db'), 'this is not a sqlite database')

    const report = doctor(data)
    const broken = report.databases.find(check => check.name === 'knowledge.db')!
    assert.ok(broken.integrity === 'unreadable' || broken.integrity === 'corrupt')
    assert.ok(report.problems.some(problem => problem.includes('knowledge.db')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor：数据目录不存在、无备份都会被指出', () => {
  const report = doctor(join(tmpdir(), 'agentops-doctor-missing-xyz'))
  assert.ok(report.problems.some(problem => problem.includes('数据目录不存在')))
  assert.ok(report.problems.some(problem => problem.includes('尚无备份')))
  assert.ok(report.databases.every(check => check.integrity === 'missing'))
})

test('doctor：备份过旧会超过阈值报警', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-doctor-old-'))
  try {
    const data = join(root, 'data')
    mkdirSync(data, { recursive: true })
    const db = new DatabaseSync(join(data, 'tasks.db'))
    db.exec('CREATE TABLE t(id TEXT);')
    db.close()

    const old = new Date(Date.now() - 30 * 86_400_000)
    backupDatabases(data, join(data, 'backups', 'old'), ['tasks.db'])
    // 篡改 manifest 时间模拟旧备份
    const manifestPath = join(data, 'backups', 'old', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { createdAt: string }
    manifest.createdAt = old.toISOString()
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const report = doctor(data, 7)
    assert.ok(report.problems.some(problem => problem.includes('超过 7 天阈值')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
