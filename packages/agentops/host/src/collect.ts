import type { DeploymentInput, DeploymentSnapshot } from './types.js'

const DEFAULT_DSH_VERSION = 'unknown'
const DEFAULT_PROFILE = 'agentops'

/**
 * Build the deployment snapshot from raw inputs.
 *
 * Pure: the caller supplies every environment fact, so contract tests can pin
 * each branch without touching `process`, the clock, or the filesystem.
 * @param input - the raw deployment facts.
 * @returns the derived deployment snapshot.
 */
export function buildDeploymentSnapshot(input: DeploymentInput = {}): DeploymentSnapshot {
  const instances = {
    mode: input.instances?.mode === 'multi' ? 'multi' : 'single',
    hostCount: normalizeCount(input.instances?.hostCount, 1),
    sessionSticky: input.instances?.sessionSticky ?? true,
  } as const


  const database = {
    engine: nonEmpty(input.database?.engine) ?? 'postgres',
    latencyMs: normalizeLatency(input.database?.latencyMs),
  }

  const dataBoundary = {
    // Fail closed: an unknown boundary must never look like "upload enabled".
    sessionLogUpload: input.dataBoundary?.sessionLogUpload ?? false,
    approvalRequired: input.dataBoundary?.approvalRequired ?? true,
    networkAllowlist: input.dataBoundary?.networkAllowlist ?? true,
  }

  const rollback = {
    snapshotAt: normalizeTimestamp(input.rollback?.snapshotAt),
  }

  const snapshot: DeploymentSnapshot = {
    dshVersion: nonEmpty(input.dshVersion) ?? DEFAULT_DSH_VERSION,
    nodeVersion: nonEmpty(input.nodeVersion) ?? 'unknown',
    profile: nonEmpty(input.profile) ?? DEFAULT_PROFILE,
    upgradeChannel: input.upgradeChannel === 'preview' ? 'preview' : 'stable',
    instances,
    database,
    dataBoundary,
    rollback,
    warnings: [],
  }

  snapshot.warnings = collectWarnings(snapshot)
  return snapshot
}

function collectWarnings(snapshot: DeploymentSnapshot): string[] {
  const warnings: string[] = []
  if (snapshot.dshVersion === DEFAULT_DSH_VERSION) {
    warnings.push('DSH 版本未知：无法执行升级兼容性判断')
  }
  if (snapshot.instances.mode === 'multi' && !snapshot.instances.sessionSticky) {
    warnings.push('多实例未启用会话粘性：同一会话可能被并发写入')
  }
  if (snapshot.dataBoundary.sessionLogUpload) {
    warnings.push('会话日志会随官方模型请求外发')
  }
  if (!snapshot.dataBoundary.approvalRequired) {
    warnings.push('高风险工具审批已关闭')
  }
  if (!snapshot.dataBoundary.networkAllowlist) {
    warnings.push('网络白名单未开启：模型可访问任意出站地址')
  }
  if (snapshot.database.latencyMs === null) {
    warnings.push('数据库延迟未知：无法判断就绪状态')
  }
  if (snapshot.rollback.snapshotAt === null) {
    warnings.push('没有可用回滚快照：升级前必须创建 profile 快照')
  }
  return warnings
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded >= 0 ? rounded : fallback
}

function normalizeLatency(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed
}
