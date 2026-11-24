import { describe, expect, it } from 'vitest'

import { buildKnowledgeCategoryTree, countCategoryDocuments, type KnowledgeTreeDocument } from '../src/client/knowledge-tree.js'

const document = (id: string, title: string, categoryPath: string): KnowledgeTreeDocument => ({
  id,
  title,
  categoryPath,
  version: 1,
  updatedAt: '2026-11-16T00:00:00Z',
})

describe('knowledge category tree', () => {
  it('groups documents by nested category path and keeps root documents', () => {
    const tree = buildKnowledgeCategoryTree([
      document('metrics', '指标口径字典', '业务口径'),
      document('time', '时间口径', '业务口径'),
      document('tables', '数据目录', '数据目录/审批数据'),
      document('intro', '知识库说明', ''),
    ])

    expect(tree.documents.map(item => item.id)).toEqual(['intro'])
    const categories = new Map(tree.categories.map(item => [item.path, item]))
    expect(categories.get('业务口径')?.documents.map(item => item.id)).toEqual(['time', 'metrics'])
    expect(categories.get('数据目录')?.children[0]?.path).toBe('数据目录/审批数据')
    expect(countCategoryDocuments(categories.get('数据目录')!)).toBe(1)
  })

  it('sorts categories and documents deterministically', () => {
    const first = buildKnowledgeCategoryTree([
      document('b', '乙', '视频模板'),
      document('a', '甲', '动效卡片'),
      document('c', '丙', '视频模板'),
    ])
    const second = buildKnowledgeCategoryTree([
      document('c', '丙', '视频模板'),
      document('a', '甲', '动效卡片'),
      document('b', '乙', '视频模板'),
    ])

    expect(first).toEqual(second)
    expect(first.categories.map(item => item.name)).toEqual(['动效卡片', '视频模板'])
    expect(first.categories[1]?.documents.map(item => item.title)).toEqual(['丙', '乙'])
  })
})
