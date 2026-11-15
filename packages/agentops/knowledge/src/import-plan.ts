/**
 * Import planning for legacy folders.
 *
 * Planning is read-only and explicit: nothing is copied before the caller
 * reviews the plan. Duplicates are detected by content hash, unsupported files
 * and oversized files are listed rather than skipped silently, and paths
 * outside the authorized roots are rejected instead of normalized into them.
 */

export type ImportAction =
  | 'import'
  | 'duplicate'
  | 'unsupported'
  | 'too-large'
  | 'outside-root'
  | 'needs-mapping'

/** One file the scanner reported, with what is known about it. */
export interface ImportCandidate {
  /** Path as reported by the scanner; absolute or root-relative. */
  path: string
  size: number
  mime?: string
  /** Content hash when the scanner already computed one. */
  contentHash?: string
  /** Leading text used for sensitive-value detection. */
  sample?: string
}

/** Authorization, limits and mapping used while planning an import. */
export interface ImportOptions {
  /** Directories the operator explicitly authorized. */
  allowedRoots: readonly string[]
  /** Hashes already present in the target space. */
  existingHashes?: readonly string[]
  /** Default 50 MiB. */
  maxBytes?: number
  /** MIME prefixes accepted; default text-like set. */
  allowedMimePrefixes?: readonly string[]
  /** Map a path prefix to a target space; unmatched paths need manual mapping. */
  spaceMap?: Readonly<Record<string, string>>
}

/** The planned treatment of one candidate file. */
export interface ImportPlanEntry {
  path: string
  action: ImportAction
  reason: string
  spaceId?: string
  contentHash?: string
  /** Sensitive-value findings; present on every action so review is complete. */
  sensitive: readonly string[]
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

const TEXT_MIMES = [
  'text/',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-excel',
  'application/json',
  'application/xml',
]

const SENSITIVE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'private-ipv4', pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'credential-assignment', pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Z0-9_\-]{8,}/i },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/ },
]

/**
 * Build a reviewable import plan.
 * @param candidates - files reported by the scanner.
 * @param options - authorized roots, hashes, limits and space mapping.
 * @returns one entry per candidate, in input order.
 */
export function planImport(
  candidates: readonly ImportCandidate[],
  options: ImportOptions,
): ImportPlanEntry[] {
  const roots = options.allowedRoots.map(normalizePath).filter(root => root.length > 0)
  const existing = new Set(options.existingHashes ?? [])
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const mimePrefixes = options.allowedMimePrefixes ?? TEXT_MIMES

  return candidates.map((candidate) => {
    const path = normalizePath(candidate.path)
    const sensitive = detectSensitive(candidate.sample ?? '')
    const hash = candidate.contentHash

    if (roots.length === 0 || !roots.some(root => isInside(path, root))) {
      return { path, action: 'outside-root', reason: '路径不在授权根目录内', sensitive, ...(hash === undefined ? {} : { contentHash: hash }) }
    }
    if (candidate.size > maxBytes) {
      return { path, action: 'too-large', reason: `超过 ${maxBytes} 字节上限`, sensitive, ...(hash === undefined ? {} : { contentHash: hash }) }
    }
    if (!isSupported(candidate.mime, mimePrefixes)) {
      return { path, action: 'unsupported', reason: `不支持的 MIME：${candidate.mime ?? '未知'}`, sensitive, ...(hash === undefined ? {} : { contentHash: hash }) }
    }
    if (hash !== undefined && existing.has(hash)) {
      return { path, action: 'duplicate', reason: '目标空间已存在相同内容', sensitive, contentHash: hash }
    }
    const spaceId = matchSpace(path, options.spaceMap)
    if (spaceId === undefined) {
      return { path, action: 'needs-mapping', reason: '未匹配到知识域，需要人工选择', sensitive, ...(hash === undefined ? {} : { contentHash: hash }) }
    }
    return { path, action: 'import', reason: '可导入', spaceId, sensitive, ...(hash === undefined ? {} : { contentHash: hash }) }
  })
}

/**
 * Summarize a plan for the review dialog.
 * @param plan - entries from {@link planImport}.
 * @returns counts per action plus the sensitive-hit total.
 */
export function summarizePlan(plan: readonly ImportPlanEntry[]): {
  total: number
  byAction: Record<ImportAction, number>
  sensitiveFiles: number
} {
  const byAction: Record<ImportAction, number> = {
    import: 0, duplicate: 0, unsupported: 0, 'too-large': 0, 'outside-root': 0, 'needs-mapping': 0,
  }
  let sensitiveFiles = 0
  for (const entry of plan) {
    byAction[entry.action] += 1
    if (entry.sensitive.length > 0) sensitiveFiles += 1
  }
  return { total: plan.length, byAction, sensitiveFiles }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '').replace(/\/{2,}/g, '/')
}

function isInside(path: string, root: string): boolean {
  if (path.includes('\u0000')) return false
  const segments = path.split('/')
  if (segments.includes('..')) return false
  return path === root || path.startsWith(`${root}/`)
}

function isSupported(mime: string | undefined, prefixes: readonly string[]): boolean {
  if (mime === undefined) return false
  const lower = mime.toLowerCase()
  return prefixes.some(prefix => lower.startsWith(prefix.toLowerCase()))
}

function matchSpace(path: string, map: Readonly<Record<string, string>> | undefined): string | undefined {
  if (map === undefined) return undefined
  let best: { prefix: string; spaceId: string } | undefined
  for (const [prefix, spaceId] of Object.entries(map)) {
    const normalized = normalizePath(prefix)
    if (isInside(path, normalized) && (best === undefined || normalized.length > best.prefix.length)) {
      best = { prefix: normalized, spaceId }
    }
  }
  return best?.spaceId
}

function detectSensitive(text: string): string[] {
  const found: string[] = []
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) found.push(name)
  }
  return found
}
