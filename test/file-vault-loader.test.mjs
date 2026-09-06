import assert from 'node:assert/strict'
import test from 'node:test'

import * as vaultBackends from '../scripts/lib/vault-backends.mjs'

test('the file-vault loader redirects the normal vault backend import', () => {
  assert.equal(
    typeof vaultBackends.listTestPlatformVaultTargets,
    'function',
    'the file-vault loader is not installed; run via npm test',
  )
})
