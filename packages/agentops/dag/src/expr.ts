/**
 * Restricted expression language for DAG conditions.
 *
 * Not `eval`: the grammar covers what the legacy workflows use — comparisons,
 * boolean operators, parentheses, ternaries, string/number/boolean literals,
 * dotted paths and `{{...}}` placeholders (whose body may itself be an
 * expression, e.g. `{{not report.critical_summary}}`).
 *
 * Anything else fails at parse time, which validation surfaces before a run.
 */

export type Value = string | number | boolean | null

/** Raised when a condition expression cannot be parsed or evaluated. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

type Token =
  | { kind: 'placeholder'; path: string }
  | { kind: 'path'; path: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'op'; value: string }
  | { kind: 'punct'; value: '(' | ')' | '?' | ':' }

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=', '&&', '||']
const ONE_CHAR_OPS = ['>', '<', '!']
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null'])

/**
 * Tokenize an expression.
 * @param source - expression text.
 * @returns tokens.
 */
export function tokenizeExpression(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source.charAt(i)
    if (/\s/.test(ch)) { i += 1; continue }

    if (ch === '{' && source[i + 1] === '{') {
      const end = source.indexOf('}}', i + 2)
      if (end === -1) throw new ExpressionError('未闭合的占位符：缺少 }}')
      const inner = source.slice(i + 2, end).trim()
      if (inner.length === 0) throw new ExpressionError('空的占位符')
      // A placeholder body may be a full expression (`not x`, `a == b`).
      tokens.push(...tokenizeExpression(inner))
      i = end + 2
      continue
    }
    if (ch === '(' || ch === ')' || ch === '?' || ch === ':') {
      tokens.push({ kind: 'punct', value: ch })
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      let value = ''
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < source.length) { value += source[j + 1]; j += 2; continue }
        value += source[j]; j += 1
      }
      if (j >= source.length) throw new ExpressionError('未闭合的字符串字面量')
      tokens.push({ kind: 'string', value })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^-?\d+(?:\.\d+)?/.exec(source.slice(i))
      if (match === null) throw new ExpressionError('无效数字')
      tokens.push({ kind: 'number', value: Number(match[0]) })
      i += match[0].length
      continue
    }

    const word = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/.exec(source.slice(i))
    if (word !== null) {
      const text = word[0]
      const lower = text.toLowerCase()
      if (lower === 'true' || lower === 'false') tokens.push({ kind: 'boolean', value: lower === 'true' })
      else if (lower === 'null') tokens.push({ kind: 'null' })
      else if (lower === 'and' || lower === 'or' || lower === 'not') tokens.push({ kind: 'op', value: lower })
      else if (KEYWORDS.has(lower)) throw new ExpressionError(`保留字不能作为路径：${text}`)
      else tokens.push({ kind: 'path', path: text })
      i += text.length
      continue
    }

    const two = TWO_CHAR_OPS.find(op => source.startsWith(op, i))
    if (two !== undefined) { tokens.push({ kind: 'op', value: two }); i += two.length; continue }
    const one = ONE_CHAR_OPS.find(op => source.startsWith(op, i))
    if (one !== undefined) { tokens.push({ kind: 'op', value: one }); i += one.length; continue }
    throw new ExpressionError(`无法识别的字符：${ch}`)
  }
  return tokens
}

/**
 * Evaluate an expression to a value.
 *
 * Gateways use this to select a port: a boolean picks the first/second port,
 * a string must name a port.
 * @param source - expression text.
 * @param context - values addressed by path.
 * @returns the value, never `undefined`.
 */
export function evaluateValue(source: string, context: Record<string, unknown>): Value {
  const parser = new Parser(tokenizeExpression(source), context)
  const result = parser.parseConditional()
  parser.expectEnd()
  return result
}

/**
 * Evaluate an expression to a boolean.
 * @param source - expression text.
 * @param context - values addressed by path.
 * @returns truthiness of the evaluated value.
 */
export function evaluateExpression(source: string, context: Record<string, unknown>): boolean {
  return toBoolean(evaluateValue(source, context))
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[], private readonly context: Record<string, unknown>) {}

  parseConditional(): Value {
    const test = this.parseOr()
    if (this.matchPunct('?')) {
      const whenTrue = this.parseConditional()
      this.expectPunct(':')
      const whenFalse = this.parseConditional()
      return toBoolean(test) ? whenTrue : whenFalse
    }
    return test
  }

  private parseOr(): Value {
    let left = this.parseAnd()
    while (this.matchOp('||', 'or')) left = toBoolean(left) || toBoolean(this.parseAnd())
    return left
  }

  private parseAnd(): Value {
    let left = this.parseUnary()
    while (this.matchOp('&&', 'and')) left = toBoolean(left) && toBoolean(this.parseUnary())
    return left
  }

  private parseUnary(): Value {
    if (this.matchOp('!', 'not')) return !toBoolean(this.parseUnary())
    return this.parseComparison()
  }

  private parseComparison(): Value {
    const left = this.parsePrimary()
    const op = this.peekOp()
    if (op === undefined || !['==', '!=', '>', '>=', '<', '<='].includes(op)) return left
    this.index += 1
    return compare(left, this.parsePrimary(), op)
  }

  private parsePrimary(): Value {
    const token = this.tokens[this.index]
    if (token === undefined) throw new ExpressionError('表达式意外结束')
    this.index += 1
    if (token.kind === 'punct' && token.value === '(') {
      const inner = this.parseConditional()
      this.expectPunct(')')
      return inner
    }
    if (token.kind === 'string') return token.value
    if (token.kind === 'number') return token.value
    if (token.kind === 'boolean') return token.value
    if (token.kind === 'null') return null
    if (token.kind === 'placeholder' || token.kind === 'path') return readPath(this.context, token.path)
    throw new ExpressionError(`意外的标记：${JSON.stringify(token)}`)
  }

  matchOp(...values: string[]): boolean {
    const token = this.tokens[this.index]
    if (token?.kind === 'op' && values.includes(token.value)) { this.index += 1; return true }
    return false
  }

  peekOp(): string | undefined {
    const token = this.tokens[this.index]
    return token?.kind === 'op' ? token.value : undefined
  }

  matchPunct(value: '(' | ')' | '?' | ':'): boolean {
    const token = this.tokens[this.index]
    if (token?.kind === 'punct' && token.value === value) { this.index += 1; return true }
    return false
  }

  expectPunct(value: '(' | ')' | '?' | ':'): void {
    if (!this.matchPunct(value)) throw new ExpressionError(`缺少 ${value}`)
  }

  expectEnd(): void {
    if (this.index !== this.tokens.length) throw new ExpressionError('表达式存在多余内容')
  }
}

function readPath(context: Record<string, unknown>, path: string): Value {
  let current: unknown = context
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === undefined) return null
  if (current === null || typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
    return current
  }
  return JSON.stringify(current)
}

function toBoolean(value: Value): boolean {
  if (value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return value !== 0
  return value
}

function compare(left: Value, right: Value, op: string): boolean {
  if (op === '==') return left === right
  if (op === '!=') return left !== right
  const numeric = typeof left === 'number' && typeof right === 'number'
  const a = numeric ? left : String(left)
  const b = numeric ? right : String(right)
  switch (op) {
    case '>': return a > b
    case '>=': return a >= b
    case '<': return a < b
    case '<=': return a <= b
    default: throw new ExpressionError(`不支持的比较运算符：${op}`)
  }
}
