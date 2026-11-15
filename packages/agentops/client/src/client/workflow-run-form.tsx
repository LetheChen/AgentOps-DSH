/**
 * Workflow run form: resolves the host-owned input declarations, validates
 * values, and starts one AgentOps session only after an explicit submit.
 *
 * @module @agentops/dsh-client/workflow-run-form
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { NS } from './locales.js'
import {
  loadWorkflowRunHint,
  startWorkflow,
  type WorkflowRunHint,
  type WorkflowRunInputDefinition,
  type WorkflowRunResult,
  type WorkflowSummary,
} from './workflow-editor-api.js'

type WorkflowRunStarted = Extract<WorkflowRunResult, { readonly ok: true }>
type WorkflowRunFormTranslate = PropsLocale<typeof NS>['t']

interface WorkflowRunFormProps extends PropsLocale<typeof NS> {
  readonly entry: WorkflowSummary
  readonly onClose: () => void
  readonly onStarted: (result: WorkflowRunStarted) => void
  /** Fetch implementation, injectable for tests and embedding hosts. */
  readonly fetchImpl?: typeof fetch
}

interface FieldState {
  readonly status: 'initialized' | 'dirty'
  readonly value: string
}

type FieldResolution =
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function initialFieldValue(input: WorkflowRunInputDefinition): string | undefined {
  if (input.defaultValue === undefined) return undefined
  switch (input.type) {
    case 'string':
      return typeof input.defaultValue === 'string' ? input.defaultValue : undefined
    case 'integer':
    case 'number':
      return typeof input.defaultValue === 'number' ? String(input.defaultValue) : undefined
    case 'boolean':
      return typeof input.defaultValue === 'boolean' ? String(input.defaultValue) : undefined
    case 'array':
      return Array.isArray(input.defaultValue) ? JSON.stringify(input.defaultValue) : undefined
  }
}

