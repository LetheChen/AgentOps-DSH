/**
 * Pure text and selection helpers for the workflow YAML editor.
 *
 * Keeping these rules outside React makes the keyboard, source-location, and
 * request-ordering behaviour testable without a browser.
 *
 * @module @agentops/dsh-client/workflow-editor-logic
 */

/** One half-open selection in the source text. */
export interface SourceSelection {
  readonly start: number
  readonly end: number
}

/** Source text after an edit and the selection that should follow it. */
export interface TextEdit {
  readonly text: string
  readonly selection: SourceSelection
}

/** The keyboard fields needed to recognize the save shortcut. */
export interface SaveShortcutInput {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
}

/** The source-position fields carried by a validation issue. */
export interface SourcePosition {
  readonly line?: number
  readonly column?: number
}

/** A validation issue carrying the optional node membership used by cycles. */
export interface NodeIssue {
  readonly kind?: string
  readonly nodeIds?: readonly string[]
}

interface SourceLine {
  readonly start: number
  readonly contentEnd: number
}

function sourceLines(text: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== '\r' && character !== '\n') continue
    lines.push({ start, contentEnd: index })
    if (character === '\r' && text[index + 1] === '\n') index += 1
    start = index + 1
  }
  lines.push({ start, contentEnd: text.length })
  return lines
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/**
 * Insert spaces over a selection and return the resulting caret position.
 * @param text - complete textarea value.
 * @param start - selection start offset.
 * @param end - selection end offset.
 * @param count - number of spaces to insert.
 * @returns edited text and a collapsed selection after the inserted spaces.
 */
export function insertSpaces(text: string, start: number, end: number, count = 2): TextEdit {
  const from = clamp(Math.trunc(start), 0, text.length)
  const to = clamp(Math.trunc(end), from, text.length)
  const spaces = ' '.repeat(Math.max(0, Math.trunc(count)))
  const cursor = from + spaces.length
  return {
    text: `${text.slice(0, from)}${spaces}${text.slice(to)}`,
    selection: { start: cursor, end: cursor },
  }
}

/**
 * Recognize Ctrl+S and Cmd+S without intercepting modified variants.
 * @param input - keyboard modifier state.
 * @returns whether the event should save the draft.
 */
export function isSaveShortcut(input: SaveShortcutInput): boolean {
  return input.key.toLowerCase() === 's'
    && (input.ctrlKey || input.metaKey)
    && !input.altKey
}

/**
 * Map a one-based issue position to the rest of that source line.
 *
 * CRLF and bare CR count as one line break. Out-of-range lines and columns are
 * clamped so a stale server position still moves the caret somewhere useful.
 *
 * @param text - complete textarea value.
 * @param issue - optional one-based line and column.
 * @returns a half-open source selection, or null when the issue has no line.
 */
export function sourceRangeForIssue(text: string, issue: SourcePosition): SourceSelection | null {
  if (issue.line === undefined) return null
  const lines = sourceLines(text)
  const requestedLine = Number.isFinite(issue.line) ? Math.trunc(issue.line) : 1
  const line = lines[clamp(requestedLine - 1, 0, lines.length - 1)]
  if (line === undefined) return { start: 0, end: 0 }
  const requestedColumn = issue.column === undefined || !Number.isFinite(issue.column)
    ? 1
    : Math.trunc(issue.column)
  const offset = clamp(requestedColumn - 1, 0, line.contentEnd - line.start)
  const start = line.start + offset
  return { start, end: line.contentEnd }
}

/**
 * Return the nodes a validation issue should highlight.
 * @param issue - issue with optional node membership.
 * @returns a de-duplicated set preserving report order.
 */
export function nodeIdsForIssue(issue: NodeIssue): ReadonlySet<string> {
  return new Set(issue.nodeIds ?? [])
}

/**
 * Find a workflow independently of the current search filter.
 * @param entries - the complete workflow catalogue.
 * @param id - workflow id, or null for no selection.
 * @returns the matching entry, or null.
 */
export function findWorkflowById<T extends { readonly id: string }>(
  entries: readonly T[],
  id: string | null,
): T | null {
  if (id === null) return null
  return entries.find(entry => entry.id === id) ?? null
}

/** Monotonic tokens for validation responses. */
export interface ValidationSequence {
  /** Start a newer request and return its token. */
  begin(): number
  /** Return whether no newer request has started since this token. */
  isCurrent(token: number): boolean
}

/**
 * Create a per-editor validation sequence.
 * @returns a counter that can reject every response older than the latest start.
 */
export function createValidationSequence(): ValidationSequence {
  let current = 0
  return {
    begin: () => {
      current += 1
      return current
    },
    isCurrent: token => token === current,
  }
}
