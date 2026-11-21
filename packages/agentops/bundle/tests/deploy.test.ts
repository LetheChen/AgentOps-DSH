import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

import { seedAgentOps } from '../../deploy/seed-agentops.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deployDir = resolve(here, '..', '..', 'deploy')

void test('部署：compose 与 Dockerfile 可解析且相互引用一致', () => {
  const compose = load(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')) as {
    services: Record<string, { build?: { dockerfile?: string }; image?: string; healthcheck?: { test?: string[] } }>
  }
  const services = Object.keys(compose.services)
  assert.deepEqual(services.sort(), ['dsh'])

  const dockerfile = compose.services.dsh!.build?.dockerfile
  assert.equal(dockerfile, 'packages/agentops/deploy/Dockerfile')
  assert.ok(existsSync(join(deployDir, 'Dockerfile')))

  for (const name of services) {
    const health = compose.services[name]!.healthcheck?.test ?? []
    assert.equal(health[0], 'CMD')
    assert.ok(health.some(part => part.endsWith('healthcheck.mjs')), `${name} 缺少健康检查脚本`)
  }
})

void test('部署：挂载补丁的 root 行都指向镜像内绝对路径', () => {
  const patch = load(readFileSync(join(deployDir, 'agentops.patch.yml'), 'utf8')) as {
    insert: { id: string; name: string; config?: { plugins?: { name: string }[] } }[]
  }[]
  const rows = patch.flatMap(entry => entry.insert)
  const rootRows = rows.filter(row => row.config?.plugins === undefined)
  const presetRows = rows.flatMap(row => row.config?.plugins ?? [])

  assert.equal(rootRows.length, 13, `root 行应为 13 个，实际 ${rootRows.length}`)
  for (const row of rootRows) {
    assert.ok(row.name.startsWith('/app/packages/agentops/'), `${row.id} 不是镜像内绝对路径：${row.name}`)
  }

  assert.equal(presetRows.length, 6, `preset 工具行应为 6 个，实际 ${presetRows.length}`)
  for (const row of presetRows) {
    assert.ok(row.name.startsWith('@agentops/'), `preset 行必须按包名解析：${row.name}`)
  }
})

void test('部署：bootstrap 链接的包都存在', () => {
  const source = readFileSync(join(deployDir, 'bootstrap.mjs'), 'utf8')
  const listed = [...source.matchAll(/'([a-z-]+)'/g)].map(match => match[1])
  const packages = ['host', 'knowledge', 'dag', 'task', 'vault', 'capability', 'log-collection', 'deployment', 'ui-capability', 'security', 'db', 'workflow-catalog', 'client', 'bundle']
  for (const name of packages) {
    assert.ok(listed.includes(name), `bootstrap 未链接 ${name}`)
    assert.ok(existsSync(resolve(deployDir, '..', name, 'package.json')), `包不存在：${name}`)
  }
})

