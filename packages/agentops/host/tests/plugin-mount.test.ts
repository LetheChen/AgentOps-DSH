import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyRoot, inject as rootInject, name as rootName } from '../src/index.ts'
import { apply as applyTools, inject as toolsInject, name as toolsName } from '../src/tools.ts'

void test('插件身份：root 无注入，tools 半注入 tools', () => {
  assert.equal(rootName, 'agentops-system')
  assert.deepEqual(rootInject, [], 'root 不能注入 tools：该服务只在 Agent 作用域提供')
  assert.equal(typeof applyRoot, 'function')

  assert.equal(toolsName, 'agentops-system-tools')
  assert.deepEqual(toolsInject, ['tools'])
  assert.equal(typeof applyTools, 'function')
})

void test('root apply 只挂路由，不触碰工具注册表', () => {
  let touched = false
  const routes: string[] = []
  const ctx = {
    tools: { register: () => { touched = true; return () => {} } },
    // The root half looks up optional services; a deployment without them must
    // still mount (the pages degrade, the plugin does not fail).
    get: () => undefined,
    inject: (_deps: string[], callback: (scope: unknown) => void) =>{  callback(ctx) },
    effect: (factory: () => unknown) => { factory(); return () => {} },
    connection: {
      fetch: { register: (route: { path: string }) => { routes.push(route.path); return async () => {} } },
    },
  }
  applyRoot(ctx as never)
  assert.equal(touched, false)
  assert.ok(routes.includes('/api/agentops/surfaces/views'))
  assert.equal(routes.includes('/api/agentops/system'), false)
  assert.equal(routes.includes('/api/agentops/providers'), false)
  assert.equal(routes.includes('/api/agentops/credentials'), false)
})

void test('tools 半只注册一个只读工具，不写会话、不读文件', () => {
  const registered: { name: string }[] = []
  const ctx = {
    tools: {
      register: (definition: { name: string }) => {
        registered.push(definition)
        return () => {}
      },
    },
  }
  applyTools(ctx as never)
  assert.deepEqual(registered.map(tool => tool.name).sort(), ['agentops_system_status', 'board_cleanup', 'present_content'])
})

void test('tools 半在缺少 tools 服务时抛出，而不是静默成功', () => {
  assert.throws(() =>{  applyTools({} as never) }, /tools|undefined/i)
})
