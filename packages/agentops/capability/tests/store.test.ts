import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { BUILTIN_CAPABILITIES } from '../src/catalog.ts'
import { CapabilityError } from '../src/errors.ts'
import { CapabilityStore } from '../src/store.ts'
import type { MasterKey } from '../../vault/src/crypto.ts'

const key: MasterKey = { key: Buffer.alloc(32, 7), source: 'env' }

/** Minimal database configuration that satisfies the declared schema. */
const DB_CONFIG = { engine: 'mysql', host: 'db.internal', port: 3306, username: 'audit_reader', database: 'audit_example' }

function store(): CapabilityStore {
  return new CapabilityStore(':memory:', key)
}

void test('seeds the built-in capability definitions', () => {
  const subject = store()
  try {
    const rows = subject.listCapabilities()
    assert.equal(rows.length, 11)
    assert.deepEqual(new Set(rows.map(row => row.capabilityId)), new Set(BUILTIN_CAPABILITIES.map(row => row.capabilityId)))
  } finally {
    subject.close()
  }
})

void test('reopening refreshes built-in definitions without touching deployment data', () => {
  const path = `${process.cwd()}/.capability-sync-${process.pid}.db`
  const first = new CapabilityStore(path, key)
  try {
    first.saveInstance({
      instanceId: 'db_a', capabilityId: 'database', name: 'Keep me', config: DB_CONFIG, secret: 'keep',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    first.replaceBindings('manager', [{ capabilityId: 'database', instanceId: 'db_a', enabled: true }])
  } finally {
    first.close()
  }
  const raw = new DatabaseSync(path)
  try {
    raw.prepare("UPDATE capability_definitions SET config_schema = '[]' WHERE capability_id = 'database'").run()
    raw.prepare("INSERT INTO capability_definitions(capability_id, name, category, provider, description, transports, config_schema, risk_level, authorization_capability_id, supports_instances, credential_required, created_at, updated_at) VALUES ('retired', 'Retired', 'infrastructure', 'test', '', '[]', '[]', 'low', 'retired', 0, 0, 'now', 'now')").run()
  } finally {
    raw.close()
  }
  const reopened = new CapabilityStore(path, key)
  try {
    const database = reopened.getCapability('database')
    const engine = (database?.configSchema as unknown as Array<{ key: string; options?: string[] }>).find(field => field.key === 'engine')
    assert.deepEqual(engine?.options, ['mysql', 'postgres', 'sqlite'])
    assert.equal(reopened.getInstance('db_a')?.name, 'Keep me')
    assert.equal(reopened.listBindings('manager').length, 1)
    assert.equal(reopened.resolveRuntime('manager', 'database').secret, 'keep')
    assert.equal(reopened.getCapability('retired'), null)
  } finally {
    reopened.close()
    unlinkSync(path)
  }
})

void test('creates an instance with a sealed credential and safe projection', () => {
  const subject = store()
  try {
    const row = subject.saveInstance({
      instanceId: 'audit_reader',
      capabilityId: 'database',
      name: 'Audit DB',
      config: DB_CONFIG,
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
      secret: 'db-secret',
    })
    assert.equal(row.instanceId, 'audit_reader')
    assert.equal(row.credentialConfigured, true)
    assert.equal(row.status, 'enabled')
    assert.equal('secret' in row, false)
    assert.equal('credential_cipher' in row, false)
  } finally {
    subject.close()
  }
})

void test('update without a secret leaves the old cipher intact', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'audit_reader', capabilityId: 'database', name: 'Audit DB',
      config: DB_CONFIG, secret: 'old-secret',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    const updated = subject.saveInstance({
      instanceId: 'audit_reader', capabilityId: 'database', name: 'Audit DB v2',
      config: DB_CONFIG,
    })
    assert.equal(updated.credentialConfigured, true)
    assert.equal(updated.name, 'Audit DB v2')
    subject.replaceBindings('manager', [{ capabilityId: 'database', instanceId: 'audit_reader', enabled: true }])
    assert.equal(subject.resolveRuntime('manager', 'database', 'audit_reader').secret, 'old-secret')
  } finally {
    subject.close()
  }
})

void test('a failed binding replacement rolls back all rows', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'audit_reader', capabilityId: 'database', name: 'Audit DB',
      config: DB_CONFIG, secret: 'db-secret',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    assert.throws(() => subject.replaceBindings('manager', [
      { capabilityId: 'database', instanceId: 'audit_reader', enabled: true },
      { capabilityId: 'database', instanceId: 'missing', enabled: true },
    ]), /missing/)
    assert.deepEqual(subject.listBindings('manager'), [])
  } finally {
    subject.close()
  }
})

void test('binding a database instance without an allowed table is rejected', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'db_empty', capabilityId: 'database', name: 'Empty policy',
      config: DB_CONFIG, secret: 'db-secret',
    })
    assert.throws(() => subject.replaceBindings('manager', [
      { capabilityId: 'database', instanceId: 'db_empty', enabled: true },
    ]), /must authorize at least one table/)
    assert.deepEqual(subject.listBindings('manager'), [])
  } finally {
    subject.close()
  }
})

