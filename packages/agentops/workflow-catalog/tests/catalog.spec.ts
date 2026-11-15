import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { compileWorkflow } from '@agentops/dsh-workflow-compiler'

import {
  CatalogConflictError,
  CatalogCreateConflictError,
  CatalogInvalidError,
  WorkflowCatalog,
  digestOf,
} from '../src/index.js'

const VALID = `workflow_id: log-patrol
version: 2
business_id: maxkb
nodes:
  - id: scan
    agent: log_analyst
    role_prompt: 扫描日志
  - id: report
    agent: log_analyst
    role_prompt: 写报告
    after: [scan]
`

function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-catalog-'))
  return run(dir).finally(() => { rmSync(dir, { recursive: true, force: true }) })
}

describe('workflowCatalog 读取', () => {
  it('目录不存在时返回空清单而不是抛错', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(join(dir, 'missing'))
      await expect(catalog.list()).resolves.toEqual({ entries: [], issues: [] })
    })
  })

  it('列出定义，并把坏文件作为 issue 保留', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      writeFileSync(join(dir, 'broken.yaml'), 'workflow_id: x\nnodes: []\n', 'utf8')
      const catalog = new WorkflowCatalog(dir)

      const listing = await catalog.list()
      expect(listing.entries.map(entry => entry.workflowId)).toEqual(['log-patrol'])
      expect(listing.entries[0]?.nodeCount).toBe(2)
      expect(listing.entries[0]?.digest).toBe(digestOf(VALID))
      expect(listing.issues.map(issue => issue.file)).toEqual(['broken.yaml'])
    })
  })

  it('read 返回原文、定义与指纹', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const read = await new WorkflowCatalog(dir).read('log-patrol')
      expect(read.text).toBe(VALID)
      expect(read.definition.workflowId).toBe('log-patrol')
      expect(read.digest).toBe(digestOf(VALID))
    })
  })

  it('readSource 即使 YAML 损坏也返回原文与指纹', async () => {
    await withDir(async (dir) => {
      const broken = 'workflow_id: broken\nnodes:\n  scan: [\n'
      writeFileSync(join(dir, 'broken.yaml'), broken, 'utf8')
      const source = await new WorkflowCatalog(dir).readSource('broken')
      expect(source).toEqual({ text: broken, digest: digestOf(broken) })
    })
  })

  it('readSource 缺少文件时保留 ENOENT', async () => {
    await withDir(async (dir) => {
      const failure = await new WorkflowCatalog(dir).readSource('missing').catch((reason: unknown) => reason)
      expect(failure).toMatchObject({ code: 'ENOENT' })
    })
  })

  it('compile 给出分层与指纹', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const compiled = await new WorkflowCatalog(dir).compile('log-patrol')
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) throw new Error('compile failed')
      expect(compiled.value.layers).toEqual([['scan'], ['report']])
      expect(compiled.value.source).toContain('phase("layer-0")')
      expect(compiled.value.digest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  it('validateAndCompile 使用解析后的定义生成预览', async () => {
    const catalog = new WorkflowCatalog('unused')
    const result = catalog.validateAndCompile(VALID)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a valid workflow')
    expect(result.compiled).toEqual(compileWorkflow(result.value))
    expect(result.compiled.ok).toBe(true)
    if (!result.compiled.ok) throw new Error('compile failed')
    expect(result.compiled.value.layers).toEqual([['scan'], ['report']])
  })

  it('validateAndCompile 失败时只返回 issues，不返回 compiled', async () => {
    const result = new WorkflowCatalog('unused').validateAndCompile('workflow_id: broken\nnodes: []\n')

    expect(result.ok).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect('compiled' in result).toBe(false)
  })

  it('compileDefinition 与共享编译器保持一致', async () => {
    const catalog = new WorkflowCatalog('unused')
    const validated = catalog.validate(VALID)
    if (!validated.ok) throw new Error('expected a valid workflow')

    expect(catalog.compileDefinition(validated.value)).toEqual(compileWorkflow(validated.value))
  })

  it('非法 workflowId 被拒，不落到文件系统', async () => {
    await withDir(async (dir) => {
      await expect(new WorkflowCatalog(dir).read('../escape')).rejects.toThrow(RangeError)
    })
  })
})

