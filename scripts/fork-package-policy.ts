/** Workspace roots whose packages follow the fork's own release and UI policies. */

export const FORK_OWNED_PACKAGE_ROOT = 'packages/agentops'

/**
 * Determine whether a path belongs to the fork-owned package tree.
 * @param path - repository-relative directory or file path using either separator.
 * @returns true for the fork root itself and everything below it.
 */
export function isForkOwnedPackagePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/u, '')
  return normalized === FORK_OWNED_PACKAGE_ROOT || normalized.startsWith(`${FORK_OWNED_PACKAGE_ROOT}/`)
}
