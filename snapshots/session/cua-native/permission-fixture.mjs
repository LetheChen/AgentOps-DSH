/** Scripted human answers and a permission-page revocation in the recorded CUA scenario. */
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { startFixtureHost } from './fixture-host.mjs'
export const name = 'cua-permission-fixture'
export const inject = ['userQuestions', 'cuaAccess', 'tools']

/** Supply external human decisions while retaining the real permission policy and tool pipeline. */
export async function apply(ctx) {
  const helper = join(process.cwd(), 'native-helper.mjs')
  await chmod(helper, 0o700)
  const close = await startFixtureHost(helper)
  ctx.effect(() => close)
  ctx.on('user-questions/request', async (request) => ({ answers: request.questions.map(question => ({
    id: question.id,
    selected: [question.question.includes('Denied Fixture') ? 'Deny' : 'Allow for this session'],
  })) }))
  ctx.on('tools/post-execute', async (execution, _result, next) => {
    const decision = await next()
    if (execution.name === 'cua' && execution.arguments.method === 'getApp'
      && execution.arguments.params.selector === 'Revocable Fixture') {
      await ctx.cuaAccess.revoke('c'.repeat(64))
    }
    return decision
  })
}
