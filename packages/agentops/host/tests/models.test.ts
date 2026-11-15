import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAgentModelCatalog, type AgentModelLlm } from '../src/models.ts'

test('buildAgentModelCatalog：返回提供方与模型目录', async () => {
  const llm: AgentModelLlm = {
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'custom', name: 'Custom' },
    ],
    listModels: async provider => provider === 'deepseek'
      ? [
        { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General' },
        { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]
      : [],
  }

  assert.deepEqual(await buildAgentModelCatalog(llm), {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      },
      { id: 'custom', name: 'Custom', models: [] },
    ],
    failures: [],
  })
})

test('buildAgentModelCatalog：单个提供方失败不影响其他提供方', async () => {
  const llm: AgentModelLlm = {
    listProviders: () => [
      { id: 'healthy', name: 'Healthy' },
      { id: 'offline', name: 'Offline' },
    ],
    listModels: async (provider) => {
      if (provider === 'offline') throw new Error('catalog endpoint unavailable')
      return [{ provider, id: 'usable', name: 'Usable' }]
    },
  }

  assert.deepEqual(await buildAgentModelCatalog(llm), {
    providers: [{
      id: 'healthy',
      name: 'Healthy',
      models: [{ id: 'usable', name: 'Usable' }],
    }],
    failures: [{
      id: 'offline',
      name: 'Offline',
      message: 'catalog endpoint unavailable',
    }],
  })
})
