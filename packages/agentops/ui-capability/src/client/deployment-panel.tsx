/**
 * Business deployment configuration panel.
 *
 * @module @agentops/dsh-ui-capability/client
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { createCapabilityApi, type CapabilityRpcResult } from './api.ts'
import { zh as copy } from './locales.ts'

interface Integration {
  readonly instanceId: string
  readonly capabilityId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly credentialConfigured: boolean
}
interface ToolItem {
  readonly toolId: string
  readonly displayName: string
  readonly capabilityId: string
  readonly runtimeAvailable: boolean
}
interface Draft {
  readonly kind: 'deployment' | 'build'
  readonly instanceId: string
  readonly name: string
  readonly tenantKey: string
  readonly ownerDomain: string
  readonly sshInstanceId: string
  readonly status: 'enabled' | 'disabled' | 'error'
  readonly existing: boolean
  readonly localRoot: string
  readonly buildCwd: string
  readonly buildScript: string
  readonly artifactPath: string
  readonly targetPath: string
  readonly workRoot: string
  readonly remoteScript: string
  readonly scriptVersion: string
  readonly scriptSha256: string
  readonly composeFile: string
  readonly envFile: string
  readonly healthUrl: string
  readonly imageName: string
  readonly containerName: string
  readonly backupDir: string
}
interface FormFieldProps {
  readonly label: string
  readonly hint?: string
  readonly wide?: boolean
  readonly required?: boolean
  readonly children: ReactNode
}

const DEPLOYMENT_CAPABILITY = 'deployment'
const BUILD_CAPABILITY = 'artifact-build'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function errorOf(result: CapabilityRpcResult): string | null { return result.ok ? null : `${result.error.code}: ${result.error.message}` }
function objectOf(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }
function textOf(value: unknown): string { return typeof value === 'string' ? value : '' }
function newId(kind: 'deployment' | 'build'): string { return `${kind === 'deployment' ? 'deploy_' : 'build_'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` }
function dirnameOf(path: string): string { const index = path.replaceAll('\\', '/').lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index) }
function statusLabel(status: Integration['status']): string { return status === 'enabled' ? copy['instance.status.enabled'] : status === 'disabled' ? copy['instance.status.disabled'] : copy['instance.status.error'] }
function statusTone(status: Integration['status']): 'ok' | 'muted' | 'error' { return status === 'enabled' ? 'ok' : status === 'disabled' ? 'muted' : 'error' }
function requiredError(label: string): string { return copy['error.required'].replace('{field}', label) }
function manifestPaths(draft: Draft): { readonly manifest: string; readonly manifestDigest: string } {
  const artifactDir = dirnameOf(draft.artifactPath)
  return artifactDir === ''
    ? { manifest: 'release-manifest.json', manifestDigest: 'release-manifest.sha256' }
    : { manifest: `${artifactDir}/release-manifest.json`, manifestDigest: `${artifactDir}/release-manifest.sha256` }
}
function scriptPinned(item: Integration): boolean {
  const config = objectOf(item.config) ?? {}
  const remote = objectOf(config.remote) ?? {}
  return textOf(remote.scriptPath).startsWith('/') && textOf(remote.scriptVersion) !== '' && SHA256_PATTERN.test(textOf(remote.scriptSha256))
}
function shortDigest(value: string): string { return value === '' ? '—' : `${value.slice(0, 12)}…` }
function hostLabel(instance: Integration): string {
  const config = objectOf(instance.config) ?? {}
  const host = textOf(config.host)
  const port = textOf(config.port)
  return host === '' ? copy['deploy.sshHostMissing'] : `${host}${port === '' ? '' : `:${port}`}`
}
function sshDisplayName(instance: Integration): string { return `${instance.name} · ${hostLabel(instance)}` }
function backupPrefixOf(imageName: string): string {
  const image = imageName.split('/').at(-1) ?? 'deployment'
  const repository = (image.split(':')[0] ?? 'deployment').toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return `${repository || 'deployment'}:backup`
}
function lockPathOf(containerName: string): string {
  const name = containerName.toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'deployment'
  return `/run/lock/${name}-release.lock`
}
function optionValue(argv: readonly unknown[], name: string): string {
  const index = argv.findIndex(item => item === name)
  return index < 0 ? '' : textOf(argv[index + 1])
}
function deploymentCommand(draft: Draft, releaseId: string, rollback = false): readonly string[] {
  const command = ['sudo', draft.remoteScript]
  if (rollback) {
    command.push('--rollback')
  } else {
    command.push('--image', `{workDir}/docker/${draft.artifactPath}`)
  }
  command.push(
    '--release-id', releaseId,
    '--base-dir', '{targetPath}',
    '--env-file', draft.envFile,
    '--compose-file', draft.composeFile,
    '--container', draft.containerName,
    '--service', draft.containerName,
    '--image-name', draft.imageName,
    '--backup-tag-prefix', backupPrefixOf(draft.imageName),
    '--lock-file', lockPathOf(draft.containerName),
    '--health-url', draft.healthUrl,
  )
  if (!rollback) command.push('--backup-dir', draft.backupDir)
  return command
}

function baseDraft(kind: 'deployment' | 'build'): Draft {
  return {
    kind, instanceId: newId(kind), name: '', tenantKey: 'default', ownerDomain: 'operations', sshInstanceId: '', status: 'enabled', existing: false,
    localRoot: '', buildCwd: 'build', buildScript: './build.sh', artifactPath: 'image/app.tar',
    targetPath: '/opt/app', workRoot: '/tmp/app-release', remoteScript: '/opt/agentops/bin/deploy-image.sh', scriptVersion: 'v1', scriptSha256: '',
    composeFile: '/opt/app/docker-compose.yml', envFile: '/opt/app/.env',
    healthUrl: 'http://127.0.0.1:8000/health/ready', imageName: 'app:latest', containerName: 'app',
    backupDir: '/opt/app/backups/mysql',
  }
}
function deploymentConfig(draft: Draft): Record<string, unknown> {
  const { manifest, manifestDigest } = manifestPaths(draft)
  return {
    schemaVersion: 1,
    instanceId: draft.instanceId,
    tenantKey: draft.tenantKey,
    ownerDomain: draft.ownerDomain,
    sshInstanceId: draft.sshInstanceId,
    access: { presets: ['deploy_operator'], operations: ['plan', 'release', 'status', 'rollback'] },
    artifact: { localRoot: draft.localRoot, bundleRoot: 'docker', updateFiles: [draft.artifactPath], firstInstallFiles: [draft.artifactPath], manifest, manifestDigest },
    environment: { installedEnvFile: draft.envFile, remotePermissions: '0600', cleanup: 'always' },
    remote: {
      workRoot: draft.workRoot, targetPath: draft.targetPath, lockPath: lockPathOf(draft.containerName), imageName: draft.imageName,
      scriptPath: draft.remoteScript, scriptVersion: draft.scriptVersion, scriptSha256: draft.scriptSha256,
      backupTagPrefix: backupPrefixOf(draft.imageName), containerName: draft.containerName, composeFile: draft.composeFile,
      commandTimeoutMs: 1800000, sudoMode: 'non-interactive',
      firstInstallCommand: deploymentCommand(draft, '{releaseId}'),
      updateCommand: deploymentCommand(draft, '{releaseId}'),
      rollbackCommand: deploymentCommand(draft, '{rollbackReleaseId}', true),
    },
    migration: { mode: 'always', backupBeforeMigrate: true, backupRetentionDays: 7 },
    health: { timeoutMs: 180000, checks: [['curl', '-fsS', draft.healthUrl]] },
  }
}

function buildConfig(draft: Draft): Record<string, unknown> {
  const { manifest, manifestDigest } = manifestPaths(draft)
  return {
    schemaVersion: 1, instanceId: draft.instanceId, tenantKey: draft.tenantKey, ownerDomain: draft.ownerDomain, access: { presets: ['build_operator'] },
    localRoot: draft.localRoot, cwd: draft.buildCwd, command: ['bash', draft.buildScript], timeoutMs: 1800000,
    outputs: [draft.artifactPath], manifest, manifestDigest, imageName: draft.imageName,
  }
}

function draftFrom(item: Integration): Draft {
  const config = objectOf(item.config) ?? {}
  const artifact = objectOf(config.artifact) ?? {}
  const remote = objectOf(config.remote) ?? {}
  const environment = objectOf(config.environment) ?? {}
  const health = objectOf(config.health) ?? {}
  const checks = Array.isArray(health.checks) ? health.checks : []
  const firstCheck = Array.isArray(checks[0]) ? checks[0] as unknown[] : []
  const update = Array.isArray(remote.updateCommand) ? remote.updateCommand as unknown[] : []
  const updateFiles = Array.isArray(artifact.updateFiles) ? artifact.updateFiles as unknown[] : []
  const command = Array.isArray(config.command) ? config.command : []
  const outputs = Array.isArray(config.outputs) ? config.outputs : []
  const base = baseDraft(item.capabilityId === BUILD_CAPABILITY ? 'build' : 'deployment')
  return {
    ...base,
    instanceId: item.instanceId, name: item.name, status: item.status, existing: true,
    tenantKey: textOf(config.tenantKey) || base.tenantKey, ownerDomain: textOf(config.ownerDomain) || base.ownerDomain,
    sshInstanceId: textOf(config.sshInstanceId), localRoot: textOf(config.localRoot) || textOf(artifact.localRoot) || base.localRoot,
    buildCwd: textOf(config.cwd) || base.buildCwd, buildScript: textOf(command[1]) || base.buildScript,
    artifactPath: textOf(updateFiles[0]) || textOf(outputs[0]) || base.artifactPath,
    targetPath: textOf(remote.targetPath) || base.targetPath, workRoot: textOf(remote.workRoot) || base.workRoot,
    remoteScript: textOf(remote.scriptPath) || textOf(update[1]) || base.remoteScript,
    scriptVersion: textOf(remote.scriptVersion) || base.scriptVersion, scriptSha256: textOf(remote.scriptSha256) || base.scriptSha256,
    composeFile: textOf(remote.composeFile) || base.composeFile,
    envFile: textOf(environment.installedEnvFile) || base.envFile, healthUrl: textOf(firstCheck.at(-1)) || base.healthUrl,
    imageName: textOf(remote.imageName) || base.imageName, containerName: textOf(remote.containerName) || base.containerName,
    backupDir: optionValue(update, '--backup-dir') || base.backupDir,
  }
}

function validateDraft(draft: Draft): string | null {
  if (draft.name.trim() === '') return copy['deploy.error.name']
  if (draft.tenantKey.trim() === '') return requiredError(copy['deploy.field.tenantKey'])
  if (draft.ownerDomain.trim() === '') return requiredError(copy['deploy.field.ownerDomain'])
  if (draft.localRoot.trim() === '') return requiredError(copy['deploy.field.localRoot'])
  if (draft.kind === 'build') {
    if (draft.buildCwd.trim() === '') return requiredError(copy['deploy.field.buildCwd'])
    if (draft.buildScript.trim() === '') return requiredError(copy['deploy.field.buildScript'])
    if (draft.artifactPath.trim() === '') return requiredError(copy['deploy.field.artifactPath'])
    return null
  }
  if (draft.artifactPath.trim() === '') return requiredError(copy['deploy.field.artifactPath'])
  if (draft.sshInstanceId.trim() === '') return copy['deploy.error.ssh']
  if (!draft.targetPath.startsWith('/') || !draft.workRoot.startsWith('/')) return requiredError(copy['deploy.field.targetPath'])
  if (!draft.remoteScript.startsWith('/')) return copy['deploy.error.remotePath'].replace('{field}', copy['deploy.field.remoteScript'])
  if (draft.scriptVersion.trim() === '') return copy['deploy.error.scriptVersion']
  if (!SHA256_PATTERN.test(draft.scriptSha256.trim())) return copy['deploy.error.scriptSha']
  if (!draft.composeFile.startsWith('/') || !draft.envFile.startsWith('/')) return copy['deploy.error.remotePath'].replace('{field}', copy['deploy.field.composeFile'])
  if (draft.healthUrl.trim() === '') return requiredError(copy['deploy.field.healthUrl'])
  if (draft.imageName.trim() === '' || draft.containerName.trim() === '' || !draft.backupDir.startsWith('/')) return copy['deploy.error.runtime']
  return null
}

function Field({ label, hint, wide = false, required = false, children }: FormFieldProps): ReactNode {
  return (
    <label className={wide ? 'ao-deploy-field is-wide' : 'ao-deploy-field'}>
      <span className="ao-deploy-field-label">{label}{required ? <em>*</em> : null}</span>
      {children}
      {hint === undefined ? null : <small className="ao-deploy-field-hint">{hint}</small>}
    </label>
  )
}
/** Render the business deployment surface. */
export function DeploymentPanel(): React.ReactElement {
  const api = useMemo(() => createCapabilityApi(), [])
  const [instances, setInstances] = useState<readonly Integration[]>([])
  const [tools, setTools] = useState<readonly ToolItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null)
    const [instanceResult, toolResult] = await Promise.all([api.listIntegrations(), api.listTools()])
    setLoading(false)
    const firstError = errorOf(instanceResult) ?? errorOf(toolResult)
    if (firstError !== null) { setError(firstError); return }
    setInstances(instanceResult.ok ? (instanceResult.value as { integrations?: Integration[] }).integrations ?? [] : [])
    setTools(toolResult.ok ? (toolResult.value as { tools?: ToolItem[] }).tools ?? [] : [])
  }, [api])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (draft === null) return
    const close = (event: KeyboardEvent): (void) => { if (event.key === 'Escape') setDraft(null) }
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('keydown', close) }
  }, [draft])

  const sshInstances = instances.filter(item => item.capabilityId === 'ssh' && item.status === 'enabled' && item.credentialConfigured)
  const deployments = instances.filter(item => item.capabilityId === DEPLOYMENT_CAPABILITY)
  const builds = instances.filter(item => item.capabilityId === BUILD_CAPABILITY)
  const deploymentTools = tools.filter(item => item.capabilityId === DEPLOYMENT_CAPABILITY || item.capabilityId === BUILD_CAPABILITY)
  const pinnedDeployments = deployments.filter(scriptPinned)

  const openNew = (kind: 'deployment' | 'build'): (void) => {
    setDraft({ ...baseDraft(kind), sshInstanceId: sshInstances[0]?.instanceId ?? '' })
    setDraftError(null)
    setNotice(null)
  }
  const openEdit = (item: Integration): (void) => { setDraft(draftFrom(item)); setDraftError(null); setNotice(null) }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (draft === null) return
    const validation = validateDraft(draft)
    if (validation !== null) { setDraftError(validation); return }
    setBusy('save')
    const config = draft.kind === 'deployment' ? deploymentConfig(draft) : buildConfig(draft)
    const body = { instanceId: draft.instanceId, capability_id: draft.kind === 'deployment' ? DEPLOYMENT_CAPABILITY : BUILD_CAPABILITY, name: draft.name.trim(), config, access_policy: {}, status: draft.status }
    const result = draft.existing ? await api.updateIntegration(draft.instanceId, body) : await api.createIntegration(body)
    setBusy('')
    if (!result.ok) { setDraftError(errorOf(result) ?? copy['deploy.error.save']); return }
    setDraft(null); setNotice(copy['deploy.saved']); await load()
  }

  const remove = async (item: Integration): Promise<void> => {
    if (!window.confirm(copy['deploy.confirmDelete'].replace('{name}', item.name))) return
    setBusy(item.instanceId)
    const result = await api.deleteIntegration(item.instanceId)
    setBusy('')
    if (!result.ok) { setError(errorOf(result) ?? copy['deploy.error.delete']); return }
    await load()
  }
  const toggle = async (item: Integration): Promise<void> => {
    setBusy(item.instanceId)
    const result = await api.updateIntegration(item.instanceId, { capability_id: item.capabilityId, name: item.name, config: item.config, access_policy: {}, status: item.status === 'enabled' ? 'disabled' : 'enabled' })
    setBusy('')
    if (!result.ok) { setError(errorOf(result) ?? copy['deploy.error.save']); return }
    await load()
  }

  const derived = draft === null ? null : manifestPaths(draft)

  return (
    <div className="ao-capability-page ao-deploy-page">
      <header className="ao-deploy-hero">
        <div className="ao-deploy-hero-copy">
          <div className="ao-deploy-eyebrow">{copy['deploy.kicker']}</div>
          <h1>{copy['deploy.title']}</h1>
          <p>{copy['deploy.description']}</p>
          <div className="ao-deploy-hero-meta">
            <span><strong>{deployments.length}</strong> {copy['deploy.stat.deployments']}</span>
            <span><strong>{pinnedDeployments.length}</strong> {copy['deploy.stat.pinned']}</span>
            <span><strong>{sshInstances.length}</strong> {copy['deploy.stat.ssh']}</span>
          </div>
        </div>
        <div className="ao-deploy-hero-actions">
          <button type="button" className="ao-capability-btn secondary" onClick={() => { void load() }} disabled={loading}>{copy['refresh']}</button>
          <button type="button" className="ao-capability-btn secondary" onClick={() => { openNew('build') }}>{copy['deploy.newBuild']}</button>
          <button type="button" className="ao-capability-btn primary" onClick={() => { openNew('deployment') }} disabled={sshInstances.length === 0}>{copy['deploy.new']}</button>
        </div>
      </header>

      {error === null ? null : <div className="ao-capability-error" role="alert">{error}</div>}
      {notice === null ? null : <div className="ao-capability-notice" role="status">{notice}</div>}
      {sshInstances.length === 0 ? <div className="ao-capability-notice">{copy['deploy.noSsh']}</div> : null}

      <section className="ao-deploy-summary-grid" aria-label={copy['deploy.summaryLabel']}>
        <article className="ao-deploy-stat"><span>{copy['deploy.stat.deployments']}</span><strong>{deployments.length}</strong><small>{copy['deploy.stat.deploymentsHint']}</small></article>
        <article className="ao-deploy-stat"><span>{copy['deploy.stat.pinned']}</span><strong>{pinnedDeployments.length}/{deployments.length}</strong><small>{copy['deploy.stat.pinnedHint']}</small></article>
        <article className="ao-deploy-stat"><span>{copy['deploy.stat.builds']}</span><strong>{builds.length}</strong><small>{copy['deploy.stat.buildsHint']}</small></article>
        <article className="ao-deploy-stat"><span>{copy['deploy.stat.ssh']}</span><strong>{sshInstances.length}</strong><small>{copy['deploy.stat.sshHint']}</small></article>
      </section>      <section className="ao-deploy-section-card ao-deploy-production-records">
        <div className="ao-deploy-section-head">
          <div><h2>{copy['deploy.deploymentsTitle']}</h2><p>{copy['deploy.deploymentsDescription']}</p></div>
          <span className="ao-deploy-count">{deployments.length}</span>
        </div>
        {loading ? <div className="ao-deploy-empty">{copy['loading']}</div> : deployments.length === 0 ? (
          <div className="ao-deploy-empty">
            <strong>{copy['deploy.emptyTitle']}</strong>
            <p>{copy['deploy.emptyHint']}</p>
            <button type="button" className="ao-capability-btn primary" onClick={() => { openNew('deployment') }} disabled={sshInstances.length === 0}>{copy['deploy.new']}</button>
          </div>
        ) : (
          <div className="ao-deploy-record-scroll">
            <table className="ao-deploy-record-table">
              <thead>
                <tr>
                  <th>{copy['deploy.col.name']}</th>
                  <th>{copy['deploy.col.ssh']}</th>
                  <th>{copy['deploy.col.target']}</th>
                  <th>{copy['deploy.col.script']}</th>
                  <th>{copy['deploy.col.health']}</th>
                  <th>{copy['deploy.col.actions']}</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((item) => {
                  const config = objectOf(item.config) ?? {}
                  const remote = objectOf(config.remote) ?? {}
                  const environment = objectOf(config.environment) ?? {}
                  const health = objectOf(config.health) ?? {}
                  const checks = Array.isArray(health.checks) ? health.checks : []
                  const firstCheck = Array.isArray(checks[0]) ? checks[0] as unknown[] : []
                  const ssh = sshInstances.find(candidate => candidate.instanceId === textOf(config.sshInstanceId))
                  const pinned = scriptPinned(item)
                  const envFile = textOf(environment.installedEnvFile)
                  const healthUrl = textOf(firstCheck.at(-1))
                  return (
                    <tr key={item.instanceId}>
                      <td>
                        <div className="ao-deploy-record-instance">
                          <span className={`ao-deploy-state-dot is-${statusTone(item.status)}`} aria-hidden="true" />
                          <div><strong>{item.name}</strong><code>{item.instanceId}</code></div>
                          <span className={`ao-deploy-status is-${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="ao-deploy-record-stack">
                          <strong>{ssh?.name ?? copy['deploy.instance.sshMissing']}</strong>
                          <code>{ssh === undefined ? textOf(config.sshInstanceId) : hostLabel(ssh)}</code>
                        </div>
                      </td>
                      <td>
                        <div className="ao-deploy-record-stack">
                          <code title={textOf(remote.targetPath)}>{textOf(remote.targetPath) || '—'}</code>
                          <span>{envFile === '' ? '—' : copy['deploy.envBound'].replace('{path}', envFile)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="ao-deploy-record-script">
                          <div><strong>{textOf(remote.scriptVersion) || '—'}</strong><span className={pinned ? 'ao-deploy-integrity-badge is-ok' : 'ao-deploy-integrity-badge is-warning'}>{pinned ? copy['deploy.scriptReady'] : copy['deploy.scriptNotReady']}</span></div>
                          <code title={textOf(remote.scriptSha256)}>{shortDigest(textOf(remote.scriptSha256))}</code>
                        </div>
                      </td>
                      <td><code className="ao-deploy-record-health" title={healthUrl}>{healthUrl || '—'}</code></td>
                      <td>
                        <div className="ao-capability-actions ao-deploy-record-actions">
                          <button type="button" className="ao-capability-btn secondary sm" onClick={() => { openEdit(item) }}>{copy['instance.edit']}</button>
                          <button type="button" className="ao-capability-btn secondary sm" onClick={() => { void toggle(item) }} disabled={busy === item.instanceId}>{item.status === 'enabled' ? copy['deploy.disable'] : copy['deploy.enable']}</button>
                          <button type="button" className="ao-capability-btn danger sm" onClick={() => { void remove(item) }} disabled={busy === item.instanceId}>{copy['instance.delete']}</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="ao-deploy-lower-layout">
        <section className="ao-deploy-section-card">
          <div className="ao-deploy-section-head">
            <div><h2>{copy['deploy.buildsTitle']}</h2><p>{copy['deploy.buildsDescription']}</p></div>
            <span className="ao-deploy-count">{builds.length}</span>
          </div>
          {builds.length === 0 ? (
            <div className="ao-deploy-empty is-compact">
              <strong>{copy['deploy.buildEmptyTitle']}</strong>
              <p>{copy['deploy.buildEmptyHint']}</p>
              <button type="button" className="ao-capability-btn secondary" onClick={() => { openNew('build') }}>{copy['deploy.newBuild']}</button>
            </div>
          ) : (
            <div className="ao-deploy-build-list">
              {builds.map((item) => {
                const config = objectOf(item.config) ?? {}
                const outputs = Array.isArray(config.outputs) ? config.outputs : []
                return (
                  <article className="ao-deploy-build-card" key={item.instanceId}>
                    <div className="ao-deploy-instance-head">
                      <div className="ao-deploy-instance-identity"><span className={`ao-deploy-state-dot is-${statusTone(item.status)}`} aria-hidden="true" /><div><h3>{item.name}</h3><code>{item.instanceId}</code></div></div>
                      <span className={`ao-deploy-status is-${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                    </div>
                    <div className="ao-deploy-build-meta">
                      <div><span>{copy['deploy.col.localRoot']}</span><code>{textOf(config.localRoot) || '—'}</code></div>
                      <div><span>{copy['deploy.field.artifactPath']}</span><code>{textOf(outputs[0]) || '—'}</code></div>
                    </div>
                    <div className="ao-deploy-instance-foot">
                      <span className="ao-deploy-integrity-badge">{copy['deploy.buildLocalOnly']}</span>
                      <div className="ao-capability-actions">
                        <button type="button" className="ao-capability-btn secondary sm" onClick={() => { openEdit(item) }}>{copy['instance.edit']}</button>
                        <button type="button" className="ao-capability-btn secondary sm" onClick={() => { void toggle(item) }} disabled={busy === item.instanceId}>{item.status === 'enabled' ? copy['deploy.disable'] : copy['deploy.enable']}</button>
                        <button type="button" className="ao-capability-btn danger sm" onClick={() => { void remove(item) }} disabled={busy === item.instanceId}>{copy['instance.delete']}</button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <aside className="ao-deploy-side">
          <section className="ao-deploy-side-card ao-deploy-integrity-card">
            <div className="ao-deploy-side-head"><div><h2>{copy['deploy.scriptTitle']}</h2><p>{copy['deploy.scriptDescription']}</p></div><span className={pinnedDeployments.length === deployments.length && deployments.length > 0 ? 'ao-deploy-integrity-badge is-ok' : 'ao-deploy-integrity-badge is-warning'}>{pinnedDeployments.length}/{deployments.length}</span></div>
            <ol className="ao-deploy-integrity-list">
              <li><b>01</b><div><strong>{copy['deploy.integrity.path']}</strong><span>{copy['deploy.integrity.pathHint']}</span></div></li>
              <li><b>02</b><div><strong>{copy['deploy.integrity.digest']}</strong><span>{copy['deploy.integrity.digestHint']}</span></div></li>
              <li><b>03</b><div><strong>{copy['deploy.integrity.verify']}</strong><span>{copy['deploy.integrity.verifyHint']}</span></div></li>
            </ol>
            <p className="ao-deploy-integrity-note">{copy['deploy.integrity.failClosed']}</p>
          </section>

          <section className="ao-deploy-side-card">
            <div className="ao-deploy-side-head"><div><h2>{copy['deploy.toolsTitle']}</h2><p>{copy['deploy.toolsDescription']}</p></div><span className="ao-deploy-count">{deploymentTools.length}</span></div>
            {deploymentTools.length === 0 ? <div className="ao-deploy-tools-empty">{copy['deploy.tools.empty']}</div> : <div className="ao-deploy-tool-tags">{deploymentTools.map(tool => <span key={tool.toolId}>{tool.displayName}</span>)}</div>}
          </section>
        </aside>
      </div>
      {draft === null ? null : (
        <div className="ao-capability-modal ao-deploy-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null) }}>
          <form className="ao-capability-dialog ao-deploy-dialog" role="dialog" aria-modal="true" aria-labelledby="ao-deploy-dialog-title" onSubmit={(event) => { void save(event) }}>
            <header className="ao-capability-dialog-header ao-deploy-dialog-header">
              <div>
                <div className="ao-deploy-eyebrow">{draft.kind === 'deployment' ? copy['deploy.dialogKicker.deployment'] : copy['deploy.dialogKicker.build']}</div>
                <h2 id="ao-deploy-dialog-title">{draft.existing ? copy['deploy.edit'] : draft.kind === 'deployment' ? copy['deploy.new'] : copy['deploy.newBuild']}</h2>
                <p>{draft.kind === 'deployment' ? copy['deploy.dialogDescription.deployment'] : copy['deploy.dialogDescription.build']}</p>
              </div>
              <button type="button" className="ao-capability-dialog-close" aria-label={copy['deploy.close']} onClick={() => { setDraft(null) }}>×</button>
            </header>

            <div className="ao-capability-dialog-body ao-deploy-dialog-body">
              <p className="ao-deploy-form-intro">{draft.kind === 'deployment' ? copy['deploy.formIntro.deployment'] : copy['deploy.formIntro.build']}</p>
              {draftError === null ? null : <div className="ao-capability-dialog-error" role="alert">{draftError}</div>}

              <section className="ao-deploy-form-section">
                <div className="ao-deploy-form-section-head"><span>01</span><div><h3>{copy['deploy.section.basic']}</h3><p>{draft.kind === 'deployment' ? copy['deploy.section.basicHint.deployment'] : copy['deploy.section.basicHint.build']}</p></div></div>
                <div className="ao-deploy-form-grid">
                  <Field label={copy['deploy.field.name']} required>
                    <input value={draft.name} autoFocus placeholder={copy['deploy.field.namePlaceholder']} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} />
                  </Field>
                  <Field label={copy['deploy.field.tenantKey']} hint={copy['deploy.field.tenantKeyHint']} required>
                    <input className="ao-deploy-mono-input" value={draft.tenantKey} spellCheck={false} onChange={(event) => { setDraft({ ...draft, tenantKey: event.target.value }) }} />
                  </Field>
                  <Field label={copy['deploy.field.ownerDomain']} hint={copy['deploy.field.ownerDomainHint']} required>
                    <input className="ao-deploy-mono-input" value={draft.ownerDomain} spellCheck={false} onChange={(event) => { setDraft({ ...draft, ownerDomain: event.target.value }) }} />
                  </Field>
                  {draft.kind === 'deployment' ? (
                    <Field label={copy['deploy.field.ssh']} hint={copy['deploy.field.sshHint']} wide required>
                      <select
                        value={draft.sshInstanceId}
                        onChange={(event) => { setDraft({ ...draft, sshInstanceId: event.target.value }) }}
                      >
                        {sshInstances.length === 0 ? <option value="">{copy['instance.config.select']}</option> : null}
                        {sshInstances.map(ssh => <option key={ssh.instanceId} value={ssh.instanceId}>{sshDisplayName(ssh)}</option>)}
                      </select>
                    </Field>
                  ) : null}
                </div>
              </section>

              <section className="ao-deploy-form-section">
                <div className="ao-deploy-form-section-head"><span>02</span><div><h3>{draft.kind === 'deployment' ? copy['deploy.section.artifact'] : copy['deploy.section.build']}</h3><p>{draft.kind === 'deployment' ? copy['deploy.section.artifactHint'] : copy['deploy.section.buildHint']}</p></div></div>
                <div className="ao-deploy-form-grid">
                  <Field label={draft.kind === 'deployment' ? copy['deploy.field.localRootDeployment'] : copy['deploy.field.localRoot']} hint={draft.kind === 'deployment' ? copy['deploy.field.localRootDeploymentHint'] : copy['deploy.field.localRootHint']} wide required>
                    <input className="ao-deploy-mono-input" value={draft.localRoot} spellCheck={false} onChange={(event) => { setDraft({ ...draft, localRoot: event.target.value }) }} />
                  </Field>
                  {draft.kind === 'build' ? <>
                    <Field label={copy['deploy.field.buildCwd']} required><input className="ao-deploy-mono-input" value={draft.buildCwd} spellCheck={false} onChange={(event) => { setDraft({ ...draft, buildCwd: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.buildScript']} required><input className="ao-deploy-mono-input" value={draft.buildScript} spellCheck={false} onChange={(event) => { setDraft({ ...draft, buildScript: event.target.value }) }} /></Field>
                  </> : null}
                  <Field label={copy['deploy.field.artifactPath']} hint={copy['deploy.field.artifactPathHint']} wide required><input className="ao-deploy-mono-input" value={draft.artifactPath} spellCheck={false} onChange={(event) => { setDraft({ ...draft, artifactPath: event.target.value }) }} /></Field>
                  <div className="ao-deploy-derived is-wide">
                    <div className="ao-deploy-derived-head"><strong>{copy['deploy.derived.title']}</strong><span>{copy['deploy.derived.hint']}</span></div>
                    <dl><div><dt>{copy['deploy.field.manifest']}</dt><dd><code>{derived?.manifest ?? ''}</code></dd></div><div><dt>{copy['deploy.field.manifestDigest']}</dt><dd><code>{derived?.manifestDigest ?? ''}</code></dd></div></dl>
                  </div>
                </div>
              </section>
              {draft.kind === 'deployment' ? <>
                <section className="ao-deploy-form-section">
                  <div className="ao-deploy-form-section-head"><span>03</span><div><h3>{copy['deploy.section.server']}</h3><p>{copy['deploy.section.serverHint']}</p></div></div>
                  <div className="ao-deploy-form-grid">
                    <Field label={copy['deploy.field.targetPath']} required><input className="ao-deploy-mono-input" value={draft.targetPath} spellCheck={false} onChange={(event) => { setDraft({ ...draft, targetPath: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.workRoot']} required><input className="ao-deploy-mono-input" value={draft.workRoot} spellCheck={false} onChange={(event) => { setDraft({ ...draft, workRoot: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.composeFile']} required><input className="ao-deploy-mono-input" value={draft.composeFile} spellCheck={false} onChange={(event) => { setDraft({ ...draft, composeFile: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.envFile']} hint={copy['deploy.field.envFileHint']} required><input className="ao-deploy-mono-input" value={draft.envFile} spellCheck={false} onChange={(event) => { setDraft({ ...draft, envFile: event.target.value }) }} /></Field>
                  </div>
                </section>

                <section className="ao-deploy-form-section">
                  <div className="ao-deploy-form-section-head"><span>04</span><div><h3>{copy['deploy.section.runtime']}</h3><p>{copy['deploy.section.runtimeHint']}</p></div></div>
                  <div className="ao-deploy-form-grid">
                    <Field label={copy['deploy.field.imageName']} required><input className="ao-deploy-mono-input" value={draft.imageName} spellCheck={false} onChange={(event) => { setDraft({ ...draft, imageName: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.containerName']} required><input className="ao-deploy-mono-input" value={draft.containerName} spellCheck={false} onChange={(event) => { setDraft({ ...draft, containerName: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.healthUrl']} wide required><input className="ao-deploy-mono-input" value={draft.healthUrl} spellCheck={false} onChange={(event) => { setDraft({ ...draft, healthUrl: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.backupDir']} wide required><input className="ao-deploy-mono-input" value={draft.backupDir} spellCheck={false} onChange={(event) => { setDraft({ ...draft, backupDir: event.target.value }) }} /></Field>
                  </div>
                </section>

                <section className="ao-deploy-form-section is-integrity">
                  <div className="ao-deploy-form-section-head"><span>05</span><div><h3>{copy['deploy.section.script']}</h3><p>{copy['deploy.section.scriptHint']}</p></div></div>
                  <div className="ao-deploy-form-grid">
                    <Field label={copy['deploy.field.remoteScript']} hint={copy['deploy.field.remoteScriptHint']} wide required><input className="ao-deploy-mono-input" value={draft.remoteScript} spellCheck={false} onChange={(event) => { setDraft({ ...draft, remoteScript: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.scriptVersion']} required><input value={draft.scriptVersion} spellCheck={false} onChange={(event) => { setDraft({ ...draft, scriptVersion: event.target.value }) }} /></Field>
                    <Field label={copy['deploy.field.scriptSha256']} hint={copy['deploy.field.scriptShaHint']} wide required><input className="ao-deploy-mono-input" value={draft.scriptSha256} spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder={copy['deploy.field.digestPlaceholder']} onChange={(event) => { setDraft({ ...draft, scriptSha256: event.target.value.trim() }) }} /></Field>
                    <div className="ao-deploy-integrity-callout is-wide">
                      <strong>{copy['deploy.integrity.ready']}</strong>
                      <p>{copy['deploy.integrity.callout']}</p>
                      <div><span>{copy['deploy.integrity.path']}</span><code>{draft.remoteScript || '—'}</code></div>
                      <div><span>{copy['deploy.integrity.digest']}</span><code>{shortDigest(draft.scriptSha256)}</code></div>
                    </div>
                  </div>
                </section>
              </> : null}
            </div>

            <footer className="ao-capability-dialog-footer ao-deploy-dialog-footer">
              <span>{draft.existing ? draft.instanceId : copy['deploy.newInstanceId']}</span>
              <div className="ao-capability-actions">
                <button type="button" className="ao-capability-btn secondary" onClick={() => { setDraft(null) }}>{copy['instance.cancel']}</button>
                <button type="submit" className="ao-capability-btn primary" disabled={busy === 'save'}>{draft.existing ? copy['deploy.save'] : copy['deploy.create']}</button>
              </div>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}
