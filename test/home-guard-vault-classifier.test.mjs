// Pins scripts/run-tests-with-home-guard.mjs's pre-existing-leak classifier
// directly: findPreexistingLoopbackLeaks() (and the parseVaultTargetName /
// isLoopbackOrigin helpers under it) is the piece that inspects the BEFORE
// platform-vault snapshot -- the before/after diff elsewhere in that file
// only ever catches a leak that happens DURING a run, so a credential that
// leaked on a PREVIOUS run and is still sitting in the real vault when this
// run starts is present in both snapshots and invisible to that diff. This
// file exists to pin the classifier's two failure-mode boundaries in
// isolation, without spawning `node --test` recursively: importing
// run-tests-with-home-guard.mjs never runs the guard itself (see the
// isMainModule gate at the bottom of that file) -- only `npm test`'s own
// direct `node scripts/run-tests-with-home-guard.mjs` invocation does.

import assert from 'node:assert/strict'
import { platform } from 'node:os'
import test from 'node:test'

import {
  findPreexistingLoopbackLeaks,
  isLoopbackOrigin,
  parseVaultTargetName,
  snapshotPlatformVaultTargets,
  classifyGuardResult,
} from '../scripts/run-tests-with-home-guard.mjs'

test('parseVaultTargetName splits origin and label around the origin\'s own port colon', () => {
  const parsed = parseVaultTargetName('1f3d9:http://127.0.0.1:54321:alice-agent')
  assert.deepEqual(parsed, { origin: 'http://127.0.0.1:54321', label: 'alice-agent' })
})

test('parseVaultTargetName handles a portless https origin', () => {
  const parsed = parseVaultTargetName('1f3d9:https://1f3d9.com:alice-agent')
  assert.deepEqual(parsed, { origin: 'https://1f3d9.com', label: 'alice-agent' })
})

test('parseVaultTargetName returns null for a name outside the 1f3d9: target shape', () => {
  assert.equal(parseVaultTargetName('not-a-1f3d9-target-at-all'), null)
})

test('isLoopbackOrigin is true for localhost and 127.0.0.1, false for a real hostname', () => {
  assert.equal(isLoopbackOrigin('http://localhost:41234'), true)
  assert.equal(isLoopbackOrigin('http://127.0.0.1:41234'), true)
  assert.equal(isLoopbackOrigin('https://1f3d9.com'), false)
  assert.equal(isLoopbackOrigin('not a url at all'), false)
})

test('findPreexistingLoopbackLeaks flags a leftover stub-origin target from a previous run', () => {
  const targetsBefore = {
    supported: true,
    names: ['1f3d9:http://127.0.0.1:54321:alice-agent--pending-registration-deadbeef'],
  }
  const leaks = findPreexistingLoopbackLeaks(targetsBefore)
  assert.deepEqual(leaks, ['1f3d9:http://127.0.0.1:54321:alice-agent--pending-registration-deadbeef'])
})

test('findPreexistingLoopbackLeaks never flags a real, non-loopback resident entry', () => {
  const targetsBefore = {
    supported: true,
    names: ['1f3d9:https://1f3d9.com:real-operator-resident'],
  }
  assert.deepEqual(findPreexistingLoopbackLeaks(targetsBefore), [])
})

test('findPreexistingLoopbackLeaks returns empty rather than false-flagging when the platform scan is unsupported', () => {
  assert.deepEqual(findPreexistingLoopbackLeaks({ supported: false, names: [] }), [])
})

test('findPreexistingLoopbackLeaks handles a mix of loopback residue and a real resident entry correctly', () => {
  const targetsBefore = {
    supported: true,
    names: [
      '1f3d9:http://localhost:9999:leaked-test-agent',
      '1f3d9:https://1f3d9.com:real-operator-resident',
    ],
  }
  assert.deepEqual(findPreexistingLoopbackLeaks(targetsBefore), ['1f3d9:http://localhost:9999:leaked-test-agent'])
})

test('snapshotPlatformVaultTargets returns supported:true, ok:true with a names array on this platform\'s vault tool', () => {
  const snapshot = snapshotPlatformVaultTargets()
  if (platform() === 'win32' || platform() === 'darwin') {
    assert.equal(snapshot.supported, true)
    // ok can legitimately be false here too (the real enumeration tool can
    // fail on any host for reasons outside this test's control), but when
    // it succeeds the shape below must hold.
    if (snapshot.ok) {
      assert.equal(Array.isArray(snapshot.names), true)
      for (const name of snapshot.names) assert.equal(name.startsWith('1f3d9:'), true)
    } else {
      assert.deepEqual(snapshot.names, [])
    }
  } else {
    assert.deepEqual(snapshot, { supported: false, ok: true, names: [] })
  }
})

