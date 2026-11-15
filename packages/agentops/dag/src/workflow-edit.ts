/**
 * Local YAML edits for the workflow canvas.
 *
 * The YAML text remains authoritative. Every operation computes source
 * splices against the parsed document and returns a new candidate string; it
 * never serializes the whole document. The caller validates the candidate
 * again before exposing it to the editor.
 *
 * @module @agentops/dsh-workflow-edit
 */

import { dataEdges, loadWorkflowDefinition, loadWorkflowGraph } from '@agentops/dsh-contracts'
import type { AwaitCommandConfig, ValidationIssue, WorkflowDefinition, WorkflowNode } from '@agentops/dsh-contracts'
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from 'yaml'
import type {
  Document,
  Node,
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from 'yaml'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** One source-only edit initiated from the workflow canvas. */
export type WorkflowEditOperation =
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly agent: string
    readonly rolePrompt: string
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'command'
    readonly cliTemplate: string
  }
  | ({
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'await_command'
  } & AwaitCommandConfig)
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'gateway'
    readonly condition: string
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'parallel_branch'
    readonly branches: readonly string[]
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'while'
    readonly body: readonly string[]
    readonly continueIf: string
    readonly maxIterations: number
  }
  | { readonly kind: 'remove-node'; readonly id: string }
  | { readonly kind: 'add-schedule-edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'remove-schedule-edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'add-data-edge'; readonly from: string; readonly to: string; readonly port: string }
  | { readonly kind: 'remove-data-edge'; readonly from: string; readonly to: string; readonly port: string }
/** Successful edit result after parsing and validating the generated source. */
export interface WorkflowEditSuccess {
  readonly text: string
  readonly definition: WorkflowDefinition
  readonly issues: readonly ValidationIssue[]
}

/** Raised when an operation is malformed or cannot produce a valid workflow. */
export class WorkflowEditError extends Error {
  /** Structured reasons the edit was rejected. */
  readonly issues: readonly ValidationIssue[]
  /** Generated YAML when the operation produced semantically invalid source. */
  readonly candidateText?: string

  /**
   * @param issues - structured reasons the edit was rejected.
   * @param candidateText - generated YAML whose graph must remain visible.
   */
  constructor(issues: readonly ValidationIssue[], candidateText?: string) {
    super(issues[0]?.message ?? '工作流编辑无效')
    this.name = 'WorkflowEditError'
    this.issues = issues
    if (candidateText !== undefined) this.candidateText = candidateText
  }
}

interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface EditableNode {
  readonly id: string
  readonly mapping: YAMLMap<Scalar, Node>
  readonly itemStart: number
  readonly itemEnd: number
  readonly fieldIndent: string
}

type EditableNodes =
  | {
    readonly kind: 'sequence'
    readonly collection: YAMLSeq<Node>
    readonly firstIndent: string
    readonly nodesPair: Pair<Scalar, Node>
  }
  | {
    readonly kind: 'mapping'
    readonly collection: YAMLMap<Scalar, Node>
    readonly firstIndent: string
    readonly nodesPair: Pair<Scalar, Node>
  }

function operationIssue(path: string, message: string): WorkflowEditError {
  return new WorkflowEditError([{ path, message, kind: 'operation' }])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw operationIssue(`${path}.${key}`, `未知字段：${key}`)
  }
}

function expectKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  rejectUnknownKeys(value, keys, path)
  for (const key of keys) {
    if (!(key in value)) throw operationIssue(`${path}.${key}`, `缺少字段：${key}`)
  }
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw operationIssue(path, `${path} 必须是非空且不含 NUL 的字符串`)
  }
  return value
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw operationIssue(path, `${path} 必须是字符串`)
  return value
}

function readStringList(value: unknown, path: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw operationIssue(path, allowEmpty ? `${path} 必须是字符串数组` : `${path} 必须是非空字符串数组`)
  }
  return value.map((entry, index) => readNonEmptyString(entry, `${path}[${index}]`))
}

function readPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw operationIssue(path, `${path} 必须是安全正整数`)
  }
  return value
}
/**
 * Parse an untrusted edit operation at the HTTP boundary.
 * @param value - JSON value from the request body.
 * @returns the normalized edit operation.
 * @throws {WorkflowEditError} when the discriminant, fields, or string values are invalid.
 */
