/**
 * Bundle manifest contract tests.
 *
 * The bundle is the only thing a deployment installs, so a typo here is a
 * broken install that only shows up at boot. These tests fail fast instead:
 * patch layers must exist, every row must resolve to a real workspace package,
 * and every row's entry must be exported by that package.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const bundleDir = resolve(here, '..')
const agentopsDir = resolve(bundleDir, '..')
const repoPackagesDir = resolve(agentopsDir, '..')
const repoAssetDir = resolve(agentopsDir, '..', '..', 'agentops')

interface Row { id: string; name: string; config?: unknown; disabled?: unknown }
interface Layer { insert?: Row[] }

/** Patch files use `!!js dshHomePath(...)`; tests only need its scalar text. */
const dshExpression = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string): string => value,
})
const patchSchema = DEFAULT_SCHEMA.extend([dshExpression])

const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as {
  files: string[]
  dsh: { bundle: { patch: string[] } }
}

function loadLayer(relative: string): Row[] {
  const raw = load(readFileSync(join(bundleDir, relative), 'utf8'), { schema: patchSchema }) as Layer[]
  return raw.flatMap(entry => entry.insert ?? [])
}

/** Rows plus any nested preset `config.plugins` entries, which is where tools live. */
function flattenRows(rows: readonly Row[]): Row[] {
  return rows.flatMap((row) => {
    const plugins = (row.config as { plugins?: unknown } | undefined)?.plugins
    const nested = Array.isArray(plugins) ? plugins as Row[] : []
    return [row, ...flattenRows(nested)]
  })
}

function allRows(): Row[] {
  return manifest.dsh.bundle.patch.flatMap(layer => flattenRows(loadLayer(layer)))
}

/** Index workspace package names to directories: AgentOps packages and repo packages. */
function workspaceIndex(): Map<string, string> {
  const index = new Map<string, string>()
  const register = (dir: string): void => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string }
    index.set(pkg.name, dir)
  }

  for (const entry of readdirSync(agentopsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) register(join(agentopsDir, entry.name))
  }
  for (const group of readdirSync(repoPackagesDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(repoPackagesDir, group.name)
    if (existsSync(join(groupDir, 'package.json'))) { register(groupDir); continue }
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) register(join(groupDir, entry.name))
    }
  }
  return index
}

const workspace = workspaceIndex()

/**
 * Map a plugin specifier (`@agentops/dsh-host/tools`) to its workspace package
 * directory and the export subpath. Core `@deepseek-ai/*` rows resolve through
 * the same index, so a typo in either namespace fails the test.
 */
function resolveSpecifier(specifier: string): { dir: string; subpath: string } {
  const parts = specifier.split('/')
  const scoped = specifier.startsWith('@')
  const packageName = scoped ? `${parts[0]}/${parts[1]}` : parts[0]!
  const subpath = parts.slice(scoped ? 2 : 1).join('/')
  const dir = workspace.get(packageName)
  return { dir: dir ?? join(agentopsDir, '__missing__', packageName), subpath: subpath.length === 0 ? '.' : `./${subpath}` }
}

