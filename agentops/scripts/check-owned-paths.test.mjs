/**
 * 负向测试：证明分类器不会放行"内容被改的 ENV 路径"，也不会因为清单过期而静默通过。
 * 运行：node --test agentops/scripts/check-owned-paths.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyEntry, classifyEntries, parseRawDiff, DEFAULT_BASE } from './check-owned-paths.mjs'

const UP = 'a'.repeat(40)      // 上游 symlink blob
const LOCAL = 'b'.repeat(40)   // 本地实体化后的 blob
const OTHER = 'c'.repeat(40)

const lists = {
  owned: ['packages/agentops/', 'agentops/'],
  core: ['packages/client/ui-sidebar/'],
  integration: ['tsconfig.client.json', 'tsconfig.host.json', 'pnpm-lock.yaml'],
  env: ['CLAUDE.md', '.claude/skills/', 'scripts/check-expected-filenames.sh'],
  symlinks: new Map([
    ['CLAUDE.md', { upstreamSha: UP, expectedBlob: LOCAL }],
    ['.claude/skills', { upstreamSha: OTHER, expectedBlob: '-' }],
  ]),
}

const entry = (over) => ({
  path: 'CLAUDE.md', status: 'M', oldMode: '120000', newMode: '100644', oldSha: UP, newSha: LOCAL, ...over,
})

test('OWNED 路径 → OWNED', () => {
  assert.equal(classifyEntry(entry({ path: 'packages/agentops/host/src/dsh.ts', status: 'A' }), lists).bucket, 'OWNED')
})

test('已登记 DSH 核心路径 → CORE', () => {
  assert.equal(classifyEntry(entry({ path: 'packages/client/ui-sidebar/src/client/index.ts', status: 'M' }), lists).bucket, 'CORE')
})

test('INTEGRATION 路径 → INTEGRATION', () => {
  assert.equal(classifyEntry(entry({ path: 'tsconfig.host.json' }), lists).bucket, 'INTEGRATION')
})

test('symlink 实体化且与清单一致 → ENV-ARTIFACT', () => {
  assert.equal(classifyEntry(entry({}), lists).bucket, 'ENV-ARTIFACT')
})

test('**symlink 实体化后内容被改 → UNEXPECTED**（门禁核心）', () => {
  const r = classifyEntry(entry({ newSha: OTHER }), lists)
  assert.equal(r.bucket, 'UNEXPECTED')
  assert.match(r.reason, /differs from manifest/)
})

test('清单过期（上游 blob 变了）→ UNEXPECTED', () => {
  const r = classifyEntry(entry({ oldSha: OTHER }), lists)
  assert.equal(r.bucket, 'UNEXPECTED')
  assert.match(r.reason, /manifest stale/)
})

test('symlink 换成真目录（清单记 -）→ 删除算 ENV-ARTIFACT', () => {
  const r = classifyEntry({ path: '.claude/skills', status: 'D', oldMode: '120000', newMode: '000000', oldSha: OTHER, newSha: '0'.repeat(40) }, lists)
  assert.equal(r.bucket, 'ENV-ARTIFACT')
})

test('symlink 换成真目录但状态不对 → UNEXPECTED', () => {
  const r = classifyEntry({ path: '.claude/skills', status: 'M', oldMode: '120000', newMode: '100644', oldSha: OTHER, newSha: OTHER }, lists)
  assert.equal(r.bucket, 'UNEXPECTED')
})

test('可执行位丢失（blob 相同）→ ENV-ARTIFACT', () => {
  const r = classifyEntry({ path: 'scripts/check-expected-filenames.sh', status: 'M', oldMode: '100755', newMode: '100644', oldSha: LOCAL, newSha: LOCAL }, lists)
  assert.equal(r.bucket, 'ENV-ARTIFACT')
})

test('symlink 展开成目录后的新增文件 → ENV-ARTIFACT', () => {
  const r = classifyEntry({ path: '.claude/skills/x/SKILL.md', status: 'A', oldMode: '000000', newMode: '100644', oldSha: '0'.repeat(40), newSha: OTHER }, lists)
  assert.equal(r.bucket, 'ENV-ARTIFACT')
})

test('**ENV 清单里路径的内容被改 → UNEXPECTED**', () => {
  const r = classifyEntry({ path: 'scripts/check-expected-filenames.sh', status: 'M', oldMode: '100644', newMode: '100644', oldSha: LOCAL, newSha: OTHER }, lists)
  assert.equal(r.bucket, 'UNEXPECTED')
  assert.match(r.reason, /not a provable env-only change/)
})

test('ENV 路径被删除 → UNEXPECTED', () => {
  const r = classifyEntry({ path: 'scripts/check-expected-filenames.sh', status: 'D', oldMode: '100644', newMode: '000000', oldSha: LOCAL, newSha: '0'.repeat(40) }, lists)
  assert.equal(r.bucket, 'UNEXPECTED')
})

test('未登记路径 → UNEXPECTED', () => {
  assert.equal(classifyEntry(entry({ path: 'packages/core/tools/src/index.ts' }), lists).bucket, 'UNEXPECTED')
})

test('parseRawDiff 能解析 M / A / R 记录（-z 格式）', () => {
  const d = 'd'.repeat(40)
  const fields = [
    `:120000 100644 ${UP} ${LOCAL} M`, 'CLAUDE.md',
    `:000000 100644 ${'0'.repeat(40)} ${OTHER} A`, 'agentops/README.md',
    `:100644 100644 ${d} ${d} R100`, 'old/name.ts', 'new/name.ts',
  ]
  const entries = parseRawDiff(fields.join('\0') + '\0')
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.path), ['CLAUDE.md', 'agentops/README.md', 'new/name.ts'])
  assert.equal(entries[2].status, 'R')
  assert.equal(entries[0].oldMode, '120000')
})

test('classifyEntries 聚合时把理由带上', () => {
  const { buckets, reasons } = classifyEntries([entry({ newSha: OTHER })], lists)
  assert.equal(buckets.UNEXPECTED.length, 1)
  assert.match(reasons.get('CLAUDE.md'), /differs from manifest/)
})

test('DEFAULT_BASE 用标签而不是分支名或裸 SHA', () => {
  assert.equal(DEFAULT_BASE, 'agentops-baseline')
  assert.doesNotMatch(DEFAULT_BASE, /^[0-9a-f]{7,40}$/)
})