export function parseWorkflowEditOperation(value: unknown): WorkflowEditOperation {
  if (!isRecord(value)) throw operationIssue('operation', 'operation 必须是对象')
  if (typeof value.kind !== 'string') throw operationIssue('operation.kind', '缺少编辑类型')

  switch (value.kind) {
    case 'add-node': {
      const id = readNonEmptyString(value.id, 'operation.id')
      switch (value.type) {
        case undefined:
          expectKeys(value, ['kind', 'id', 'agent', 'rolePrompt'], 'operation')
          return {
            kind: 'add-node',
            id,
            agent: readNonEmptyString(value.agent, 'operation.agent'),
            rolePrompt: readString(value.rolePrompt, 'operation.rolePrompt'),
          }
        case 'command':
          expectKeys(value, ['kind', 'id', 'type', 'cliTemplate'], 'operation')
          return {
            kind: 'add-node',
            id,
            type: 'command',
            cliTemplate: readNonEmptyString(value.cliTemplate, 'operation.cliTemplate'),
          }
        case 'await_command':
          rejectUnknownKeys(value, [
            'kind',
            'id',
            'type',
            'targetActors',
            'commandPort',
            'expirySeconds',
            'maxCommands',
          ], 'operation')
          return {
            kind: 'add-node',
            id,
            type: 'await_command',
            targetActors: value.targetActors === undefined
              ? []
              : readStringList(value.targetActors, 'operation.targetActors', true),
            commandPort: value.commandPort === undefined
              ? 'command'
              : readNonEmptyString(value.commandPort, 'operation.commandPort'),
            expirySeconds: value.expirySeconds === undefined
              ? 86400
              : readPositiveInteger(value.expirySeconds, 'operation.expirySeconds'),
            maxCommands: value.maxCommands === undefined
              ? 10
              : readPositiveInteger(value.maxCommands, 'operation.maxCommands'),
          }
        case 'gateway':
          expectKeys(value, ['kind', 'id', 'type', 'condition'], 'operation')
          return {
            kind: 'add-node',
            id,
            type: 'gateway',
            condition: readNonEmptyString(value.condition, 'operation.condition'),
          }
        case 'parallel_branch':
          expectKeys(value, ['kind', 'id', 'type', 'branches'], 'operation')
          return {
            kind: 'add-node',
            id,
            type: 'parallel_branch',
            branches: readStringList(value.branches, 'operation.branches'),
          }
        case 'while':
          expectKeys(value, ['kind', 'id', 'type', 'body', 'continueIf', 'maxIterations'], 'operation')
          return {
            kind: 'add-node',
            id,
            type: 'while',
            body: readStringList(value.body, 'operation.body'),
            continueIf: readNonEmptyString(value.continueIf, 'operation.continueIf'),
            maxIterations: readPositiveInteger(value.maxIterations, 'operation.maxIterations'),
          }
        default:
          throw operationIssue('operation.type', `未知节点类型：${String(value.type)}`)
      }
    }
    case 'remove-node':
      expectKeys(value, ['kind', 'id'], 'operation')
      return { kind: 'remove-node', id: readNonEmptyString(value.id, 'operation.id') }
    case 'add-schedule-edge':
    case 'remove-schedule-edge':
      expectKeys(value, ['kind', 'from', 'to'], 'operation')
      return {
        kind: value.kind,
        from: readNonEmptyString(value.from, 'operation.from'),
        to: readNonEmptyString(value.to, 'operation.to'),
      }
    case 'add-data-edge':
    case 'remove-data-edge':
      expectKeys(value, ['kind', 'from', 'to', 'port'], 'operation')
      return {
        kind: value.kind,
        from: readNonEmptyString(value.from, 'operation.from'),
        to: readNonEmptyString(value.to, 'operation.to'),
        port: readNonEmptyString(value.port, 'operation.port'),
      }
    default:
      throw operationIssue('operation.kind', `未知编辑类型：${value.kind}`)
  }
}
function newlineOf(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function lineStart(source: string, index: number): number {
  return source.lastIndexOf('\n', Math.max(0, index - 1)) + 1
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf('\n', index)
  return newline === -1 ? source.length : newline + 1
}

function rangeLineEnd(source: string, index: number): number {
  // YAML scalar ranges commonly end just after the trailing newline. Search
  // from the final content character so a replacement never consumes the next
  // mapping entry.
  return lineEnd(source, Math.max(0, index - 1))
}

function indentationAt(source: string, index: number): string {
  const line = source.slice(lineStart(source, index), index)
  const match = /^[ \t]*/.exec(line)
  return match?.[0] ?? ''
}

function rangeOf(node: Node | null | undefined): readonly [number, number, number] {
  if (node?.range === undefined || node.range === null) {
    throw operationIssue('nodes', 'YAML 节点缺少源位置，无法安全编辑')
  }
  return node.range
}

function applySplices(source: string, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((left, right) => right.start - left.start)
  let previousStart = source.length
  let result = source
  for (const splice of ordered) {
    if (splice.start < 0 || splice.end < splice.start || splice.end > source.length) {
      throw operationIssue('nodes', 'YAML 源位置越界，无法安全编辑')
    }
    if (splice.end > previousStart) {
      throw operationIssue('nodes', '编辑范围重叠，无法安全编辑')
    }
    result = `${result.slice(0, splice.start)}${splice.text}${result.slice(splice.end)}`
    previousStart = splice.start
  }
  return result
}

function parseEditable(source: string): {
  readonly document: Document.Parsed
  readonly definition: WorkflowDefinition
  readonly nodes: EditableNodes
} {
  const validated = loadWorkflowDefinition(source)
  if (!validated.ok) throw new WorkflowEditError(validated.issues)

  const document = parseDocument(source, { keepSourceTokens: true })
  if (document.errors.length > 0) {
    throw operationIssue('nodes', 'YAML 无法解析，不能安全编辑')
  }
  if (!isMap<Scalar, Node>(document.contents)) throw operationIssue('nodes', '工作流根节点必须是映射')

  const nodesPair = document.contents.items.find(pair => isScalar(pair.key) && pair.key.value === 'nodes')
  if (nodesPair === undefined || nodesPair.value === null) throw operationIssue('nodes', '缺少 nodes')
  const collection = nodesPair.value
  if (isSeq<Node>(collection)) {
    if (collection.flow === true) throw operationIssue('nodes', 'flow-style nodes 不支持安全编辑')
    const first = collection.items[0]
    if (first === undefined) throw operationIssue('nodes', 'nodes 至少需要一个节点')
    const firstId = idPairOf(first)
    const firstOffset = rangeOf(firstId.key)[0]
    return {
      document,
      definition: validated.value,
      nodes: {
        kind: 'sequence',
        collection,
        firstIndent: indentationAt(source, firstOffset),
        nodesPair,
      },
    }
  }
  if (isMap<Scalar, Node>(collection)) {
    if (collection.flow === true) throw operationIssue('nodes', 'flow-style nodes 不支持安全编辑')
    const first = collection.items[0]
    if (first === undefined) throw operationIssue('nodes', 'nodes 至少需要一个节点')
    if (!isScalar(first.key)) throw operationIssue('nodes', '节点 id 必须是标量')
    return {
      document,
      definition: validated.value,
      nodes: {
        kind: 'mapping',
        collection,
        firstIndent: indentationAt(source, rangeOf(first.key)[0]),
        nodesPair,
      },
    }
  }
  throw operationIssue('nodes', 'nodes 必须是序列或映射')
}

function idPairOf(value: unknown): Pair<Scalar, Scalar> {
  if (!isMap<Scalar, Node>(value)) throw operationIssue('nodes', '节点必须是映射')
  if (value.flow === true) throw operationIssue('nodes', 'flow-style 节点映射不支持安全编辑')
  const pair = value.items.find(
    (item): item is Pair<Scalar, Scalar> =>
      isScalar(item.key)
      && item.key.value === 'id'
      && isScalar(item.value)
      && typeof item.value.value === 'string',
  )
  if (pair === undefined) throw operationIssue('nodes', '节点缺少字符串 id')
  return pair
}

function editableNodes(source: string, parsed: ReturnType<typeof parseEditable>): readonly EditableNode[] {
  if (parsed.nodes.kind === 'sequence') {
    return parsed.nodes.collection.items.map((item) => {
      const mapping = item
      if (!isMap<Scalar, Node>(mapping)) throw operationIssue('nodes', '节点必须是映射')
      const pair = idPairOf(mapping)
      const id = pair.value
      if (!isScalar(id) || typeof id.value !== 'string') throw operationIssue('nodes', '节点缺少字符串 id')
      const dashIndent = indentationAt(source, rangeOf(pair.key)[0])
      return {
        id: id.value,
        mapping,
        itemStart: lineStart(source, rangeOf(mapping)[0]),
        itemEnd: rangeOf(mapping)[2],
        fieldIndent: `${dashIndent}  `,
      }
    })
  }

  return parsed.nodes.collection.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isMap<Scalar, Node>(pair.value)) {
      throw operationIssue('nodes', '映射形式的节点必须是 id → 对象')
    }
    const keyIndent = indentationAt(source, rangeOf(pair.key)[0])
    return {
      id: pair.key.value,
      mapping: pair.value,
      itemStart: lineStart(source, rangeOf(pair.key)[0]),
      itemEnd: rangeOf(pair.value)[2],
      fieldIndent: `${keyIndent}  `,
    }
  })
}

