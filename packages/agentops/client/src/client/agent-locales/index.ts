/** `agentopsAgents` dictionaries for the Agent management surface. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

import { de } from './de.js'
import { en } from './en.js'
import { es } from './es.js'
import { fr } from './fr.js'
import { ja } from './ja.js'
import { pt } from './pt.js'
import { ru } from './ru.js'
import { zh, type AgentKey } from './zh.js'

/** Dictionary namespace owned by Agent management. */
export const AGENTS_NS = 'agentopsAgents'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent catalogue and editor copy. */
    agentopsAgents: AgentKey
  }
}

export { de, en, es, fr, ja, pt, ru, zh }
export type { AgentKey }
