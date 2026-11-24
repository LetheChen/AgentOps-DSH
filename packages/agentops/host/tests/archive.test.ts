import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanArchive } from '../src/archive.ts'

void test('scanArchive：目录缺失返回 missing', () => {
  const result = scanArchive(join(tmpdir(), 'agentops-no-archive-xyz'))
  assert.equal(result.missing, true)
  assert.deepEqual(result.entries, [])
})

void test('scanArchive：递归列出文件，路径用正斜杠，按时间倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-archive-'))
  try {
    mkdirSync(join(dir, 'report'), { recursive: true })
    writeFileSync(join(dir, 'report', 'a.md'), 'hello')
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(16))

    const result = scanArchive(dir)
    assert.equal(result.missing, false)
    assert.equal(result.entries.length, 2)
    const byPath = new Map(result.entries.map(entry => [entry.path, entry]))
    assert.ok(byPath.has('report/a.md'))
    assert.equal(byPath.get('report/a.md')!.ext, 'md')
    assert.equal(byPath.get('b.png')!.ext, 'png')
    assert.equal(byPath.get('b.png')!.bytes, 16)
    assert.ok(result.entries[0]!.mtime >= result.entries[1]!.mtime)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('scanArchive：超过上限截断并标记 truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-archive-cap-'))
  try {
    for (let index = 0; index < 5; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'x')
    const result = scanArchive(dir, 2)
    assert.equal(result.entries.length, 2)
    assert.equal(result.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('scanArchive：深度超限不再下钻', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-archive-depth-'))
  try {
    const deep = join(dir, 'a', 'b', 'c', 'd')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'deep.txt'), 'x')
    writeFileSync(join(dir, 'top.txt'), 'x')
    const result = scanArchive(dir, 200, 2)
    assert.deepEqual(result.entries.map(entry => entry.path), ['top.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
