import { describe, expect, it } from 'vitest'

import {
  de,
  en,
  es,
  fr,
  ja,
  pt,
  ru,
  zh,
} from '../src/client/agent-locales/index.js'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map(match => match[1] ?? '')
    .sort()
}

describe('Agent dictionaries', () => {
  it('provide the same keys and interpolation slots in all eight languages', () => {
    const expectedKeys = Object.keys(zh).sort()
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(expectedKeys)
      for (const key of expectedKeys as (keyof typeof zh)[]) {
        expect(dictionary[key], key).not.toBe('')
        expect(placeholders(dictionary[key]), key).toEqual(placeholders(zh[key]))
      }
    }
  })
})
