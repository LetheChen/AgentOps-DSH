#!/usr/bin/env node
/**
 * 分类检查：把 `<base>..HEAD` 的每个变更归入
 * OWNED / CORE / INTEGRATION / ENV-ARTIFACT / UNEXPECTED，出现 UNEXPECTED 即退出码 1。
 *
 * 2026-10-26 外部质询后加固的三条规则（v1 的漏洞：只看路径 → 改了内容也放行）：
 * 1. **ENV-ARTIFACT 必须可证**：
 *    - 模式变了、blob 没变（可执行位丢失）→ ENV-ARTIFACT；
 *    - 上游 symlink 被实体化 → 与 `SYMLINK-MATERIALIZED.txt` 里记录的两侧 blob SHA 逐条比对，
 *      本地 blob 变了（= 有人改了内容）→ **UNEXPECTED**；
 *    - symlink 展开成目录后其下的新增文件 → ENV-ARTIFACT（仅 `A` 状态）。
 * 2. **base 不允许等于 HEAD**（否则 diff 恒空，假绿）。
 * 3. **工作区有未提交的核心改动 → 直接失败**（--allow-dirty 显式绕过）。
 * 4. **CORE 必须双登记**：路径同时在 CORE-PATHS.txt 与 DSH-CORE-CHANGES.md。
 *
 * 比较点：有共同祖先按 merge-base（三点语义）；当前 depth=1 graft 基线没有祖先 → 两点，
 * 并在输出里标注，避免让人误以为一直是三点。
 *
 * 用法：
 *   node agentops/scripts/check-owned-paths.mjs --base <旧基线引用>
 *   node agentops/scripts/check-owned-paths.mjs --base <ref> --json
 *   node agentops/scripts/check-owned-paths.mjs --base <ref> --allow-dirty
 *   git diff --name-only <base>..HEAD | node agentops/scripts/check-owned-paths.mjs --stdin
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认基线：标记上游基线提交的标签 `agentops-baseline`（不是分支名，避免随分支移动）。 */
export const DEFAULT_BASE = 'agentops-baseline'

const readLines = (path) => readFileSync(path, 'utf8')
  .split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))

/** 读取清单：owned / core / integration / env / symlinks（path → {upstreamSha, expectedBlob}）。 */
export function readLists(root) {
  const base = join(root, 'agentops')
  const symlinks = new Map()
  for (const line of readLines(join(base, 'SYMLINK-MATERIALIZED.txt'))) {
    const [upstreamSha, expectedBlob, ...rest] = line.split(' ')
    const path = rest.join(' ')
    if (upstreamSha !== undefined && expectedBlob !== undefined && path !== '') {
      symlinks.set(path, { upstreamSha, expectedBlob })
    }
  }
  return {
    owned: readLines(join(base, 'OWNED-PATHS.txt')),
    core: readLines(join(base, 'CORE-PATHS.txt')),
    integration: readLines(join(base, 'INTEGRATION-PATHS.txt')),
    env: readLines(join(base, 'ENV-ARTIFACTS.txt')),
    symlinks,
  }
}

const hit = (path, list) => list.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry)
const ZERO = /^0+$/

/**
 * 分类一条变更。
 * @param {{path:string,status:string,oldMode:string,newMode:string,oldSha:string,newSha:string}} entry
 * @param {{owned:string[],core:string[],integration:string[],env:string[],symlinks:Map}} lists
 * @returns {{bucket:string, reason:string}}
 */
export function classifyEntry(entry, lists) {
  const { path, status, oldMode, newMode, oldSha, newSha } = entry
  if (hit(path, lists.owned)) return { bucket: 'OWNED', reason: 'owned path' }
  if (hit(path, lists.core)) return { bucket: 'CORE', reason: 'registered DSH core change' }
  if (hit(path, lists.integration)) return { bucket: 'INTEGRATION', reason: 'registered integration file' }

  const symlink = lists.symlinks.get(path)
  if (symlink !== undefined) {
    if (oldSha !== symlink.upstreamSha) {
      return { bucket: 'UNEXPECTED', reason: `symlink manifest stale: upstream blob ${oldSha.slice(0, 8)} ≠ recorded ${symlink.upstreamSha.slice(0, 8)}` }
    }
    if (symlink.expectedBlob === '-') {
      return status === 'D'
        ? { bucket: 'ENV-ARTIFACT', reason: 'symlink replaced by a real directory' }
        : { bucket: 'UNEXPECTED', reason: `expected deletion of symlink entry, got ${status}` }
    }
    if ((status === 'M' || status === 'T') && oldMode === '120000' && newSha === symlink.expectedBlob) {
      return { bucket: 'ENV-ARTIFACT', reason: 'symlink materialized, blob matches manifest' }
    }
    return { bucket: 'UNEXPECTED', reason: `materialized content differs from manifest (${newSha.slice(0, 8)} ≠ ${symlink.expectedBlob.slice(0, 8)})` }
  }

  if (hit(path, lists.env)) {
    const prefix = lists.env.find(item => item.endsWith('/') && path.startsWith(item))
    if (prefix !== undefined && status === 'A') {
      return { bucket: 'ENV-ARTIFACT', reason: `symlink expansion under ${prefix}` }
    }
    if (status === 'M' && oldSha === newSha && oldMode !== newMode) {
      return { bucket: 'ENV-ARTIFACT', reason: `mode-only ${oldMode}→${newMode}, blob identical` }
    }
    return { bucket: 'UNEXPECTED', reason: `listed as env artifact but not a provable env-only change (status ${status}, ${oldSha.slice(0, 8)}→${newSha.slice(0, 8)})` }
  }
  return { bucket: 'UNEXPECTED', reason: 'not in any list' }
}

