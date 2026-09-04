// Permanent, win32-only coverage for round-7 finding 2 (pre-existing at
// 5e03eb2, the round-5-approved commit; found on the release walk after
// round 6's four items were already confirmed fixed):
//
// On Windows, `setup.mjs` used to abort with a libuv `UV_HANDLE_CLOSING`
// assertion (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
// src\win\async.c, line 76`, exit code 0xC0000409 / 3221226505) instead of
// exiting 1 cleanly, whenever a stored vault entry exists for the
// requested handle and its /api/me probe answers anything but 200 (a 503,
// a genuine city 401, or any other non-2xx). This only happened once TWO
// AbortSignal.timeout()-gated fetches had run in the same process
// (probeMe for the vault-adopt check, then probeOfficialDoors for the
// coding-client-doors check) and setup then called a hard `process.exit()`
// -- the crash reproduced whether or not a spawnSync (`listVaultLabels`'s
// `cmdkey /list`) sat between the two fetches. A first fix routed every
// `process.exit()` in setup.mjs through a shared `exitClean()` helper that
// drained briefly (a `setTimeout`, not just a `setImmediate` -- tested and
// found insufficient) before the actual exit -- this masked the crash on
// an idle machine but was still a race: measured failure threshold 20-40ms
// idle, and the shipped 100ms constant crashed a measured fraction of runs
// under real CPU contention. The actual fix removes `process.exit()`
// entirely: setup.mjs now only ever sets `process.exitCode` and lets the
// module fall off the end naturally (see the comment above `class
// SetupRefusal` in scripts/setup.mjs), which cannot race a libuv teardown
// because nothing calls exit while a handle might still be closing. See
// test/setup-repair-exit-code.test.mjs for the sibling repair-path
// exit-code finding (1) found on the same walk.
//
// This is the reviewer's own scratchpad/pr14f-abort-matrix.mjs harness,
// promoted to permanent coverage: same server shape, same request matrix,
// asserting exit code and absence of the libuv assertion text on stderr
// instead of only printing them for a human to read.
//
// Runs ONLY on win32 (skip honestly everywhere else, matching
// test/vault-roundtrip-windows.test.mjs's own convention) -- this crash
// class is specific to Windows' libuv async-handle teardown and cannot
// reproduce on ubuntu-latest. Listed explicitly in the windows-latest leg
// of .github/workflows/ci.yml (this repo's full suite otherwise skips the
// identity-command subprocess tests there for cost reasons -- see that
// file's own comment).

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
const handle = 'alice-agent'
const GOOD = `1f3d9_sk_${'a'.repeat(48)}`
const ASSERTION_TEXT = /Assertion failed/u

const tlsFor = () => ({
  key: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-key.pem')),
  cert: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-cert.pem')),
})

/** A fixed-answer /api/me server; every other path (including /api/official) answers 200. */
async function startFixedMeServer(answer) {
  const server = createHttpsServer(tlsFor(), (req, res) => {
    if (req.url === '/api/me') {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ identity: { coding_client_json: { doors_enabled: true } } }))
  })
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  return {
    origin: `https://localhost:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

/**
 * Runs setup.mjs with an explicit --handle/--client-class (never a repair
 * pass) against a vault entry for `handle` -- this is the shape that
 * reaches BOTH probeMe (the vault-adopt check) and probeOfficialDoors (the
 * coding-client-doors check) before refusing, which is what the crash
 * needs. `withState` additionally seeds ~/.1f3d9/setup-state.json, which
 * still takes the non-repair branch here because --handle/--client-class
 * are passed and name a DIFFERENT origin-state combination than a bare
 * repair pass would read.
 */
async function runNonRepairPass(meAnswer, { storeEntry = true } = {}) {
  const server = await startFixedMeServer(meAnswer)
  const home = makeTempHome('setup-abort-r7-')
  try {
    if (storeEntry) {
      storeSecret(server.origin, handle, {
        kind: 'resident', handle, client_class: 'coding_persistent', resident_key: GOOD, origin: server.origin, stored_at: new Date().toISOString(),
      }, { homeDir: home.dir })
    }
    const result = await runNode(
      setupPath,
      ['--origin', server.origin, '--handle', handle, '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    return { result, server, home }
  } catch (error) {
    await server.close()
    home.cleanup()
    throw error
  }
}

const WIN32_SKIP = process.platform !== 'win32' && 'this crash class is specific to Windows libuv async-handle teardown'

test(
  'setup.mjs exits 1 cleanly (no libuv UV_HANDLE_CLOSING abort) when a vault entry exists and /api/me answers 503',
  { skip: WIN32_SKIP },
  async () => {
    const { result, server, home } = await runNonRepairPass({ status: 503, body: JSON.stringify({ error: 'upstream unavailable' }) })
    try {
      assert.equal(result.status, 1, `expected clean exit 1, got ${result.status} (stderr: ${result.stderr.slice(-400)})`)
      assert.doesNotMatch(result.stderr, ASSERTION_TEXT, 'must never crash with a libuv assertion')
    } finally {
      try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
      home.cleanup()
      await server.close()
    }
 },
)

test(
  'setup.mjs exits 1 cleanly (no libuv UV_HANDLE_CLOSING abort) when a vault entry exists and /api/me answers a genuine city 401',
  { skip: WIN32_SKIP },
  async () => {
    const { result, server, home } = await runNonRepairPass({ status: 401, body: JSON.stringify({ error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>' }) })
    try {
      assert.equal(result.status, 1, `expected clean exit 1, got ${result.status} (stderr: ${result.stderr.slice(-400)})`)
      assert.doesNotMatch(result.stderr, ASSERTION_TEXT, 'must never crash with a libuv assertion')
    } finally {
      try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
      home.cleanup()
      await server.close()
    }
  },
)

test(
  'setup.mjs exits 1 cleanly with no vault entry at all (control -- probeMe never runs, so no crash risk either way)',
  { skip: WIN32_SKIP },
  async () => {
    const { result, server, home } = await runNonRepairPass({ status: 503, body: JSON.stringify({ error: 'x' }) }, { storeEntry: false })
    try {
      assert.equal(result.status, 1)
      assert.doesNotMatch(result.stderr, ASSERTION_TEXT)
    } finally {
      home.cleanup()
      await server.close()
    }
  },
)

test(
  'setup.mjs exits 0 cleanly when the stored key genuinely works (control -- adopts it, never reaches the crash-risk path)',
  { skip: WIN32_SKIP },
  async () => {
    const { result, server, home } = await runNonRepairPass({ status: 200, body: JSON.stringify({ handle }) })
    try {
      assert.equal(result.status, 0)
      assert.doesNotMatch(result.stderr, ASSERTION_TEXT)
    } finally {
      try { deleteSecret(server.origin, handle, { homeDir: home.dir }) } catch { /* best effort */ }
      home.cleanup()
      await server.close()
    }
  },
)
