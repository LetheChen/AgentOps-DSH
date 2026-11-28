import { describe, expect, it } from 'vitest'

import { isSafeGenerativeUiPreviewUri } from '../src/client/a2ui/lib/artifact-uri.js'

describe('generative-UI preview URI allowlist', () => {
  it('accepts content-addressed surface images with a canonical digest', () => {
    expect(isSafeGenerativeUiPreviewUri(`/api/agentops/surfaces/asset?digest=${'a'.repeat(64)}`)).toBe(true)
  })

  it('rejects malformed, traversal, and active-content image sources', () => {
    expect(isSafeGenerativeUiPreviewUri('/api/agentops/surfaces/asset?digest=short')).toBe(false)
    expect(isSafeGenerativeUiPreviewUri(`/api/agentops/surfaces/asset?digest=${'a'.repeat(64)}&next=../x`)).toBe(false)
    expect(isSafeGenerativeUiPreviewUri('data:image/svg+xml,<svg/>')).toBe(false)
    expect(isSafeGenerativeUiPreviewUri('/images/../secret.png')).toBe(false)
  })
})
