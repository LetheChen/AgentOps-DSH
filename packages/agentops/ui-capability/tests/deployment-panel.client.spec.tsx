// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { DeploymentPanel } from '../src/client/deployment-panel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ssh = {
  instanceId: 'ssh_prod',
  capabilityId: 'ssh',
  name: '生产服务器',
  config: { host: 'prod.example', port: 22, username: 'deploy', host_key_sha256: 'SHA256:pin' },
  status: 'enabled',
  credentialConfigured: true,
}
const deployment = {
  instanceId: 'deploy_app',
  capabilityId: 'deployment',
  name: '示例应用自动化部署',
  config: {
    sshInstanceId: 'ssh_prod',
    tenantKey: 'tenant-a',
    ownerDomain: 'operations',
    artifact: { localRoot: 'C:\\deploy\\app', updateFiles: ['image/app.tar'] },
    environment: { installedEnvFile: '/opt/app/.env' },
    remote: {
      targetPath: '/opt/app', workRoot: '/tmp/app-release', scriptPath: '/opt/agentops/bin/deploy-image.sh',
      scriptVersion: 'v1', scriptSha256: 'a'.repeat(64), imageName: 'app:latest', containerName: 'app', composeFile: '/opt/app/docker-compose.yml',
    },
    health: { checks: [['curl', '-fsS', 'http://127.0.0.1:8000/health/ready']] },
  },
  status: 'enabled',
  credentialConfigured: false,
}
const tools = [
  { toolId: 'artifact_build', displayName: 'Artifact Build', capabilityId: 'artifact-build', runtimeAvailable: true },
  { toolId: 'deployment_plan', displayName: 'Deployment Plan', capabilityId: 'deployment', runtimeAvailable: true },
]

function reply(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
}

function install(): { readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    bodies.push(body)
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    if (endpoint.endsWith('/integrations') && body.method === 'GET') return reply({ integrations: [ssh, deployment] })
    if (endpoint.endsWith('/tools')) return reply({ tools })
    if (endpoint.endsWith('/integrations') && body.method === 'POST') return reply({})
    return reply({})
  }))
  return { bodies }
}

describe('deployment panel', () => {
  it('shows script integrity and validates the pinned digest in the grouped form', async () => {
    const { bodies } = install()
    render(<DeploymentPanel />)
    expect(await screen.findByText('示例应用自动化部署')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '通用脚本一致性' })).toBeTruthy()
    expect(screen.getByText('已固定')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '新增部署实例' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('基础信息')
    expect(dialog.textContent).toContain('镜像产物与发布清单')
    expect(within(dialog).queryByLabelText('构建工作目录*')).toBeNull()
    expect(within(dialog).queryByLabelText('构建脚本相对路径*')).toBeNull()
    expect(dialog.textContent).toContain('生产服务器')
    expect(dialog.textContent).toContain('运行与检查')
    expect(dialog.textContent).toContain('通用部署脚本')
    expect(within(dialog).getByLabelText<HTMLInputElement>(/已构建产物根目录/).value).toBe('')

    fireEvent.change(screen.getByPlaceholderText('例如 生产部署'), { target: { value: '示例应用 staging' } })
    fireEvent.change(within(dialog).getByLabelText(/已构建产物根目录/), { target: { value: 'C:\\deploy\\app' } })
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }))
    expect(await screen.findByText('请填写 64 位小写 SHA-256')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('64 位小写十六进制'), { target: { value: 'b'.repeat(64) } })
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }))
    await waitFor(() => {
      expect(bodies.some(body => body.method === 'POST' && String(body.endpoint).endsWith('/integrations'))).toBe(true)
    })
    const created = bodies.find(body => body.method === 'POST' && String(body.endpoint).endsWith('/integrations'))
    const payload = created?.body as Record<string, unknown>
    const config = payload.config as Record<string, unknown>
    const remote = config.remote as Record<string, unknown>
    expect(remote.scriptVersion).toBe('v1')
    expect(remote.scriptSha256).toBe('b'.repeat(64))
    expect(remote.scriptPath).toBe('/opt/agentops/bin/deploy-image.sh')
    expect(config.tenantKey).toBe('default')
    expect(config.ownerDomain).toBe('operations')
    expect(remote.imageName).toBe('app:latest')
    expect(remote.containerName).toBe('app')
    expect(remote.updateCommand).toEqual(expect.arrayContaining([
      '--release-id', '{releaseId}',
      '--compose-file', '/opt/app/docker-compose.yml',
      '--container', 'app',
      '--service', 'app',
      '--image-name', 'app:latest',
      '--backup-tag-prefix', 'app:backup',
      '--lock-file', '/run/lock/app-release.lock',
      '--health-url', 'http://127.0.0.1:8000/health/ready',
      '--backup-dir', '/opt/app/backups/mysql',
    ]))
    expect(remote.firstInstallCommand).toEqual(remote.updateCommand)
    expect(remote.rollbackCommand).toEqual(expect.arrayContaining([
      '--rollback',
      '--release-id', '{rollbackReleaseId}',
      '--compose-file', '/opt/app/docker-compose.yml',
      '--container', 'app',
      '--image-name', 'app:latest',
      '--lock-file', '/run/lock/app-release.lock',
    ]))
    expect(remote.rollbackCommand).not.toContain('--image')
  })

  it('shows build-only fields in the separate build instance form', async () => {
    install()
    render(<DeploymentPanel />)
    await screen.findByText('示例应用自动化部署')
    fireEvent.click(screen.getAllByRole('button', { name: '新增构建实例' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('构建与镜像产物')
    expect(dialog.textContent).toContain('构建工作目录')
    expect(dialog.textContent).toContain('构建脚本相对路径')
    expect(within(dialog).queryByLabelText('生产目标目录*')).toBeNull()
    expect(within(dialog).queryByLabelText('通用部署脚本路径*')).toBeNull()
  })
})