function resolveField(
  input: WorkflowRunInputDefinition,
  state: FieldState | undefined,
  t: WorkflowRunFormTranslate,
): FieldResolution {
  if (state === undefined) {
    return input.required
      ? { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
      : { ok: true, present: false }
  }

  const raw = state.value
  switch (input.type) {
    case 'string':
      if (input.required && raw.trim() === '') {
        return { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
      }
      return { ok: true, present: true, value: raw }
    case 'integer': {
      const trimmed = raw.trim()
      if (trimmed === '') {
        return input.required
          ? { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
          : { ok: true, present: false }
      }
      const value = Number(trimmed)
      if (!Number.isSafeInteger(value)) {
        return { ok: false, error: t('page.run.invalidInteger', { name: input.name }) }
      }
      return { ok: true, present: true, value }
    }
    case 'number': {
      const trimmed = raw.trim()
      if (trimmed === '') {
        return input.required
          ? { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
          : { ok: true, present: false }
      }
      const value = Number(trimmed)
      if (!Number.isFinite(value)) {
        return { ok: false, error: t('page.run.invalidNumber', { name: input.name }) }
      }
      return { ok: true, present: true, value }
    }
    case 'boolean':
      if (raw === '') {
        return input.required
          ? { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
          : { ok: true, present: false }
      }
      return { ok: true, present: true, value: raw === 'true' }
    case 'array': {
      if (raw.trim() === '') {
        return input.required
          ? { ok: false, error: t('page.run.invalidRequired', { name: input.name }) }
          : { ok: true, present: false }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, error: t('page.run.invalidArray', { name: input.name }) }
      }
      if (!Array.isArray(parsed) || !isJsonValue(parsed)) {
        return { ok: false, error: t('page.run.invalidArray', { name: input.name }) }
      }
      return { ok: true, present: true, value: parsed }
    }
  }
}

function resolveInputs(
  inputs: readonly WorkflowRunInputDefinition[],
  fields: Readonly<Record<string, FieldState>>,
  t: WorkflowRunFormTranslate,
): { readonly ok: true; readonly values: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> } {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const input of inputs) {
    const resolution = resolveField(input, fields[input.name], t)
    if (!resolution.ok) {
      errors[input.name] = resolution.error
    } else if (resolution.present) {
      values[input.name] = resolution.value
    }
  }
  return Object.keys(errors).length === 0
    ? { ok: true, values }
    : { ok: false, errors }
}

/**
 * Render the run-input dialog for one workflow.
 * @param props - locale translator, catalogue entry, and close/start callbacks.
 * @returns the modal run form.
 */
export function WorkflowRunForm({
  t,
  entry,
  onClose,
  onStarted,
  fetchImpl,
}: WorkflowRunFormProps): ReactElement {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const startingRef = useRef(false)
  const [hint, setHint] = useState<WorkflowRunHint | null>(null)
  const [fields, setFields] = useState<Readonly<Record<string, FieldState>>>({})
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [runError, setRunError] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const request = ++generation.current
    setHint(null)
    setFields({})
    setErrors({})
    setLoadError('')
    setRunError('')
    setLoading(true)
    void loadWorkflowRunHint(entry.id, fetchImpl ?? fetch)
      .then((nextHint) => {
        if (!mounted.current || generation.current !== request) return
        const initialFields: Record<string, FieldState> = {}
        for (const input of nextHint.inputs) {
          const value = initialFieldValue(input)
          if (value !== undefined) initialFields[input.name] = { status: 'initialized', value }
        }
        setFields(initialFields)
        setHint(nextHint)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (!mounted.current || generation.current !== request) return
        setLoadError(t('page.run.loadFailed', { message: errorMessage(reason) }))
        setLoading(false)
      })
    return () => {
      if (generation.current === request) generation.current += 1
    }
  }, [entry.id, fetchImpl, t])

  useEffect(() => {
    if (hint === null) return
    formRef.current?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus()
  }, [hint])

  const requestClose = useCallback((): void => {
    if (!startingRef.current) onClose()
  }, [onClose])

  const changeField = useCallback((name: string, value: string): void => {
    setFields(current => ({
      ...current,
      [name]: { status: 'dirty', value },
    }))
    setErrors((current) => {
      if (current[name] === undefined) return current
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== name))
    })
  }, [])

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (startingRef.current || hint === null) return
    const resolved = resolveInputs(hint.inputs, fields, t)
    if (!resolved.ok) {
      setErrors(resolved.errors)
      return
    }

    startingRef.current = true
    setStarting(true)
    setRunError('')
    setErrors({})
    try {
      const result = await startWorkflow(entry.id, resolved.values, fetchImpl ?? fetch)
      if (!mounted.current) return
      if (result.ok) {
        onStarted(result)
      } else {
        setRunError(t('page.run.failed', { message: result.reason }))
      }
    } catch (reason) {
      if (mounted.current) {
        setRunError(t('page.run.failed', { message: errorMessage(reason) }))
      }
    } finally {
      if (mounted.current) {
        startingRef.current = false
        setStarting(false)
      }
    }
  }, [entry.id, fetchImpl, fields, hint, onStarted, t])

  const firstInputName = hint?.inputs[0]?.name
  return (
    <Modal
      open
      onClose={requestClose}
      title={t('page.run.formTitle')}
      closeLabel={t('page.run.closeLabel')}
      className="agentops-theme-scope workflow-run-dialog"
      contentClassName="workflow-run-content"
      footer={(
        <>
          <Button
            variant="outline"
            disabled={starting}
            onClick={requestClose}
          >
            {t('page.run.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={loading || hint === null || starting}
          >
            {starting ? t('page.starting') : t('page.run.start')}
          </Button>
        </>
      )}
    >
      <form
        ref={formRef}
        id={formId}
        className="workflow-run-form"
        onSubmit={(event) => { void submit(event) }}
      >
        {loading && (
          <p className="workflow-run-loading" role="status">{t('page.run.loading')}</p>
        )}
        {loadError !== '' && (
          <p className="workflow-run-error" role="alert">{loadError}</p>
        )}
        {hint !== null && (
          <>
            <section className="workflow-run-reason" aria-label={t('page.run.reason')}>
              <p>{hint.reason}</p>
            </section>
            {hint.inputs.length === 0
              ? <p className="workflow-run-empty">{t('page.run.noInputs')}</p>
              : (
                <section className="workflow-run-fields" aria-labelledby={`${formId}-inputs`}>
                  <h3 id={`${formId}-inputs`}>{t('page.run.inputs')}</h3>
                  {hint.inputs.map((input, index) => {
                    const fieldId = `${formId}-${index}`
                    const descriptionId = `${fieldId}-description`
                    const errorId = `${fieldId}-error`
                    const field = fields[input.name]
                    const value = field?.value ?? ''
                    const error = errors[input.name]
                    const describedBy = [
                      input.description === undefined ? '' : descriptionId,
                      error === undefined ? '' : errorId,
                    ].filter(Boolean).join(' ') || undefined
                    const common = {
                      id: fieldId,
                      name: input.name,
                      value,
                      'aria-required': input.required,
                      'aria-invalid': error !== undefined,
                      'aria-describedby': describedBy,
                      'data-modal-autofocus': input.name === firstInputName ? true : undefined,
                    }
                    return (
                      <div key={input.name} className="workflow-run-field">
                        <label htmlFor={fieldId}>
                          {input.name}
                          {input.required ? <span aria-hidden="true"> *</span> : null}
                        </label>
                        {input.description !== undefined && (
                          <p id={descriptionId} className="workflow-run-description">
                            {input.description}
                          </p>
                        )}
                        {input.type === 'string' && (
                          <input
                            {...common}
                            type="text"
                            className="workflow-run-control"
                            onChange={(event) => { changeField(input.name, event.target.value) }}
                          />
                        )}
                        {(input.type === 'integer' || input.type === 'number') && (
                          <input
                            {...common}
                            type="text"
                            inputMode={input.type === 'integer' ? 'numeric' : 'decimal'}
                            className="workflow-run-control"
                            onChange={(event) => { changeField(input.name, event.target.value) }}
                          />
                        )}
                        {input.type === 'boolean' && (
                          <select
                            {...common}
                            className="workflow-run-control"
                            onChange={(event) => { changeField(input.name, event.target.value) }}
                          >
                            <option value="">—</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        )}
                        {input.type === 'array' && (
                          <textarea
                            {...common}
                            className="workflow-run-control workflow-run-array"
                            rows={4}
                            spellCheck={false}
                            onChange={(event) => { changeField(input.name, event.target.value) }}
                          />
                        )}
                        {error !== undefined && (
                          <p id={errorId} className="workflow-run-field-error" role="alert">
                            {error}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </section>
              )}
          </>
        )}
        {runError !== '' && (
          <p className="workflow-run-error" role="alert">{runError}</p>
        )}
      </form>
    </Modal>
  )
}
