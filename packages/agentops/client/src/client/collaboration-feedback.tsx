/** Rerun feedback rendered in the application overlay. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Localized transient rerun notice, with identity for restarting its lifetime. */
export interface RerunNotice {
  readonly text: string
  readonly seq: number
}

/** Registration-owned rerun notice source and dismissal callback. */
export interface RerunFeedbackInjected {
  readonly hooks: { readonly notice: SnapshotStore<RerunNotice | null> }
  readonly dismiss: () => void
}

/** Shared rerun feedback store and its application-overlay registration. */
export interface RerunFeedback {
  readonly notice: SnapshotStore<RerunNotice | null>
  /** @param text - already localized rerun result copy. */
  readonly publish: (text: string) => void
  readonly dismiss: () => void
  /** @param ctx - client plugin context carrying slots. */
  readonly register: (ctx: Context) => void
}

/**
 * Render the current rerun notice after its requesting panel unmounts.
 * @param props - framework-bound notice source and dismissal callback.
 * @returns the current notice toast, or nothing.
 */
export function RerunFeedback({ useNotice, dismiss }: InjectFace<RerunFeedbackInjected>) {
  const notice = useNotice(value => value)
  return notice === null
    ? null
    : <Toast key={notice.seq} text={notice.text} tone="success" onDone={dismiss} />
}

/**
 * Create one plugin-lifetime rerun feedback store.
 * @returns the notice source, publication commands, and overlay registration.
 */
export function createRerunFeedback(): RerunFeedback {
  const notice = createSnapshotStore<RerunNotice | null>(null, { flush: 'sync' })
  let sequence = 0
  const publish = (text: string): void => { notice.set({ text, seq: ++sequence }) }
  const dismiss = (): void => { notice.set(null) }
  const register = (ctx: Context): void => {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'agentops.collaboration-rerun-toast',
      inject: (): RerunFeedbackInjected => ({ hooks: { notice }, dismiss }),
    }, RerunFeedback))
  }
  return { notice, publish, dismiss, register }
}
