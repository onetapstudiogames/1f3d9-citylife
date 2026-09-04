// Permanent coverage for the round-3 review of `key adopt`
// (scripts/key.mjs): the only state that may ever be treated as "the live
// entry is dead" is a probe the city answered with an actual credential
// rejection -- an HTTP 401 whose body is the city's own parsed JSON
// error, never a 403 and never any other 401 shape (round-4 finding,
// covered separately in test/key-adopt-round4.test.mjs). Every other probe
// outcome -- a transport failure, or a successful probe naming a different
// resident -- must refuse without touching anything. These tests
// reproduce, then pin, the two destructive states the round-3 review found
// (scratchpad/pr14c-adopt-states.mjs scenarios D and I), plus the
// MEDIUM/LOW findings alongside them.
//
// The stub city server (test/helpers/stub-city-server.mjs) only ever
// answers GET /api/me with 200 or 401, so the transport-failure tests below
// (D and G) use their own tiny controllable HTTPS server -- same fixture
// TLS cert, same shape -- that can be scripted to return an arbitrary
// status on a chosen call, the way a real city blip, timeout, or 5xx
// would look to probeMe.

import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const here = dirname(fileURLToPath(import.meta.url))
const NO_SECRET_LITERAL = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

/**
 * A controllable GET /api/me server: `owners` maps a bearer key to the
 * handle it authenticates as (401 for anything else, matching the real
 * door and the stub), and `script` -- a list indexed by call number,
 * 0-based -- can override any specific call with an arbitrary HTTP status,
 * standing in for a transient city/network fault (503, a rate limit,
 * whatever) without actually needing one to happen. Never used against
 * anything but 127.0.0.1: this is a stand-in for the real city's /api/me,
 * not a client for it.
 */