function findNode(nodes: readonly EditableNode[], id: string): EditableNode {
  const node = nodes.find(candidate => candidate.id === id)
  if (node === undefined) throw operationIssue(`nodes.${id}`, `节点不存在：${id}`)
  return node
}

function appendField(source: string, node: EditableNode, field: string): string {
  const newline = newlineOf(source)
  const end = node.mapping.range?.[2]
  if (end === undefined) throw operationIssue('nodes', '节点缺少源位置')
  const prefix = end > 0 && source[end - 1] !== '\n' ? newline : ''
  return applySplices(source, [{
    start: end,
    end,
    text: `${prefix}${node.fieldIndent}${field}${newline}`,
  }])
}

function fieldSplice(source: string, pair: Pair<Scalar, Node>, replacement: string): Splice {
  if (!isScalar(pair.key) || pair.value === null) throw operationIssue('nodes', '字段缺少源位置')
  return {
    start: lineStart(source, rangeOf(pair.key)[0]),
    end: rangeLineEnd(source, rangeOf(pair.value)[2]),
    text: replacement,
  }
}

function renderScalar(value: string): string {
  const reserved = /^(?:null|true|false|~)$/i.test(value)
  return IDENTIFIER.test(value) && !reserved ? value : JSON.stringify(value)
}

