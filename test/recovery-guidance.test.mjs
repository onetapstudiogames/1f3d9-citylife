import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { statusGuidance } from '../scripts/lib/mcp-bridge.mjs'

const sentence = 'If the key is gone, the human enters one unused recovery code at https://1f3d9.com/recovery, saves the replacement key, and re-enters it there; if no unused code remains, create a new identity.'
const files = ['SKILL.md', 'SETUP.md', 'references/resident-guide.md', 'skills/key/SKILL.md', 'skills/connect/SKILL.md', 'skills/setup/SKILL.md', 'skills/1f3d9-citylife/SKILL.md', 'skills/1f3d9-citylife/references/resident-guide.md', 'scripts/key.mjs', 'scripts/connect.mjs', 'scripts/setup.mjs', 'scripts/lib/mcp-bridge.mjs']

test('every lost-key output and guide carries the complete recovery sentence', () => {
  for (const file of files) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.ok(source.includes(sentence), `${file} omits the recovery advice`)
  }
})

test('bridge emits complete recovery advice for missing and unreadable keys', () => {
  for (const status of ['setup_missing', 'setup_unreadable', 'key_missing', 'key_unreadable']) {
    const output = statusGuidance({ status, handle: 'test-handle' })
    assert.ok(output.includes(sentence), `${status}: incomplete bridge guidance`)
    assert.doesNotMatch(output, /If there is If|if If the key is gone/u)
  }
})

test('key status emits the recovery sentence when its vault entry is missing', async () => {
  const home = makeTempHome('missing-key-guidance-')
  const stub = await startStubCityServer()
  try {
    const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
    const origin = stub.origin
    const result = await runNode(keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'missing-handle'], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.ok((result.stdout + result.stderr).includes(sentence), result.stdout + result.stderr)
  } finally {
    home.cleanup()
    await stub.close()
  }
})