void test('部署：seed 导入全部迁移资产，默认不覆盖、--force 才覆盖', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'agentops-seed-'))
  const assetRoot = resolve(deployDir, '..', '..', '..', 'agentops')
  const yamlAssets = (dir: string): string[] => readdirSync(join(assetRoot, dir))
    .filter(name => name.endsWith('.yaml'))
    .sort()
  const skillsRoot = resolve(deployDir, '..', 'skills')
  const skillFiles = readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => `skills/${join(entry.parentPath, entry.name).slice(skillsRoot.length + 1).replaceAll('\\', '/')}`)
    .sort()
  const expected = [
    ...yamlAssets('agents').map(name => `agents/${name}`),
    ...yamlAssets('workflows').map(name => `workflows/${name}`),
    ...yamlAssets('mappings').map(name => `mappings/${name}`),
    ...yamlAssets('domains').map(name => `domains/${name}`),
    ...readdirSync(join(assetRoot, 'actors'))
      .map(name => `actors/${name}/actor_visual_profile.json`),
    ...skillFiles,
  ].sort()
  try {
    const first = seedAgentOps({ dshHome })
    assert.deepEqual(first.copied.sort(), expected)
    assert.deepEqual(readdirSync(join(dshHome, 'agentops', 'agents')).sort(), yamlAssets('agents'))
    assert.deepEqual(readdirSync(join(dshHome, 'agentops', 'workflows')).sort(), yamlAssets('workflows'))
    assert.deepEqual(readdirSync(join(dshHome, 'agentops', 'mappings')).sort(), yamlAssets('mappings'))
    assert.deepEqual(readdirSync(join(dshHome, 'agentops', 'domains')).sort(), yamlAssets('domains'))
    assert.ok(existsSync(join(dshHome, 'agentops', 'actors', 'log_puller', 'actor_visual_profile.json')))
    assert.ok(existsSync(join(dshHome, 'agentops', 'skills', 'data-query', 'SKILL.md')))
    assert.ok(existsSync(join(dshHome, 'agentops', 'skills', 'weekly-report-summary', 'SKILL.md')))

    const manager = join(dshHome, 'agentops', 'agents', 'manager.yaml')
    writeFileSync(manager, '# local edit\n', 'utf8')
    const second = seedAgentOps({ dshHome })
    assert.deepEqual(second.copied, [])
    assert.equal(second.skipped.length, expected.length)
    assert.equal(readFileSync(manager, 'utf8'), '# local edit\n')

    const forced = seedAgentOps({ dshHome, force: true })
    assert.equal(forced.copied.length, expected.length)
    assert.match(readFileSync(manager, 'utf8'), /agent_id: manager/)
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})

void test('部署：镜像携带迁移资产，启动时 seed 并挂载生成式 Agent preset', () => {
  const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /COPY agentops\/agents \.\/agentops\/agents/)
  assert.match(dockerfile, /COPY agentops\/workflows \.\/agentops\/workflows/)
  assert.match(dockerfile, /COPY agentops\/mappings \.\/agentops\/mappings/)
  assert.match(dockerfile, /COPY agentops\/domains \.\/agentops\/domains/)
  assert.match(dockerfile, /COPY agentops\/actors \.\/agentops\/actors/)
  assert.match(dockerfile, /CMD \["node", "\/app\/packages\/agentops\/deploy\/bootstrap\.mjs"\]/)

  const bootstrap = readFileSync(join(deployDir, 'bootstrap.mjs'), 'utf8')
  assert.match(bootstrap, /seedAgentOps\(\{ dshHome \}\)/)
  assert.match(bootstrap, /'--patch', '\/etc\/agentops\/agentops\.patch\.yml'/)
  assert.match(bootstrap, /'--patch', '\/app\/packages\/agentops\/browser\/cordis\.patch\.yml'/)
  assert.match(bootstrap, /'--patch', '\/app\/packages\/agentops\/bundle\/presets\/agents\.generated\.patch\.yml'/)
})

void test('部署：Agent 与工作流目录位于持久化 DSH_HOME', () => {
  type PatchConfig = {
    agentDir?: string
    workflowDir?: string
    domainDir?: string
    actorDir?: string
    directory?: string
  }
  const patch = load(readFileSync(join(deployDir, 'agentops.patch.yml'), 'utf8')) as {
    insert: { config?: PatchConfig & { plugins?: { config?: PatchConfig }[] } }[]
  }[]
  const configs: (PatchConfig | undefined)[] = patch.flatMap(entry => entry.insert).flatMap((row) => {
    const nested = row.config?.plugins ?? []
    return [row.config, ...nested.map(plugin => plugin.config)]
  })
  const paths = configs
    .flatMap(config => [
      config?.agentDir,
      config?.workflowDir,
      config?.domainDir,
      config?.actorDir,
      config?.directory,
    ])
    .filter((path): path is string => path !== undefined)

  assert.ok(paths.includes('/data/dsh/agentops/agents'))
  assert.ok(paths.includes('/data/dsh/agentops/domains'))
  assert.ok(paths.includes('/data/dsh/agentops/actors'))
  assert.equal(paths.filter(path => path === '/data/dsh/agentops/workflows').length, 3)
  assert.ok(paths.every(path => path.startsWith('/data/dsh/agentops/')))
})
