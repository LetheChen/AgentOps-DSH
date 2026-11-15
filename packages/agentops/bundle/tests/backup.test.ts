import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { backupDatabases, backupFolderName, listBackups, restoreBackup } from '../src/backup.ts'

function seed(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const tasks = new DatabaseSync(join(dir, 'tasks.db'))
  tasks.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT);')
  tasks.prepare('INSERT INTO tasks(id, title) VALUES (?, ?)').run('t1', '备份测试')
  tasks.close()

  const knowledge = new DatabaseSync(join(dir, 'knowledge.db'))
  knowledge.exec('CREATE TABLE docs(id TEXT PRIMARY KEY);')
  knowledge.prepare('INSERT INTO docs(id) VALUES (?)').run('d1')
  knowledge.close()
}

test('backup：快照两个库并写入 manifest，缺失的库记为 skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-backup-'))
  try {
    const data = join(root, 'data')
    seed(data)
    const out = join(root, 'backup-1')

    const manifest = backupDatabases(data, out)
    assert.deepEqual(manifest.files.map(file => file.name).sort(), ['knowledge.db', 'tasks.db'])
    assert.deepEqual(manifest.skipped, ['runs.db'])
    assert.ok(manifest.files.every(file => file.bytes > 0 && file.sha256.length === 64))

    const written = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as typeof manifest
    assert.equal(written.files.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore：哈希一致才恢复，数据可读', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-restore-'))
  try {
    const data = join(root, 'data')
    seed(data)
    const backup = join(root, 'backup')
    backupDatabases(data, backup)

    const target = join(root, 'restored')
    const result = restoreBackup(backup, target)
    assert.deepEqual(result.rejected, [])
    assert.deepEqual(result.restored.sort(), ['knowledge.db', 'tasks.db'])

    const db = new DatabaseSync(join(target, 'tasks.db'))
    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string }
    assert.equal(row.title, '备份测试')
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore：覆盖前先给现状做安全快照，可回退', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-safety-'))
  try {
    const data = join(root, 'data')
    seed(data)
    const backup = join(root, 'backup')
    backupDatabases(data, backup)

    // 现状改成与备份不同的内容
    const live = new DatabaseSync(join(data, 'tasks.db'))
    live.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('被改坏的标题', 't1')
    live.close()

    const result = restoreBackup(backup, data)
    assert.ok(result.safetyBackup !== undefined, '应生成安全快照')

    const safety = new DatabaseSync(join(result.safetyBackup, 'tasks.db'))
    const before = safety.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string }
    assert.equal(before.title, '被改坏的标题', '安全快照必须保留恢复前的内容')
    safety.close()

    const after = new DatabaseSync(join(data, 'tasks.db'))
    const restored = after.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string }
    assert.equal(restored.title, '备份测试', '恢复后应回到备份内容')
    after.close()

    const skipped = restoreBackup(backup, data, { skipSafetyBackup: true })
    assert.equal(skipped.safetyBackup, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore：目标为空时不生成安全快照', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-nosafety-'))
  try {
    const data = join(root, 'data')
    seed(data)
    const backup = join(root, 'backup')
    backupDatabases(data, backup)
    const empty = join(root, 'empty')
    const result = restoreBackup(backup, empty)
    assert.equal(result.safetyBackup, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore：被篡改的备份文件被拒绝，不覆盖目标库', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-tamper-'))
  try {
    const data = join(root, 'data')
    seed(data)
    const backup = join(root, 'backup')
    backupDatabases(data, backup)
    writeFileSync(join(backup, 'tasks.db'), 'not a database')

    const target = join(root, 'restored')
    const result = restoreBackup(backup, target)
    assert.deepEqual(result.rejected, ['tasks.db'])
    assert.deepEqual(result.restored, ['knowledge.db'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listBackups：按创建时间倒序，忽略无 manifest 的目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-list-'))
  try {
    const data = join(root, 'data')
    seed(data)
    backupDatabases(data, join(root, 'a'))
    mkdirSync(join(root, 'junk'), { recursive: true })
    const list = listBackups(root)
    assert.equal(list.length, 1)
    assert.equal(list[0]!.name, 'a')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('backupFolderName：冒号与点被替换，可用于 Windows 路径', () => {
  const name = backupFolderName(new Date('2026-10-25T04:30:00.123Z'))
  assert.equal(name, '2026-10-25T04-30-00-123Z')
})
