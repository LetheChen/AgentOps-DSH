import type { Chunk, SearchHit, SearchRequest } from './types.js'

const K1 = 1.2
const B = 0.75
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/**
 * Tokenize for mixed Chinese/English text.
 *
 * Latin runs become whole words; CJK runs become adjacent bigrams (single
 * characters for one-character runs), which keeps recall usable without a
 * dictionary or an embedding model.
 * @param text - any text.
 * @returns lowercase tokens, order preserved.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const pattern = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff]+/gi
  for (const match of text.matchAll(pattern)) {
    const run = match[0]
    if (/^[a-z0-9_]+$/i.test(run)) {
      tokens.push(run.toLowerCase())
      continue
    }
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/**
 * Lexical search over chunks with BM25.
 *
 * Visibility is enforced here rather than by callers: a chunk outside
 * `allowedSpaces` is never scored, so an empty allowance yields no hits.
 * @param chunks - searchable chunks (all spaces).
 * @param request - query, allowed spaces, optional document filter and limit.
 * @returns hits ordered by score, then by chunk id for determinism.
 */
export function searchChunks(chunks: readonly Chunk[], request: SearchRequest): SearchHit[] {
  const query = request.query.trim()
  if (query.length === 0) return []

  const limit = clampLimit(request.limit)
  const allowed = new Set(request.allowedSpaces)
  if (allowed.size === 0) return []

  const candidates = chunks.filter(chunk =>
    allowed.has(chunk.spaceId)
    && (request.documentId === undefined || chunk.documentId === request.documentId))

  if (candidates.length === 0) return []

  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []

  const docTerms = candidates.map(chunk => tokenize(chunk.text))
  const lengths = docTerms.map(terms => terms.length)
  const avgdl = lengths.reduce((sum, n) => sum + n, 0) / candidates.length || 1

  const df = new Map<string, number>()
  for (const term of queryTerms) {
    let count = 0
    for (const terms of docTerms) if (terms.includes(term)) count += 1
    df.set(term, count)
  }

  const hits: SearchHit[] = []
  const n = candidates.length
  for (const [index, terms] of docTerms.entries()) {
    const chunk = candidates[index]
    if (chunk === undefined) continue
    const tf = new Map<string, number>()
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const freq = tf.get(term) ?? 0
      if (freq === 0) continue
      const docsWithTerm = df.get(term) ?? 0
      const idf = Math.log(1 + (n - docsWithTerm + 0.5) / (docsWithTerm + 0.5))
      const denom = freq + K1 * (1 - B + (B * (lengths[index] ?? 0)) / avgdl)
      score += idf * ((freq * (K1 + 1)) / denom)
    }
    if (score > 0) hits.push({ chunk, score: round(score) })
  }

  hits.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  return hits.slice(0, limit)
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
