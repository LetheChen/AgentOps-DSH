/** Agent-operation feedback rendered in the application overlay. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Localized transient Agent-operation notice. */
export interface AgentFeedbackNotice {
  readonly text: string
  readonly tone: 'success' | 'failure'
  readonly seq: number
}

/** Registration-owned Agent notice source and dismissal callback. */
export interface AgentFeedbackInjected {
  readonly hooks: { readonly notice: SnapshotStore<AgentFeedbackNotice | null> }
  readonly dismiss: () => void
}

/** Shared Agent feedback store and its application-overlay registration. */
export interface AgentFeedback {
  readonly notice: SnapshotStore<AgentFeedbackNotice | null>
  /** @param text - already localized success copy. */
  readonly publishSuccess: (text: string) => void
  /** @param text - already localized failure copy. */
  readonly publishFailure: (text: string) => void
  readonly dismiss: () => void
  /** @param ctx - client plugin context carrying slots. */
  readonly register: (ctx: Context) => void
}

/**
 * Render the current Agent notice after its requesting panel unmounts.
 * @param props - framework-bound notice source and dismissal callback.
 * @returns the current notice toast, or nothing.
 */
export function AgentFeedback({ useNotice, dismiss }: InjectFace<AgentFeedbackInjected>) {
  const notice = useNotice(value => value)
  if (notice === null) return null
  return notice.tone === 'success'
    ? <Toast key={notice.seq} text={notice.text} tone="success" onDone={dismiss} />
    : <Toast
      key={notice.seq}
      text={notice.text}
      icon={<IconWarningOutlineRegular />}
      onDone={dismiss}
    />
}

/**
 * Create one plugin-lifetime Agent feedback store.
 * @returns the notice source, publication commands, and overlay registration.
 */
export function createAgentFeedback(): AgentFeedback {
  const notice = createSnapshotStore<AgentFeedbackNotice | null>(null, { flush: 'sync' })
  let sequence = 0
  const publish = (text: string, tone: AgentFeedbackNotice['tone']): void => {
    notice.set({ text, tone, seq: ++sequence })
  }
  const publishSuccess = (text: string): void => { publish(text, 'success') }
  const publishFailure = (text: string): void => { publish(text, 'failure') }
  const dismiss = (): void => { notice.set(null) }
  const register = (ctx: Context): void => {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'agentops.agent-toast',
      inject: (): AgentFeedbackInjected => ({ hooks: { notice }, dismiss }),
    }, AgentFeedback))
  }
  return { notice, publishSuccess, publishFailure, dismiss, register }
}