async function startControllableMeServer() {
  const tlsDir = join(here, 'helpers', 'fixtures')
  const TLS = {
    key: readFileSync(join(tlsDir, 'localhost-key.pem')),
    cert: readFileSync(join(tlsDir, 'localhost-cert.pem')),
  }
  const owners = new Map()
  let script = []
  let calls = 0
  const server = createHttpsServer(TLS, (req, res) => {
    if (req.method === 'GET' && req.url === '/api/me') {
      const idx = calls++
      const override = script[idx]
      if (override) {
        res.writeHead(override.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: override.error ?? 'transient' }))
        return
      }
      const auth = req.headers.authorization ?? ''
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const handle = owners.get(key)
      if (!handle) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ handle }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  return {
    origin: `https://localhost:${server.address().port}`,
    setOwner: (key, handle) => owners.set(key, handle),
    setScript: (list) => { script = list; calls = 0 },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

const GOOD = `1f3d9_sk_${'a'.repeat(48)}`
const OLD = `1f3d9_sk_${'b'.repeat(48)}`
const OTHER = `1f3d9_sk_${'c'.repeat(48)}`
const CODES = [`1f3d9_rc_${'1'.repeat(64)}`, `1f3d9_rc_${'2'.repeat(64)}`]
const handle = 'alice-agent'
const stagingLabel = 'alice-agent--pending-registration-deadbeef'

test('key adopt: a transport failure on the LIVE probe (scenario D) refuses and changes nothing, never overwrites a working key', async () => {
  const controllable = await startControllableMeServer()
  const home = makeTempHome('key-adopt-r3-live-503-')
  try {
    controllable.setOwner(GOOD, handle)
    controllable.setOwner(OLD, handle)
    // The staged probe (call 0) succeeds; the LIVE probe (call 1) hits a
    // scripted 503 -- exactly the shape a city blip or rate limit
    // produces, and NOT a credential rejection.
    controllable.setScript([null, { status: 503, error: 'upstream unavailable' }])
    storeSecret(controllable.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent',
      resident_key: OLD, recovery_codes: CODES, origin: controllable.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(controllable.origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent',
      resident_key: GOOD, origin: controllable.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', controllable.origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses rather than treating an unanswered probe as proof of death')
    assert.match(result.stderr, /could not verify whether the existing entry at "alice-agent" is dead/u)
    assert.match(result.stderr, /upstream unavailable/u)
    assert.match(result.stderr, /nothing was changed/u)
    assert.doesNotMatch(result.stderr, /\breplacing\b/u, 'never claims a replacement that did not happen')
    assertNoSecretLeaked(result, 'key adopt live-probe transport failure')

    const live = readSecret(controllable.origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, OLD, 'the working live key was never overwritten')
    assert.deepEqual(live.value.recovery_codes, CODES, 'its recovery codes were never dropped')
    assert.equal(live.value.recovery_codes_invalidated_at, undefined, 'no false invalidation stamp was written')
    const staging = readSecret(controllable.origin, stagingLabel, { homeDir: home.dir })
    assert.ok(staging.found, 'the staging copy is left in place, not deleted, on refusal')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(controllable.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await controllable.close()
 }
})

test('key adopt: a live key that WORKS but authenticates as a different resident (scenario I) refuses and never destroys it', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-adopt-r3-cross-resident-')
  try {
    stub.residents.set('alice-agent', { resident_key: GOOD, recovery_codes: [], client_class: 'coding_persistent' })
    stub.residents.set('bob-agent', { resident_key: OTHER, recovery_codes: [], client_class: 'coding_persistent' })
    // The vault entry LABELLED "alice-agent" actually holds bob-agent's
    // working key -- a hand-copied entry, a stale label, or a city-
    // normalized handle, the same shape status()/refuseOnHandleMismatch
    // already treat as real everywhere else in this file.
    storeSecret(stub.origin, 'alice-agent', {
      kind: 'resident', handle: 'alice-agent', client_class: 'coding_persistent',
      resident_key: OTHER, recovery_codes: CODES, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(stub.origin, stagingLabel, {
      kind: 'staging', handle: 'alice-agent', client_class: 'coding_persistent',
      resident_key: GOOD, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', stub.origin, '--handle', 'alice-agent', '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses to destroy a live key that works for someone else')
    assert.match(result.stderr, /the vault entry at "alice-agent" holds a key that WORKS, but authenticates as "bob-agent"/u)
    assert.match(result.stderr, /not a dead entry/u)
    assert.match(result.stderr, /key show --handle alice-agent --reveal/u)
    assert.match(result.stderr, /key adopt --handle bob-agent --from-label alice-agent/u)
    assertNoSecretLeaked(result, 'key adopt cross-resident refusal')

    const live = readSecret(stub.origin, 'alice-agent', { homeDir: home.dir })
    assert.equal(live.value.resident_key, OTHER, "bob-agent's working key was never overwritten")
    assert.deepEqual(live.value.recovery_codes, CODES, "bob-agent's recovery codes were never dropped")
    const staging = readSecret(stub.origin, stagingLabel, { homeDir: home.dir })
    assert.ok(staging.found, 'the staging copy is left in place, not deleted, on refusal')
  } finally {
    for (const label of ['alice-agent', stagingLabel]) {
      try { deleteSecret(stub.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await stub.close()
  }
})

test('key adopt: a registration strand keeps its staged recovery codes over a dead live entry, with no false invalidation stamp', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-adopt-r3-reg-codes-')
  try {
    stub.residents.set(handle, { resident_key: GOOD, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_ephemeral',
      resident_key: OLD, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    // A staged REGISTRATION bundle -- register() always stages
    // recovery_codes (identity-client.mjs), unlike rotate()/recoverBegin().
    storeSecret(stub.origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent',
      resident_key: GOOD, recovery_codes: CODES, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', stub.origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.equal(result.status, 0, `adopt over a dead live entry must still succeed: ${result.stderr}`)
    assertNoSecretLeaked(result, 'key adopt registration-strand codes')

    const live = readSecret(stub.origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, GOOD)
    assert.deepEqual(live.value.recovery_codes, CODES, "the staged registration's real recovery codes are kept, not dropped")
    assert.equal(live.value.recovery_codes_invalidated_at, undefined, 'no invalidation stamp is written when the staged bundle carries real codes')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(stub.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await stub.close()
  }
})

test('key adopt: a rotation/recovery strand (no staged codes) stamps recovery_codes_invalidated_at over a dead live entry', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-adopt-r3-rot-stamp-')
  try {
    stub.residents.set(handle, { resident_key: GOOD, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent',
      resident_key: OLD, recovery_codes: CODES, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    // A staged ROTATION bundle -- no recovery_codes field, matching what
    // rotate()'s own promoteReplacementKey call stages.
    storeSecret(stub.origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent',
      resident_key: GOOD, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', stub.origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.equal(result.status, 0, `adopt over a dead live entry must still succeed: ${result.stderr}`)
    assert.match(result.stdout, /the city rejected it/u, 'the success line quotes the actual rejection, not a bare "dead" claim')
    assertNoSecretLeaked(result, 'key adopt rotation-strand stamp')

    const live = readSecret(stub.origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, GOOD)
    assert.ok(!Array.isArray(live.value.recovery_codes), 'a rotation strand carries no codes of its own to keep, and none of the old live entry\'s codes survive the promotion either')
    assert.ok(live.value.recovery_codes_invalidated_at, 'the invalidation stamp IS written when the staged bundle has no codes of its own')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(stub.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await stub.close()
  }
})

test('key adopt: a live entry with no resident_key at all is reported before being replaced, never silently overwritten', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-adopt-r3-malformed-')
  try {
    stub.residents.set(handle, { resident_key: GOOD, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent',
      resident_key: null, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(stub.origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent',
      resident_key: GOOD, recovery_codes: CODES, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', stub.origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.equal(result.status, 0, `promoting over a malformed live entry must still succeed: ${result.stderr}`)
    assert.match(result.stdout, /an entry exists at "alice-agent" but holds no resident_key; replacing it/u)
    assert.match(result.stdout, /replacing the entry found there -- it held no resident_key -- and deleted the staging copy/u)
    assertNoSecretLeaked(result, 'key adopt malformed live entry')

    const live = readSecret(stub.origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, GOOD)
    assert.deepEqual(live.value.recovery_codes, CODES)
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(stub.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await stub.close()
  }
})

test('key adopt: a transport failure on the STAGED probe (scenario G) says "could not be verified", never "does not work"', async () => {
  const controllable = await startControllableMeServer()
  const home = makeTempHome('key-adopt-r3-staged-503-')
  try {
    controllable.setOwner(GOOD, handle)
    controllable.setOwner(OLD, handle)
    // The STAGED probe (call 0) hits the scripted 503 this time.
    controllable.setScript([{ status: 503, error: 'upstream unavailable' }])
    storeSecret(controllable.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent',
      resident_key: OLD, origin: controllable.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(controllable.origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent',
      resident_key: GOOD, origin: controllable.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', controllable.origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses -- a staged key that could not be verified is not adopted')
    assert.match(result.stderr, /could not be verified right now \(upstream unavailable\)/u)
    assert.doesNotMatch(result.stderr, /does not work/u, 'a transport fault is never blamed on the key itself')
    assert.match(result.stderr, /nothing was changed/u)
    assertNoSecretLeaked(result, 'key adopt staged-probe transport failure')

    const live = readSecret(controllable.origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, OLD, 'the live entry is untouched')
    const staging = readSecret(controllable.origin, stagingLabel, { homeDir: home.dir })
    assert.ok(staging.found, 'the staging copy is left in place')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(controllable.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await controllable.close()
  }
})

test('key adopt: refuses safely, naming itself, when another process holds the per-handle vault lock while adopting into an empty slot', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-adopt-r3-lockrace-')
  const raceHandle = 'lockrace-agent'
  const raceStaging = 'lockrace-agent--pending-registration-abc12300'
  try {
    stub.residents.set(raceHandle, { resident_key: GOOD, recovery_codes: [], client_class: 'coding_persistent' })
    // Nothing lives at raceHandle yet -- adopt's own outer read will find
    // an empty slot, which is exactly the state that now makes it pass
    // refuseIfPresent:true into promoteReplacementKey (round-3 LOW
    // finding). Simulate a concurrent register/rotate/recover/adopt for
    // this same handle already holding the per-(origin, handle) lock --
    // same technique as the existing "key recover generate refuses when
    // the per-handle vault lock is already held" test.
    storeSecret(stub.origin, raceStaging, {
      kind: 'staging', handle: raceHandle, client_class: 'coding_persistent',
      resident_key: GOOD, origin: stub.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    const safeOrigin = stub.origin.replace(/[^a-z0-9.-]/giu, '_')
    const safeHandle = raceHandle.replace(/[^a-z0-9._-]/giu, '_')
    const lockDir = join(home.dir, '.1f3d9')
    mkdirSync(lockDir, { recursive: true })
    const lockPath = join(lockDir, `promote-lock__${safeOrigin}__${safeHandle}.lock`)
    writeFileSync(lockPath, '')

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', stub.origin, '--handle', raceHandle, '--from-label', raceStaging],
      { env: home.env, timeout: 10_000 },
    )
    assert.notEqual(result.status, 0, 'refuses rather than writing while the lock is held by someone else')
    assert.match(result.stderr, /could not acquire the per-handle vault lock/u)
    // Round-3 LOW finding: adopt is now named alongside the other three
    // callers that can hold this same lock.
    assert.match(result.stderr, /another registration, rotation, recovery, or adopt/u)
    assertNoSecretLeaked(result, 'key adopt lock-timeout refusal')

    const live = readSecret(stub.origin, raceHandle, { homeDir: home.dir })
    assert.equal(live.found, false, 'nothing was written to the handle while the lock was held')
    const staging = readSecret(stub.origin, raceStaging, { homeDir: home.dir })
    assert.ok(staging.found, 'the staging copy is left in place, not deleted, when the lock could not be acquired')
  } finally {
    for (const label of [raceHandle, raceStaging]) {
      try { deleteSecret(stub.origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await stub.close()
  }
})
