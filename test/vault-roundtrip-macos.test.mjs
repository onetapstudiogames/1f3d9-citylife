import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/lib/vault-backends.mjs'

const isMac = process.platform === 'darwin'

test('macOS Keychain stores and reads the new-agent-2 throwaway entry', {
  skip: !isMac && 'real macOS Keychain coverage runs only on macos-latest',
}, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'new-agent-2-keychain-'))
  const runId = `${process.pid}-${randomUUID().slice(0, 8)}`
  const origin = `https://new-agent-2-${runId}.invalid`
  const label = `new-agent-2-${runId}`
  const expected = {
    resident_key: `1f3d9_sk_${'a'.repeat(48)}`,
    recovery_codes: [`1f3d9_rc_${'b'.repeat(48)}`],
    handle: label,
  }

  try {
    const location = storeSecret(origin, label, expected, { homeDir })
    assert.match(location, /macOS Keychain/u)
    assert.deepEqual(readSecret(origin, label, { homeDir }), { found: true, value: expected })
  } finally {
    deleteSecret(origin, label, { homeDir })
    await rm(homeDir, { recursive: true, force: true })
  }
})