function renderScalarList(values: readonly string[]): string {
  return `[${values.map(renderScalar).join(', ')}]`
}

function rewriteAfter(
  source: string,
  targetId: string,
  values: readonly string[],
  path: string,
): string {
  const parsed = parseEditable(source)
  const node = findNode(editableNodes(source, parsed), targetId)
  const newline = newlineOf(source)
  const replacement = `${node.fieldIndent}after: ${renderScalarList(values)}${newline}`
  const pair = node.mapping.items.find(item => isScalar(item.key) && item.key.value === 'after')
  if (pair === undefined) return appendField(source, node, `after: ${renderScalarList(values)}`)
  if (!isScalar(pair.key) || pair.value === null) throw operationIssue(path, 'after 字段无法安全编辑')
  return applySplices(source, [fieldSplice(source, pair, replacement)])
}

function requireNode(definition: WorkflowDefinition, id: string): WorkflowNode {
  const node = definition.nodes.find(candidate => candidate.id === id)
  if (node === undefined) throw operationIssue(`nodes.${id}`, `节点不存在：${id}`)
  return node
}

function renderOutputs(indent: string, outputs: Readonly<Record<string, readonly string[]>>, newline: string): string {
  const entries = Object.entries(outputs)
  if (entries.length === 0) return `${indent}outputs: {}${newline}`
  return [
    `${indent}outputs:`,
    ...entries.map(([port, targets]) => `${indent}  ${renderScalar(port)}: ${renderScalarList(targets)}`),
    '',
  ].join(newline)
}

