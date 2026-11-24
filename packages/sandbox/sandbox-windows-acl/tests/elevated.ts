/** Detect a Windows token whose integrity level bypasses the ACL cases under test. */
import { execFileSync } from 'node:child_process'

/**
 * @returns whether the current Windows process runs at High or System integrity.
 */
export function isElevatedWindows(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const groups = execFileSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true })
    return groups.includes('S-1-16-12288') || groups.includes('S-1-16-16384')
  } catch {
    return false
  }
}
