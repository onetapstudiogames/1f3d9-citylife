// A fully stubbed Windows Credential Manager round trip: write, read back,
// promote through the same path rotate/recover use, then delete. The stub
// models the PowerShell CredWrite/CredRead shim and cmdkey deletion in memory,
// so this test covers the win32 backend without touching the host's vault.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deleteSecret, promoteReplacementKey, readSecret, storeSecret } from '../scripts/identity-client.mjs'

const posix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const fakeKey = () => `1f3d9_sk_${randomBytes(24).toString('hex')}`
const fakeRecoveryCode = () => `1f3d9_rc_${randomBytes(32).toString('hex')}`

function makeWindowsVaultStub() {
  const entries = new Map()
  const execFileSync = (command, args, options = {}) => {
    if (command === 'powershell.exe' && options.input !== undefined) {
      const { target, blob } = JSON.parse(options.input)
      entries.set(target, blob)
      return ''
    }
    if (command === 'powershell.exe') {
      const target = /CredRead\('([^']+)'/u.exec(args.at(-1))?.[1]
      if (!target || !entries.has(target)) throw new Error('credential not found')
      return entries.get(target)
    }
    if (command === 'cmdkey' && args[0]?.startsWith('/delete:')) {
      entries.delete(args[0].slice('/delete:'.length))
      return ''
    }
    if (command === 'cmdkey' && args[0] === '/list') {
      return [...entries.keys()].map(target => `Target: ${target}`).join('\n')
    }
    throw new Error(`unexpected credential command: ${command}`)
  }
  return { entries, execFileSync }
}

test('stubbed Windows Credential Manager round trip: write, read back, promote, delete', () => {
  const origin = `https://vault-roundtrip-test.invalid/${posix()}`
  const handle = `vault-test-${posix()}`
  const stagingLabel = `${handle}--pending-rotation`
  const originalKey = fakeKey()
  const recoveryCodes = Array.from({ length: 8 }, () => fakeRecoveryCode())
  const replacementKey = fakeKey()
  const homeDir = mkdtempSync(join(tmpdir(), 'vault-roundtrip-windows-'))
  const vault = makeWindowsVaultStub()
  const deps = { homeDir, platform: 'win32', execFileSync: vault.execFileSync }

  try {
    const writeLocation = storeSecret(origin, handle, {
      kind: 'resident',
      handle,
      client_class: 'coding_persistent',
      resident_key: originalKey,
      recovery_codes: recoveryCodes,
      origin,
    }, deps)
    assert.match(writeLocation, /^Windows Credential Manager/u)

    const readBack = readSecret(origin, handle, deps)
    assert.equal(readBack.found, true)
    assert.equal(readBack.value.resident_key, originalKey)
    assert.deepEqual(readBack.value.recovery_codes, recoveryCodes)

    storeSecret(origin, stagingLabel, {
      kind: 'staging',
      handle,
      resident_key: replacementKey,
      origin,
    }, deps)
    const promoteLocation = promoteReplacementKey(origin, handle, stagingLabel, replacementKey, previous => ({
      ...(previous?.client_class ? { client_class: previous.client_class } : {}),
      ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
    }), deps)
    assert.match(promoteLocation, /^Windows Credential Manager/u)

    const afterPromote = readSecret(origin, handle, deps)
    assert.equal(afterPromote.value.resident_key, replacementKey)
    assert.deepEqual(afterPromote.value.recovery_codes, recoveryCodes)
    assert.equal(readSecret(origin, stagingLabel, deps).found, false)

    deleteSecret(origin, handle, deps)
    assert.equal(readSecret(origin, handle, deps).found, false)
    assert.equal(vault.entries.size, 0, 'the in-memory credential store is empty after delete')
  } finally {
    deleteSecret(origin, stagingLabel, deps)
    deleteSecret(origin, handle, deps)
    rmSync(homeDir, { recursive: true, force: true })
  }
})
