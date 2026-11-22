import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDeploymentSnapshot } from '../src/collect.ts'
import { createSystemService, readEnvironment } from '../src/plugin.ts'

void test('缺省输入：失败关闭边界 + 明确告警', () => {
  const s = buildDeploymentSnapshot()
  assert.equal(s.instances.mode, 'single')
  assert.equal(s.instances.hostCount, 1)
  assert.equal(s.instances.sessionSticky, true)
  assert.equal(s.dataBoundary.sessionLogUpload, false, '未知边界不得视为允许外发')
  assert.equal(s.dataBoundary.approvalRequired, true)
  assert.equal(s.dataBoundary.networkAllowlist, true)
  assert.equal(s.rollback.snapshotAt, null)
  assert.ok(s.warnings.includes('DSH 版本未知：无法执行升级兼容性判断'))
  assert.ok(s.warnings.includes('没有可用回滚快照：升级前必须创建 profile 快照'))
})

void test('多实例未启用会话粘性 → 阻断级告警', () => {
  const s = buildDeploymentSnapshot({
    dshVersion: '0.2.1-rc.3',
    instances: { mode: 'multi', hostCount: 3, sessionSticky: false },
    rollback: { snapshotAt: '2026-10-25T03:00:00+08:00' },
  })
  assert.ok(s.warnings.includes('多实例未启用会话粘性：同一会话可能被并发写入'))
})

void test('Sidecar 已移除：快照不含该字段，也不产生告警', () => {
  const snapshot = buildDeploymentSnapshot({})
  assert.equal('sidecar' in snapshot, false)
  assert.ok(!snapshot.warnings.some(warning => warning.includes('Sidecar')))
})

void test('外发与审批关闭都会产生告警', () => {
  const s = buildDeploymentSnapshot({
    dataBoundary: { sessionLogUpload: true, approvalRequired: false, networkAllowlist: false },
  })
  assert.ok(s.warnings.includes('会话日志会随官方模型请求外发'))
  assert.ok(s.warnings.includes('高风险工具审批已关闭'))
  assert.ok(s.warnings.includes('网络白名单未开启：模型可访问任意出站地址'))
})

void test('异常数值归一：负数计数回落、延迟非数视为未知、时间戳非法清空', () => {
  const s = buildDeploymentSnapshot({
    instances: { hostCount: -3 },
    database: { latencyMs: Number.POSITIVE_INFINITY },
    rollback: { snapshotAt: 'not-a-date' },
  })
  assert.equal(s.instances.hostCount, 1)
  assert.equal(s.database.latencyMs, null)
  assert.equal(s.rollback.snapshotAt, null)
  assert.ok(s.warnings.includes('数据库延迟未知：无法判断就绪状态'))
})

void test('只读环境采集：默认关闭外发、默认开启审批', () => {
  const input = readEnvironment({})
  const s = buildDeploymentSnapshot(input)
  assert.equal(s.dataBoundary.sessionLogUpload, false)
  assert.equal(s.dataBoundary.approvalRequired, true)
  assert.equal(s.instances.mode, 'single')
})

void test('环境变量可覆盖，且只读快照不可被外部修改', () => {
  const env = {
    DSH_VERSION: '0.2.1-rc.3',
    AGENTOPS_PROFILE: 'agentops',
    AGENTOPS_INSTANCE_MODE: 'multi',
    AGENTOPS_HOST_COUNT: '4',
    AGENTOPS_SESSION_STICKY: 'true',
    AGENTOPS_SIDECAR_REPLICAS: '2',
    AGENTOPS_DB_ENGINE: 'postgres',
    AGENTOPS_DB_LATENCY_MS: '12',
    AGENTOPS_SESSION_LOG_UPLOAD: 'false',
    AGENTOPS_ROLLBACK_SNAPSHOT_AT: '2026-10-25T03:00:00+08:00',
  }
  const service = createSystemService(readEnvironment(env))
  const first = service.snapshot()
  assert.equal(first.dshVersion, '0.2.1-rc.3')
  assert.equal(first.instances.hostCount, 4)
  assert.equal(first.database.latencyMs, 12)
  assert.deepEqual(first.warnings, [])

  ;(first.warnings as unknown as string[]).push('tampered')
  assert.deepEqual(service.snapshot().warnings, [], '快照必须返回副本')
})