function replaceOutputsField(
  source: string,
  node: EditableNode,
  outputs: Readonly<Record<string, readonly string[]>>,
): string {
  const newline = newlineOf(source)
  const pair = node.mapping.items.find(item => isScalar(item.key) && item.key.value === 'outputs')
  if (pair === undefined) return appendField(source, node, `outputs: ${renderScalarList([])}`)
  if (!isScalar(pair.key) || pair.value === null) throw operationIssue('outputs', 'outputs 字段无法安全编辑')
  return applySplices(source, [fieldSplice(source, pair, renderOutputs(node.fieldIndent, outputs, newline))])
}

function replaceOutputPort(
  source: string,
  node: EditableNode,
  port: string,
  targets: readonly string[],
): string {
  const pair = node.mapping.items.find(item => isScalar(item.key) && item.key.value === 'outputs')
  if (pair === undefined || pair.value === null || !isMap<Scalar, Node>(pair.value)) {
    if (targets.length === 0) return source
    return replaceOutputsField(source, node, { ...nodeOutputs(node), [port]: targets })
  }
  if (pair.value.flow === true) {
    const current = nodeOutputs(node)
    const next = targets.length === 0
      ? Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== port))
      : { ...current, [port]: targets }
    return replaceOutputsField(source, node, next)
  }

  const portPair = pair.value.items.find(item => isScalar(item.key) && String(item.key.value) === port)
  if (portPair === undefined) {
    if (targets.length === 0) throw operationIssue(`outputs.${port}`, `输出端口不存在：${port}`)
    const newline = newlineOf(source)
    const indent = `${node.fieldIndent}  `
    return applySplices(source, [{
      start: rangeOf(pair.value)[2],
      end: rangeOf(pair.value)[2],
      text: `${indent}${renderScalar(port)}: ${renderScalarList(targets)}${newline}`,
    }])
  }

  if (targets.length > 0) {
    if (!isScalar(portPair.key) || portPair.value === null) {
      throw operationIssue(`outputs.${port}`, 'output port 无法安全编辑')
    }
    const newline = newlineOf(source)
    return applySplices(source, [fieldSplice(
      source,
      portPair,
      `${node.fieldIndent}  ${renderScalar(port)}: ${renderScalarList(targets)}${newline}`,
    )])
  }

  if (pair.value.items.length === 1) return replaceOutputsField(source, node, {})
  if (!isScalar(portPair.key) || portPair.value === null) {
    throw operationIssue(`outputs.${port}`, '输出端口无法安全删除')
  }
  return applySplices(source, [{
    start: lineStart(source, rangeOf(portPair.key)[0]),
    end: rangeLineEnd(source, rangeOf(portPair.value)[2]),
    text: '',
  }])
}

function nodeOutputs(node: EditableNode): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {}
  const pair = node.mapping.items.find(item => isScalar(item.key) && item.key.value === 'outputs')
  if (pair === undefined || pair.value === null || !isMap<Scalar, Node>(pair.value)) return result
  for (const item of pair.value.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string' || item.value === null) continue
    if (isScalar(item.value) && typeof item.value.value === 'string') {
      result[item.key.value] = [item.value.value]
    } else if (isSeq<Node>(item.value)) {
      const targets = item.value.items
        .filter((target): target is Scalar => isScalar(target) && typeof target.value === 'string')
        .map(target => String(target.value))
      result[item.key.value] = targets
    } else if (isMap<Scalar, Node>(item.value)) {
      const to = item.value.items.find(target => isScalar(target.key) && target.key.value === 'to')
      if (to !== undefined && isScalar(to.value) && typeof to.value.value === 'string') {
        result[item.key.value] = [to.value.value]
      }
    }
  }
  return result
}

function renderSingleQuoted(value: string): string {
  return /[\r\n]/.test(value) ? JSON.stringify(value) : `'${value.replaceAll("'", "''")}'`
}