void test('capability runtime list returns only enabled authorized instances', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'db_on', capabilityId: 'database', name: 'On', config: DB_CONFIG, secret: 'a',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.saveInstance({
      instanceId: 'db_off', capabilityId: 'database', name: 'Off', config: DB_CONFIG, secret: 'b', status: 'disabled',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.replaceBindings('manager', [
      { capabilityId: 'database', instanceId: 'db_on', enabled: true },
      { capabilityId: 'database', instanceId: 'db_off', enabled: false },
    ])
    const rows = subject.listRuntimes('manager', 'database')
    assert.deepEqual(rows.map(row => row.instanceId), ['db_on'])
    assert.equal(rows[0]?.secret, 'a')
  } finally {
    subject.close()
  }
})

void test('binding configuration state distinguishes never configured from explicit empty', () => {
  const subject = store()
  try {
    assert.equal(subject.hasBindings('manager'), false)
    subject.replaceBindings('manager', [])
    assert.equal(subject.hasBindings('manager'), true)
    assert.deepEqual(subject.listRuntimes('manager', 'database'), [])
  } finally {
    subject.close()
  }
})

void test('runtime resolution fails closed for missing and ambiguous bindings', () => {
  const subject = store()
  try {
    assert.throws(
      () => subject.resolveRuntime('manager', 'database'),
      (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_BINDING_MISSING',
    )
    subject.saveInstance({
      instanceId: 'db_a', capabilityId: 'database', name: 'A', config: DB_CONFIG, secret: 'a',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.saveInstance({
      instanceId: 'db_b', capabilityId: 'database', name: 'B', config: DB_CONFIG, secret: 'b',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.replaceBindings('manager', [
      { capabilityId: 'database', instanceId: 'db_a', enabled: true },
      { capabilityId: 'database', instanceId: 'db_b', enabled: true },
    ])
    assert.throws(
      () => subject.resolveRuntime('manager', 'database'),
      (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_BINDING_AMBIGUOUS',
    )
    assert.equal(subject.resolveRuntime('manager', 'database', 'B').secret, 'b')
  } finally {
    subject.close()
  }
})

void test('one transaction writes instance, credential, audit and outbox', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'db_a', capabilityId: 'database', name: 'A', config: DB_CONFIG, secret: 'a',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.replaceBindings('manager', [{ capabilityId: 'database', instanceId: 'db_a', enabled: true }])
    const audit = subject.listAudit()
    assert.equal(audit.some(row => row.action === 'integration.create'), true)
    assert.equal(subject.resolveRuntime('manager', 'database').secret, 'a')
  } finally {
    subject.close()
  }
})


void test('credential-free capability instance resolves without a secret', () => {
  const subject = store()
  try {
    subject.saveInstance({
      instanceId: 'build', capabilityId: 'artifact-build', name: 'Build',
      config: {},
    })
    subject.replaceBindings('manager', [{ capabilityId: 'artifact-build', instanceId: 'build', enabled: true }])
    const runtime = subject.resolveRuntime('manager', 'artifact-build')
    assert.equal(runtime.instanceId, 'build')
    assert.equal(runtime.secret, null)
  } finally {
    subject.close()
  }
})

void test('corrupt ciphertext is reported as decrypt failure, never as missing', () => {
  const path = `${process.cwd()}/.capability-corrupt-${process.pid}.db`
  const subject = new CapabilityStore(path, key)
  try {
    subject.saveInstance({
      instanceId: 'db_a', capabilityId: 'database', name: 'A', config: DB_CONFIG, secret: 'a',
      accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
    })
    subject.replaceBindings('manager', [{ capabilityId: 'database', instanceId: 'db_a', enabled: true }])
  } finally {
    subject.close()
  }
  const raw = new DatabaseSync(path)
  try {
    raw.prepare('UPDATE capability_instances SET credential_cipher = ? WHERE instance_id = ?').run('v1.corrupt', 'db_a')
  } finally {
    raw.close()
  }
  const reopened = new CapabilityStore(path, key)
  try {
    assert.throws(
      () => reopened.resolveRuntime('manager', 'database'),
      (error: unknown) => error instanceof CapabilityError && error.code === 'CREDENTIAL_DECRYPT_FAILED',
    )
  } finally {
    reopened.close()
    unlinkSync(path)
  }
})

void test('imports legacy vault connections into connector instances with their ids', () => {
  const subject = store()
  try {
    const imported = subject.importLegacyConnections([
      {
        id: 'oa_database', kind: 'database', name: 'OA database', driver: 'mysql',
        host: 'db.internal', port: 3306, username: 'reader', defaultDatabase: 'oa',
        enabled: true, secret: 'db-secret',
      },
      {
        id: 'ops_server', kind: 'server', name: 'Ops server', driver: 'ssh',
        host: '10.0.0.8', port: 22, username: 'ops', defaultDatabase: null,
        enabled: false, secret: 'ssh-secret',
      },
    ])
    assert.equal(imported, 2)
    const database = subject.getInstance('oa_database')
    assert.equal(database?.capabilityId, 'database')
    assert.equal(database?.credentialConfigured, true)
    assert.equal(database?.config.engine, 'mysql')
    assert.equal(database?.config.host, 'db.internal')
    const server = subject.getInstance('ops_server')
    assert.equal(server?.capabilityId, 'ssh')
    assert.equal(server?.status, 'disabled')
    assert.equal(server?.config.host, '10.0.0.8')
    assert.equal(subject.importLegacyConnections([{
      id: 'oa_database', kind: 'database', name: 'Ignored duplicate', driver: 'mysql',
      host: 'ignored', port: null, username: '', defaultDatabase: null,
      enabled: true, secret: null,
    }]), 0)
    assert.equal(subject.getInstance('oa_database')?.name, 'OA database')
  } finally {
    subject.close()
  }
})
