/**
 * Agent archive: list files agents produced.
 *
 * Read-only directory scan with hard limits (depth, file count) so a huge
 * output tree cannot stall the page. No content is returned — only names,
 * sizes and timestamps.
 *
 * @module @agentops/dsh-host/archive
 */

import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** One file an agent produced. */
export interface ArchiveEntry {
  name: string
  path: string
  bytes: number
  mtime: string
  ext: string
}

/** The files found under one archive directory. */
export interface ArchiveListing {
  dir: string
  entries: ArchiveEntry[]
  truncated: boolean
  missing: boolean
}

/**
 * Walk an output directory.
 * @param dir - root to scan.
 * @param limit - maximum entries returned.
 * @param maxDepth - directory depth to descend.
 * @returns the files found, and whether the directory was missing.
 */
export function scanArchive(dir: string, limit = 200, maxDepth = 3): ArchiveListing {
  const entries: ArchiveEntry[] = []
  let truncated = false

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || truncated) return
    let children: string[]
    try {
      children = readdirSync(current)
    } catch {
      return
    }
    for (const child of children) {
      if (truncated) return
      const full = join(current, child)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entries.length >= limit) { truncated = true; return }
      entries.push({
        name: child,
        path: relative(dir, full).split('\\').join('/'),
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        ext: extname(child).replace(/^\./, '').toLowerCase(),
      })
    }
  }

  try {
    statSync(dir)
  } catch {
    return { dir, entries: [], truncated: false, missing: true }
  }

  walk(dir, 0)
  entries.sort((left, right) => right.mtime.localeCompare(left.mtime))
  return { dir, entries, truncated, missing: false }
}

/**
 * Register `GET /api/agentops/archive`.
 * @param ctx - context carrying Connection.
 * @param dir - output directory to scan.
 */
export function registerArchiveRoute(ctx: Context, dir: string): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/archive',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify(scanArchive(dir)), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  }), 'agentops-system: /api/agentops/archive')
}
