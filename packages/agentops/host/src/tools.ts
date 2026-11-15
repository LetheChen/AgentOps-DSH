/**
 * System-status tool, mounted inside an Agent preset.
 *
 * The registry is Agent-scoped, so this half cannot live at the root.
 *
 * @module @agentops/dsh-host/tools
 */

import type { Context } from '@deepseek-ai/cordis'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createSystemTool, resolveSurfaceDbPath } from './dsh.ts'
import { createSystemService, readEnvironment } from './plugin.ts'
import { createBoardCleanupTool, createPresentContentTool, SurfaceStore } from './surfaces.ts'

export const name = 'agentops-system-tools'

export const inject = ['tools']

/** 本插件会注册的工具名（`only` 的合法取值）。 */
export const TOOL_NAMES = ['agentops_system_status', 'present_content', 'board_cleanup'] as const

/** Configuration of the system-tools plugin. */
export interface Config {
  /** 只注册这些工具；省略 = 全注册，空数组 = 全禁。 */
  only?: readonly string[]
}

/** `only` 过滤器：undefined = 全注册；空数组 = 全禁；未知名字一律抛错（防拼错后静默失效）。 */
function onlyRegistrar(
  ctx: Context,
  only: readonly string[] | undefined,
  known: readonly string[],
): (definition: Parameters<Context['tools']['register']>[0]) => void {
  if (only !== undefined) {
    for (const name of only) {
      if (!known.includes(name)) {
        throw new Error(`only 含本插件不注册的工具 "${name}"；已知：${known.join(', ')}`)
      }
    }
  }
  const allow = only === undefined ? undefined : new Set(only)
  return (definition) => {
    if (allow === undefined || allow.has(definition.name)) ctx.tools.register(definition)
  }
}

/**
 * Register the read-only deployment snapshot tool.
 * @param ctx - Agent-scoped context carrying the tool registry.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const reg = onlyRegistrar(ctx, config.only, TOOL_NAMES)
  reg(createSystemTool(createSystemService(readEnvironment())))

  const path = resolveSurfaceDbPath()
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const surfaces = new SurfaceStore(path)
  reg(createPresentContentTool(surfaces))
  reg(createBoardCleanupTool(surfaces))
}
