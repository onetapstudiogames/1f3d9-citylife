// Permanent coverage for the round-5 review of `key adopt` / `key status`
// (scripts/key.mjs / scripts/lib/identity-probe.mjs / scripts/identity-client.mjs):
//
// 1. MEDIUM (scripts/key.mjs status()): `key status` collapsed every failed
//    probe into "stored key: does not work" -- the exact transient-vs-dead
//    confusion `key adopt` spent three rounds removing from its own probes
//    -- even though `probe.rejected` already told them apart precisely.
//    `key status` is the first command an agent runs to check a key, and
//    it is what adopt's own new refusal messages point back to; an agent
//    told "does not work" during an edge/WAF 403 or a city 503 can
//    reasonably escalate to `key rotate` or `key recover begin`, both of
//    which succeed against a healthy city and both of which irreversibly
//    burn every recovery code, connector session, and delegated grant on
//    false information. `status()` now mirrors adopt's own
//    rejected-vs-not-rejected branch.
//
// 2. LOW (scripts/lib/identity-probe.mjs): `rejected` used to fire for ANY
//    401 whose body was JSON with a string `error`, not only the city's
//    own message -- so a JSON-speaking gateway or rate limiter in front of
//    a healthy origin could still make adopt destroy a working live key,
//    with the disclosed reason attributing to "the city" a string the
//    city never emits. `rejected` now requires the exact known city
//    string (`CITY_REJECTION_MESSAGE`); anything else is "could not
//    verify," quoting the unexpected text verbatim, never blamed on the
//    city.
//
// 3. LOW (scripts/identity-client.mjs promoteReplacementKey): the
//    expectPreviousKey mismatch refusal always asserted a concurrent WRITE
//    landed and told the caller to compare "which of the two entries" they
//    want -- but it also fires when the live entry was simply DELETED in
//    that same window, leaving nothing to compare. The message now branches
//    on whether anything is left at the handle at all.
//
// Reproduces scratchpad/pr14e-status.mjs, scratchpad/pr14e-edge.mjs cases
// N2 and V1, using the same controllable-HTTPS-server technique as
// test/key-adopt-round4.test.mjs.

import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const here = dirname(fileURLToPath(import.meta.url))
const NO_SECRET_LITERAL = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

const tlsFor = () => ({
  key: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-key.pem')),
 cert: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-cert.pem')),
})