function renderNodeBlock(
  operation: Extract<WorkflowEditOperation, { kind: 'add-node' }>,
  firstIndent: string,
  newline: string,
): string {
  const fieldIndent = `${firstIndent}  `
  if (!('type' in operation)) {
    return [
      `${firstIndent}- id: ${renderScalar(operation.id)}`,
      `${fieldIndent}agent: ${renderScalar(operation.agent)}`,
      `${fieldIndent}role_prompt: ${JSON.stringify(operation.rolePrompt)}`,
      '',
    ].join(newline)
  }

  const lines = [
    `${firstIndent}- id: ${renderScalar(operation.id)}`,
    `${fieldIndent}type: ${operation.type}`,
  ]
  switch (operation.type) {
    case 'command':
      lines.push(
        `${fieldIndent}command_config:`,
        `${fieldIndent}  cli_template: ${renderSingleQuoted(operation.cliTemplate)}`,
      )
      break
    case 'await_command':
      lines.push(
        `${fieldIndent}await_command_config:`,
        `${fieldIndent}  target_actors: ${renderScalarList(operation.targetActors)}`,
        `${fieldIndent}  command_port: ${renderScalar(operation.commandPort)}`,
        `${fieldIndent}  expiry_seconds: ${String(operation.expirySeconds)}`,
        `${fieldIndent}  max_commands: ${String(operation.maxCommands)}`,
      )
      break
    case 'gateway':
      lines.push(
        `${fieldIndent}condition: ${renderScalar(operation.condition)}`,
        `${fieldIndent}outputs:`,
        `${fieldIndent}  next: []`,
      )
      break
    case 'parallel_branch':
      lines.push(`${fieldIndent}branches: ${renderScalarList(operation.branches)}`)
      break
    case 'while':
      lines.push(
        `${fieldIndent}body: ${renderScalarList(operation.body)}`,
        `${fieldIndent}continue_if: ${renderScalar(operation.continueIf)}`,
        `${fieldIndent}max_iterations: ${String(operation.maxIterations)}`,
      )
      break
  }
  lines.push('')
  return lines.join(newline)
}

function renderMappingNodeBlock(
  operation: Extract<WorkflowEditOperation, { kind: 'add-node' }>,
  firstIndent: string,
  newline: string,
): string {
  if (!('type' in operation)) {
    const fieldIndent = `${firstIndent}  `
    return [
      `${firstIndent}${renderScalar(operation.id)}:`,
      `${fieldIndent}agent: ${renderScalar(operation.agent)}`,
      `${fieldIndent}role_prompt: ${JSON.stringify(operation.rolePrompt)}`,
      '',
    ].join(newline)
  }

  const sequenceBlock = renderNodeBlock(operation, firstIndent, newline)
  const firstLineEnd = sequenceBlock.indexOf(newline)
  const firstLine = sequenceBlock.slice(0, firstLineEnd).replace(`${firstIndent}- id: `, '')
  return `${firstIndent}${firstLine}:${sequenceBlock.slice(firstLineEnd)}`
}

function addNode(source: string, operation: Extract<WorkflowEditOperation, { kind: 'add-node' }>): string {
  const parsed = parseEditable(source)
  if (parsed.definition.nodes.some(node => node.id === operation.id)) {
    throw operationIssue(`nodes.${operation.id}`, `节点已存在：${operation.id}`)
  }
  if (
    'type' in operation
    && operation.type === 'await_command'
    && parsed.definition.nodes.some(node => node.type === 'await_command')
  ) {
    throw operationIssue(
      `nodes.${operation.id}.await_command_config`,
      '整个工作流最多只能有一个 await_command 节点',
    )
  }
  const newline = newlineOf(source)
  const afterNodesKey = lineEnd(source, rangeOf(parsed.nodes.nodesPair.key)[0])
  const isAgent = !('type' in operation)
  let insertAt = afterNodesKey
  const firstIndent = parsed.nodes.firstIndent
  if (!isAgent) {
    const editable = editableNodes(source, parsed)
    const firstAgentIndex = parsed.definition.nodes.findIndex(node => node.type === 'agent')
    const anchor = editable[firstAgentIndex === -1 ? editable.length - 1 : firstAgentIndex]
    if (anchor === undefined) throw operationIssue('nodes', '无法确定新节点插入位置')
    insertAt = anchor.itemStart
  }
  const block = parsed.nodes.kind === 'sequence'
    ? renderNodeBlock(operation, firstIndent, newline)
    : renderMappingNodeBlock(operation, firstIndent, newline)
  return applySplices(source, [{ start: insertAt, end: insertAt, text: block }])
}

