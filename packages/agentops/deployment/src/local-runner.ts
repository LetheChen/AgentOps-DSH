/**
 * Local build command runner over the shared subprocess seam.
 * @module @agentops/dsh-deployment/local-runner
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

import { DeploymentError, type RemoteCommandResult } from './types.ts'

/** Run one trusted local command without a shell. */
export interface LocalCommandRunner {
  /**
   * @param argv - executable and literal arguments.
   * @param cwd - absolute working directory.
   * @param timeoutMs - command deadline.
   * @param signal - caller cancellation.
   * @returns independent exit, signal, output, and timeout facts.
   */
  run(argv: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RemoteCommandResult>
}

/** Subprocess-backed local runner used by `artifact_build`. */
export class SubprocessLocalCommandRunner implements LocalCommandRunner {
  readonly #subprocess: SubprocessRuntime

  /**
   * @param subprocess - execution-world subprocess provider.
   */
  constructor(subprocess: SubprocessRuntime) {
    this.#subprocess = subprocess
  }

  async run(argv: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RemoteCommandResult> {
    if (argv.length === 0 || argv[0] === undefined || argv[0] === '') {
      throw new DeploymentError('DEPLOYMENT_BUILD_FAILED', 'build command is empty')
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeout.abort(new Error('build command timed out'))
    }, timeoutMs)
    const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
    try {
      const executable = await this.#subprocess.resolveExecutable(argv[0], undefined, combined)
      const handle = this.#subprocess.spawn({
        argv: [executable, ...argv.slice(1)],
        cwd,
        env: { GIT_TERMINAL_PROMPT: '0' },
        graceMs: 5_000,
        signal: combined,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 2 * 1024 * 1024 },
          stderr: { maxBytes: 2 * 1024 * 1024 },
        },
      })
      try {
        const outcome = await handle.done
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        return {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          stdout: stdout?.text ?? '',
          stderr: stderr?.text ?? '',
          timedOut: timeout.signal.aborted,
        }
      } finally {
        handle.terminate()
        await handle.waitForExit()
      }
    } catch (error) {
      if (error instanceof DeploymentError) throw error
      throw new DeploymentError('DEPLOYMENT_BUILD_FAILED', error instanceof Error ? error.message : String(error), {
        cause: error,
        action: 'Check the configured build root, command, and local toolchain.',
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
