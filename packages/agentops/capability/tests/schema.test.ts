import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITY_TABLES, SCHEMA_VERSION, createCapabilitySchema, readSchemaVersion } from '../src/schema.ts'
import { DatabaseSync } from 'node:sqlite'

void test('schema creates the versioned capability tables', () => {
  const db = new DatabaseSync(':memory:')
  try {
    createCapabilitySchema(db)
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION)
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name))
    for (const name of CAPABILITY_TABLES) assert.equal(names.has(name), true, name)
  } finally {
    db.close()
  }
})