function removeNode(source: string, id: string): string {
  let working = source
  let parsed = parseEditable(working)
  const definition = parsed.definition
  if (definition.nodes.length === 1) throw operationIssue('nodes', '工作流至少需要保留一个节点')

  for (const node of definition.nodes) {
    if (node.id !== id && node.after.includes(id)) {
      working = rewriteAfter(working, node.id, node.after.filter(dependency => dependency !== id), `nodes.${node.id}.after`)
    }
  }

  parsed = parseEditable(working)
  for (const edge of dataEdges(parsed.definition.nodes)) {
    if (edge.to === id) {
      const node = requireNode(parsed.definition, edge.from)
      const targets = (node.outputs[edge.port] ?? []).filter(target => target !== id)
      working = replaceOutputPort(working, findNode(editableNodes(working, parseEditable(working)), edge.from), edge.port, targets)
      parsed = parseEditable(working)
    }
  }

  const target = findNode(editableNodes(working, parseEditable(working)), id)
  return applySplices(working, [{ start: target.itemStart, end: target.itemEnd, text: '' }])
}

function editScheduleEdge(
  source: string,
  operation: Extract<WorkflowEditOperation, { kind: 'add-schedule-edge' | 'remove-schedule-edge' }>,
): string {
  const parsed = parseEditable(source)
  requireNode(parsed.definition, operation.from)
  const target = requireNode(parsed.definition, operation.to)
  const hasEdge = target.after.includes(operation.from)
  const path = `nodes.${operation.to}.after`
  if (operation.kind === 'add-schedule-edge' && hasEdge) throw operationIssue(path, '调度边已存在')
  if (operation.kind === 'remove-schedule-edge' && !hasEdge) throw operationIssue(path, '调度边不存在')
  const next = operation.kind === 'add-schedule-edge'
    ? [...target.after, operation.from]
    : target.after.filter(dependency => dependency !== operation.from)
  return rewriteAfter(source, operation.to, next, path)
}

function editDataEdge(
  source: string,
  operation: Extract<WorkflowEditOperation, { kind: 'add-data-edge' | 'remove-data-edge' }>,
): string {
  const parsed = parseEditable(source)
  const sourceNode = requireNode(parsed.definition, operation.from)
  requireNode(parsed.definition, operation.to)
  const current = sourceNode.outputs[operation.port] ?? []
  const hasEdge = current.includes(operation.to)
  if (operation.kind === 'add-data-edge' && hasEdge) throw operationIssue(`outputs.${operation.port}`, '数据边已存在')
  if (operation.kind === 'remove-data-edge' && !hasEdge) throw operationIssue(`outputs.${operation.port}`, '数据边不存在')
  const next = operation.kind === 'add-data-edge'
    ? [...current, operation.to]
    : current.filter(target => target !== operation.to)
  const node = findNode(editableNodes(source, parsed), operation.from)
  return replaceOutputPort(source, node, operation.port, next)
}

/**
 * Apply one edit and validate the resulting YAML.
 *
 * A failure leaves the caller's source untouched because no result string is
 * returned. An unchanged field is preserved byte-for-byte outside the local
 * source range being replaced.
 * @param source - current valid YAML text.
 * @param operation - typed canvas operation.
 * @returns the generated text, parsed definition, and non-fatal parse issues.
 * @throws {WorkflowEditError} when the source cannot be edited or the result is invalid.
 */
export function applyWorkflowEdit(source: string, operation: WorkflowEditOperation): WorkflowEditSuccess {
  let next: string
  switch (operation.kind) {
    case 'add-node':
      next = addNode(source, operation)
      break
    case 'remove-node':
      next = removeNode(source, operation.id)
      break
    case 'add-schedule-edge':
    case 'remove-schedule-edge':
      next = editScheduleEdge(source, operation)
      break
    case 'add-data-edge':
    case 'remove-data-edge':
      next = editDataEdge(source, operation)
      break
  }

  const parsed = loadWorkflowDefinition(next)
  if (!parsed.ok) {
    const graph = loadWorkflowGraph(next)
    throw new WorkflowEditError(graph.issues.length === 0 ? parsed.issues : graph.issues, next)
  }
  return { text: next, definition: parsed.value, issues: parsed.issues }
}
