import { describe, expect, it } from 'vitest'

import {
  createValidationSequence,
  findWorkflowById,
  insertSpaces,
  isSaveShortcut,
  nodeIdsForIssue,
  sourceRangeForIssue,
} from '../src/client/workflow-editor-logic.js'

describe('workflow editor logic', () => {
  it('Tab 插入两个空格并保留选区后的光标位置', () => {
    expect(insertSpaces('abc', 1, 1)).toEqual({ text: 'a  bc', selection: { start: 3, end: 3 } })
    expect(insertSpaces('abcd', 1, 3)).toEqual({ text: 'a  d', selection: { start: 3, end: 3 } })
  })

  it('Ctrl+S 与 Cmd+S 都是保存快捷键，带 Alt 的输入不是', () => {
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(isSaveShortcut({ key: 'S', ctrlKey: false, metaKey: true, altKey: false })).toBe(true)
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, altKey: true })).toBe(false)
    expect(isSaveShortcut({ key: 'x', ctrlKey: true, metaKey: false, altKey: false })).toBe(false)
  })

  it('CRLF 的源码定位按实际字符偏移计算', () => {
    const text = 'a\r\nb\r\nc'
    expect(sourceRangeForIssue(text, { line: 2, column: 1 })).toEqual({ start: 3, end: 4 })
    expect(sourceRangeForIssue(text, { line: 3, column: 2 })).toEqual({ start: 7, end: 7 })
  })

  it('越界行列钳制到最近的可选范围', () => {
    const text = 'abc\r\ndef'
    expect(sourceRangeForIssue(text, { line: -4, column: -2 })).toEqual({ start: 0, end: 3 })
    expect(sourceRangeForIssue(text, { line: 99, column: 99 })).toEqual({ start: 8, end: 8 })
    expect(sourceRangeForIssue(text, { line: 2, column: 99 })).toEqual({ start: 8, end: 8 })
  })

  it('新校验开始后旧响应不再是当前响应', () => {
    const sequence = createValidationSequence()
    const first = sequence.begin()
    const second = sequence.begin()
    expect(sequence.isCurrent(first)).toBe(false)
    expect(sequence.isCurrent(second)).toBe(true)
  })

  it('环 issue 产生去重后的高亮节点集合', () => {
    const ids = nodeIdsForIssue({
      kind: 'cycle',
      nodeIds: ['a', 'b', 'a'],
    })
    expect([...ids]).toEqual(['a', 'b'])
    expect(nodeIdsForIssue({}).size).toBe(0)
  })

  it('搜索隐藏当前工作流时仍可按 id 从全量条目找到它', () => {
    const entries = [{ id: 'alpha' }, { id: 'log-patrol' }]
    expect(findWorkflowById(entries, 'log-patrol')).toEqual({ id: 'log-patrol' })
    expect(findWorkflowById(entries, 'missing')).toBeNull()
  })
})
