import { describe, expect, it } from 'vitest'

import {
  SECURITY_NS,
  de,
  en,
  es,
  fr,
  ja,
  pt,
  ru,
  zh,
} from '../src/client/security-locales.js'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map(match => match[1] ?? '')
    .sort()
}

describe('security dictionaries', () => {
  it('uses the registered AgentOps security namespace', () => {
    expect(SECURITY_NS).toBe('agentopsSecurity')
  })

  it('provide the same keys and interpolation slots in all eight languages', () => {
    const expectedKeys = Object.keys(zh).sort()
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(expectedKeys)
      for (const key of expectedKeys as (keyof typeof zh)[]) {
        expect(dictionary[key].trim(), key).not.toBe('')
        expect(placeholders(dictionary[key]), key).toEqual(placeholders(zh[key]))
      }
    }
  })
})
