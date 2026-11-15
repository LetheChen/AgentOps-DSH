import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'

import { Config } from '../src/config.ts'
import { apply } from '../src/index.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('validates the collaboration poll interval and publishes it to browser pages', async () => {
  expect(Config({}).collaborationPollIntervalMs).toBe(3_000)
  expect(Config({ collaborationPollIntervalMs: 1 }).collaborationPollIntervalMs).toBe(1)
  expect(Config({ collaborationPollIntervalMs: 2_147_483_646 }).collaborationPollIntervalMs).toBe(2_147_483_646)
  for (const value of [0, -1, 1.5, 2_147_483_647, Infinity, NaN]) {
    expect(() => Config({ collaborationPollIntervalMs: value })).toThrow()
  }

  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ collaborationPollIntervalMs: 1_250 })
  const fiber = ctx.plugin({ apply }, config)
  await fiber.await()

  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, PAGE_PEER)
  expect(rows).toEqual([{
    kind: 'global',
    name: '__DSH_AGENTOPS_CLIENT_CONFIG__',
    value: { collaborationPollIntervalMs: 1_250 },
  }])

  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, PAGE_PEER)
  expect(after).toEqual([])
})
