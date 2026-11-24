import assert from 'node:assert/strict'
import test from 'node:test'

import { createPullLogsTool, type PullLogsService } from '../src/index.ts'

void test('pull_logs exposes only canonical log_task_id', () => {
  const tool = createPullLogsTool({} as PullLogsService, { tenantKey: 'tenant-a', agentPreset: 'log_puller' })
  assert.equal(tool.name, 'pull_logs')
  assert.deepEqual(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}), ['log_task_id'])
})


void test('pull_logs renders the complete structured result for the model', () => {
  const tool = createPullLogsTool({} as PullLogsService, { tenantKey: 'tenant-a', agentPreset: 'log_puller' })
  const value = {
    ok: true,
    log_task_id: 'oa_approval',
    ssh_instance_id: 'MaxKB',
    files: [{
      remote_path: '/opt/app.log', local_path: 'C:/logs/app.log', bytes: 10,
      delta_start: 4, delta_end: 10, skipped: false,
    }],
    files_cleaned: 0,
  }
  const rendered = tool.output.render({ log_task_id: 'oa_approval' }, value)
  assert.equal(rendered[0]?.type, 'text')
  assert.deepEqual(JSON.parse(rendered[0]?.text ?? ''), value)
})
