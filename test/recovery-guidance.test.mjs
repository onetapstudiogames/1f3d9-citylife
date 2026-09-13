import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { statusGuidance } from '../scripts/lib/mcp-bridge.mjs'
import { LOST_KEY_ADVICE, UNREADABLE_ENTRY_ADVICE } from '../scripts/lib/recovery-guidance.mjs'

// Two cases, never merged.
//   Case B — the key is KNOWN to be gone: one unused recovery code replaces
//            it, and only when no code remains is a new identity the way out.
//   Case A — the entry could not be READ: the key is not known to be gone, so
//            a new identity is never the answer.
const NEW_IDENTITY = 'create a new identity'

// Every guide that spells the Case B sentence out for a reader.
const lostKeyDocs = [
  'SKILL.md',
  'SETUP.md',
  'references/resident-guide.md',
  'skills/key/SKILL.md',
  'skills/connect/SKILL.md',
  'skills/setup/SKILL.md',
  'skills/1f3d9-citylife/SKILL.md',
  'skills/1f3d9-citylife/references/resident-guide.md',
]

// Every script that prints the Case B sentence. Scripts quote the one home in
// scripts/lib/recovery-guidance.mjs; a retyped copy is drift waiting to happen.
const lostKeyScripts = ['scripts/key.mjs', 'scripts/connect.mjs', 'scripts/lib/mcp-bridge.mjs']

// Every script that refuses on an unreadable entry, and how many such
// refusals it holds. The count is asserted so a new refusal cannot be added
// without being checked here.
const unreadableRefusals = [
  ['scripts/connect.mjs', 2],
  ['scripts/key.mjs', 4],
  ['scripts/setup.mjs', 1],
]

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('the two sentences stay distinct, and only the lost-key one offers a new identity', () => {
  assert.ok(LOST_KEY_ADVICE.includes(NEW_IDENTITY), 'Case B ends at a new identity when no code remains')
  assert.ok(!UNREADABLE_ENTRY_ADVICE.includes(NEW_IDENTITY), 'Case A never offers a new identity')
  assert.ok(
    UNREADABLE_ENTRY_ADVICE.endsWith('never create a second identity to work around an unreadable entry.'),
    'Case A ends on the refusal to duplicate an identity',
  )
  assert.ok(UNREADABLE_ENTRY_ADVICE.includes('fix or remove the corrupt entry, then re-run'))
  assert.ok(UNREADABLE_ENTRY_ADVICE.includes('https://1f3d9.com/recovery'))
  // One sentence each: a single terminating period, at the end.
  for (const sentence of [LOST_KEY_ADVICE, UNREADABLE_ENTRY_ADVICE]) {
    assert.equal(sentence.split('. ').length, 1, `one sentence only: ${sentence}`)
    assert.ok(sentence.endsWith('.'))
  }
})

test('every lost-key guide carries the complete Case B sentence, word for word', () => {
  for (const file of lostKeyDocs) {
    assert.ok(read(file).includes(LOST_KEY_ADVICE), `${file} omits the lost-key advice`)
  }
})

test('every lost-key output quotes the one home, never a retyped copy', () => {
  for (const file of [...lostKeyScripts, 'scripts/setup.mjs']) {
    const source = read(file)
    assert.ok(!source.includes(LOST_KEY_ADVICE), `${file} retypes the lost-key sentence instead of importing it`)
    assert.ok(!source.includes(UNREADABLE_ENTRY_ADVICE), `${file} retypes the unreadable-entry sentence instead of importing it`)
  }
  for (const file of lostKeyScripts) {
    assert.ok(read(file).includes('LOST_KEY_ADVICE'), `${file} omits the lost-key advice`)
  }
})

test('setup never advertises a new identity: its only lost-key words are the unreadable-entry case', () => {
  const source = read('scripts/setup.mjs')
  assert.ok(source.includes('UNREADABLE_ENTRY_ADVICE'), 'setup.mjs carries the unreadable-entry advice')
  assert.ok(!source.includes('LOST_KEY_ADVICE'), 'setup.mjs does not also carry the lost-key sentence')
  assert.ok(!source.includes(NEW_IDENTITY), 'setup.mjs never tells the reader to create a new identity')
})

test('no unreadable-entry refusal offers a new identity', () => {
  const guard = 'if (!(error instanceof SecretReadFailure)) throw error'
  for (const [file, expected] of unreadableRefusals) {
    const chunks = read(file).split(guard).slice(1)
    assert.equal(chunks.length, expected, `${file}: unexpected number of unreadable-entry refusals`)
    for (const [index, chunk] of chunks.entries()) {
      const refusal = chunk.slice(0, chunk.indexOf('process.exitCode'))
      assert.ok(!refusal.includes(NEW_IDENTITY), `${file} refusal ${index + 1}: offers a new identity`)
      assert.ok(!refusal.includes('LOST_KEY_ADVICE'), `${file} refusal ${index + 1}: uses the wrong case`)
    }
  }
})

test('bridge guidance keeps the two cases apart', () => {
  for (const status of ['setup_missing', 'key_missing']) {
    const output = statusGuidance({ status, handle: 'test-handle' })
    assert.ok(output.includes(LOST_KEY_ADVICE), `${status}: incomplete bridge guidance`)
  }
  for (const status of ['setup_unreadable', 'key_unreadable']) {
    const output = statusGuidance({ status, handle: 'test-handle' })
    assert.ok(output.includes(UNREADABLE_ENTRY_ADVICE), `${status}: incomplete bridge guidance`)
    assert.ok(!output.includes(NEW_IDENTITY), `${status}: an unreadable entry never means a new identity`)
  }
  for (const status of ['setup_missing', 'setup_unreadable', 'key_missing', 'key_unreadable']) {
    assert.doesNotMatch(statusGuidance({ status, handle: 'test-handle' }), /If there is If|if If the key is gone/u)
  }
})

test('key status emits the lost-key sentence when its vault entry is missing', async () => {
  const home = makeTempHome('missing-key-guidance-')
  const stub = await startStubCityServer()
  try {
    const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
    const origin = stub.origin
    const result = await runNode(keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'missing-handle'], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.ok((result.stdout + result.stderr).includes(LOST_KEY_ADVICE), result.stdout + result.stderr)
  } finally {
    home.cleanup()
    await stub.close()
  }
})
