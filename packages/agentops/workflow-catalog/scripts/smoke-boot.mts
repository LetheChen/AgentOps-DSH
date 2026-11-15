/**
 * Startup smoke: mount the catalogue through the Cordis Loader and call it.
 *
 * This is a script rather than a vitest spec on purpose. Under vite the
 * Loader's dynamic import resolves the package graph to a second copy of
 * `@deepseek-ai/cordis`, so the service registers on a different `Context`
 * class and `root.get('workflowCatalog')` returns undefined even though the
 * boot itself succeeded. Run through tsx (native ESM, one copy) it works.
 *
 * Usage: pnpm exec tsx packages/agentops/workflow-catalog/scripts/smoke-boot.mts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const ENTRY = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.ts')).href

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

const checks: Array<{ id: string; ok: boolean; detail: string }> = []
const check = (id: string, ok: boolean, detail: string): void => {
  checks.push({ id, ok, detail })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-catalog-boot-'))
  writeFileSync(join(dir, 'log-patrol.yaml'), VALID, 'utf8')

  const root = new Context()
  await root.plugin(Loader, { baseUrl: ENTRY })
  try {
    const id = await root.loader.create({ name: ENTRY, config: { directory: dir } })
    check('B1 Loader 能装配插件', typeof id === 'string', `entry=${id}`)

    const service = root.get('workflowCatalog')
    check('B2 代理上能取到服务', service !== undefined, `typeof=${typeof service}`)
    if (service === undefined) return

    check('B3 配置透传到服务', service.directory === dir, `directory=${service.directory}`)

    const listing = await service.list()
    check('B4 list() 经代理可用', listing.entries.length === 1, JSON.stringify(listing.entries.map(entry => entry.workflowId)))

    const compiled = await service.compile('log-patrol')
    check('B5 compile() 经代理可用', compiled.ok && compiled.value.layers.length === 2, `result=${JSON.stringify(compiled)}`)
  } finally {
    await root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = checks.filter(item => !item.ok)
  process.stdout.write(`\nworkflowCatalog 启动冒烟（${checks.length - failed.length}/${checks.length} 通过）\n`)
  for (const item of checks) process.stdout.write(`${item.ok ? '✔' : '✘'} ${item.id}\n    ${item.detail}\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()