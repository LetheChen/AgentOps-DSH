export interface SeedAgentOpsOptions {
  /** DSH home containing the runtime `agentops` directory. */
  dshHome?: string
  /** Replace files that already exist. */
  force?: boolean
  /** Report intended copies without touching the filesystem. */
  dryRun?: boolean
}

export interface SeedAgentOpsResult {
  /** Relative paths copied, or that would be copied during a dry run. */
  copied: string[]
  /** Relative paths preserved because they already exist. */
  skipped: string[]
}

/**
 * Copy migrated Agent and workflow YAML assets into the runtime catalogue.
 *
 * @param options - Runtime root and overwrite policy.
 * @returns Copied and skipped relative paths.
 */
export function seedAgentOps(options?: SeedAgentOpsOptions): SeedAgentOpsResult
