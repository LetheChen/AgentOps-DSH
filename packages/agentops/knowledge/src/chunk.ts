import type { Chunk, DocumentId, Locator, SpaceId } from './types.js'

/** Sizing rules applied when text is split into chunks. */
export interface ChunkOptions {
  /** Maximum characters per chunk. Default 800. */
  maxChars?: number
  /** Characters repeated from the previous chunk for context. Default 80. */
  overlap?: number
  /** Minimum characters; shorter trailing fragments merge into the previous chunk. Default 120. */
  minChars?: number
}

/** One chunk before it receives its document identity. */
export interface ChunkDraft {
  text: string
  locator: Locator
}

const DEFAULTS: Required<ChunkOptions> = { maxChars: 800, overlap: 80, minChars: 120 }

/**
 * Normalize text before chunking: unify newlines, trim right-hand whitespace,
 * collapse runs of blank lines. Offsets in every locator refer to the result.
 * @param text - raw extracted text.
 * @returns normalized text.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split normalized text into overlapping chunks with locators.
 *
 * Deterministic: the same input and options always produce the same chunks,
 * which is what makes index rebuilds comparable.
 * @param text - already normalized text.
 * @param options - chunk sizing.
 * @returns chunk drafts without ids.
 */
export function chunkText(text: string, options: ChunkOptions = {}): ChunkDraft[] {
  const { maxChars, overlap, minChars } = { ...DEFAULTS, ...options }
  if (text.length === 0) return []
  if (maxChars <= 0) throw new Error('maxChars must be positive')
  if (overlap < 0 || overlap >= maxChars) throw new Error('overlap must be >= 0 and < maxChars')

  const pages = pageBoundaries(text)
  const headings = headingPositions(text)
  const drafts: ChunkDraft[] = []

  let start = 0
  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length)
    const end = hardEnd === text.length ? hardEnd : findBreak(text, start, hardEnd, minChars)
    const slice = text.slice(start, end).trim()
    if (slice.length > 0) {
      drafts.push({
        text: slice,
        locator: {
          start,
          end,
          ...pageAt(pages, start),
          ...sectionAt(headings, start),
        },
      })
    }
    if (end >= text.length) break
    const next = Math.max(end - overlap, start + 1)
    start = next
  }
  return drafts
}

/**
 * Attach identity to drafts.
 * @param drafts - output of {@link chunkText}.
 * @param ids - owning document and space.
 * @returns full chunks with stable ordinals.
 */
export function toChunks(
  drafts: readonly ChunkDraft[],
  ids: { documentId: DocumentId; version: number; spaceId: SpaceId },
): Chunk[] {
  return drafts.map((draft, ordinal) => ({
    id: `${ids.documentId}@${ids.version}#${ordinal}`,
    documentId: ids.documentId,
    version: ids.version,
    spaceId: ids.spaceId,
    ordinal,
    text: draft.text,
    locator: draft.locator,
  }))
}

function findBreak(text: string, start: number, hardEnd: number, minChars: number): number {
  const window = text.slice(start, hardEnd)
  const minEnd = Math.max(1, Math.min(minChars, window.length))
  const sentence = /[。！？!?；;]\s*|\n\n/g
  let candidate = -1
  for (const match of window.matchAll(sentence)) {
    const at = (match.index ?? 0) + match[0].length
    if (at >= minEnd) candidate = at
  }
  if (candidate > 0) return start + candidate
  const space = window.lastIndexOf(' ')
  if (space >= minEnd) return start + space
  return hardEnd
}

function pageBoundaries(text: string): number[] {
  const marks: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\f') marks.push(i)
  }
  return marks
}

function pageAt(pages: readonly number[], offset: number): { page?: number } {
  let page = 1
  for (const mark of pages) {
    if (mark < offset) page += 1
    else break
  }
  return page > 1 ? { page } : {}
}

interface Heading { offset: number; title: string }

function headingPositions(text: string): Heading[] {
  const headings: Heading[] = []
  const pattern = /^(#{1,6})[ \t]+(.+)$/gm
  for (const match of text.matchAll(pattern)) {
    headings.push({ offset: match.index ?? 0, title: match[2]?.trim() ?? '' })
  }
  return headings
}

function sectionAt(headings: readonly Heading[], offset: number): { section?: string } {
  let title: string | undefined
  for (const heading of headings) {
    if (heading.offset <= offset) title = heading.title
    else break
  }
  return title === undefined ? {} : { section: title }
}
