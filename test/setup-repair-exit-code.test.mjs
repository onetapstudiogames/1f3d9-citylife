// Permanent coverage for round-7 finding 1 (scripts/setup.mjs), pre-existing
// at 5e03eb2 (the round-5-approved commit) and found on a release walk
// after round 6's four items were already confirmed fixed:
//
// `finishAsRepair`'s two top-level call sites -- the `existing.handle`
// repair branch, and the "a working vault entry already exists" adopt-
// and-repair branch -- both ended with a hardcoded `process.exit(0)`,
// which threw away the `process.exitCode = 1` that `report()` sets when
// the stored key could not be verified, is dead, or authenticates as a
// different resident. The file's own comment on that line said exactly why
// this must not happen ("exiting 0 anyway would tell a caller that
// branches on exit status this run succeeded when the connection it
// verified does not actually work"), and CLAUDE.md rule 6 names honest
// status codes as a hard rule -- yet `setup` printed "secret reference
// works: no" and still exited 0, for a script whose entire job is
// verifying a stored resident key. Both call sites now let the module fall
// off the end naturally (setup.mjs no longer calls `process.exit()` at
// all -- see the comment above `class SetupRefusal` there), honoring
// whatever `process.exitCode` `report()` already set.
//
// Reproduces scratchpad/pr14f-repair-exit0.mjs's three failure shapes
// using the same controllable-HTTPS-server technique
// test/key-adopt-round5.test.mjs already uses. See
// test/setup-windows-abort.test.mjs for the sibling Windows-only crash
// finding (2) found on the same walk.

import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, storeSecret } from '../scripts/identity-client.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
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

/** A fixed-answer /api/me server: every call gets the same scripted response; every other path answers 200. */
async function startFixedMeServer(answer) {
  const server = createHttpsServer(tlsFor(), (req, res) => {
    if (req.method === 'GET' && req.url === '/api/me') {
      res.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' })
      res.end(answer.body)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ identity: { coding_client_doors: { register: '/api/register' } } }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  return {
    origin: `https://localhost:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

const handle = 'alice-agent'
const GOOD = `1f3d9_sk_${'a'.repeat(48)}`

/**
 * Runs `setup.mjs` with no --handle/--client-class (a repair pass) against
 * a vault entry for `handle` and a matching non-secret setup-state.json,
 * against a server that answers /api/me with `meAnswer`.
 */
async function runRepairPass(meAnswer) {
  const server = await startFixedMeServer(meAnswer)
  const home = makeTempHome('setup-repair-exit-')
  try {
    storeSecret(server.origin, handle, {
      kind: 'resident', handle, client_class: 'coding_persistent', resident_key: GOOD, origin: server.origin, stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })
    mkdirSync(join(home.dir, '.1f3d9'), { recursive: true })
    writeFileSync(
      join(home.dir, '.1f3d9', 'setup-state.json'),
      JSON.stringify({ [server.origin]: { handle, client_class: 'coding_persistent' } }),
    )
    const result = await runNode(setupPath, ['--origin', server.origin], { env: home.env })
    return { result, server, home }
  } catch (error) {
    await server.close()
    home.cleanup()
    throw error
  }
}

test('setup repair pass exits nonzero when the stored key cannot be verified (transient 503)', async () => {
  const { result, server, home } = await runRepairPass({ status: 503, body: JSON.stringify({ error: 'upstream unavailable' }) })
  try {
    assert.notEqual(result.status, 0, 'a failed verification must never exit 0')
    assert.match(result.stdout, /secret reference works: no \(me read failed: upstream unavailable\)/u)
    assertNoSecretLeaked(result, 'setup repair pass, 503')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

test('setup repair pass exits nonzero when the stored key is genuinely dead (city 401)', async () => {
  const { result, server, home } = await runRepairPass({ status: 401, body: JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }) })
  try {
    assert.notEqual(result.status, 0, 'a dead key must never exit 0')
    assert.match(result.stdout, /secret reference works: no \(me read failed: resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>\)/u)
    assertNoSecretLeaked(result, 'setup repair pass, 401')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

test('setup repair pass exits nonzero when the vault entry authenticates as a different resident', async () => {
  const { result, server, home } = await runRepairPass({ status: 200, body: JSON.stringify({ handle: 'someone-else' }) })
  try {
    assert.notEqual(result.status, 0, 'a mismatched resident must never exit 0')
    assert.match(result.stdout, /secret reference works: no \(the vault entry labelled "alice-agent" actually authenticates as "someone-else"/u)
    assertNoSecretLeaked(result, 'setup repair pass, mismatch')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

test('setup repair pass exits 0 when the stored key genuinely works (control)', async () => {
  const { result, server, home } = await runRepairPass({ status: 200, body: JSON.stringify({ handle }) })
  try {
    assert.equal(result.status, 0)
    assert.match(result.stdout, /secret reference works: yes/u)
    assertNoSecretLeaked(result, 'setup repair pass, control')
  } finally {
    try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
    home.cleanup()
    await server.close()
  }
})

