import { expect, it } from 'vitest'

import { resolveClientConfig } from '../src/config.js'

it('parses the injected browser configuration and rejects malformed globals', () => {
  expect(resolveClientConfig(undefined).collaborationPollIntervalMs).toBe(3_000)
  expect(resolveClientConfig({ collaborationPollIntervalMs: 1_200 }).collaborationPollIntervalMs).toBe(1_200)
  expect(resolveClientConfig({ collaborationPollIntervalMs: 2_147_483_646 }).collaborationPollIntervalMs).toBe(2_147_483_646)

  for (const value of [null, [], 'invalid', true, { collaborationPollIntervalMs: 0 },
    { collaborationPollIntervalMs: '3000' }, { collaborationPollIntervalMs: null }]) {
    expect(() => resolveClientConfig(value)).toThrow()
  }
})
