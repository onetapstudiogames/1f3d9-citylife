// One real Windows Credential Manager round trip, using a fake key of the
// exact resident-key shape identity-client.mjs validates (never a real one):
// write, read back, promote (via promoteReplacementKey, the same path
// rotate()/recoverBegin() use), delete, then confirm with the real `cmdkey`
// tool that nothing was left behind. This exercises the actual Win32
// CredWrite/CredRead API through the PowerShell/.NET shim in
// scripts/identity-client.mjs, not a mock — so it only runs on win32 and
// skips honestly everywhere else (this repo's own CI runs on ubuntu-latest,
// where the file-backend tests in identity-client.test.mjs cover the
// equivalent round trip instead).
//
// The console evidence this test prints is redacted: it prints only that a
// value round-tripped correctly (booleans/lengths), never the fake key or
// recovery codes themselves, and never the `cmdkey /list` output's raw
// lines beyond a redacted count/match check.
//
// The secret bundle itself deliberately goes to the REAL Windows Credential
// Manager (that IS the thing under test) -- but every storeSecret/
// promoteReplacementKey/deleteSecret call still passes a throwaway temp
// homeDir, so the non-secret vault-index.json bookkeeping those write stays
// confined to that temp directory and never touches the operator's real
// ~/.1f3d9/vault-index.json. Cleanup goes through deleteSecret (same
// homeDir) rather than a bare `cmdkey /delete`, so both the real credential
// AND its temp-index entry are removed together, the same pairing every
// other caller of storeSecret/deleteSecret relies on.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deleteSecret, promoteReplacementKey, readSecret, storeSecret } from '../scripts/identity-client.mjs'

const posix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
// Matches ROOT_KEY_RE / RECOVERY_CODE_RE in identity-client.mjs exactly
// (^1f3d9_sk_[0-9a-f]{48}$ / ^1f3d9_rc_[0-9a-f]{64}$) with real random hex,
// never a real resident's key — this is a fixture, not a live credential.
const fakeKey = () => `1f3d9_sk_${randomBytes(24).toString('hex')}`
const fakeRecoveryCode = () => `1f3d9_rc_${randomBytes(32).toString('hex')}`

test(
  'real Windows Credential Manager round trip: write, read back, promote, delete, confirm nothing left',
  { skip: process.platform !== 'win32' && 'this probe only exercises the real win32 CredWrite/CredRead path' },
  () => {
    const origin = `https://vault-roundtrip-test.invalid/${posix()}`
    const handle = `vault-test-${posix()}`
    const target = `1f3d9:${origin}:${handle}`
    const stagingLabel = `${handle}--pending-rotation`
    const stagingTarget = `1f3d9:${origin}:${stagingLabel}`

    const originalKey = fakeKey()
    const recoveryCodes = Array.from({ length: 8 }, () => fakeRecoveryCode())
    const replacementKey = fakeKey()
    assert.notEqual(originalKey, replacementKey, 'test fixture sanity: original and replacement differ')

    const homeDir = mkdtempSync(join(tmpdir(), 'vault-roundtrip-windows-'))
    const deps = { homeDir }
    // Tracks which vault labels (never raw targets) still need cleaning up
    // through deleteSecret -- the same real-credential-plus-temp-index pair
    // storeSecret wrote -- so a failed assertion never leaves either half
    // behind.
    let cleanupNeeded = [handle, stagingLabel]
    try {
      // --- write --------------------------------------------------------
      const writeLocation = storeSecret(origin, handle, {
        kind: 'resident',
        handle,
        client_class: 'coding_persistent',
        resident_key: originalKey,
        recovery_codes: recoveryCodes,
        origin,
      }, deps)
      console.log(`[vault-roundtrip] write: ok (${writeLocation.startsWith('Windows Credential Manager') ? 'Windows Credential Manager' : 'unexpected backend'})`)
      assert.match(writeLocation, /^Windows Credential Manager/u)

      // --- read back: must equal exactly what was written ---------------
      const readBack = readSecret(origin, handle, deps)
      assert.equal(readBack.found, true)
      assert.equal(readBack.value.resident_key, originalKey, 'read-back resident_key matches exactly what was written')
      assert.deepEqual(readBack.value.recovery_codes, recoveryCodes, 'read-back recovery_codes match exactly')
      console.log(`[vault-roundtrip] read back: ok (resident_key matches: ${readBack.value.resident_key === originalKey}, recovery_codes match: ${JSON.stringify(readBack.value.recovery_codes) === JSON.stringify(recoveryCodes)})`)

      // --- promote: same path rotate()/recoverBegin() use ---------------
      // Stage the replacement under a distinct target first, exactly as
      // rotate() does, before promoting it over the live entry.
      storeSecret(origin, stagingLabel, {
        kind: 'resident',
        handle,
        resident_key: replacementKey,
        origin,
      }, deps)
      const promoteLocation = promoteReplacementKey(origin, handle, stagingLabel, replacementKey, (previous) => ({
        ...(previous?.client_class ? { client_class: previous.client_class } : {}),
        ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
      }), deps)
      assert.match(promoteLocation, /^Windows Credential Manager/u)
      const afterPromote = readSecret(origin, handle, deps)
      assert.equal(afterPromote.found, true)
      assert.equal(afterPromote.value.resident_key, replacementKey, 'live entry now holds the promoted replacement key')
      assert.notEqual(afterPromote.value.resident_key, originalKey, 'the old key no longer lives at the live entry')
      assert.deepEqual(afterPromote.value.recovery_codes, recoveryCodes, 'recovery_codes carried forward across promotion')
      console.log(`[vault-roundtrip] promote: ok (live entry now holds replacement: ${afterPromote.value.resident_key === replacementKey}, staging cleaned up: ${!readSecret(origin, stagingLabel, deps).found})`)
      assert.equal(readSecret(origin, stagingLabel, deps).found, false, 'promoteReplacementKey deletes the staging entry on success')
      cleanupNeeded = [handle] // staging already deleted by promotion

      // --- delete + confirm with the real cmdkey tool --------------------
      // deleteSecret is the module's own delete path (cmdkey /delete plus
      // the matching temp-index removal) -- using it here, not a bare
      // cmdkey call, is itself part of what this test verifies: that a
      // normal deleteSecret call really does remove the real Credential
      // Manager entry, not just the index bookkeeping.
      deleteSecret(origin, handle, deps)
      cleanupNeeded = []
      const afterDelete = readSecret(origin, handle, deps)
      assert.equal(afterDelete.found, false, 'entry is gone from Credential Manager after deleteSecret')

      const listing = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
      const matchesLeft = (listing.match(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length
      const stagingMatchesLeft = (listing.match(new RegExp(stagingTarget.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length
      console.log(`[vault-roundtrip] cmdkey /list confirms cleanup: live target occurrences=${matchesLeft}, staging target occurrences=${stagingMatchesLeft} (both expected 0)`)
      assert.equal(matchesLeft, 0, 'cmdkey /list no longer lists the live target')
      assert.equal(stagingMatchesLeft, 0, 'cmdkey /list no longer lists the staging target')
    } finally {
      // Best-effort cleanup even on assertion failure, so a failed run
      // never leaves a fake credential (or its temp-index entry) behind.
      for (const leftoverLabel of cleanupNeeded) {
        try {
          deleteSecret(origin, leftoverLabel, deps)
        } catch {
          // Nothing to delete, or already gone — fine either way.
        }
      }
      rmSync(homeDir, { recursive: true, force: true })
    }
  },
)
