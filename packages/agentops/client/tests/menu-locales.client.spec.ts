import { describe, expect, it } from 'vitest'

import {
  de as menuDe,
  en as menuEn,
  es as menuEs,
  fr as menuFr,
  ja as menuJa,
  pt as menuPt,
  ru as menuRu,
  zh as menuZh,
} from '../src/client/menu-locales.js'
import {
  de as tasksDe,
  en as tasksEn,
  es as tasksEs,
  fr as tasksFr,
  ja as tasksJa,
  pt as tasksPt,
  ru as tasksRu,
  zh as tasksZh,
} from '../src/client/task-locales.js'

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map(match => match[1] ?? '')
    .sort()
}

function assertComplete(
  dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
  source: Readonly<Record<string, string>>,
): void {
  const expectedKeys = Object.keys(source).sort()
  for (const dictionary of Object.values(dictionaries)) {
    expect(Object.keys(dictionary).sort()).toEqual(expectedKeys)
    for (const key of expectedKeys) {
      expect(dictionary[key], key).not.toBe('')
      expect(placeholders(dictionary[key] ?? ''), key).toEqual(placeholders(source[key] ?? ''))
    }
  }
}

describe('menu dictionaries', () => {
  it('provide the same keys and interpolation slots in all eight languages', () => {
    assertComplete(
      { zh: menuZh, en: menuEn, ja: menuJa, es: menuEs, fr: menuFr, de: menuDe, ru: menuRu, pt: menuPt },
      menuZh,
    )
  })
})

describe('task management dictionaries', () => {
  it('provide the same keys and interpolation slots in all eight languages', () => {
    assertComplete(
      { zh: tasksZh, en: tasksEn, ja: tasksJa, es: tasksEs, fr: tasksFr, de: tasksDe, ru: tasksRu, pt: tasksPt },
      tasksZh,
    )
  })
})
