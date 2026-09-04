// Permanent coverage for round-7 finding 3 (scripts/key.mjs
// requireStoredKey), pre-existing at 5e03eb2 and found on a release walk:
// `requireStoredKey` collapsed "no vault entry at all" and "an entry
// exists but carries no resident_key" into the same "no vault entry
// found" message, contradicting `show()` below (which already worded the
// two states separately) for the exact same handle -- and contradicting
// the very refusal (identity-client.mjs promoteReplacementKey's mismatch
// case) that sends an agent to `key status` to "work out which of the two
// entries is the one you actually want": an agent following that pointer
// was told no entry exists one line after being told an entry is there.
// requireStoredKey now splits the two conditions the way show() already
// does.

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { deleteSecret, storeSecret } from '../scripts/identity-client.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'

const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const NO_SECRET_LITERAL = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

test('key status: an entry that exists but carries no resident_key is never reported as "no vault entry found"', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-status-nokey-')
  try {
    storeSecret(origin, 'keyless-handle', {
      kind: 'resident', handle: 'keyless-handle', origin,
      // deliberately missing resident_key
    }, { homeDir: home.dir })
    const result = await runNode(
      keyPath,
      ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'keyless-handle'],
      { env: { ...home.env, AGENT_1F3D9_STUB_ONLY: '0' } },
    )
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /no vault entry found/u, 'a keyless entry is not "no entry"')
    assert.match(result.stderr, /a vault entry exists for "keyless-handle".*but it carries no resident_key field/u)
    assertNoSecretLeaked(result, 'key status keyless entry')
  } finally {
    try { deleteSecret(origin, 'keyless-handle', { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
 }
})

test('key status: truly no vault entry still says "no vault entry found" (control)', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-status-noentry-')
  try {
    const result = await runNode(
      keyPath,
      ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'never-registered'],
      { env: { ...home.env, AGENT_1F3D9_STUB_ONLY: '0' } },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no vault entry found for "never-registered"/u)
    assertNoSecretLeaked(result, 'key status no entry at all')
  } finally {
    home.cleanup()
  }
})

test('key status: exits nonzero when the stored key authenticates as a different resident', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-status-mismatch-')
  const residentKey = `1f3d9_sk_${'b'.repeat(48)}`
  try {
    stub.residents.set('bob-agent', { resident_key: residentKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'alice-agent', {
      kind: 'resident', handle: 'alice-agent', client_class: 'coding_persistent', resident_key: residentKey,
      origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    const result = await runNode(
      keyPath,
      ['status', '--origin', stub.origin, '--handle', 'alice-agent'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /authenticates as "bob-agent", not "alice-agent"/u)
    assertNoSecretLeaked(result, 'key status mismatched resident')
  } finally {
    deleteSecret(stub.origin, 'alice-agent', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})
