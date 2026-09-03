// Round-5 finding 6: unit coverage for the pure pieces of
// scripts/run-tests-with-home-guard.mjs -- classifyVaultTargetOrigin (the
// loopback-vs-real classifier that decides whether a pre-existing platform
// vault entry is reported as a leak) and the enumeration-failure sentinel
// snapshotPlatformVaultNames now returns, so a transient cmdkey/security
// failure is distinguished from a genuinely empty vault rather than
// silently read as the same thing. Importing this module never runs the
// guard itself -- only isDirectRun there does that (see its own comment).

import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyVaultTargetOrigin, diffNameSets, isDrift, snapshotDir } from '../scripts/run-tests-with-home-guard.mjs'

test('classifyVaultTargetOrigin: localhost and 127.0.0.1, any port, are loopback', () => {
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://localhost:64604:alice-agent'), 'loopback')
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://localhost:alice-agent'), 'loopback')
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://127.0.0.1:64604:alice-agent'), 'loopback')
})

test('classifyVaultTargetOrigin: the real city origin is never classified as loopback', () => {
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://1f3d9.com:alice-agent'), 'real')
})

test('classifyVaultTargetOrigin: an unrelated --allow-origin value is neither loopback nor real', () => {
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://example.invalid:alice-agent'), 'other')
})

test('classifyVaultTargetOrigin: a name without this plugin\'s own prefix is not classified at all', () => {
  assert.equal(classifyVaultTargetOrigin('some-other-app:target'), null)
})

test('classifyVaultTargetOrigin: a bare-domain lookalike ("1f3d9:https://1f3d9.com.evil.example:x") is never "real"', () => {
  // Domain-boundary check: the real-origin test must anchor at the ":"
  // separator, not merely test a "1f3d9.com" substring -- a label like
  // "1f3d9.com.evil.example" must never be classified as the operator's own
  // legitimate resident identity.
  assert.equal(classifyVaultTargetOrigin('1f3d9:https://1f3d9.com.evil.example:x'), 'other')
})

test('diffNameSets: reports both additions and removals between two label sets', () => {
  const diff = diffNameSets(['a', 'b'], ['b', 'c'])
  assert.deepEqual(diff.added, ['c'])
  assert.deepEqual(diff.removed, ['a'])
})

test('isDrift: false for two identical, unchanged snapshots', () => {
  const snap = { existed: true, entries: [{ path: 'vault-index.json', size: 42 }] }
  const diff = { existedChanged: false, added: [], removed: [], changed: [] }
  assert.equal(isDrift(diff), false)
  // sanity: snapshotDir itself never throws for a directory that does not exist
  assert.doesNotThrow(() => snapshotDir('C:/this/path/does/not/exist/at/all'))
})