/** A fixed-answer /api/me server: every call gets the same scripted response. */
async function startFixedMeServer(answer) {
  const server = createHttpsServer(tlsFor(), (req, res) => {
    if (req.method === 'GET' && req.url === '/api/me') {
      res.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' })
      res.end(answer.body)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  return {
    origin: `https://localhost:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

const GOOD = `1f3d9_sk_${'a'.repeat(48)}`
const OLD = `1f3d9_sk_${'b'.repeat(48)}`
const handle = 'alice-agent'
const stagingLabel = 'alice-agent--pending-rotation-deadbeef'

// --- Finding 1: `key status` must not say "does not work" for a probe ----
// the city never actually answered with a credential rejection.

test('key status: an edge/WAF 403 HTML page never says "does not work" -- prints "could not be verified right now" instead', async () => {
  const server = await startFixedMeServer({ status: 403, contentType: 'text/html', body: '<html><body>Forbidden</body></html>' })
  const home = makeTempHome('key-status-r5-403html-')
  try {
    storeSecret(server.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: GOOD, origin: server.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['status', '--origin', server.origin, '--handle', handle], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /does not work/u, 'a 403 HTML page is not proof the key is dead')
    assert.match(result.stdout, /could not be verified right now/u)
    assert.match(result.stdout, /this is not evidence the key is dead/u)
    assertNoSecretLeaked(result, 'key status 403 HTML')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

test('key status: a city 503 never says "does not work" -- prints "could not be verified right now" instead', async () => {
  const server = await startFixedMeServer({ status: 503, body: JSON.stringify({ error: 'upstream unavailable' }) })
  const home = makeTempHome('key-status-r5-503-')
  try {
    storeSecret(server.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: GOOD, origin: server.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['status', '--origin', server.origin, '--handle', handle], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /does not work/u, 'a 503 is not proof the key is dead')
    assert.match(result.stdout, /could not be verified right now \(upstream unavailable\)/u)
    assertNoSecretLeaked(result, 'key status 503')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

test('key status: a genuine city 401 JSON rejection still says "does not work" (control for the two tests above)', async () => {
  const server = await startFixedMeServer({ status: 401, body: JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }) })
  const home = makeTempHome('key-status-r5-real401-')
  try {
    storeSecret(server.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: GOOD, origin: server.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['status', '--origin', server.origin, '--handle', handle], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /does not work \(resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>\)/u)
    assert.doesNotMatch(result.stdout, /could not be verified right now/u)
    assertNoSecretLeaked(result, 'key status real 401 JSON rejection')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

// --- Finding 2: `rejected` must require the city's OWN exact JSON error --

test('key adopt: a 401 JSON `error` that is not the city\'s own message is not a rejection -- refuses and never attributes the text to the city', async () => {
  const home = makeTempHome('key-adopt-r5-n2-')
  let calls = 0
  let origin
  const server = createHttpsServer(tlsFor(), (req, res) => {
    if (req.method === 'GET' && req.url === '/api/me') {
      const n = calls++
      const auth = req.headers.authorization ?? ''
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (n === 0) {
        // Staged probe -- succeeds normally.
        if (key === GOOD) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ handle }))
          return
        }
      }
      // Live probe -- a JSON-speaking gateway/rate-limiter shape, not the
      // city's own message.
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded; retry later' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  origin = `https://localhost:${server.address().port}`
  try {
    storeSecret(origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: OLD, origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent', resident_key: GOOD, origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'a non-city 401 JSON error must never be treated as a credential rejection')
    assert.match(result.stderr, /could not verify whether the existing entry at "alice-agent" is dead \(rate limit exceeded; retry later\)/u)
    assert.match(result.stderr, /nothing was changed/u)
    assert.doesNotMatch(result.stderr, /the city rejected it/u, 'the city never produced this text -- it must never be attributed to the city')
    assertNoSecretLeaked(result, 'key adopt non-city 401 JSON')

    const live = readSecret(origin, handle, { homeDir: home.dir })
    assert.equal(live.value.resident_key, OLD, 'the working live entry survives a non-city 401 JSON error')
    const staging = readSecret(origin, stagingLabel, { homeDir: home.dir })
    assert.ok(staging.found, 'the staging copy is left in place')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})

// --- Finding 3: the expectPreviousKey mismatch message must not claim a --
// concurrent WRITE landed, and a comparison the caller cannot perform, when
// the live entry was actually DELETED inside the probe window.

test('key adopt: a live entry that VANISHES (is deleted) inside the live-probe window refuses with its own honest wording, not the "concurrent write, compare the two" message', async () => {
  const home = makeTempHome('key-adopt-r5-v1-')
  let deleted = false
  let calls = 0
  let origin
  const server = createHttpsServer(tlsFor(), (req, res) => {
    if (req.method === 'GET' && req.url === '/api/me') {
      const n = calls++
      const auth = req.headers.authorization ?? ''
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (n === 1) {
        // adopt's FIRST-RUN live-entry probe for the OLD (soon-to-be-dead)
        // key -- while it is in flight, delete the entry outright,
        // simulating a concurrent process that removed it rather than
        // replacing it. Every other call (the first run's staged probe at
        // n=0, and the retry run's own staged probe below) falls through
        // to the normal owner check, so the retry's promote-into-empty-slot
        // path never needs its own live probe (existingLive.found is false
        // by then) and behaves exactly as a fresh adopt would.
        deleteSecret(origin, handle, { homeDir: home.dir })
        deleted = true
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }))
        return
      }
      if (key === GOOD) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ handle }))
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  origin = `https://localhost:${server.address().port}`
  try {
    storeSecret(origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: OLD, origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    storeSecret(origin, stagingLabel, {
      kind: 'staging', handle, client_class: 'coding_persistent', resident_key: GOOD, origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['adopt', '--origin', origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.ok(deleted, 'the harness must actually have deleted the entry inside the probe window')
    assert.notEqual(result.status, 0, 'a handle that vanished underneath adopt must refuse, not overwrite')
    assert.match(result.stderr, /has since been deleted/u)
    assert.match(result.stderr, /nothing (?:was overwritten|to compare)/u)
    assert.match(result.stderr, /[Rr]e-run this exact adopt command/u)
    assert.doesNotMatch(result.stderr, /a concurrent write to this same handle on this host must have landed/u, 'nothing was written -- it was deleted, not replaced')
    assert.doesNotMatch(result.stderr, /which of the two entries/u, 'there is only ONE entry left (the staging copy) -- there is nothing to compare')
    assertNoSecretLeaked(result, 'key adopt vanished-live-entry')

    const live = readSecret(origin, handle, { homeDir: home.dir })
    assert.equal(live.found, false, 'the handle stays empty -- adopt did not write into it')
    const staging = readSecret(origin, stagingLabel, { homeDir: home.dir })
    assert.ok(staging.found, 'the staged key is left in place, not deleted, when the write is refused')

    // Self-healing: a plain re-run of the identical command promotes
    // cleanly through the now-empty slot.
    const retry = await runNode(
      keyPath,
      ['adopt', '--origin', origin, '--handle', handle, '--from-label', stagingLabel],
      { env: home.env },
    )
    assert.equal(retry.status, 0, `a plain re-run must promote into the now-empty handle: ${retry.stderr}`)
    const liveAfterRetry = readSecret(origin, handle, { homeDir: home.dir })
    assert.equal(liveAfterRetry.value.resident_key, GOOD, 'the staged key is recovered on re-run')
  } finally {
    for (const label of [handle, stagingLabel]) {
      try { deleteSecret(origin, label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})