/** 分类一批变更，附带理由。 */
export function classifyEntries(entries, lists) {
  const buckets = { OWNED: [], CORE: [], INTEGRATION: [], 'ENV-ARTIFACT': [], UNEXPECTED: [] }
  const reasons = new Map()
  for (const entry of entries) {
    const { bucket, reason } = classifyEntry(entry, lists)
    buckets[bucket].push(entry.path)
    reasons.set(entry.path, reason)
  }
  return { buckets, reasons }
}

/** 解析 `git diff --raw -z` 输出。 */
export function parseRawDiff(text) {
  const fields = text.split('\0')
  const entries = []
  let index = 0
  while (index < fields.length) {
    const header = fields[index]
    index += 1
    if (header === undefined || !header.startsWith(':')) continue
    const [oldMode, newMode, oldSha, newSha, statusField] = header.slice(1).split(' ')
    const status = (statusField ?? '').slice(0, 1)
    let path = fields[index]
    index += 1
    if (status === 'R' || status === 'C') { path = fields[index]; index += 1 }
    if (path === undefined) break
    entries.push({ path, status, oldMode, newMode, oldSha, newSha })
  }
  return entries
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function die(message) {
  process.stderr.write(`check-owned-paths: ${message}\n`)
  process.exit(2)
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '..', '..')
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const fromStdin = argv.includes('--stdin')
  const allowDirty = argv.includes('--allow-dirty')
  const baseIndex = argv.indexOf('--base')
  const explicit = baseIndex >= 0
  const base = explicit ? argv[baseIndex + 1] : (process.env.AGENTOPS_BASE ?? DEFAULT_BASE)

  if (base === undefined || base === '') die('--base 需要一个 git 引用或 SHA')
  const lists = readLists(root)
  if (lists.symlinks.size === 0) die('SYMLINK-MATERIALIZED.txt 不可读或为空')

  let head
  try { head = git(root, ['rev-parse', 'HEAD']).trim() } catch { die('当前目录不是 git 仓库') }
  let baseSha
  try { baseSha = git(root, ['rev-parse', base]).trim() } catch {
    die(`无法解析 base: ${base} —— 标签缺失时先执行 git tag agentops-baseline <上游基线 commit>，或用 --base <ref> 指定其它基线`)
  }
  if (baseSha === head) die(`base 与 HEAD 相同（${baseSha.slice(0, 8)}）——diff 会恒空，属假绿；请传旧基线 SHA 或 upstream 引用`)

  if (!allowDirty) {
    const dirty = git(root, ['status', '--porcelain=v1', '-z', '-uno']).split('\0')
      .filter(Boolean).map(row => row.slice(3))
    const offenders = dirty.filter(path => !hit(path, lists.owned) && !hit(path, lists.integration))
    if (offenders.length > 0) {
      process.stderr.write('check-owned-paths: 工作区有未提交的核心改动（先提交/还原，或 --allow-dirty）：\n')
      for (const path of offenders.slice(0, 20)) process.stderr.write(`  ! ${path}\n`)
      process.exit(2)
    }
  }

  let compareBase = baseSha
  let semantics = 'two-dot'
  try {
    const mergeBase = git(root, ['merge-base', baseSha, head]).trim()
    if (mergeBase !== '' && mergeBase !== baseSha) { compareBase = mergeBase; semantics = 'three-dot(merge-base)' }
    else if (mergeBase === baseSha) semantics = 'two-dot(base 是祖先)'
  } catch { semantics = "two-dot(无共同祖先：depth=1 graft 基线)" }

  let entries
  if (fromStdin) {
    const paths = readFileSync(0, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    entries = paths.map(path => ({ path, status: 'M', oldMode: '', newMode: '', oldSha: '', newSha: '' }))
  } else {
    entries = parseRawDiff(git(root, ['-c', 'core.quotepath=false', 'diff', '--raw', '--no-abbrev', '-z', compareBase, head]))
  }

  const { buckets, reasons } = classifyEntries(entries, lists)
  const failed = buckets.UNEXPECTED.length > 0

  if (json) {
    process.stdout.write(`${JSON.stringify({
      base, compareBase, semantics, total: entries.length, ok: !failed,
      buckets, reasons: Object.fromEntries(reasons),
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`base    = ${base} (${baseSha.slice(0, 8)})\ncompare = ${compareBase.slice(0, 8)} [${semantics}]\n`)
    for (const [name, list] of Object.entries(buckets)) {
      process.stdout.write(`${name.padEnd(13)} ${String(list.length).padStart(4)}\n`)
    }
    if (buckets['ENV-ARTIFACT'].length > 0) {
      process.stdout.write('\nENV-ARTIFACT 判定理由:\n')
      for (const path of buckets['ENV-ARTIFACT']) process.stdout.write(`  · ${path} — ${reasons.get(path)}\n`)
    }
    if (failed) {
      process.stdout.write('\nUNEXPECTED（未登记，或登记的 ENV 路径内容被改）:\n')
      for (const path of buckets.UNEXPECTED) process.stdout.write(`  ! ${path} — ${reasons.get(path)}\n`)
      process.stdout.write('\n修法：AgentOps 自有 → OWNED-PATHS.txt；DSH 核心改动 → CORE-PATHS.txt + DSH-CORE-CHANGES.md；集成必需 → INTEGRATION-PATHS.txt + DSH-CORE-CHANGES.md；')
      process.stdout.write('\n      仅模式/symlink 差异 → ENV-ARTIFACTS.txt 或重跑 gen-symlink-manifest；其余一律回滚。\n')
    } else {
      process.stdout.write('\nOK：无未登记的核心改动。\n')
    }
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