void test('bundle 清单：patch 层文件都存在且在 files 里', () => {
  for (const layer of manifest.dsh.bundle.patch) {
    assert.ok(existsSync(join(bundleDir, layer)), `缺少 patch 层：${layer}`)
    assert.ok(manifest.files.includes(layer.replace(/^\.\//, '')), `files 未包含：${layer}`)
  }
})

void test('bundle 清单：每行都能解析到真实包，且入口被子路径导出', () => {
  const rows = allRows()
  assert.ok(rows.length >= 10, `行数过少：${rows.length}`)

  for (const row of rows) {
    const { dir, subpath } = resolveSpecifier(row.name)
    const manifestPath = join(dir, 'package.json')
    assert.ok(existsSync(manifestPath), `${row.id} 指向不存在的包：${row.name}`)

    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string
      exports?: Record<string, unknown>
    }
    assert.equal(pkg.name, row.name.split('/').slice(0, 2).join('/'), `${row.id} 包名不一致`)
    assert.ok(pkg.exports?.[subpath] !== undefined, `${row.id} 的入口 ${subpath} 未被导出`)
  }
})

void test('bundle 清单：root 层不声明 inject tools，工具都在 preset 层', () => {
  const [rootLayer] = manifest.dsh.bundle.patch
  const rootRows = loadLayer(rootLayer!)
  const presetRows = allRows().filter(row => /\/tools(-v1)?$/.test(row.name))

  assert.ok(rootRows.every(row => row.id !== 'agentops-task-tools'), '工具行不应出现在 root 层')
  assert.ok(presetRows.length >= 5, `preset 层应包含 5 个工具行，实际 ${presetRows.length}`)
})

void test('bundle 清单：preset registry 覆盖 web-app 行而不重复插入', () => {
  const rootRows = loadLayer('./cordis.patch.yml')
  assert.equal(rootRows.filter(row => row.id === 'agent-preset-registry').length, 0)
  const raw = load(readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8'), { schema: patchSchema }) as Row[]
  assert.equal(raw.filter(row => row.id === 'agent-preset-registry').length, 1)
  assert.deepEqual((raw.find(row => row.id === 'agent-preset-registry')?.config as { default?: string }), { default: 'manager' })
})

void test('bundle 清单：解析器对不存在的包会失败（守卫本身有牙）', () => {
  const { dir } = resolveSpecifier('@agentops/dsh-does-not-exist/tools')
  assert.equal(existsSync(dir), false)
})

void test('bundle 清单：模块 id 唯一', () => {
  const rootIds = manifest.dsh.bundle.patch.flatMap(layer => loadLayer(layer).map(row => row.id))
  assert.equal(new Set(rootIds).size, rootIds.length, `根层存在重复 id：${rootIds.join(', ')}`)

  for (const row of allRows().filter(row => Array.isArray((row.config as { plugins?: unknown } | undefined)?.plugins))) {
    const ids = ((row.config as { plugins: Row[] }).plugins).map(plugin => plugin.id)
    assert.equal(new Set(ids).size, ids.length, `${row.id} 内存在重复 id：${ids.join(', ')}`)
  }
})

void test('bundle 清单：挂载 tool-skill 的 preset 绑定同一运行时 skill 目录', () => {
  const presets = loadLayer('./presets/agents.generated.patch.yml')
  const skillPresets = presets.filter(row =>
    ((row.config as { plugins?: Row[] } | undefined)?.plugins ?? []).some(plugin => plugin.id === 'tool-skill'))
  assert.ok(skillPresets.length > 0, '没有 preset 挂载 tool-skill')

  for (const preset of skillPresets) {
    const plugins = (preset.config as { plugins: Row[] }).plugins
    const provider = plugins.find(plugin => plugin.id === 'skill-filesystem')
    const config = provider?.config as { customSkillDirs?: unknown[]; disabledSkillsFile?: unknown } | undefined
    assert.deepEqual(config?.customSkillDirs, ["dshHomePath('agentops', 'skills')"], `${preset.id} 的 skill 根不一致`)
    assert.equal(config?.disabledSkillsFile, "dshHomePath('agentops', 'skills-disabled.json')", `${preset.id} 的禁用文件不一致`)
  }
})
void test('bundle 清单：生成式 Agent preset 覆盖全部迁移 Agent', () => {
  const relative = './presets/agents.generated.patch.yml'
  assert.ok(manifest.files.includes(relative.replace(/^\.\//, '')), 'files 未包含生成式 Agent preset')
  assert.ok(manifest.dsh.bundle.patch.includes(relative), 'patch 清单未挂载生成式 Agent preset')

  const ids = loadLayer(relative).map(row => (row.config as { id?: string } | undefined)?.id)
  const expected = readdirSync(join(repoAssetDir, 'agents'))
    .filter(name => name.endsWith('.yaml'))
    .map(name => name.replace(/\.yaml$/, ''))
    .sort()
  assert.deepEqual(ids.sort(), expected)
})

void test('bundle 清单：部署与构建 operator 使用最小工具面', () => {
  const presets = loadLayer('./presets/agents.generated.patch.yml')
  const pluginsOf = (id: string): Row[] => {
    const preset = presets.find(row => row.id === `preset-agent-${id}`)
    const plugins = (preset?.config as { plugins?: Row[] } | undefined)?.plugins
    assert.ok(Array.isArray(plugins), `${id} 缺少 plugins`)
    return plugins
  }
  const build = pluginsOf('build_operator')
  assert.deepEqual(build.find(row => row.id === 'deployment-tools')?.config, { agentPreset: 'build_operator', only: ['artifact_build'] })
  assert.equal(build.some(row => row.name === '@deepseek-ai/dsh-tool-pwsh'), false)
  const deploy = pluginsOf('deploy_operator')
  assert.deepEqual(deploy.find(row => row.id === 'deployment-tools')?.config, {
    agentPreset: 'deploy_operator',
    only: ['deployment_plan', 'deployment_release', 'deployment_status', 'deployment_rollback'],
  })
  assert.equal(deploy.some(row => row.name === '@deepseek-ai/dsh-tool-pwsh'), false)
  assert.equal(deploy.some(row => row.name === '@deepseek-ai/dsh-tool-fs' && (row.config as { write?: boolean } | undefined)?.write === true), false)
})
