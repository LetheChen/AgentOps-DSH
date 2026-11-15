/**
 * K1 / K5 运行期冒烟（一次性，可重复执行）
 *
 * K1：`agentPresets.acquireScope(id)` 拿到的 ScopeKey，能否在宿主平面
 *     用 `ctx.get('tools').schemas(key)` 读到这个 preset 注册的工具（且不含全局层）。
 * K5：preset scope 内注册的 `ctx.tools.guard()`，能否真的拒绝指定工具、且不误伤其它工具。
 *
 * 不启动 profile、不碰 3080 实例：就在本进程里拼一棵最小 Cordis 树。
 * 用法：node --import tsx packages/agentops/host/scripts/smoke-k1-k5.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'

const fixture = (name: string): string => new URL(`../tests/fixtures/${name}.js`, import.meta.url).href
const results: { id: string; ok: boolean; detail: string }[] = []
const check = (id: string, ok: boolean, detail: string): void => { results.push({ id, ok, detail }) }

async function build(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = new URL('../tests/fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'smoke' })
  return ctx
}

async function main(): Promise<void> {
  const ctx = await build()

  await ctx.plugin({
    inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.agentPresets.register({
        id: 'smoke',
        name: 'smoke preset',
        plugins: [
          { name: fixture('smoke-tools'), config: { names: ['alpha', 'beta'] } },
          { name: fixture('smoke-guard'), config: { deny: ['alpha'] } },
        ],
      })
    },
  })

  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('ctx.get(tools) 为空：本部署没有工具注册表')

  // ── K1：preset scope 的工具清单 ─────────────────────────────
  await using lease = await ctx.agentPresets.acquireScope('smoke')
  const scoped = tools.schemas(lease.key).map(schema => schema.name).sort()
  const global = tools.schemas(undefined).map(schema => schema.name).sort()
  check('K1a 宿主平面可读 preset scope 的工具', scoped.join(',') === 'alpha,beta', `schemas(lease.key) = [${scoped.join(', ')}]`)
  check('K1b 租约 key 不含全局层', global.length === 0, `schemas(undefined) = [${global.join(', ')}]`)
  check('K1c 组合可枚举（不建 Agent 也有行）',
    (await ctx.agentPresets.compositionInventory()).find(row => row.id === 'smoke')?.rows.length === 2,
    'compositionInventory(smoke).rows = 2')

  // ── K5：guard 在真实 execute 链路上生效 ────────────────────
  const handle = await ctx.agents.create({
    sessionId: SessionId('smoke-k1-k5'),
    setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, 'smoke') },
  })
  const agent = handle.agent
  const run = async (name: string) => {
    const batch = await tools.execute({
      calls: [{ type: 'tool-call', id: `call-${name}`, name, arguments: '{}' } as never],
      signal: AbortSignal.timeout(10_000),
      agent,
    })
    return batch.results[0]!.result
  }

  const denied = await run('alpha')
  const deniedText = denied.content.map(block => (block as { text?: string }).text ?? '').join(' ')
  check('K5a guard 拒绝 deny 名单内的工具', denied.isError === true, `alpha.isError=${String(denied.isError)} reason="${deniedText.slice(0, 80)}"`)

  const allowed = await run('beta')
  const allowedText = allowed.content.map(block => (block as { text?: string }).text ?? '').join(' ')
  check('K5b guard 不误伤其它工具', allowed.isError === false, `beta.isError=${String(allowed.isError)} text="${allowedText.slice(0, 80)}"`)

  // ── 报告 ───────────────────────────────────────────────────
  const pass = results.filter(row => row.ok).length
  process.stdout.write(`\nK1/K5 冒烟（${pass}/${results.length} 通过）\n`)
  for (const row of results) {
    process.stdout.write(`${row.ok ? '✔' : '✘'} ${row.id}\n    ${row.detail}\n`)
  }
  process.exit(pass === results.length ? 0 : 1)
}

await main()
