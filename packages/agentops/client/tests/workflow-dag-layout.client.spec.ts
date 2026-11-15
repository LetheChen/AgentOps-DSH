import { describe, expect, it } from 'vitest'

import { dagEdgeKey, layoutDag } from '../src/client/workflow-dag-layout.js'

const OPTIONS = { nodeWidth: 100, nodeHeight: 40, columnGap: 50, rowGap: 10, padding: 8 }

describe('DAG 分层布局', () => {
  it('空定义不产生节点，尺寸只剩内边距', () => {
    const layout = layoutDag([], [], OPTIONS)
    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.width).toBe(16)
    expect(layout.height).toBe(16)
  })

  it('单节点落在第一列且垂直居中', () => {
    const layout = layoutDag([{ id: 'scan', level: 0 }], [], OPTIONS)
    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]).toMatchObject({ id: 'scan', level: 0, x: 8, y: 8, width: 100, height: 40 })
  })

  it('层号决定列，列间距按配置递增', () => {
    const layout = layoutDag(
      [{ id: 'a', level: 0 }, { id: 'b', level: 1 }, { id: 'c', level: 2 }],
      [],
      OPTIONS,
    )
    expect(layout.nodes.map(node => node.x)).toEqual([8, 158, 308])
    expect(layout.width).toBe(8 * 2 + 3 * 100 + 2 * 50)
  })

  it('同层节点纵向堆叠，且相对较高列居中', () => {
    const layout = layoutDag(
      [{ id: 'a', level: 0 }, { id: 'b', level: 1 }, { id: 'c', level: 1 }],
      [],
      OPTIONS,
    )
    const a = layout.nodes.find(node => node.id === 'a')
    const b = layout.nodes.find(node => node.id === 'b')
    const c = layout.nodes.find(node => node.id === 'c')
    expect(b?.y).toBe(8)
    expect(c?.y).toBe(8 + 40 + 10)
    // 单节点列在内容高度内居中：(90 - 40) / 2 + 8
    expect(a?.y).toBe(33)
  })

  it('未知节点的边被丢弃而不是画到原点', () => {
    const layout = layoutDag(
      [{ id: 'a', level: 0 }, { id: 'b', level: 1 }],
      [{ from: 'a', to: 'b' }, { from: 'ghost', to: 'b' }],
      OPTIONS,
    )
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0]).toMatchObject({ from: 'a', to: 'b' })
    expect(layout.edges[0]?.path.startsWith('M 108 ')).toBe(true)
  })

  it('回边与同列边向下绕行，且控制点不越出画布', () => {
    const forward = layoutDag([{ id: 'a', level: 0 }, { id: 'b', level: 1 }], [{ from: 'a', to: 'b' }], OPTIONS)
    const backward = layoutDag([{ id: 'a', level: 1 }, { id: 'b', level: 0 }], [{ from: 'a', to: 'b' }], OPTIONS)
    expect(backward.edges[0]?.path).not.toBe(forward.edges[0]?.path)

    for (const layout of [forward, backward]) {
      const numbers = (layout.edges[0]?.path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
      expect(numbers.length).toBeGreaterThan(0)
      expect(numbers.every(value => value >= 0)).toBe(true)
      expect(numbers.every(value => value <= Math.max(layout.width, layout.height))).toBe(true)
    }
  })

  it('同一输入两次布局完全一致', () => {
    const nodes = [{ id: 'a', level: 0 }, { id: 'b', level: 1 }, { id: 'c', level: 1 }]
    const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]
    expect(layoutDag(nodes, edges, OPTIONS)).toEqual(layoutDag(nodes, edges, OPTIONS))
  })

  it('未通过校验的 level=-1 排在最左列', () => {
    const layout = layoutDag([{ id: 'broken', level: -1 }, { id: 'ok', level: 0 }], [], OPTIONS)
    const broken = layout.nodes.find(node => node.id === 'broken')
    const ok = layout.nodes.find(node => node.id === 'ok')
    expect(broken?.x).toBe(8)
    expect(ok?.x).toBe(158)
  })

  it('缺省域为调度边，并保留数据边的 port', () => {
    const layout = layoutDag(
      [{ id: 'a', level: 0 }, { id: 'b', level: 1 }],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b', domain: 'data', port: 'records' },
      ],
      OPTIONS,
    )
    expect(layout.edges).toHaveLength(2)
    expect(layout.edges[0]).toMatchObject({ from: 'a', to: 'b', domain: 'schedule' })
    expect(layout.edges[1]).toMatchObject({ from: 'a', to: 'b', domain: 'data', port: 'records' })
  })

  it('同起止节点的不同域与端口生成互不冲突的 key', () => {
    expect(dagEdgeKey({ from: 'a', to: 'b' })).toBe('schedule:a->b')
    expect(dagEdgeKey({ from: 'a', to: 'b', domain: 'data', port: 'records' })).toBe('data:a->b:records')
    expect(dagEdgeKey({ from: 'a', to: 'b', domain: 'data', port: 'errors' })).not.toBe(
      dagEdgeKey({ from: 'a', to: 'b', domain: 'data', port: 'records' }),
    )
  })

  it('数据边参与路由但不改变拓扑层', () => {
    const nodes = [{ id: 'scan', level: 0 }, { id: 'analyze', level: 0 }]
    const withoutData = layoutDag(nodes, [], OPTIONS)
    const withData = layoutDag(
      nodes,
      [{ from: 'scan', to: 'analyze', domain: 'data', port: 'records' }],
      OPTIONS,
    )
    expect(withData.nodes.map(node => ({ id: node.id, level: node.level, x: node.x })))
      .toEqual(withoutData.nodes.map(node => ({ id: node.id, level: node.level, x: node.x })))
    expect(withData.edges).toHaveLength(1)
  })
})
