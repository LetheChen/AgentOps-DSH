import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteInstalledSkill, listManagedSkills, readDisabledSkills, writeDisabledSkills } from '../src/skills.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentops-skills-'))
  const managedDir = join(root, 'managed')
  const disabledFile = join(root, 'disabled.json')
  mkdirSync(managedDir, { recursive: true })
  return { root, managedDir, disabledFile }
}

test('disabled skill manifest round-trips and validates names', () => {
  const f = fixture()
  try {
    writeDisabledSkills(f.disabledFile, ['disabled-skill', 'disabled-skill'])
    assert.deepEqual([...readDisabledSkills(f.disabledFile)], ['disabled-skill'])
    writeFileSync(f.disabledFile, JSON.stringify({ skills: ['Bad_Name'] }))
    assert.throws(() => readDisabledSkills(f.disabledFile), /invalid name/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('listManagedSkills marks installed and disabled rows without leaking paths', async () => {
  const f = fixture()
  try {
    const installedPath = join(f.managedDir, 'installed-skill', 'SKILL.md')
    mkdirSync(join(f.managedDir, 'installed-skill'), { recursive: true })
    writeFileSync(installedPath, '---\nname: installed-skill\ndescription: installed\n---\n')
    writeDisabledSkills(f.disabledFile, ['installed-skill'])
    const skills = {
      snapshot: async () => ({
        complete: true,
        skills: [{
          name: 'installed-skill', description: 'installed', source: 'custom', provider: 'filesystem',
          path: installedPath, invocation: { modelInvocable: true, userInvocable: true },
        }],
      }),
    }
    const result = await listManagedSkills(skills, f)
    const installed = result.skills.find(skill => skill.name === 'installed-skill')
    assert.equal(installed?.installed, true)
    assert.equal(installed?.disabled, true)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('deleteInstalledSkill removes managed skills but refuses built-ins', () => {
  const f = fixture()
  try {
    const installedDir = join(f.managedDir, 'installed-skill')
    mkdirSync(installedDir, { recursive: true })
    const installedPath = join(installedDir, 'SKILL.md')
    writeFileSync(installedPath, '---\nname: installed-skill\ndescription: installed\n---\n')
    deleteInstalledSkill([{ name: 'installed-skill', path: installedPath }], f, 'installed-skill')
    assert.equal(existsSync(installedDir), false)

    const builtinPath = join(f.root, 'builtin', 'SKILL.md')
    assert.throws(
      () => { deleteInstalledSkill([{ name: 'builtin-skill', path: builtinPath }], f, 'builtin-skill') },
      /built in/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
