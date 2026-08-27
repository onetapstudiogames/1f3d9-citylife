import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertVersionAdvance,
  checkRepositoryVersion,
} from '../scripts/check-release-version.mjs'

const manifestPaths = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'gemini-extension.json',
  'qwen-extension.json',
]

const runGit = (cwd, ...argumentsList) => {
  const result = spawnSync('git', argumentsList, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

const createRepository = async ({ skill = 'city\n', references = {} } = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'citylife-release-test-'))
  await Promise.all([
    mkdir(join(cwd, '.claude-plugin'), { recursive: true }),
    mkdir(join(cwd, '.codex-plugin'), { recursive: true }),
    mkdir(join(cwd, 'agents'), { recursive: true }),
    mkdir(join(cwd, 'references'), { recursive: true }),
  ])
  await Promise.all([
    ...manifestPaths.map((path) => writeFile(join(cwd, path), '{"version":"1.0.0"}\n')),
    writeFile(join(cwd, 'SKILL.md'), skill),
    writeFile(join(cwd, 'agents/openai.yaml'), 'interface: {}\n'),
    ...Object.entries(references).map(([path, content]) => writeFile(join(cwd, 'references', path), content)),
  ])
  runGit(cwd, 'init', '--quiet')
  runGit(cwd, 'config', 'user.email', 'release-test@example.invalid')
  runGit(cwd, 'config', 'user.name', 'Release Test')
  runGit(cwd, 'add', '.')
  runGit(cwd, 'commit', '--quiet', '-m', 'test fixture')
  return { cwd, baseRef: runGit(cwd, 'rev-parse', 'HEAD') }
}

test('semantic skill changes require a strictly newer release version', () => {
  assert.doesNotThrow(() => {
    assertVersionAdvance({ changed: false, baseVersion: '1.0.0', currentVersion: '1.0.0' })
  })
  assert.throws(
    () => assertVersionAdvance({ changed: true, baseVersion: '1.0.0', currentVersion: '1.0.0' }),
    /must advance past 1\.0\.0/u,
  )
  assert.doesNotThrow(() => {
    assertVersionAdvance({ changed: true, baseVersion: '1.0.0', currentVersion: '1.1.0' })
  })
  assert.throws(
    () => assertVersionAdvance({ changed: true, baseVersion: '1.1.0', currentVersion: '1.0.1' }),
    /must advance past 1\.1\.0/u,
  )
  assert.throws(
    () => assertVersionAdvance({ changed: true, baseVersion: 'v1', currentVersion: '1.1.0' }),
    /valid x\.y\.z/u,
  )
  assert.throws(
    () => assertVersionAdvance({ changed: false, baseVersion: '2.0.0', currentVersion: '1.0.0' }),
    /must not go backwards/iu,
  )
})

test('this checkout couples semantic skill changes to the manifest release', async (t) => {
  const result = await checkRepositoryVersion({
    baseRef: process.env.SKILL_VERSION_BASE_SHA,
    requireBase: process.env.REQUIRE_RELEASE_BASE === '1',
  })

  if (result.skipped) {
    t.skip(result.notice)
    return
  }

  assert.equal(result.valid, true)
})

test('base comparison preserves meaningful boundary whitespace', async (t) => {
  const fixture = await createRepository({ skill: '\ncity\n\n' })
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }))
  await writeFile(join(fixture.cwd, 'SKILL.md'), 'city\n')

  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  )
})

test('added and removed semantic references both require a version advance', async (t) => {
  const fixture = await createRepository({ references: { 'existing.md': 'existing\n' } })
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }))

  await unlink(join(fixture.cwd, 'references/existing.md'))
  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  )

  await writeFile(join(fixture.cwd, 'references/existing.md'), 'existing\n')
  await writeFile(join(fixture.cwd, 'references/added.md'), 'added\n')
  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  )
})
