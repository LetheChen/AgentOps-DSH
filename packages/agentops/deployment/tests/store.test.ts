import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DeploymentStore } from '../src/store.ts'
import { DeploymentError } from '../src/types.ts'

void test('claims one release lease and persists image backup evidence', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new DeploymentStore(db)
    const claimed = store.claim({
      instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-1', ownerPreset: 'deploy_operator',
    })
    store.recordStep(claimed.releaseUid, { name: 'uploaded', status: 'passed', at: 'now' })
    store.recordStep(claimed.releaseUid, { name: 'backup', status: 'passed', at: 'now' }, {
      backupTag: 'app:backup-20261119-153045-ab12cd34', backupImageId: 'sha256:old',
    })
    store.settle(claimed.releaseUid, 'healthy')
    const status = store.status('app-production')
    assert.equal(status.current?.releaseId, 'build-1')
    assert.equal(status.current?.backupTag, 'app:backup-20261119-153045-ab12cd34')
    assert.equal(status.current?.backupImageId, 'sha256:old')
    assert.equal(store.lease('app-production'), null)
  } finally {
    db.close()
  }
})

void test('rejects a second lease until the first settles', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new DeploymentStore(db)
    const claimed = store.claim({ instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-1', ownerPreset: 'deploy_operator' })
    assert.throws(() => store.claim({
      instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-2', ownerPreset: 'deploy_operator',
    }), (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_LEASE_HELD')
    store.settle(claimed.releaseUid, 'failed')
    assert.doesNotThrow(() => store.claim({
      instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-2', ownerPreset: 'deploy_operator',
    }))
  } finally {
    db.close()
  }
})

void test('keeps the lease on an unknown remote outcome', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new DeploymentStore(db)
    const claimed = store.claim({ instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-1', ownerPreset: 'deploy_operator' })
    store.holdUnknown(claimed.releaseUid, 'release-command', 'ssh disconnected')
    assert.equal(store.get(claimed.releaseUid).state, 'unknown_hold')
    assert.equal(store.lease('app-production')?.state, 'unknown_hold')
    assert.throws(() => store.claim({
      instanceId: 'app-production', tenantKey: 'tenant-a', releaseId: 'build-2', ownerPreset: 'deploy_operator',
    }), (error: unknown) => error instanceof DeploymentError && error.code === 'DEPLOYMENT_LEASE_HELD')
  } finally {
    db.close()
  }
})