test('snapshotPlatformVaultTargets reports ok:false, not ok:true with an empty result, when the enumeration tool itself cannot run', (t) => {
  if (platform() !== 'win32' && platform() !== 'darwin') {
    t.skip('this failure mode only exercises the win32 cmdkey / darwin security code paths')
    return
  }
  // Same technique used to reproduce this finding by hand: strip PATH so the
  // platform's enumeration binary (cmdkey.exe / security) cannot be found by
  // the child-process spawn, which makes execFileSync throw ENOENT the same
  // way a genuinely broken host would. Restored in `finally` no matter what,
  // since a leaked empty PATH would break every later test in this process.
  const realPath = process.env.PATH
  const realPathLower = process.env.Path
  try {
    process.env.PATH = ''
    if (realPathLower !== undefined) process.env.Path = ''
    const snapshot = snapshotPlatformVaultTargets()
    assert.deepEqual(snapshot, { supported: true, ok: false, names: [] })
  } finally {
    process.env.PATH = realPath
    if (realPathLower !== undefined) process.env.Path = realPathLower
  }
})

function dirSnapshot(entries) {
  return { existed: true, entries }
}

const cleanTargets = { supported: true, ok: true, names: [] }
const failedTargets = { supported: true, ok: false, names: [] }

test('classifyGuardResult reports nothing and does not fail when nothing changed', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([])
  const result = classifyGuardResult({ before, after, targetsBefore: cleanTargets, targetsAfter: cleanTargets })
  assert.deepEqual(result.messages, [])
  assert.equal(result.failed, false)
})

test('classifyGuardResult fails outright and names the enumeration tool when either read could not enumerate', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([])
  const result = classifyGuardResult({ before, after, targetsBefore: failedTargets, targetsAfter: cleanTargets })
  assert.equal(result.failed, true)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /could not be enumerated/u)
})

test('classifyGuardResult still reports a real directory leak even when enumeration failed on the same run', () => {
  // This is the exact suppression this classifier exists to close: a
  // previous exclusive if/else meant a real, already-proven ~/.1f3d9 leak
  // was hidden behind "investigate the enumeration tool" whenever cmdkey/
  // security also happened to fail on the same run. Both must be reported.
  const before = dirSnapshot([])
  const after = dirSnapshot([{ path: 'leaked.json', size: 2 }])
  const result = classifyGuardResult({ before, after, targetsBefore: failedTargets, targetsAfter: cleanTargets })
  assert.equal(result.failed, true)
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[0], /could not be enumerated/u)
  assert.match(result.messages[1], /real ~\/\.1f3d9 changed/u)
  assert.match(result.messages[1], /leaked\.json \(new, 2 bytes\)/u)
})

test('classifyGuardResult reports a real directory leak on its own when enumeration succeeded', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([{ path: 'leaked.json', size: 2 }])
  const result = classifyGuardResult({ before, after, targetsBefore: cleanTargets, targetsAfter: cleanTargets })
  assert.equal(result.failed, true)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /real ~\/\.1f3d9 changed/u)
})

test('classifyGuardResult reports a real platform-vault target drift when enumeration succeeded on both reads', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([])
  const targetsBefore = { supported: true, ok: true, names: [] }
  const targetsAfter = { supported: true, ok: true, names: ['1f3d9:https://1f3d9.com:leaked-agent'] }
  const result = classifyGuardResult({ before, after, targetsBefore, targetsAfter })
  assert.equal(result.failed, true)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /vault entries under/u)
})

test('classifyGuardResult never computes a target drift when enumeration failed (would be meaningless, not just unreported)', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([])
  // targetsAfter's names differ from targetsBefore's, but targetsBefore
  // failed to enumerate -- this pair must never be compared as a diff.
  const targetsAfter = { supported: true, ok: true, names: ['1f3d9:https://1f3d9.com:leaked-agent'] }
  const result = classifyGuardResult({ before, after, targetsBefore: failedTargets, targetsAfter })
  assert.equal(result.failed, true)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /could not be enumerated/u)
})

test('classifyGuardResult reports pre-existing loopback residue and never computes it when enumeration failed', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([])
  const targetsWithResidue = {
    supported: true, ok: true,
    names: ['1f3d9:http://localhost:9999:leaked-test-agent'],
  }
  const clean = classifyGuardResult({ before, after, targetsBefore: targetsWithResidue, targetsAfter: targetsWithResidue })
  assert.equal(clean.failed, true)
  assert.equal(clean.messages.length, 1)
  assert.match(clean.messages[0], /already held 1 loopback-origin/u)

  // findPreexistingLoopbackLeaks itself already guards on ok===false (see
  // its own doc comment), so residue is never asserted from an unreadable
  // BEFORE snapshot -- pin that through the classifier too.
  const failedWithResidue = { ...targetsWithResidue, ok: false }
  const withFailure = classifyGuardResult({ before, after, targetsBefore: failedWithResidue, targetsAfter: cleanTargets })
  assert.equal(withFailure.failed, true)
  assert.equal(withFailure.messages.length, 1)
  assert.match(withFailure.messages[0], /could not be enumerated/u)
})

test('classifyGuardResult reports every applicable failure together, not just the first', () => {
  const before = dirSnapshot([])
  const after = dirSnapshot([{ path: 'leaked.json', size: 2 }])
  const targetsWithResidue = {
    supported: true, ok: false,
    names: [],
  }
  const result = classifyGuardResult({ before, after, targetsBefore: targetsWithResidue, targetsAfter: cleanTargets })
  assert.equal(result.failed, true)
  // enumeration failure + real directory drift; no target drift (not
  // comparable) and no pre-existing leak (targetsBefore.ok is false, so
  // findPreexistingLoopbackLeaks already returns []).
  assert.equal(result.messages.length, 2)
})