describe('workflowCatalog 保存（CAS）', () => {
  it('新建时 expectedDigest 必须为 null', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(dir)
      expect((await catalog.save('log-patrol', VALID, null)).digest).toBe(digestOf(VALID))
      expect(readFileSync(join(dir, 'log-patrol.yaml'), 'utf8')).toBe(VALID)
    })
  })

  it('文件已存在却按新建提交时报冲突', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const catalog = new WorkflowCatalog(dir)
      await expect(catalog.save('log-patrol', VALID, null)).rejects.toBeInstanceOf(CatalogConflictError)
    })
  })

  it('基于旧指纹保存会被拒绝，且磁盘内容不变', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const catalog = new WorkflowCatalog(dir)
      const changed = VALID.replace('扫描日志', '扫描日志（新版）')

      const failure = await catalog.save('log-patrol', changed, 'deadbeef').catch((reason: unknown) => reason)
      expect(failure).toBeInstanceOf(CatalogConflictError)
      expect((failure as CatalogConflictError).actual).toBe(digestOf(VALID))
      expect(readFileSync(join(dir, 'log-patrol.yaml'), 'utf8')).toBe(VALID)
    })
  })

  it('指纹匹配时覆盖成功，返回新指纹', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const catalog = new WorkflowCatalog(dir)
      const changed = VALID.replace('扫描日志', '扫描日志（新版）')

      const saved = await catalog.save('log-patrol', changed, digestOf(VALID))
      expect(saved.digest).toBe(digestOf(changed))
      expect(readFileSync(join(dir, 'log-patrol.yaml'), 'utf8')).toBe(changed)

      // 旧指纹已失效，再次提交必须冲突
      await expect(catalog.save('log-patrol', VALID, digestOf(VALID))).rejects.toBeInstanceOf(CatalogConflictError)
    })
  })

  it('非法定义在写盘前就被拒', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(dir)
      const failure = await catalog.save('log-patrol', 'workflow_id: log-patrol\nnodes: []\n', null).catch((reason: unknown) => reason)
      expect(failure).toBeInstanceOf(CatalogInvalidError)
      expect((failure as CatalogInvalidError).issues.length).toBeGreaterThan(0)
    })
  })

  it('文件内的 workflow_id 与文件名不一致时拒绝', async () => {
    await withDir(async (dir) => {
      const other = VALID.replace('workflow_id: log-patrol', 'workflow_id: another')
      await expect(new WorkflowCatalog(dir).save('log-patrol', other, null)).rejects.toBeInstanceOf(CatalogInvalidError)
    })
  })
})

describe('workflowCatalog 原子创建', () => {
  it('创建新文件并返回指纹', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(join(dir, 'nested'))
      await expect(catalog.create('log-patrol', VALID)).resolves.toEqual({ digest: digestOf(VALID) })
      expect(readFileSync(join(dir, 'nested', 'log-patrol.yaml'), 'utf8')).toBe(VALID)
    })
  })

  it('并发创建同一 ID 时只有一个成功，另一个返回创建冲突', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(dir)
      const results = await Promise.allSettled([
        catalog.create('log-patrol', VALID),
        catalog.create('log-patrol', VALID.replace('扫描日志', '并发版本')),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find(result => result.status === 'rejected')
      expect(rejected?.status).toBe('rejected')
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(CatalogCreateConflictError)
      }
    })
  })

  it('已存在的文件不会被创建操作覆盖', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      const changed = VALID.replace('扫描日志', '不应写入')
      await expect(new WorkflowCatalog(dir).create('log-patrol', changed))
        .rejects.toBeInstanceOf(CatalogCreateConflictError)
      expect(readFileSync(join(dir, 'log-patrol.yaml'), 'utf8')).toBe(VALID)
    })
  })

  it('创建前校验 YAML、ID 与文件内 workflow_id', async () => {
    await withDir(async (dir) => {
      const catalog = new WorkflowCatalog(dir)
      await expect(catalog.create('log-patrol', 'workflow_id: log-patrol\nnodes: []\n'))
        .rejects.toBeInstanceOf(CatalogInvalidError)
      await expect(catalog.create('other', VALID)).rejects.toBeInstanceOf(CatalogInvalidError)
      await expect(catalog.create('../escape', VALID)).rejects.toBeInstanceOf(RangeError)
      expect(readdirSync(dir)).toEqual([])
    })
  })
})

describe('workflowCatalog 删除', () => {
  it('只删除目标文件并保留目录', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')
      writeFileSync(join(dir, 'keep.yaml'), VALID.replace('log-patrol', 'keep'), 'utf8')
      const catalog = new WorkflowCatalog(dir)

      await catalog.remove('log-patrol')

      expect(() => readFileSync(join(dir, 'log-patrol.yaml'))).toThrow()
      expect(readFileSync(join(dir, 'keep.yaml'), 'utf8')).toContain('workflow_id: keep')
      expect(readdirSync(dir).sort()).toEqual(['keep.yaml'])
    })
  })

  it('非法 id 在触碰文件系统前被拒绝', async () => {
    await withDir(async (dir) => {
      await expect(new WorkflowCatalog(dir).remove('../escape')).rejects.toThrow(RangeError)
    })
  })

  it('缺失文件保留 ENOENT', async () => {
    await withDir(async (dir) => {
      const failure = await new WorkflowCatalog(dir).remove('missing').catch((reason: unknown) => reason)
      expect(failure).toMatchObject({ code: 'ENOENT' })
    })
  })
})
